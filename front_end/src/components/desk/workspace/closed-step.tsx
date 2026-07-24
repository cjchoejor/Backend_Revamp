"use client";

import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Check, FileText, Handshake, Receipt, Scale, Wallet } from "lucide-react";
import { toast } from "sonner";
import { useSession } from "@/hooks/use-session";
import { ApiError } from "@/lib/api/client";
import {
  closeDispute,
  dispatchInvoice,
  expirePostCheckoutInspectionWindow,
  fulfilHandoff,
  issueFolioInvoice,
  postCreditNote,
  postStayCharge,
  recordInvoicePaymentEvent,
  writeOffOutstanding,
} from "@/lib/api/post-stay";
import { progressDispute } from "@/lib/api/in-stay";
import { deriveFinancials, money, moneyOrDash, s9CloseReadiness } from "@/lib/desk/workspace";
import { usePaymentStatus } from "@/hooks/use-payment-status";
import { openInvoicePdf } from "@/lib/api/documents";
import { PdfButton } from "./pdf-button";
import { BackendRail, type RailGroup } from "./backend-inline";
import { STAGE_ACTIONS } from "@/lib/desk/backend-actions";
import type { EntryDetail } from "@/types/api";

function BlockH({ children }: { children: React.ReactNode }) {
  return (
    <div className="block-h">
      {children}
      <span className="ln" />
    </div>
  );
}
function isElevated(level?: string) {
  return level === "L2" || level === "L3" || level === "L4";
}
function isGm(level?: string) {
  return level === "L3" || level === "L4";
}

const POST_STAY_LINE_TYPES = ["OTHER", "DAMAGE", "F_AND_B", "MINIBAR", "LAUNDRY"] as const;

/**
 * S9 · Post-stay. The actionable surface for an entry that has reached S9 but is not yet sealed.
 * Ports the OLD stage s9-workspace capabilities: post-stay charges, invoice issue/dispatch,
 * invoice payment-tracking (government submission), reconcile, write-off, credit note, H5
 * fulfilment, deferred-inspection window expiry (W9), and dispute review/close. The terminal
 * `closeEntryAtS9` seal lives in the workspace gate bar (like settle at checkout).
 */
export function PostStayStep({ entry }: { entry: EntryDetail }) {
  const { session } = useSession();
  const queryClient = useQueryClient();
  const elevated = isElevated(session?.actorLevel);
  const gm = isGm(session?.actorLevel);

  const paymentStatus = usePaymentStatus(entry.id, { enabled: !!entry.folio });
  const fin = deriveFinancials(entry, { paymentStatus: paymentStatus.data });
  const folio = entry.folio;
  const invoices = folio?.invoices ?? [];
  const draftInvoices = invoices.filter((i) => i.state === "DRAFT");
  const latestInvoice = invoices[0];
  const isGovernment = folio?.billingModel === "GOVERNMENT";
  const handoffs = entry.handoffs ?? [];
  const h5 = handoffs.find((h) => h.handoffType === "H5");
  const h5Blocking = !!h5 && (h5.state === "CREATED" || h5.state === "ASSIGNED" || h5.state === "ACCEPTED");
  const inspections = entry.roomInspectionRecords ?? [];
  const deferredInspection =
    inspections[0]?.isDeferred && !inspections.some((i) => !i.isDeferred) ? inspections[0] : undefined;
  const disputes = entry.disputes ?? [];
  const openDisputes = disputes.filter(
    (d) => d.status === "OPEN" || d.status === "IN_PROGRESS" || d.status === "REOPENED",
  );
  const commissionRecords = entry.commissionDueRecords ?? [];
  const followUpTasks = entry.followUpTasks ?? [];
  const currency = (folio?.lines ?? [])[0]?.currency;
  const checks = s9CloseReadiness(entry);

  const [postStayLineType, setPostStayLineType] = useState<string>("OTHER");
  const [postStayDesc, setPostStayDesc] = useState("");
  const [postStayAmount, setPostStayAmount] = useState("");
  const [creditDesc, setCreditDesc] = useState("");
  const [creditAmount, setCreditAmount] = useState("");
  const [writeOffAmount, setWriteOffAmount] = useState("");
  const [writeOffReason, setWriteOffReason] = useState("");
  const [selectedInvoiceId, setSelectedInvoiceId] = useState("");
  const [paymentEventAmount, setPaymentEventAmount] = useState("");
  const [paymentEventRef, setPaymentEventRef] = useState("");
  const [h5Evidence, setH5Evidence] = useState("Residual obligations resolved");
  const [disputeCloseReason, setDisputeCloseReason] = useState("");

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ["entry", entry.id] });
    void queryClient.invalidateQueries({ queryKey: ["entry-trace", entry.id] });
    void queryClient.invalidateQueries({ queryKey: ["entry-timers", entry.id] });
  };
  const wrap = <T,>(fn: () => Promise<T>, msg: string) => ({
    mutationFn: fn,
    onSuccess: () => {
      toast.success(msg);
      invalidate();
    },
    onError: (e: unknown) => toast.error(e instanceof ApiError ? e.message : "Action failed"),
  });

  const invId = () => selectedInvoiceId || latestInvoice?.id;

  const postStayM = useMutation(
    wrap(() => {
      const amount = Number.parseFloat(postStayAmount);
      if (!folio?.id || !Number.isFinite(amount)) throw new Error("Valid amount required");
      return postStayCharge(session!, folio.id, {
        entryId: entry.id,
        lineType: postStayLineType,
        description: postStayDesc.trim() || "Post-stay charge",
        amount,
        postedAt: new Date().toISOString(),
        isPostStay: true,
      }).then(() => {
        setPostStayDesc("");
        setPostStayAmount("");
      });
    }, "Post-stay charge posted (guest notified)"),
  );
  const creditM = useMutation(
    wrap(() => {
      const amount = Number.parseFloat(creditAmount);
      if (!folio?.id || !Number.isFinite(amount)) throw new Error("Valid amount required");
      return postCreditNote(session!, folio.id, {
        entryId: entry.id,
        description: creditDesc.trim() || "Post-stay credit",
        amount,
        creditDate: new Date().toISOString(),
      }).then(() => {
        setCreditDesc("");
        setCreditAmount("");
      });
    }, "Credit note posted"),
  );
  const writeOffM = useMutation(
    wrap(() => {
      const amount = Number.parseFloat(writeOffAmount);
      if (!folio?.id || !Number.isFinite(amount) || amount <= 0) throw new Error("Valid amount required");
      if (!writeOffReason.trim()) throw new Error("Write-off reason is required");
      return writeOffOutstanding(session!, folio.id, { amount, reason: writeOffReason.trim() }).then(() => {
        setWriteOffAmount("");
        setWriteOffReason("");
      });
    }, "Write-off recorded — folio → WRITTEN_OFF"),
  );
  const issueInvoiceM = useMutation(
    wrap(() => {
      if (!folio?.id) throw new Error("No folio");
      return issueFolioInvoice(session!, folio.id, { entryId: entry.id, templateKey: "final-v1" });
    }, "Final invoice created (draft — dispatch next)"),
  );
  const dispatchM = useMutation(
    wrap(() => {
      const d = draftInvoices[0];
      if (!d) throw new Error("No draft invoice to dispatch");
      return dispatchInvoice(session!, d.id);
    }, "Invoice dispatched"),
  );
  const paymentEventM = useMutation(
    wrap(() => {
      const id = invId();
      if (!id) throw new Error("Select an invoice");
      const amount = Number.parseFloat(paymentEventAmount);
      const body: Parameters<typeof recordInvoicePaymentEvent>[2] = {
        nextState: "PAYMENT_TRACKED",
        referenceNumber: paymentEventRef.trim() || undefined,
      };
      if (Number.isFinite(amount) && amount > 0) body.amount = amount;
      return recordInvoicePaymentEvent(session!, id, body);
    }, "Payment event recorded — invoice PAYMENT_TRACKED"),
  );
  const reconcileM = useMutation(
    wrap(() => {
      const id = invId();
      if (!id) throw new Error("Select an invoice");
      return recordInvoicePaymentEvent(session!, id, { nextState: "RECONCILED" });
    }, "Invoice reconciled"),
  );
  const fulfilH5M = useMutation(
    wrap(() => {
      if (!h5) throw new Error("No H5 handoff");
      return fulfilHandoff(session!, h5.id, { resolutionBasis: h5Evidence.trim() });
    }, "H5 fulfilled"),
  );
  const expireInspectionM = useMutation(
    wrap(() => expirePostCheckoutInspectionWindow(session!, entry.id), "Post-checkout inspection window expired"),
  );

  const railGroups: RailGroup[] = [
    { key: "background", label: "Post-stay workers & services", items: STAGE_ACTIONS.S9.background },
  ];

  return (
    <div className="bx-split">
      <div className="bx-main">
        <div className="speak">
          <div className="now">Post-stay</div>
          <h2>Resolve residual obligations, then seal the record.</h2>
          <p>
            The stay is over. Track invoice payments, settle any residual charges, fulfil H5, and clear
            disputes. When the loop-closure checklist is green, close and seal the record from the bar below —
            that last step is permanent.
          </p>
        </div>

        {/* Loop-closure checklist */}
        <div className="block">
          <BlockH>
            <Check style={{ width: 13, height: 13 }} />
            Loop-closure checklist
          </BlockH>
          {checks.map((c) => (
            <div
              key={c.label}
              style={{ display: "flex", alignItems: "center", gap: 8, padding: "4px 0", fontSize: 12.5 }}
            >
              <span
                className={`nd`}
                style={{
                  width: 8,
                  height: 8,
                  borderRadius: 999,
                  background: c.met ? "var(--green)" : "var(--line-2)",
                  flexShrink: 0,
                }}
              />
              <span style={{ color: c.met ? "var(--ink)" : "var(--ink-3)" }}>{c.label}</span>
              {c.met && <Check style={{ width: 13, height: 13, color: "var(--green-d)" }} />}
            </div>
          ))}
        </div>

        {/* Bill snapshot */}
        <div className="block">
          <BlockH>
            <Receipt style={{ width: 13, height: 13 }} />
            The bill
          </BlockH>
          {/* Read from the backend only — no charges-total field exists on the folio, so it is
              omitted rather than summed here. */}
          <div className="field">
            <label>Payments received</label>
            <div className="val">{moneyOrDash(fin.advanceReceived, currency)}</div>
          </div>
          <div className="field">
            <label>Outstanding</label>
            <div className="val">{moneyOrDash(fin.outstanding, currency)}</div>
          </div>
        </div>

        {/* Invoices & payment tracking (government submission) */}
        <div className="block">
          <BlockH>
            <FileText style={{ width: 13, height: 13 }} />
            Invoices &amp; payment tracking
            {isGovernment ? " · government submission" : ""}
          </BlockH>
          {invoices.length > 0 && (
            <div className="field">
              <label>Invoice</label>
              <select value={invId() ?? ""} onChange={(e) => setSelectedInvoiceId(e.target.value)}>
                {invoices.map((inv) => (
                  <option key={inv.id} value={inv.id}>
                    {inv.invoiceType} · {inv.state} · {inv.id.slice(0, 12)}
                  </option>
                ))}
              </select>
            </div>
          )}
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 10 }}>
            <button className="btn btn-ghost btn-sm" disabled={issueInvoiceM.isPending} onClick={() => issueInvoiceM.mutate()}>
              Issue final invoice
            </button>
            {draftInvoices.length > 0 && (
              <button className="btn btn-ghost btn-sm" disabled={dispatchM.isPending} onClick={() => dispatchM.mutate()}>
                Dispatch draft invoice
              </button>
            )}
            {session && invId() && (
              <PdfButton label="View invoice PDF" open={() => openInvoicePdf(session, invId()!)} />
            )}
          </div>
          {elevated && invoices.length > 0 && (
            <>
              <div style={{ fontSize: 11, fontWeight: 600, color: "var(--ink-3)", margin: "4px 0 7px" }}>
                Record payment event (FOM+)
              </div>
              <div className="frow">
                <div className="field">
                  <label>Amount (optional)</label>
                  <input type="number" value={paymentEventAmount} onChange={(e) => setPaymentEventAmount(e.target.value)} />
                </div>
                <div className="field">
                  <label>Reference</label>
                  <input value={paymentEventRef} onChange={(e) => setPaymentEventRef(e.target.value)} />
                </div>
              </div>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                <button className="btn btn-ghost btn-sm" disabled={paymentEventM.isPending} onClick={() => paymentEventM.mutate()}>
                  Mark payment tracked
                </button>
                <button className="btn btn-ghost btn-sm" disabled={reconcileM.isPending} onClick={() => reconcileM.mutate()}>
                  Reconcile
                </button>
              </div>
            </>
          )}
        </div>

        {/* Post-stay charge */}
        <div className="block">
          <BlockH>
            <Receipt style={{ width: 13, height: 13 }} />
            Post-stay charge
          </BlockH>
          <div className="frow">
            <div className="field">
              <label>Type</label>
              <select value={postStayLineType} onChange={(e) => setPostStayLineType(e.target.value)}>
                {POST_STAY_LINE_TYPES.map((t) => (
                  <option key={t} value={t}>
                    {t}
                  </option>
                ))}
              </select>
            </div>
            <div className="field">
              <label>Description</label>
              <input value={postStayDesc} onChange={(e) => setPostStayDesc(e.target.value)} />
            </div>
            <div className="field">
              <label>Amount</label>
              <input type="number" value={postStayAmount} onChange={(e) => setPostStayAmount(e.target.value)} />
            </div>
          </div>
          <button className="btn btn-ghost btn-sm" disabled={postStayM.isPending} onClick={() => postStayM.mutate()}>
            Post charge (notifies guest)
          </button>
        </div>

        {/* Credit note */}
        <div className="block">
          <BlockH>Post a credit note</BlockH>
          <div className="frow">
            <div className="field">
              <label>Description</label>
              <input value={creditDesc} onChange={(e) => setCreditDesc(e.target.value)} />
            </div>
            <div className="field">
              <label>Amount</label>
              <input type="number" value={creditAmount} onChange={(e) => setCreditAmount(e.target.value)} />
            </div>
          </div>
          <button className="btn btn-ghost btn-sm" disabled={creditM.isPending} onClick={() => creditM.mutate()}>
            Post credit note
          </button>
        </div>

        {/* Write-off (FOM+) */}
        {elevated && (
          <div className="block">
            <BlockH>
              <Wallet style={{ width: 13, height: 13 }} />
              Write off outstanding (FOM+)
            </BlockH>
            <div className="frow">
              <div className="field">
                <label>Amount</label>
                <input type="number" value={writeOffAmount} onChange={(e) => setWriteOffAmount(e.target.value)} />
              </div>
              <div className="field">
                <label>Reason</label>
                <input value={writeOffReason} onChange={(e) => setWriteOffReason(e.target.value)} />
              </div>
            </div>
            <button className="btn btn-ghost btn-sm" disabled={writeOffM.isPending} onClick={() => writeOffM.mutate()}>
              Record write-off
            </button>
          </div>
        )}

        {/* H5 residual obligations */}
        {h5 && (
          <div className="block">
            <BlockH>
              <Handshake style={{ width: 13, height: 13 }} />
              Residual-obligations handoff (H5)
            </BlockH>
            {h5Blocking ? (
              <>
                <p style={{ fontSize: 12, color: "var(--ink-3)", marginTop: 0 }}>
                  State: {h5.state}. Fulfil after payment matched, write-off, or confirmed no-action.
                </p>
                <div className="frow">
                  <div className="field">
                    <label>Resolution basis</label>
                    <input value={h5Evidence} onChange={(e) => setH5Evidence(e.target.value)} />
                  </div>
                  <div className="field" style={{ alignSelf: "end" }}>
                    <button className="btn btn-ghost" disabled={fulfilH5M.isPending} onClick={() => fulfilH5M.mutate()}>
                      Fulfil H5
                    </button>
                  </div>
                </div>
              </>
            ) : (
              <div className="fact b-bound" style={{ padding: "9px 12px", fontSize: 12.5 }}>
                <Check style={{ width: 14, height: 14, color: "var(--green-d)" }} />
                H5 {h5.state}
              </div>
            )}
          </div>
        )}

        {/* Deferred inspection expiry (W9) */}
        {deferredInspection && (
          <div className="block">
            <BlockH>Deferred inspection</BlockH>
            <p style={{ fontSize: 12, color: "var(--ink-3)", marginTop: 0 }}>
              The room inspection was deferred to the post-checkout window. If the window lapses without a
              recorded inspection, expire it to clear the closure gate (W9).
            </p>
            <button className="btn btn-ghost btn-sm" disabled={expireInspectionM.isPending} onClick={() => expireInspectionM.mutate()}>
              Expire inspection window
            </button>
          </div>
        )}

        {/* Disputes */}
        {disputes.length > 0 && (
          <div className="block">
            <BlockH>
              <Scale style={{ width: 13, height: 13 }} />
              Disputes (must clear before close)
            </BlockH>
            {disputes.map((d) => (
              <div
                key={d.id}
                style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, padding: "6px 0", borderBottom: "1px dashed var(--line)" }}
              >
                <span style={{ fontSize: 13 }}>
                  <b>{d.title}</b>
                </span>
                <span style={{ display: "flex", gap: 6, alignItems: "center" }}>
                  <span className={`tag ${d.status === "RESOLVED" || d.status === "CLOSED" ? "" : "warn"}`}>{d.status}</span>
                  {(d.status === "OPEN" || d.status === "IN_PROGRESS") && elevated && (
                    <button className="btn btn-ghost btn-sm" onClick={() => progressDispute(session!, d.id, "IN_PROGRESS").then(invalidate)}>
                      Start review
                    </button>
                  )}
                </span>
              </div>
            ))}
            {openDisputes.length > 0 && gm && (
              <div className="frow" style={{ marginTop: 11 }}>
                <div className="field">
                  <label>Closure reason (GM)</label>
                  <input value={disputeCloseReason} onChange={(e) => setDisputeCloseReason(e.target.value)} />
                </div>
                <div className="field" style={{ alignSelf: "end" }}>
                  <button
                    className="btn btn-ghost"
                    disabled={!disputeCloseReason.trim()}
                    onClick={() => {
                      const d = openDisputes[0];
                      if (!d) return;
                      closeDispute(session!, d.id, disputeCloseReason.trim()).then(() => {
                        toast.success("Dispute closed");
                        setDisputeCloseReason("");
                        invalidate();
                      });
                    }}
                  >
                    Close dispute (GM)
                  </button>
                </div>
              </div>
            )}
          </div>
        )}

        {/* Post-closure records */}
        {(commissionRecords.length > 0 || followUpTasks.length > 0) && (
          <div className="block">
            <BlockH>Post-closure records</BlockH>
            {commissionRecords.map((c) => (
              <div key={c.id} style={{ fontSize: 12.5, padding: "3px 0", color: "var(--ink-2)" }}>
                Commission due · {c.status}
                {c.calculatedAmount != null ? ` · ${money(Number(c.calculatedAmount), c.currency)}` : ""}
              </div>
            ))}
            {followUpTasks.map((t) => (
              <div key={t.id} style={{ fontSize: 12.5, padding: "3px 0", color: "var(--ink-2)" }}>
                Follow-up due {new Date(t.dueAt).toLocaleDateString()}
                {t.completedAt ? " · completed" : ""}
              </div>
            ))}
          </div>
        )}
      </div>

      <BackendRail entryId={entry.id} groups={railGroups} activeKeys={["background"]} firingKey={null} />
    </div>
  );
}
