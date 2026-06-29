"use client";

import { useEffect, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Check, Handshake, KeyRound, Receipt, Scale, Search, Wallet } from "lucide-react";
import { toast } from "sonner";
import { useSession } from "@/hooks/use-session";
import { ApiError } from "@/lib/api/client";
import {
  buildH4FulfilmentEvidence,
  closeDispute,
  fulfilHandoff,
  initiateSettlement,
  issueFinalInvoice,
  postFolioCharge,
  recordKeyReturn,
  recordRoomInspection,
  reEnterS8ToS7,
} from "@/lib/api/checkout";
import { dispatchInvoice } from "@/lib/api/reservation-setup";
import { progressDispute } from "@/lib/api/in-stay";
import { deriveFinancials, money } from "@/lib/desk/workspace";
import type { EntryDetail } from "@/types/api";
import { DeskConfirmModal } from "./confirm-modal";

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
function folioTerminal(state?: string) {
  return state === "SETTLED" || state === "OUTSTANDING";
}

export function CheckOutStep({ entry, setSelected }: { entry: EntryDetail; setSelected: (n: number) => void }) {
  const { session } = useSession();
  const queryClient = useQueryClient();
  const elevated = isElevated(session?.actorLevel);
  const gm = isGm(session?.actorLevel);

  const fin = deriveFinancials(entry);
  const folio = entry.folio;
  const folioLines = folio?.lines ?? [];
  const folioInvoices = folio?.invoices ?? [];
  const hasFinalInvoice = folioInvoices.some((i) => i.invoiceType === "FINAL");
  const draftFinalInvoice = folioInvoices.find((i) => i.invoiceType === "FINAL" && i.state === "DRAFT");
  const folioLive = folio?.state === "LIVE";
  const folioSettled = folioTerminal(folio?.state);
  const handoffs = entry.handoffs ?? [];
  const h4 = handoffs.find((h) => h.handoffType === "H4");
  const room = entry.roomAssignments?.[0]?.room;
  const deficientRecords = room?.deficientConditionRecords ?? [];
  const activeDeficient = deficientRecords.find((d) => d.status === "UNRESOLVED" || d.status === "DEFICIENT_UNRESOLVED_AT_CHECKOUT");
  const keyReturn = (entry.keyReturnRecords ?? [])[0];
  const inspection = (entry.roomInspectionRecords ?? [])[0];
  const keysIssued = entry.keysIssuedCount ?? 0;
  const disputes = entry.disputes ?? [];
  const openDisputes = disputes.filter((d) => d.status === "OPEN" || d.status === "IN_PROGRESS");
  const currency = folioLines[0]?.currency;
  const balance = fin.outstanding ?? Math.max(0, fin.chargesTotal - fin.advanceReceived);

  const [keysReturned, setKeysReturned] = useState(String(keysIssued || 1));
  const [keyReconcileNote, setKeyReconcileNote] = useState("");
  const [inspectionDeferred, setInspectionDeferred] = useState(false);
  const [deficientFlagStatus, setDeficientFlagStatus] = useState<"RESOLVED" | "UNRESOLVED_AT_CHECKOUT" | "NOT_APPLICABLE">(
    activeDeficient ? "UNRESOLVED_AT_CHECKOUT" : "NOT_APPLICABLE",
  );
  const [inspectorAssessment, setInspectorAssessment] = useState("");
  const [damageFound, setDamageFound] = useState(false);
  const [damageNotes, setDamageNotes] = useState("");
  const [settlementMethod, setSettlementMethod] = useState("CASH");
  const [paymentRef, setPaymentRef] = useState("");
  const [partialAmount, setPartialAmount] = useState("");
  const [fomAckRef, setFomAckRef] = useState("");
  const [finalChargeDesc, setFinalChargeDesc] = useState("");
  const [finalChargeAmount, setFinalChargeAmount] = useState("");
  const [reEntryReason, setReEntryReason] = useState("");
  const [disputeCloseReason, setDisputeCloseReason] = useState("");
  const [h4DeficientFlag, setH4DeficientFlag] = useState("RECORDED");
  const [settleOpen, setSettleOpen] = useState(false);

  useEffect(() => {
    setDeficientFlagStatus(activeDeficient ? "UNRESOLVED_AT_CHECKOUT" : "NOT_APPLICABLE");
  }, [activeDeficient?.id]);

  const invalidate = () => void queryClient.invalidateQueries({ queryKey: ["entry", entry.id] });
  const wrap = <T,>(fn: () => Promise<T>, msg: string) => ({
    mutationFn: fn,
    onSuccess: () => {
      toast.success(msg);
      invalidate();
    },
    onError: (e: unknown) => toast.error(e instanceof ApiError ? e.message : "Action failed"),
  });

  const finalChargeM = useMutation(
    wrap(() => {
      const amt = Number.parseFloat(finalChargeAmount);
      if (!folio?.id || !Number.isFinite(amt)) throw new Error("Valid amount required");
      return postFolioCharge(session!, folio.id, { entryId: entry.id, lineType: "F_AND_B", description: finalChargeDesc.trim() || "Final morning charge", amount: amt, chargeDate: new Date().toISOString() });
    }, "Final charge posted"),
  );
  const keyReturnM = useMutation(
    wrap(() => {
      const n = Number.parseInt(keysReturned, 10);
      if (!Number.isInteger(n) || n < 0) throw new Error("Invalid key count");
      const body: { keyCountReturned: number; reconciliationNote?: string } = { keyCountReturned: n };
      if (n !== keysIssued) body.reconciliationNote = keyReconcileNote.trim();
      return recordKeyReturn(session!, entry.id, body);
    }, "Key return recorded"),
  );
  const inspectionM = useMutation(
    wrap(() => {
      if (deficientFlagStatus !== "NOT_APPLICABLE" && !activeDeficient?.id) throw new Error("Choose NOT_APPLICABLE when there is no open deficiency.");
      if (deficientFlagStatus === "UNRESOLVED_AT_CHECKOUT" && !inspectorAssessment.trim()) throw new Error("Inspector assessment required for unresolved.");
      return recordRoomInspection(session!, entry.id, {
        isDeferred: inspectionDeferred,
        deficientFlagStatus,
        deficientConditionId: deficientFlagStatus !== "NOT_APPLICABLE" ? activeDeficient!.id : undefined,
        inspectorAssessment: deficientFlagStatus === "UNRESOLVED_AT_CHECKOUT" ? inspectorAssessment.trim() : undefined,
        damageFound,
        damageNotes: damageFound ? damageNotes.trim() : undefined,
      });
    }, "Room inspection recorded"),
  );
  const settleM = useMutation({
    mutationFn: () => {
      if (!folio?.id || !folio.billingModel) throw new Error("Folio or billing model missing");
      const body: Parameters<typeof initiateSettlement>[2] = { settlementMethod, billingModelConfirmation: folio.billingModel };
      if (paymentRef.trim()) body.paymentVerificationRef = paymentRef.trim();
      const partial = Number.parseFloat(partialAmount);
      if (Number.isFinite(partial) && partial > 0) body.partialAmount = partial;
      if (fomAckRef.trim()) body.fomAcknowledgementRef = fomAckRef.trim();
      return initiateSettlement(session!, folio.id, body);
    },
    onSuccess: () => {
      setSettleOpen(false);
      toast.success("Settled — folio closed, room released to housekeeping");
      invalidate();
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : "Settlement failed"),
  });
  const fulfilH4M = useMutation(wrap(() => fulfilHandoff(session!, h4!.id, buildH4FulfilmentEvidence(h4DeficientFlag)), "Handoff fulfilled"));
  const reEntryM = useMutation({
    mutationFn: () => reEnterS8ToS7(session!, entry.id, entry.version, reEntryReason.trim()),
    onSuccess: () => {
      toast.success("Returned to Stay to post charges");
      invalidate();
      setSelected(7);
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : "Re-entry failed"),
  });

  return (
    <>
      <div className="speak">
        <div className="now">{folioSettled ? "Settled" : "Do this next"}</div>
        <h2>{folioSettled ? "Folio settled. Ready to close." : "Settle the folio and collect the keys."}</h2>
        <p>
          {folioSettled
            ? "Payment has been taken; the room goes to housekeeping for turnover. Close the stay to seal it."
            : "Verify the bill, take payment for the balance, collect the keys and inspect the room. Taking payment is the last thing you can't reclaim."}
        </p>
      </div>

      {/* Pre-checkout handoff */}
      {h4 && h4.state !== "FULFILLED" && !h4.isAutoFulfilled && (
        <div className="block">
          <BlockH>
            <Handshake style={{ width: 13, height: 13 }} />
            Pre-checkout handoff
          </BlockH>
          <div className="frow">
            <div className="field">
              <label>Deficiency final status</label>
              <select value={h4DeficientFlag} onChange={(e) => setH4DeficientFlag(e.target.value)}>
                <option value="NOT_APPLICABLE">Not applicable</option>
                <option value="RESOLVED">Resolved</option>
                <option value="UNRESOLVED_AT_CHECKOUT">Unresolved at checkout</option>
                <option value="RECORDED">Recorded</option>
              </select>
            </div>
            <div className="field" style={{ alignSelf: "end" }}>
              <button className="btn btn-ghost" disabled={fulfilH4M.isPending} onClick={() => fulfilH4M.mutate()}>
                Fulfil handoff
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Folio */}
      <div className="block">
        <BlockH>
          <Receipt style={{ width: 13, height: 13 }} />
          The bill
        </BlockH>
        <div className="field">
          <label>Charges total</label>
          <div className="val derived">{money(fin.chargesTotal, currency)}</div>
        </div>
        <div className="field">
          <label>Advance / payments received</label>
          <div className="val">{money(fin.advanceReceived, currency)}</div>
        </div>
        <div className="field">
          <label>Balance due</label>
          <div className="val derived">{money(balance, currency)}</div>
        </div>
        {folioLive && (
          <div style={{ marginTop: 6, borderTop: "1px dashed var(--line-2)", paddingTop: 11 }}>
            <div style={{ fontSize: 11, fontWeight: 600, color: "var(--ink-3)", marginBottom: 7 }}>Post a final-morning charge</div>
            <div className="frow">
              <div className="field">
                <label>Description</label>
                <input value={finalChargeDesc} onChange={(e) => setFinalChargeDesc(e.target.value)} />
              </div>
              <div className="field">
                <label>Amount</label>
                <input type="number" value={finalChargeAmount} onChange={(e) => setFinalChargeAmount(e.target.value)} />
              </div>
            </div>
            <button className="btn btn-ghost btn-sm" disabled={finalChargeM.isPending} onClick={() => finalChargeM.mutate()}>
              Post final charge
            </button>
          </div>
        )}
      </div>

      {/* Key return */}
      <div className="block">
        <BlockH>
          <KeyRound style={{ width: 13, height: 13 }} />
          Key return
        </BlockH>
        {keyReturn ? (
          <div className="fact b-bound" style={{ padding: "9px 12px", fontSize: 12.5 }}>
            <Check style={{ width: 14, height: 14, color: "var(--green-d)" }} />
            Returned {keyReturn.keyCountReturned} of {keyReturn.keyCountIssued}
            {keyReturn.countReconciled ? " · reconciled" : keyReturn.reconciliationNote ? ` · ${keyReturn.reconciliationNote}` : ""}
          </div>
        ) : (
          <>
            <p style={{ fontSize: 12, color: "var(--ink-3)", marginTop: 0 }}>Keys issued at check-in: {keysIssued}</p>
            <div className="frow">
              <div className="field">
                <label>Keys returned</label>
                <input type="number" min={0} value={keysReturned} onChange={(e) => setKeysReturned(e.target.value)} />
              </div>
              {Number.parseInt(keysReturned, 10) !== keysIssued && (
                <div className="field">
                  <label>Reconciliation note</label>
                  <input value={keyReconcileNote} onChange={(e) => setKeyReconcileNote(e.target.value)} />
                </div>
              )}
            </div>
            <button className="btn btn-ghost" disabled={keyReturnM.isPending} onClick={() => keyReturnM.mutate()}>
              Record key return
            </button>
          </>
        )}
      </div>

      {/* Room inspection */}
      <div className="block">
        <BlockH>
          <Search style={{ width: 13, height: 13 }} />
          Room inspection
        </BlockH>
        {inspection ? (
          <div className="fact b-bound" style={{ padding: "9px 12px", fontSize: 12.5 }}>
            <Check style={{ width: 14, height: 14, color: "var(--green-d)" }} />
            {inspection.isDeferred ? "Deferred" : "Inspected"} · {inspection.deficientFlagStatus}
            {inspection.damageFound ? " · damage noted" : ""}
          </div>
        ) : (
          <>
            {activeDeficient && (
              <p style={{ fontSize: 12, color: "var(--warn)", marginTop: 0 }}>
                Open deficiency ({activeDeficient.category}) — record how inspection closes it.
              </p>
            )}
            <label className="checkline" style={{ cursor: "pointer", marginBottom: 7 }}>
              <input type="checkbox" checked={inspectionDeferred} onChange={(e) => setInspectionDeferred(e.target.checked)} />
              <span>Defer to post-checkout window</span>
            </label>
            <div className="field">
              <label>Deficiency at checkout</label>
              <select value={deficientFlagStatus} onChange={(e) => setDeficientFlagStatus(e.target.value as typeof deficientFlagStatus)}>
                {!activeDeficient && <option value="NOT_APPLICABLE">Not applicable</option>}
                {activeDeficient && (
                  <>
                    <option value="RESOLVED">Resolved at inspection</option>
                    <option value="UNRESOLVED_AT_CHECKOUT">Unresolved at departure</option>
                  </>
                )}
              </select>
            </div>
            {deficientFlagStatus === "UNRESOLVED_AT_CHECKOUT" && (
              <div className="field">
                <label>Inspector assessment</label>
                <input value={inspectorAssessment} onChange={(e) => setInspectorAssessment(e.target.value)} />
              </div>
            )}
            <label className="checkline" style={{ cursor: "pointer" }}>
              <input type="checkbox" checked={damageFound} onChange={(e) => setDamageFound(e.target.checked)} />
              <span>Damage found</span>
            </label>
            {damageFound && (
              <div className="field" style={{ marginTop: 7 }}>
                <label>Damage notes</label>
                <input value={damageNotes} onChange={(e) => setDamageNotes(e.target.value)} />
              </div>
            )}
            <button className="btn btn-ghost" disabled={inspectionM.isPending} onClick={() => inspectionM.mutate()} style={{ marginTop: 9 }}>
              Record inspection
            </button>
          </>
        )}
      </div>

      {/* Settlement */}
      <div className="block">
        <BlockH>
          <Wallet style={{ width: 13, height: 13 }} />
          Settlement
        </BlockH>
        {folioSettled ? (
          <>
            <div className="fact b-bound" style={{ padding: "9px 12px", fontSize: 12.5, marginBottom: 11 }}>
              <Check style={{ width: 14, height: 14, color: "var(--green-d)" }} />
              Folio {folio?.state}
              {folio?.closedAt ? ` · closed ${new Date(folio.closedAt).toLocaleString()}` : ""}
            </div>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              {!hasFinalInvoice && folio?.id && (
                <button
                  className="btn btn-ghost btn-sm"
                  onClick={() =>
                    issueFinalInvoice(session!, folio.id, entry.id)
                      .then(() => {
                        toast.success("Final invoice created");
                        invalidate();
                      })
                      .catch((e) => toast.error(e instanceof ApiError ? e.message : "Issue failed"))
                  }
                >
                  Issue final invoice
                </button>
              )}
              {draftFinalInvoice && (
                <button
                  className="btn btn-ghost btn-sm"
                  onClick={() =>
                    dispatchInvoice(session!, draftFinalInvoice.id)
                      .then(() => {
                        toast.success("Invoice dispatched");
                        invalidate();
                      })
                      .catch((e) => toast.error(e instanceof ApiError ? e.message : "Dispatch failed"))
                  }
                >
                  Dispatch final invoice
                </button>
              )}
            </div>
          </>
        ) : (
          <>
            <div className="frow">
              <div className="field">
                <label>Settlement method</label>
                <select value={settlementMethod} onChange={(e) => setSettlementMethod(e.target.value)}>
                  <option value="CASH">Cash</option>
                  <option value="MOBILE_PAYMENT">Mobile payment</option>
                  <option value="BANK_TRANSFER">Bank transfer</option>
                  <option value="DIRECT_BILL">Direct bill</option>
                  <option value="VOUCHER">Voucher</option>
                </select>
              </div>
              <div className="field">
                <label>Payment reference</label>
                <input value={paymentRef} onChange={(e) => setPaymentRef(e.target.value)} />
              </div>
            </div>
            <div className="frow">
              <div className="field">
                <label>Partial amount (optional)</label>
                <input type="number" value={partialAmount} onChange={(e) => setPartialAmount(e.target.value)} placeholder="Remainder → outstanding" />
              </div>
              {elevated && (
                <div className="field">
                  <label>FOM ack ref (if over ceiling)</label>
                  <input value={fomAckRef} onChange={(e) => setFomAckRef(e.target.value)} />
                </div>
              )}
            </div>
            <button className="btn btn-primary" style={{ background: "var(--green)" }} disabled={!folioLive} onClick={() => setSettleOpen(true)}>
              <Wallet style={{ width: 14, height: 14 }} />
              Take payment &amp; settle
            </button>
            {!folioLive && <p style={{ fontSize: 11.5, color: "var(--ink-3)", marginBottom: 0 }}>Folio must be live to settle.</p>}
          </>
        )}
      </div>

      {/* Additional charge (S8→S7) */}
      {elevated && !folioSettled && (
        <div className="block">
          <BlockH>Need to add a charge?</BlockH>
          <div className="frow">
            <div className="field">
              <label>Reason to re-open Stay</label>
              <input value={reEntryReason} onChange={(e) => setReEntryReason(e.target.value)} />
            </div>
            <div className="field" style={{ alignSelf: "end" }}>
              <button className="btn btn-ghost" disabled={reEntryM.isPending || !reEntryReason.trim()} onClick={() => reEntryM.mutate()}>
                Return to Stay
              </button>
            </div>
          </div>
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
            <div key={d.id} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, padding: "6px 0", borderBottom: "1px dashed var(--line)" }}>
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

      <DeskConfirmModal
        open={settleOpen}
        title="Take payment & settle?"
        subtitle={`${entry.id} · balance ${money(balance, currency)}`}
        why="Taking payment commits a resource you can't reclaim:"
        consequences={[
          <>
            The balance of <b>{money(balance, currency)}</b> is processed for payment{partialAmount ? " (partial — remainder stays outstanding)" : ""}.
          </>,
          "The folio closes — no further charges can be posted.",
          "The room releases to housekeeping for turnover.",
        ]}
        confirmLabel="Take payment"
        pending={settleM.isPending}
        onConfirm={() => settleM.mutate()}
        onClose={() => setSettleOpen(false)}
      />
    </>
  );
}
