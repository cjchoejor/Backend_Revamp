"use client";

import { useEffect, useMemo, useState } from "react";
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
  reEnterS8ToS2,
} from "@/lib/api/checkout";
import { dispatchInvoice } from "@/lib/api/reservation-setup";
import { progressDispute } from "@/lib/api/in-stay";
import { deriveFinancials, money, moneyOrDash } from "@/lib/desk/workspace";
import { usePaymentStatus } from "@/hooks/use-payment-status";
import { openInvoicePdf } from "@/lib/api/documents";
import { PdfButton } from "./pdf-button";
import { BackendRail, type RailGroup } from "./backend-inline";
import { STAGE_ACTIONS } from "@/lib/desk/backend-actions";
import type { BillingModelDefaults, EntryDetail } from "@/types/api";
import { DeskConfirmModal } from "./confirm-modal";
import {
  updateBillingModelDefaults,
  SPLIT_BILLING_MODELS,
  FOLIO_LINE_TYPES,
  type SplitBillingModel,
  type FolioLineTypeKey,
} from "@/lib/api/split-billing";

const BK = STAGE_ACTIONS.S8;

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

  const paymentStatus = usePaymentStatus(entry.id, { enabled: !!entry.folio });
  const fin = deriveFinancials(entry, { paymentStatus: paymentStatus.data });
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
  // The server's folio.outstandingBalance is the balance — never re-derived from lines/payments.
  const balance = fin.outstanding;
  // Split-billing settle-bucket state (declared here so the useMemo / useEffect below can see it).
  const [settleBucket, setSettleBucket] = useState<string>("");
  const [defaultsEditorOpen, setDefaultsEditorOpen] = useState(false);
  // Split-billing per-bucket derivation (same logic as StayStep — keep in sync). Derives from
  // line.billingModel + payment.billingModel with NULL→primary rollup. Used by the settlement
  // form's bucket picker so operator can settle each payer independently.
  const bucketSummary = useMemo(() => {
    const primary = folio?.billingModel?.trim() ?? null;
    const bucketOf = (m: string | null | undefined) => (m?.trim() || null) ?? primary;
    const map = new Map<string, { charges: number; paymentsIn: number; paymentsOut: number; lineCount: number }>();
    const bump = (key: string | null, fn: (b: { charges: number; paymentsIn: number; paymentsOut: number; lineCount: number }) => void) => {
      if (!key) return;
      const b = map.get(key) ?? { charges: 0, paymentsIn: 0, paymentsOut: 0, lineCount: 0 };
      fn(b);
      map.set(key, b);
    };
    for (const l of folio?.lines ?? []) bump(bucketOf(l.billingModel), (b) => { b.charges += Number(l.amount); b.lineCount += 1; });
    for (const p of folio?.payments ?? []) {
      const k = bucketOf(p.billingModel);
      if (p.paymentDirection === "IN") bump(k, (b) => { b.paymentsIn += Number(p.amount); });
      else if (p.paymentDirection === "OUT") bump(k, (b) => { b.paymentsOut += Number(p.amount); });
    }
    return Array.from(map.entries())
      .map(([billingModel, b]) => ({
        billingModel,
        lineCount: b.lineCount,
        outstanding: Math.max(0, b.charges - b.paymentsIn + b.paymentsOut),
      }))
      .sort((a, b) => a.billingModel.localeCompare(b.billingModel));
  }, [folio?.billingModel, folio?.lines, folio?.payments]);
  const isSplitBilled = bucketSummary.length > 1;
  // Default bucket pick: an outstanding bucket that isn't already zero (skip already-settled ones);
  // prefer GUEST_PAY (guests usually settle first at the desk). Runs on mount + when buckets change.
  useEffect(() => {
    if (!isSplitBilled) { setSettleBucket(""); return; }
    if (settleBucket && bucketSummary.some((b) => b.billingModel === settleBucket && b.outstanding > 0)) return;
    const preferGuest = bucketSummary.find((b) => b.billingModel === "GUEST_PAY" && b.outstanding > 0);
    const anyUnsettled = bucketSummary.find((b) => b.outstanding > 0);
    setSettleBucket((preferGuest ?? anyUnsettled)?.billingModel ?? "");
  }, [isSplitBilled, bucketSummary, settleBucket]);
  // Final-morning charges belong to the checkout day, not "today" — the checkout day is never a
  // stay night, so it's never sealed by night audit (SIG-S8 §2.2). Using today collides with the
  // just-audited final stay night when checkout happens on/near it (e.g. a compressed test stay).
  const checkoutChargeDate = entry.reservation?.frozenCheckOutDate ?? entry.checkOutDate ?? null;
  const checkoutChargeYmd = checkoutChargeDate ? checkoutChargeDate.slice(0, 10) : null;

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
  // settleBucket + defaultsEditorOpen states declared earlier (above bucketSummary derivation).
  const [finalChargeDesc, setFinalChargeDesc] = useState("");
  const [finalChargeAmount, setFinalChargeAmount] = useState("");
  const [reEntryReason, setReEntryReason] = useState("");
  const [reEntryS2Reason, setReEntryS2Reason] = useState("");
  const [disputeCloseReason, setDisputeCloseReason] = useState("");
  const [h4DeficientFlag, setH4DeficientFlag] = useState("RECORDED");
  const [settleOpen, setSettleOpen] = useState(false);

  useEffect(() => {
    setDeficientFlagStatus(activeDeficient ? "UNRESOLVED_AT_CHECKOUT" : "NOT_APPLICABLE");
  }, [activeDeficient?.id]);

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

  const finalChargeM = useMutation(
    wrap(() => {
      const amt = Number.parseFloat(finalChargeAmount);
      if (!folio?.id || !Number.isFinite(amt)) throw new Error("Valid amount required");
      return postFolioCharge(session!, folio.id, { entryId: entry.id, lineType: "F_AND_B", description: finalChargeDesc.trim() || "Final morning charge", amount: amt, chargeDate: checkoutChargeDate ?? new Date().toISOString() });
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
      // Split-billing: when a specific bucket is picked, target that; confirmation must match
      // the target (not the folio's primary). Legacy single-bucket path passes folio.billingModel.
      const targetBucket = isSplitBilled && settleBucket ? settleBucket : null;
      const confirmation = targetBucket ?? folio.billingModel;
      const body: Parameters<typeof initiateSettlement>[2] = {
        settlementMethod,
        billingModelConfirmation: confirmation,
        ...(targetBucket ? { billingModel: targetBucket } : {}),
      };
      if (paymentRef.trim()) body.paymentVerificationRef = paymentRef.trim();
      const partial = Number.parseFloat(partialAmount);
      if (Number.isFinite(partial) && partial > 0) body.partialAmount = partial;
      if (fomAckRef.trim()) body.fomAcknowledgementRef = fomAckRef.trim();
      return initiateSettlement(session!, folio.id, body);
    },
    onSuccess: () => {
      setSettleOpen(false);
      // Split-billing: only celebrate "folio closed" when the whole folio is done. A
      // per-bucket settlement leaves other buckets outstanding — softer toast.
      const remainingBuckets = bucketSummary.filter((b) => b.outstanding > 0 && b.billingModel !== settleBucket);
      const stillOwed = isSplitBilled && remainingBuckets.length > 0;
      toast.success(
        stillOwed
          ? `${settleBucket || "Bucket"} settled — ${remainingBuckets.length} bucket${remainingBuckets.length === 1 ? "" : "s"} still owed`
          : "Settled — folio closed, room released to housekeeping",
      );
      invalidate();
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : "Settlement failed"),
  });
  // Split-billing: update the folio's per-line-type defaults. Body sourced from the modal.
  const defaultsM = useMutation({
    mutationFn: (arg: { defaults: BillingModelDefaults; reason?: string }) => {
      if (!folio?.id) throw new Error("No folio");
      return updateBillingModelDefaults(session!, folio.id, arg);
    },
    onSuccess: () => {
      toast.success("Defaults updated — future charges will use the new map");
      setDefaultsEditorOpen(false);
      invalidate();
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : "Update failed"),
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
  // S8 → S2 rate dispute: re-open to Quote for a full renegotiation. Seals the current segment and
  // starts a new one at S2; the live folio persists. Backend requires L2+ + a reason (SIG-S8 §1.2).
  const reEntryS2M = useMutation({
    mutationFn: () => reEnterS8ToS2(session!, entry.id, entry.version, reEntryS2Reason.trim()),
    onSuccess: () => {
      toast.success("Re-opened to Quote for renegotiation");
      invalidate();
      void queryClient.invalidateQueries({ queryKey: ["entries"] });
      setSelected(2);
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : "Rate-dispute re-entry failed"),
  });

  // Persistent highlight: each group stays lit once its action has run (derived from real key /
  // inspection / folio state). `firingKey` adds the transient "running now" pulse.
  const activeKeys = [
    keyReturn ? "keyReturn" : null,
    inspection ? "inspection" : null,
    folioSettled ? "settle" : null,
    entry.currentStage !== "S8" ? "advance" : null,
  ].filter(Boolean) as string[];
  const firingKey = keyReturnM.isPending
    ? "keyReturn"
    : inspectionM.isPending
      ? "inspection"
      : settleM.isPending
        ? "settle"
        : reEntryM.isPending
          ? "reentry"
          : null;
  const railGroups: RailGroup[] = [
    { key: "keyReturn", label: "On recording key return", items: BK.keyReturn },
    { key: "inspection", label: "On recording the room inspection", items: BK.inspection },
    { key: "settle", label: "On taking payment & settling", items: BK.settle },
    { key: "reentry", label: "On returning to Stay (S8→S7)", items: BK.reentry },
    { key: "advance", label: "On advancing to Closed", items: BK.advance },
  ];

  return (
    <div className="bx-split">
      <div className="bx-main">
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
        {/* Every figure here is read from the backend. The folio carries no charges-total field,
            so that row is gone rather than summed in the browser — the line list below still
            shows each backend-priced charge individually. */}
        <div className="field">
          <label>Advance / payments received</label>
          <div className="val">{moneyOrDash(fin.advanceReceived, currency)}</div>
        </div>
        <div className="field">
          <label>Balance due</label>
          <div className="val">{moneyOrDash(balance, currency)}</div>
        </div>
        {folioLive && (
          <div style={{ marginTop: 6, borderTop: "1px dashed var(--line-2)", paddingTop: 11 }}>
            <div style={{ fontSize: 11, fontWeight: 600, color: "var(--ink-3)", marginBottom: 7 }}>
              Post a final-morning charge{checkoutChargeYmd ? ` · dated checkout day ${checkoutChargeYmd}` : ""}
            </div>
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
              {session &&
                (() => {
                  const finalInvoice = folioInvoices.find((i) => i.invoiceType === "FINAL");
                  return finalInvoice ? (
                    <PdfButton label="View final invoice PDF" open={() => openInvoicePdf(session, finalInvoice.id)} />
                  ) : null;
                })()}
            </div>
          </>
        ) : (
          <>
            {isSplitBilled && (
              <div style={{
                padding: "10px 12px", borderRadius: 8, border: "1px solid var(--line, #e6e0d4)",
                background: "var(--surface-2, #fafaf5)", marginBottom: 12,
              }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
                  <div style={{ fontSize: 11.5, fontWeight: 600, color: "var(--ink-3, #7a6a52)" }}>
                    Split billing — this folio has multiple payers. Settle each bucket separately.
                  </div>
                  <button
                    type="button"
                    onClick={() => setDefaultsEditorOpen(true)}
                    style={{
                      padding: "4px 10px", borderRadius: 4, fontSize: 11, cursor: "pointer",
                      border: "1px solid var(--line, #e6e0d4)", background: "var(--surface, #fff)",
                    }}
                  >
                    Edit defaults
                  </button>
                </div>
                <div style={{ display: "grid", gap: 6 }}>
                  {bucketSummary.map((b) => {
                    const selected = settleBucket === b.billingModel;
                    const isPaid = b.outstanding <= 0;
                    return (
                      <label
                        key={b.billingModel}
                        style={{
                          display: "flex", justifyContent: "space-between", alignItems: "center",
                          padding: "6px 10px", borderRadius: 6, cursor: isPaid ? "default" : "pointer",
                          border: selected ? "1px solid var(--accent, #a44f2b)" : "1px solid var(--line, #e6e0d4)",
                          background: selected ? "rgba(164, 79, 43, 0.06)" : "var(--surface, #fff)",
                          opacity: isPaid ? 0.55 : 1,
                        }}
                      >
                        <span style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12.5 }}>
                          <input
                            type="radio"
                            name="settle-bucket"
                            value={b.billingModel}
                            checked={selected}
                            disabled={isPaid}
                            onChange={() => setSettleBucket(b.billingModel)}
                            style={{ margin: 0 }}
                          />
                          <b>{b.billingModel}</b>
                          <span style={{ color: "var(--ink-3, #7a6a52)", fontSize: 11 }}>
                            · {b.lineCount} charge{b.lineCount === 1 ? "" : "s"}
                          </span>
                          {isPaid && <span style={{ color: "var(--green, #1e6b3f)", fontSize: 11 }}>· settled</span>}
                        </span>
                        <span style={{ fontVariantNumeric: "tabular-nums", fontSize: 13 }}>
                          {isPaid ? "—" : money(b.outstanding, currency ?? "BTN")}
                        </span>
                      </label>
                    );
                  })}
                </div>
              </div>
            )}
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

      {/* Rate dispute (S8→S2) — full renegotiation */}
      {elevated && !folioSettled && (
        <div className="block">
          <BlockH>Dispute the rate?</BlockH>
          <p style={{ fontSize: 11.5, color: "var(--ink-3)", marginTop: 0, lineHeight: 1.5 }}>
            Re-open the booking to Quote for a full rate renegotiation. Seals this segment and starts a fresh
            one at Quote; the live folio carries over. Requires FOM (L2)+.
          </p>
          <div className="frow">
            <div className="field">
              <label>Reason to re-open Quote</label>
              <input
                value={reEntryS2Reason}
                onChange={(e) => setReEntryS2Reason(e.target.value)}
                placeholder="e.g. guest disputes the rate charged"
              />
            </div>
            <div className="field" style={{ alignSelf: "end" }}>
              <button className="btn btn-ghost" disabled={reEntryS2M.isPending || !reEntryS2Reason.trim()} onClick={() => reEntryS2M.mutate()}>
                Re-open to Quote
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
      </div>

      <BackendRail entryId={entry.id} groups={railGroups} activeKeys={activeKeys} firingKey={firingKey} />

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

      {defaultsEditorOpen && (
        <BillingModelDefaultsEditor
          current={folio?.billingModelDefaults ?? null}
          primary={folio?.billingModel ?? null}
          pending={defaultsM.isPending}
          onClose={() => setDefaultsEditorOpen(false)}
          onSubmit={(defaults, reason) => defaultsM.mutate({ defaults, reason })}
        />
      )}
    </div>
  );
}

/**
 * Modal for editing the folio's per-line-type billing-model defaults map. Renders one radio
 * group per line-type (ROOM_CHARGE, F_AND_B, SERVICE, OTHER); operator picks a billing-model
 * per row. Submitting sends a partial merge — existing lines are NOT retroactively updated
 * (backend enforces future-only), so the operator gets a warning about that expectation.
 */
function BillingModelDefaultsEditor({
  current,
  primary,
  pending,
  onSubmit,
  onClose,
}: {
  current: BillingModelDefaults | null;
  primary: string | null;
  pending: boolean;
  onSubmit: (defaults: BillingModelDefaults, reason?: string) => void;
  onClose: () => void;
}) {
  const initial: Record<FolioLineTypeKey, SplitBillingModel> = useMemo(() => {
    const fallback = (primary as SplitBillingModel) || "GUEST_PAY";
    return {
      ROOM_CHARGE: (current?.ROOM_CHARGE as SplitBillingModel) || fallback,
      F_AND_B: (current?.F_AND_B as SplitBillingModel) || fallback,
      SERVICE: (current?.SERVICE as SplitBillingModel) || fallback,
      OTHER: (current?.OTHER as SplitBillingModel) || fallback,
      CREDIT_NOTE: (current?.CREDIT_NOTE as SplitBillingModel) || fallback,
    };
  }, [current, primary]);
  const [values, setValues] = useState<Record<FolioLineTypeKey, SplitBillingModel>>(initial);
  const [reason, setReason] = useState("");
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const editableTypes: FolioLineTypeKey[] = ["ROOM_CHARGE", "F_AND_B", "SERVICE", "OTHER"];

  return (
    <div
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
      style={{
        position: "fixed", inset: 0, zIndex: 200, background: "rgba(0,0,0,0.5)",
        display: "flex", alignItems: "center", justifyContent: "center", padding: 16,
        backdropFilter: "blur(4px)",
      }}
    >
      <div
        role="dialog" aria-modal="true"
        onMouseDown={(e) => e.stopPropagation()}
        style={{
          background: "var(--surface, #fff)", color: "var(--ink-1, #111)",
          borderRadius: 10, maxWidth: 560, width: "100%",
          boxShadow: "0 20px 50px rgba(0,0,0,0.25)", border: "1px solid var(--line, #e6e0d4)",
          overflow: "hidden",
        }}
      >
        <div style={{ padding: "14px 18px", borderBottom: "1px solid var(--line, #e6e0d4)" }}>
          <div style={{ fontSize: 15, fontWeight: 600 }}>Split-billing defaults</div>
          <div style={{ fontSize: 11.5, color: "var(--ink-3, #7a6a52)", marginTop: 3 }}>
            Which payer gets each type of charge? Changes affect NEW charges only — already-posted
            lines keep their current payer.
          </div>
        </div>

        <div style={{ padding: "14px 18px", display: "grid", gap: 10 }}>
          {editableTypes.map((lt) => (
            <div key={lt} style={{
              display: "grid", gridTemplateColumns: "120px 1fr", alignItems: "center", gap: 12,
              padding: "6px 0",
            }}>
              <div style={{ fontSize: 12.5, fontWeight: 500 }}>{lt}</div>
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                {SPLIT_BILLING_MODELS.map((m) => (
                  <label key={m} style={{
                    display: "inline-flex", alignItems: "center", gap: 5,
                    padding: "4px 9px", borderRadius: 5, cursor: "pointer",
                    border: values[lt] === m ? "1px solid var(--accent, #a44f2b)" : "1px solid var(--line, #e6e0d4)",
                    background: values[lt] === m ? "rgba(164, 79, 43, 0.06)" : "var(--surface, #fff)",
                    fontSize: 11.5,
                  }}>
                    <input
                      type="radio"
                      name={`default-${lt}`}
                      value={m}
                      checked={values[lt] === m}
                      onChange={() => setValues((v) => ({ ...v, [lt]: m }))}
                      style={{ margin: 0 }}
                    />
                    {m}
                  </label>
                ))}
              </div>
            </div>
          ))}

          <div style={{ marginTop: 6 }}>
            <label style={{ display: "block", fontSize: 11, fontWeight: 600, color: "var(--ink-3, #7a6a52)", marginBottom: 4 }}>
              Reason (optional)
            </label>
            <input
              type="text"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="e.g. Agent will now cover F&B too"
              style={{
                width: "100%", padding: "7px 10px", borderRadius: 6,
                border: "1px solid var(--line, #e6e0d4)", background: "var(--surface, #fff)",
                fontSize: 13,
              }}
            />
          </div>
        </div>

        <div style={{ padding: "12px 18px", borderTop: "1px solid var(--line, #e6e0d4)", display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <button
            type="button"
            onClick={onClose}
            disabled={pending}
            style={{
              padding: "6px 14px", borderRadius: 6, border: "1px solid var(--line, #e6e0d4)",
              background: "var(--surface, #fff)", cursor: "pointer", fontSize: 13,
            }}
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => onSubmit(values, reason.trim() || undefined)}
            disabled={pending}
            style={{
              padding: "6px 14px", borderRadius: 6, border: "1px solid var(--accent, #a44f2b)",
              background: pending ? "var(--surface-2, #fafaf5)" : "var(--accent, #a44f2b)",
              color: pending ? "var(--ink-3, #7a6a52)" : "#fff",
              cursor: pending ? "not-allowed" : "pointer", fontSize: 13, fontWeight: 500,
            }}
          >
            {pending ? "Saving…" : "Save defaults"}
          </button>
        </div>
      </div>
    </div>
  );
}
