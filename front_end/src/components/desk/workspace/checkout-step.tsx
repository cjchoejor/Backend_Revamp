"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Check, Handshake, KeyRound, Receipt, Scale, Search, Wallet } from "lucide-react";
import { toast } from "sonner";
import { useSession } from "@/hooks/use-session";
import { ApiError } from "@/lib/api/client";
import {
  buildH4FulfilmentEvidence,
  closeDispute,
  fulfilHandoff,
  initiateSettlement,
  postFolioCharge,
  recordKeyReturn,
  recordRoomInspection,
  reEnterS8ToS7,
  reEnterS8ToS2,
} from "@/lib/api/checkout";
import { correctFolioCharge, postCreditNote, progressDispute } from "@/lib/api/in-stay";
import { getBillingSummary } from "@/lib/api/entries";
import { deriveFinancials, money, moneyOrDash } from "@/lib/desk/workspace";
import { usePaymentStatus } from "@/hooks/use-payment-status";
import { FolioDocumentsBlock } from "./folio-documents";
import { BackendRail, type RailGroup } from "./backend-inline";
import { STAGE_ACTIONS } from "@/lib/desk/backend-actions";
import type { EntryDetail } from "@/types/api";
import { DeskConfirmModal, DeskSuccessModal } from "./confirm-modal";

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
  // Same rule as the Stay step: corrections target real charge lines, not tax lines or
  // earlier corrections (the backend rejects those too — this just keeps the picker clean).
  const correctable = folioLines.filter(
    (l) => !l.description.toLowerCase().startsWith("sales tax") && !l.description.toLowerCase().startsWith("correction for"),
  );
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
  // Final-morning charges belong to the checkout day, not "today" — the checkout day is never a
  // stay night, so it's never sealed by night audit (SIG-S8 §2.2). Using today collides with the
  // just-audited final stay night when checkout happens on/near it (e.g. a compressed test stay).
  const checkoutChargeDate = entry.reservation?.frozenCheckOutDate ?? entry.checkOutDate ?? null;
  const checkoutChargeYmd = checkoutChargeDate ? checkoutChargeDate.slice(0, 10) : null;

  // Per-room folio breakdown (2026-08-14): roomId → room number for the correction picker's
  // labels, and the SERVER-summed per-room subtotals for the bill review — same billing-summary
  // query the workspace header and the Stay step share; the desk never adds lines up itself.
  const roomNumberById = useMemo(
    () => new Map((entry.roomAssignments ?? []).map((a) => [a.roomId, a.room?.roomNumber ?? a.roomId.slice(0, 6)])),
    [entry.roomAssignments],
  );
  const billingQuery = useQuery({
    queryKey: ["billing-summary", entry.id, entry.updatedAt],
    queryFn: () => getBillingSummary(session!, entry.id),
    enabled: !!session && !!entry.folio?.id,
    refetchInterval: 30_000,
  });
  const perRoomCharges = billingQuery.data?.folio?.perRoomCharges ?? null;
  const unassignedCharges = billingQuery.data?.folio?.unassignedCharges ?? null;

  const [keysReturned, setKeysReturned] = useState(String(keysIssued || 1));
  const [keyReconcileNote, setKeyReconcileNote] = useState("");
  // Room-wise key return (2026-08-17, operator request — mirrors the S6 per-room radios):
  // one row per room whose key has a story, marked as each physical key lands on the desk.
  const [returnedKeyRooms, setReturnedKeyRooms] = useState<Record<string, boolean>>({});
  const keyRoomPlan = useMemo(() => {
    const byRoom = new Map<string, NonNullable<EntryDetail["roomAssignments"]>>();
    for (const a of entry.roomAssignments ?? []) byRoom.set(a.roomId, [...(byRoom.get(a.roomId) ?? []), a]);
    return Array.from(byRoom.entries())
      .map(([roomId, rs]) => ({
        roomId,
        roomNumber: rs[0].room?.roomNumber ?? roomId.slice(0, 6),
        outstanding: rs.some((r) => r.keyIssuedAt && !r.keyReturnedAt),
        // Came back mid-stay (room-change key swap) — nothing left to collect here.
        returnedEarlier: rs.some((r) => r.keyReturnedAt) && !rs.some((r) => r.keyIssuedAt && !r.keyReturnedAt),
      }))
      .filter((k) => k.outstanding || k.returnedEarlier)
      .sort((a, b) => a.roomNumber.localeCompare(b.roomNumber, undefined, { numeric: true }));
  }, [entry.roomAssignments]);
  // Room-wise mode whenever per-room stamps exist; legacy count-only input otherwise.
  const keyRoomsOutstanding = keyRoomPlan.filter((k) => k.outstanding);
  const keyRoomWise = keyRoomPlan.length > 0;
  const markedKeyRooms = keyRoomsOutstanding.filter((k) => returnedKeyRooms[k.roomId]);
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
  // Pre-fill the settlement amount with the FULL balance (2026-08-17, operator request) —
  // the common case is paying everything, so the figure is ready; editing it down makes the
  // settlement partial. Same touched-latch pattern as the S3 advance prefill: the ref flips
  // on the first keystroke so a refetch never overwrites a deliberately different figure.
  const partialTouched = useRef(false);
  useEffect(() => {
    if (partialTouched.current) return;
    const n = Number(balance);
    if (balance != null && Number.isFinite(n) && n > 0) setPartialAmount(String(balance));
  }, [balance]);
  const [fomAckRef, setFomAckRef] = useState("");
  const [finalChargeDesc, setFinalChargeDesc] = useState("");
  const [finalChargeAmount, setFinalChargeAmount] = useState("");
  // Per-room folio attribution (2026-08-14): which room the last-minute charge belongs to.
  // "" = the whole booking. Applies to the charge and the credit note alike.
  const [finalChargeRoomId, setFinalChargeRoomId] = useState("");
  // Posted-charge receipt (2026-08-17): same dialog + "Posted ✓" flash as the Stay step.
  const [postedInfo, setPostedInfo] = useState<null | {
    description: string;
    amount: string | number;
    currency?: string;
    lineType: string;
    roomNumber: string | null;
  }>(null);
  const [postedFlash, setPostedFlash] = useState(false);
  // Same charge toolkit as the Stay step (2026-08-03, operator request): type select, credit
  // note, and corrections — the backend posts at S7 OR S8 pre-settlement (SIG-S8 §2.2).
  const [finalChargeType, setFinalChargeType] = useState("F_AND_B");
  const [correctLineId, setCorrectLineId] = useState("");
  const [correctMode, setCorrectMode] = useState<"adjust" | "setNet">("adjust");
  const [correctDelta, setCorrectDelta] = useState("");
  const [correctToAmount, setCorrectToAmount] = useState("");
  const [correctReason, setCorrectReason] = useState("");
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

  const finalChargeM = useMutation({
    mutationFn: () => {
      const amt = Number.parseFloat(finalChargeAmount);
      if (!folio?.id || !Number.isFinite(amt)) throw new Error("Valid amount required");
      return postFolioCharge(session!, folio.id, {
        entryId: entry.id,
        lineType: finalChargeType,
        description: finalChargeDesc.trim() || "Final morning charge",
        amount: amt,
        chargeDate: checkoutChargeDate ?? new Date().toISOString(),
        roomId: finalChargeRoomId || undefined,
      });
    },
    // Posted-charge receipt (2026-08-17): dialog with the posted facts, inputs cleared for
    // the next charge, button flashing "Posted ✓" while the dialog is up.
    onSuccess: (line) => {
      invalidate();
      setPostedInfo({
        description: line.description,
        amount: line.amount,
        currency: line.currency,
        lineType: line.lineType,
        roomNumber: line.roomId ? roomNumberById.get(line.roomId) ?? null : null,
      });
      setFinalChargeDesc("");
      setFinalChargeAmount("");
      setPostedFlash(true);
      window.setTimeout(() => setPostedFlash(false), 1800);
    },
    onError: (e: unknown) => toast.error(e instanceof ApiError ? e.message : "Couldn't post the charge"),
  });
  const creditNoteM = useMutation(
    wrap(() => {
      const amt = Number.parseFloat(finalChargeAmount);
      if (!folio?.id || !Number.isFinite(amt) || amt <= 0) throw new Error("Valid amount required");
      // Dated to the checkout day like the charges — "today" can collide with the just-audited
      // final stay night (see checkoutChargeDate above).
      return postCreditNote(session!, folio.id, {
        entryId: entry.id,
        description: finalChargeDesc.trim() || "Credit note",
        amount: amt,
        creditDate: checkoutChargeDate ?? new Date().toISOString(),
        roomId: finalChargeRoomId || undefined,
      });
    }, "Credit note posted"),
  );
  const correctM = useMutation(
    wrap(() => {
      if (!folio?.id || !correctLineId) throw new Error("Select a line to correct");
      const body: Parameters<typeof correctFolioCharge>[2] = {
        entryId: entry.id,
        originalFolioLineId: correctLineId,
        reason: correctReason.trim(),
        correctionDate: checkoutChargeDate ?? new Date().toISOString(),
      };
      if (correctMode === "setNet") {
        const net = Number.parseFloat(correctToAmount);
        if (!Number.isFinite(net)) throw new Error("Enter the net amount to set the line to");
        body.correctToAmount = net;
      } else {
        const v = Number.parseFloat(correctDelta);
        if (!Number.isFinite(v) || v === 0) throw new Error("Enter a non-zero adjustment");
        body.correctionAmount = v;
      }
      return correctFolioCharge(session!, folio.id, body);
    }, "Correction posted"),
  );
  const keyReturnM = useMutation(
    wrap(() => {
      if (keyRoomWise) {
        // Room-wise ceremony: count = rooms marked; short of the outstanding set needs the
        // reconciliation note (the backend enforces it against the same outstanding count).
        const marked = markedKeyRooms.map((k) => k.roomId);
        const body: { keyCountReturned: number; reconciliationNote?: string; returnedRoomIds?: string[] } = {
          keyCountReturned: marked.length,
          ...(marked.length > 0 ? { returnedRoomIds: marked } : {}),
        };
        if (marked.length !== keyRoomsOutstanding.length) body.reconciliationNote = keyReconcileNote.trim();
        return recordKeyReturn(session!, entry.id, body);
      }
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
  // S8 → S2 rate dispute: re-open to Negotiation for a full renegotiation. Seals the current segment
  // and starts a new one at S2; the live folio persists. Backend requires L2+ + a reason (SIG-S8 §1.2).
  const reEntryS2M = useMutation({
    mutationFn: () => reEnterS8ToS2(session!, entry.id, entry.version, reEntryS2Reason.trim()),
    onSuccess: () => {
      toast.success("Re-opened to Negotiation for renegotiation");
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
        {/* Advance plan telltale (2026-08-07): a guest who said "I'll pay the rest at check-out"
            arrives at this desk with the advance legitimately short — say so, name the figure,
            and point at the settlement below. All figures from payment-status. */}
        {paymentStatus.data?.paymentPlan && paymentStatus.data.paidInFull === false && (
          <div className="fact b-transit" style={{ padding: "7px 11px", fontSize: 12.5, width: "100%", marginBottom: 9, display: "block", lineHeight: 1.55 }}>
            The guest&rsquo;s advance plan was{" "}
            <b>
              {paymentStatus.data.paymentPlan.plan === "INSTALLMENTS"
                ? "installments"
                : paymentStatus.data.paymentPlan.plan === "FULL"
                  ? "the full amount" // FULL carries timing since 2026-08-19 — it can arrive here unpaid
                  : "part now, rest later"}
            </b>
            {paymentStatus.data.paymentPlan.balanceDueAt === "AT_CHECKOUT"
              ? " with the remainder due at check-out — this is where it gets collected. "
              : paymentStatus.data.paymentPlan.balanceDueAt === "AT_CHECKIN"
                ? " with the remainder due at check-in, and it is still short. "
                : " and the remainder is still short. "}
            The advance is short <b>{money(paymentStatus.data.shortfall, currency)}</b>; the unpaid part is inside the
            balance below — settlement collects it with the rest of the bill.
          </div>
        )}
        <div className="field">
          <label>Advance / payments received</label>
          <div className="val">{moneyOrDash(fin.advanceReceived, currency)}</div>
        </div>
        {/* Per-room charge subtotals (2026-08-14) — SERVER-summed billing-summary buckets, so
            the checkout review can answer "what did each room spend" before settlement. */}
        {perRoomCharges && perRoomCharges.length > 0 && (
          <div className="field">
            <label>Charges by room</label>
            <div style={{ display: "grid", gap: 4 }}>
              {perRoomCharges.map((r) => (
                <div key={r.roomId} style={{ display: "flex", justifyContent: "space-between", fontSize: 12.5 }}>
                  <span>
                    Room {r.roomNumber ?? "?"}{" "}
                    <span style={{ color: "var(--ink-3)" }}>
                      · {r.lineCount} line{r.lineCount === 1 ? "" : "s"}
                    </span>
                  </span>
                  <span style={{ fontWeight: 600 }}>{money(r.charges, currency)}</span>
                </div>
              ))}
              {unassignedCharges && (
                <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12.5 }}>
                  <span>
                    Whole booking (no room named){" "}
                    <span style={{ color: "var(--ink-3)" }}>
                      · {unassignedCharges.lineCount} line{unassignedCharges.lineCount === 1 ? "" : "s"}
                    </span>
                  </span>
                  <span style={{ fontWeight: 600 }}>{money(unassignedCharges.charges, currency)}</span>
                </div>
              )}
            </div>
          </div>
        )}
        <div className="field">
          <label>Balance due</label>
          <div className="val">{moneyOrDash(balance, currency)}</div>
        </div>
        {folioLive && (
          <div style={{ marginTop: 6, borderTop: "1px dashed var(--line-2)", paddingTop: 11 }}>
            {/* Full charge toolkit, same as the Stay step (2026-08-03): the backend posts at
                S7 OR S8 pre-settlement (SIG-S8 §2.2), so last-minute minibar/breakfast items,
                credit notes and corrections all work right here until the folio settles.
                Everything is dated to the checkout day — "today" can collide with the
                just-audited final stay night. */}
            <div style={{ fontSize: 11, fontWeight: 600, color: "var(--ink-3)", marginBottom: 7 }}>
              Post a charge{checkoutChargeYmd ? ` · dated checkout day ${checkoutChargeYmd}` : ""}
            </div>
            <div className="frow">
              <div className="field">
                <label>Type</label>
                <select value={finalChargeType} onChange={(e) => setFinalChargeType(e.target.value)}>
                  <option value="F_AND_B">F &amp; B</option>
                  <option value="SERVICE">Service</option>
                  <option value="OTHER">Other</option>
                </select>
              </div>
              <div className="field">
                <label>For room</label>
                {/* Per-room folio attribution (2026-08-14) — same as the Stay step's form. */}
                <select value={finalChargeRoomId} onChange={(e) => setFinalChargeRoomId(e.target.value)}>
                  <option value="">Whole booking</option>
                  {Array.from(new Map((entry.roomAssignments ?? []).map((a) => [a.roomId, a])).values()).map((a) => (
                    <option key={a.roomId} value={a.roomId}>
                      Room {a.room?.roomNumber ?? a.roomId.slice(0, 6)}
                    </option>
                  ))}
                </select>
              </div>
              <div className="field">
                <label>Amount</label>
                <input type="number" min={0} step="0.01" value={finalChargeAmount} onChange={(e) => setFinalChargeAmount(e.target.value)} />
              </div>
            </div>
            <div className="field">
              <label>Description</label>
              <input value={finalChargeDesc} onChange={(e) => setFinalChargeDesc(e.target.value)} />
            </div>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <button
                className={`btn btn-primary btn-sm${postedFlash ? " is-done" : ""}`}
                disabled={finalChargeM.isPending || postedFlash}
                onClick={() => finalChargeM.mutate()}
              >
                {postedFlash ? "Posted ✓" : "Post a charge"}
              </button>
              {elevated && (
                <button className="btn btn-ghost btn-sm" disabled={creditNoteM.isPending} onClick={() => creditNoteM.mutate()}>
                  Post credit note (L2+)
                </button>
              )}
            </div>

            {correctable.length > 0 && (
              <div style={{ marginTop: 12, borderTop: "1px dashed var(--line-2)", paddingTop: 11 }}>
                <div style={{ fontSize: 11, fontWeight: 600, color: "var(--ink-3)", marginBottom: 4 }}>Correct a charge</div>
                <p style={{ fontSize: 11.5, color: "var(--ink-2)", margin: "0 0 9px", lineHeight: 1.55 }}>
                  The folio stays append-only — correcting adds an offsetting line next to the
                  original, so the bill shows both the mistake and the fix.
                </p>
                <div className="field">
                  <label>Which posted charge is wrong?</label>
                  <select value={correctLineId} onChange={(e) => setCorrectLineId(e.target.value)}>
                    <option value="">Choose a charge from the folio…</option>
                    {correctable.map((l) => (
                      <option key={l.id} value={l.id}>
                        {l.roomId ? `[Room ${roomNumberById.get(l.roomId) ?? "?"}] ` : ""}
                        {l.lineType} — {l.description} ({String(l.amount)})
                      </option>
                    ))}
                  </select>
                </div>
                <div className="field">
                  <label>Mode</label>
                  <div style={{ display: "flex", gap: 14, fontSize: 12.5 }}>
                    <label className="checkline" style={{ cursor: "pointer" }}>
                      <input type="radio" name="checkoutCorrectMode" checked={correctMode === "adjust"} onChange={() => setCorrectMode("adjust")} />
                      <span>Adjust by ±</span>
                    </label>
                    <label className="checkline" style={{ cursor: "pointer" }}>
                      <input type="radio" name="checkoutCorrectMode" checked={correctMode === "setNet"} onChange={() => setCorrectMode("setNet")} />
                      <span>Set net to</span>
                    </label>
                  </div>
                </div>
                <div className="frow">
                  {correctMode === "adjust" ? (
                    <div className="field">
                      <label>Adjustment (±)</label>
                      <input type="number" step="0.01" value={correctDelta} onChange={(e) => setCorrectDelta(e.target.value)} />
                    </div>
                  ) : (
                    <div className="field">
                      <label>Net amount to set</label>
                      <input type="number" min={0} step="0.01" value={correctToAmount} onChange={(e) => setCorrectToAmount(e.target.value)} />
                    </div>
                  )}
                  <div className="field">
                    <label>Reason</label>
                    <input value={correctReason} onChange={(e) => setCorrectReason(e.target.value)} />
                  </div>
                </div>
                <button
                  className="btn btn-ghost btn-sm"
                  disabled={correctM.isPending || !correctLineId || !correctReason.trim()}
                  onClick={() => correctM.mutate()}
                >
                  Post correction
                </button>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Bills for check-out (2026-08-22): the master bill (signed here; frozen at the seal)
          and the tax invoice (a draft until settlement issues the one original). The issue /
          dispatch controls live on the tax-invoice row, not under Settlement. */}
      <FolioDocumentsBlock entry={entry} stage="S8" />

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
        ) : keyRoomWise ? (
          <>
            {/* Room-wise return (2026-08-17, operator request): mark each room's key as it
                lands on the desk — same shape as the S6 issue radios. Keys already swapped
                back mid-stay show as done; the ceremony records the rest. */}
            <div style={{ display: "grid", gap: 6, marginBottom: 9 }}>
              {keyRoomPlan.map((k) => (
                <div
                  key={k.roomId}
                  className="fact b-bound"
                  style={{ padding: "8px 12px", fontSize: 12.5, width: "100%", justifyContent: "space-between" }}
                >
                  <span>Room {k.roomNumber}</span>
                  {k.outstanding ? (
                    <label
                      style={{ display: "inline-flex", alignItems: "center", gap: 6, cursor: "pointer", fontSize: 12, fontWeight: 600 }}
                      title={`Mark when room ${k.roomNumber}'s key is back on the desk`}
                    >
                      <input
                        type="radio"
                        checked={!!returnedKeyRooms[k.roomId]}
                        onClick={() => setReturnedKeyRooms((prev) => ({ ...prev, [k.roomId]: !prev[k.roomId] }))}
                        readOnly
                        style={{ cursor: "pointer" }}
                      />
                      Key returned
                    </label>
                  ) : (
                    <span
                      className="tag"
                      style={{ color: "var(--green-d)", borderColor: "var(--green-d)", background: "var(--green-t, transparent)" }}
                    >
                      Returned earlier
                    </span>
                  )}
                </div>
              ))}
            </div>
            <p style={{ fontSize: 12, color: "var(--ink-3)", marginTop: 0 }}>
              {markedKeyRooms.length} of {keyRoomsOutstanding.length} key{keyRoomsOutstanding.length === 1 ? "" : "s"} back
            </p>
            {markedKeyRooms.length !== keyRoomsOutstanding.length && (
              <div className="field">
                <label>Reconciliation note (a key is missing)</label>
                <input value={keyReconcileNote} onChange={(e) => setKeyReconcileNote(e.target.value)} />
              </div>
            )}
            <button className="btn btn-ghost" disabled={keyReturnM.isPending} onClick={() => keyReturnM.mutate()}>
              Record key return
            </button>
          </>
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
            <p style={{ fontSize: 11.5, color: "var(--ink-3)", margin: 0, lineHeight: 1.55 }}>
              The folio is sealed. Issue and send the <b>tax invoice</b>, and print the frozen <b>master bill</b>, under
              Bills for check-out above.
            </p>
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
                {/* The figure is what the guest PAYS NOW (2026-08-17, operator asked which way
                    it reads) — the backend caps it at the balance and the remainder stays
                    outstanding for post-stay collection at S9. Empty = full balance. */}
                <label>Amount paid now</label>
                <input
                  type="number"
                  value={partialAmount}
                  onChange={(e) => {
                    partialTouched.current = true;
                    setPartialAmount(e.target.value);
                  }}
                  placeholder="Empty = full balance · rest stays outstanding"
                />
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
            Re-open the booking to Negotiation for a full rate renegotiation. Seals this segment and starts a
            fresh one at Negotiation; the live folio carries over. Requires FOM (L2)+.
          </p>
          <div className="frow">
            <div className="field">
              <label>Reason to re-open Negotiation</label>
              <input
                value={reEntryS2Reason}
                onChange={(e) => setReEntryS2Reason(e.target.value)}
                placeholder="e.g. guest disputes the rate charged"
              />
            </div>
            <div className="field" style={{ alignSelf: "end" }}>
              <button className="btn btn-ghost" disabled={reEntryS2M.isPending || !reEntryS2Reason.trim()} onClick={() => reEntryS2M.mutate()}>
                Re-open to Negotiation
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

      {/* Posted-charge receipt (2026-08-17): what just landed on the bill, and for whom. */}
      <DeskSuccessModal
        open={!!postedInfo}
        title="Charge posted"
        subtitle={entry.id}
        lines={
          postedInfo
            ? [
                <>
                  <b>{money(postedInfo.amount, postedInfo.currency)}</b> — {postedInfo.description}
                </>,
                <>
                  {postedInfo.lineType === "F_AND_B" ? "F & B" : postedInfo.lineType} ·{" "}
                  {postedInfo.roomNumber ? `for Room ${postedInfo.roomNumber}` : "for the whole booking"}
                </>,
                "Service charge and GST companion lines post automatically alongside.",
              ]
            : []
        }
        onClose={() => setPostedInfo(null)}
      />

      <DeskConfirmModal
        open={settleOpen}
        title="Take payment & settle?"
        subtitle={`${entry.id} · balance ${money(balance, currency)}`}
        why="Taking payment commits a resource you can't reclaim:"
        consequences={[
          <>
            {/* Partial wording only when the typed figure is genuinely SHORT of the balance —
                a comparison against the server's figure, no derived money shown. */}
            {partialAmount && Number.parseFloat(partialAmount) < Number(balance ?? 0) ? (
              <>
                The guest pays <b>{money(Number.parseFloat(partialAmount), currency)}</b> now — the rest of the{" "}
                {money(balance, currency)} balance stays outstanding, collected post-stay.
              </>
            ) : (
              <>
                The balance of <b>{money(balance, currency)}</b> is processed for payment in full.
              </>
            )}
          </>,
          "The folio closes — no further charges can be posted.",
          "The room releases to housekeeping for turnover.",
        ]}
        confirmLabel="Take payment"
        pending={settleM.isPending}
        onConfirm={() => settleM.mutate()}
        onClose={() => setSettleOpen(false)}
      />
    </div>
  );
}
