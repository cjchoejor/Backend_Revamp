"use client";

import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Banknote, Check, Eye, EyeOff, FileCheck, Lock, RefreshCw, Shield } from "lucide-react";
import { toast } from "sonner";
import { useSession } from "@/hooks/use-session";
import { ApiError } from "@/lib/api/client";
import {
  approveFocGm,
  cancelEntryAtS3,
  confirmCoordinator,
  dispatchInvoice,
  ensureProvisionalFolio,
  getPaymentStatus,
  initiateS3ReEntryToS1,
  initiateS3ReEntryToS2,
  placeCommittedHold,
  recordCancellationDisclosure,
  recordCreditExtension,
  recordFolioPayment,
  reconcileAdvancePayment,
  schedulePaymentMilestones,
  setAdvanceRequirement,
} from "@/lib/api/reservation-setup";
import { money } from "@/lib/desk/workspace";
import { openInvoicePdf } from "@/lib/api/documents";
import { PdfButton } from "./pdf-button";
import { BackendRail, type RailGroup } from "./backend-inline";
import { STAGE_ACTIONS } from "@/lib/desk/backend-actions";
import type { EntryDetail } from "@/types/api";
import { optionSelectedRoomIds } from "@/types/api";
import { DeskConfirmModal } from "./confirm-modal";
import { CommunicationAcceptanceBlock } from "./communication-acceptance";
import { ProformaPreview } from "./quotation-preview";

const BK = STAGE_ACTIONS.S3;

const BILLING_MODELS = ["GUEST_PAY", "DIRECT_BILL", "TOUR_OPERATOR_VOUCHER"] as const;
const BILLING_LABEL: Record<string, string> = {
  GUEST_PAY: "Guest pays",
  DIRECT_BILL: "Direct bill",
  TOUR_OPERATOR_VOUCHER: "Tour-operator voucher",
};

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

export function SetupStep({ entry, setSelected }: { entry: EntryDetail; setSelected: (n: number) => void }) {
  const { session } = useSession();
  const router = useRouter();
  const queryClient = useQueryClient();

  const folio = entry.folio ?? null;
  const rawHold = entry.committedHold ?? null;
  const hold = rawHold && rawHold.state !== "RELEASED" && rawHold.state !== "EXPIRED" ? rawHold : null;
  const disclosure = entry.cancellationDisclosure ?? null;
  const acceptedQuotation = useMemo(
    () => (entry.quotations ?? []).find((q) => q.state === "ACCEPTED"),
    [entry.quotations],
  );
  const sealedPreferred = (entry.availabilityConfigs ?? []).find((c) => c.sealedAt && c.optionSelected);
  const preferredRoomId = optionSelectedRoomIds(sealedPreferred?.optionSelected)[0] ?? null;
  const proformaInvoices = (folio?.invoices ?? []).filter((i) => i.invoiceType === "PROFORMA");
  // Segment labeling for the proforma list (2026-08-01, operator request): after a re-entry the
  // prior segment's proforma stays listed next to the new one, labeled so old vs current is
  // unambiguous. Invoices carry no segmentId, so each is attributed to the segment whose
  // [startedAt, sealedAt) window contains its creation — the same time-windowing the
  // segment-history service uses server-side.
  const segments = entry.segments ?? [];
  const currentSegmentNo = segments[0]?.segmentNumber ?? null;
  const multiSegment = segments.length > 1;
  const segmentNoForDate = (iso: string): number | null => {
    const t = new Date(iso).getTime();
    if (!Number.isFinite(t)) return null;
    const seg = segments.find((s) => {
      const start = s.startedAt ? new Date(s.startedAt).getTime() : Number.NEGATIVE_INFINITY;
      const end = s.sealedAt ? new Date(s.sealedAt).getTime() : Number.POSITIVE_INFINITY;
      return t >= start && t < end;
    });
    return seg?.segmentNumber ?? null;
  };
  // Operator language mirror of the S2 quote tags: a created proforma IS ready to go — "DRAFT"
  // is backend state, not desk vocabulary.
  // Mirrors the backend's `enforceProformaDispatchedBeforeAdvancePayment` (2026-08-01): the
  // bill goes out first, then the money comes in — the payment form stays locked until then.
  const proformaDispatchedNow = proformaInvoices.some((i) => i.state !== "SUPERSEDED" && i.dispatchedAt != null);
  const invoiceStateLabel = (inv: { state: string; dispatchedAt?: string | null }): string =>
    inv.dispatchedAt
      ? "Dispatched"
      : inv.state === "DRAFT"
        ? "Ready to send"
        : inv.state.charAt(0) + inv.state.slice(1).toLowerCase();
  const inPayments = (folio?.payments ?? []).filter((p) => /IN/i.test(p.paymentDirection ?? "") && !/OUT|REFUND/i.test(p.paymentDirection ?? ""));
  const isGroupLike = entry.useType === "GROUP" || entry.useType === "CONFERENCE";
  const needsMilestones = entry.useType === "CORPORATE" || entry.useType === "CONFERENCE";

  const [billingModel, setBillingModel] = useState(folio?.billingModel ?? "GUEST_PAY");
  // Billing-model section collapses to a settled "Updated ✓ / Change" row once a model is on
  // the folio (same pattern as the disclosure block below). The form shows only on first
  // setup or after the operator clicks Change.
  const [editingBilling, setEditingBilling] = useState(false);
  const [noShowStatement, setNoShowStatement] = useState(
    disclosure?.noShowTreatmentStatement ?? "No-show: one night room charge plus applicable taxes.",
  );
  const [paymentAmount, setPaymentAmount] = useState("");
  const [paymentNotes, setPaymentNotes] = useState("");
  const [reconcileNote, setReconcileNote] = useState("");
  // Advance requirement (2026-08-01): the desk pins how much the guest must pay — a flat
  // amount, or a percentage the BACKEND converts against the quote total (no money math here).
  const [advReqMode, setAdvReqMode] = useState<"AMOUNT" | "PERCENT">("AMOUNT");
  const [advReqValue, setAdvReqValue] = useState("");
  const [creditCeiling, setCreditCeiling] = useState("");
  const [creditReason, setCreditReason] = useState("");
  // Optional time limit on the credit extension — hours until it stops satisfying the condition.
  const [creditHours, setCreditHours] = useState("");
  // Which proforma's inline document preview is open (one at a time).
  const [proformaPreviewId, setProformaPreviewId] = useState<string | null>(null);
  const [holdJustification, setHoldJustification] = useState("Reservation setup — committed inventory hold");
  // Guest email for the proforma dispatch. Same robust auto-pull as the S2 send field — resolve
  // across the profile chain and fill via an effect so a late-loading profile still populates it.
  const guestEmail = entry.guestProfile?.email ?? entry.inquiry?.guestProfile?.email ?? "";
  const [dispatchTo, setDispatchTo] = useState(guestEmail);
  useEffect(() => {
    if (guestEmail) setDispatchTo((prev) => prev || guestEmail);
  }, [guestEmail]);
  const [coordinatorName, setCoordinatorName] = useState("");
  const [coordinatorScope, setCoordinatorScope] = useState("");
  const [milestoneTemplate, setMilestoneTemplate] = useState("DEFAULT");
  const [reEntryReason, setReEntryReason] = useState("");
  const [cancelReason, setCancelReason] = useState("");
  const [cancelOpen, setCancelOpen] = useState(false);

  const elevated = isElevated(session?.actorLevel);
  const gm = isGm(session?.actorLevel);

  const paymentStatusQuery = useQuery({
    queryKey: ["payment-status", entry.id],
    queryFn: () => getPaymentStatus(session!, entry.id),
    enabled: !!session && !!folio?.id,
  });
  const paymentStatus = paymentStatusQuery.data;

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ["entry", entry.id] });
    void queryClient.invalidateQueries({ queryKey: ["payment-status", entry.id] });
    void queryClient.invalidateQueries({ queryKey: ["entry-trace", entry.id] });
    void queryClient.invalidateQueries({ queryKey: ["entry-timers", entry.id] });
    // The inline proforma preview recomposes from the folio's current payments + advance
    // requirement — logging a payment or changing the requirement changes the document.
    void queryClient.invalidateQueries({ queryKey: ["invoice-preview"] });
  };
  const wrap = <T,>(fn: () => Promise<T>, msg: string) => ({
    mutationFn: fn,
    onSuccess: () => {
      toast.success(msg);
      invalidate();
    },
    onError: (e: unknown) => toast.error(e instanceof ApiError ? e.message : "Action failed"),
  });

  const folioM = useMutation(
    wrap(() => ensureProvisionalFolio(session!, entry.id, { billingModel }), folio?.billingModel ? "Billing model updated" : "Provisional folio created"),
  );
  const disclosureM = useMutation(
    wrap(
      () => recordCancellationDisclosure(session!, entry.id, { noShowTreatmentStatement: noShowStatement.trim(), disclosedTerms: { tier: "DEFAULT" } }),
      "Cancellation terms recorded",
    ),
  );
  const paymentM = useMutation({
    mutationFn: () => {
      if (!folio) throw new Error("Create the folio first");
      return recordFolioPayment(session!, folio.id, { entryId: entry.id, amount: Number(paymentAmount), notes: paymentNotes.trim() || undefined });
    },
    onSuccess: () => {
      toast.success("Advance payment recorded");
      setPaymentAmount("");
      setPaymentNotes("");
      invalidate();
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : "Action failed"),
  });
  const reconcileM = useMutation(
    wrap(() => {
      if (!folio) throw new Error("Create the folio first");
      return reconcileAdvancePayment(session!, folio.id, { entryId: entry.id, note: reconcileNote.trim() || undefined });
    }, "Advance reconciled"),
  );
  const creditM = useMutation(
    wrap(
      () =>
        recordCreditExtension(session!, entry.id, {
          ceilingAmount: Number(creditCeiling),
          reason: creditReason.trim(),
          validForHours: creditHours.trim() !== "" ? Number(creditHours) : null,
        }),
      "Credit extension approved",
    ),
  );
  const advReqM = useMutation({
    mutationFn: () => {
      if (!folio) throw new Error("Create the folio first");
      const n = Number(advReqValue);
      if (!Number.isFinite(n) || n <= 0) throw new Error("Enter a positive value");
      return setAdvanceRequirement(
        session!,
        entry.id,
        advReqMode === "AMOUNT" ? { mode: "AMOUNT", amount: n } : { mode: "PERCENT", percent: n },
      );
    },
    onSuccess: (status) => {
      toast.success(`Advance requirement set — ${money(status.requiredAmount)}`);
      setAdvReqValue("");
      invalidate();
    },
    onError: (e: unknown) => toast.error(e instanceof ApiError ? e.message : e instanceof Error ? e.message : "Action failed"),
  });
  const advReqClearM = useMutation(
    wrap(() => setAdvanceRequirement(session!, entry.id, { mode: "CLEAR" }), "Requirement cleared — hotel default applies"),
  );
  const holdM = useMutation(
    wrap(() => {
      if (!preferredRoomId) throw new Error("No preferred room from Inquiry");
      return placeCommittedHold(session!, entry.id, { roomId: preferredRoomId, commercialJustification: holdJustification.trim() });
    }, "Committed hold placed"),
  );
  const dispatchM = useMutation(
    wrap(() => {
      const inv = proformaInvoices.find((i) => i.state === "DRAFT") ?? proformaInvoices[0];
      if (!inv) throw new Error("No proforma invoice");
      return dispatchInvoice(session!, inv.id, { dispatchedTo: dispatchTo.trim() || undefined });
    }, "Proforma invoice dispatched"),
  );
  const coordinatorM = useMutation(
    wrap(() => confirmCoordinator(session!, entry.id, { coordinatorName: coordinatorName.trim(), authorityScope: coordinatorScope.trim() }), "Coordinator confirmed"),
  );
  const milestonesM = useMutation(
    wrap(() => schedulePaymentMilestones(session!, entry.id, { templateKey: milestoneTemplate.trim() }), "Payment milestones scheduled"),
  );
  const focGmM = useMutation(wrap(() => approveFocGm(session!, entry.id, {}), "FOC GM approval recorded"));

  const reEntryS2M = useMutation({
    mutationFn: () => initiateS3ReEntryToS2(session!, entry.id, { reason: reEntryReason.trim() || undefined }),
    onSuccess: () => {
      toast.success("Re-opened for renegotiation (Negotiation)");
      invalidate();
      setSelected(2);
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : "Re-entry failed"),
  });
  const reEntryS1M = useMutation({
    mutationFn: () => initiateS3ReEntryToS1(session!, entry.id, { reason: reEntryReason.trim() || undefined }),
    onSuccess: () => {
      toast.success("Re-opened for reconfiguration (Inquiry)");
      invalidate();
      setSelected(1);
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : "Re-entry failed"),
  });
  const cancelM = useMutation({
    mutationFn: () => cancelEntryAtS3(session!, entry.id, { reason: cancelReason.trim() || undefined }),
    onSuccess: () => {
      setCancelOpen(false);
      toast.success("Booking cancelled — hold released, timers cancelled");
      invalidate();
      router.push("/desk/bookings");
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : "Cancellation failed"),
  });

  // Persistent highlight: each group stays lit once its action has run for this booking (derived
  // from real folio / hold / invoice state). `firingKey` adds the transient "running now" pulse.
  const activeKeys = [
    folio ? "folio" : null,
    disclosure ? "disclosure" : null,
    inPayments.length > 0 || folio?.advancePaymentReconciliationComplete ? "advance" : null,
    rawHold ? "hold" : null,
    proformaInvoices.some((i) => i.dispatchedAt != null) ? "dispatch" : null,
  ].filter(Boolean) as string[];
  const firingKey = folioM.isPending
    ? "folio"
    : disclosureM.isPending
      ? "disclosure"
      : paymentM.isPending || reconcileM.isPending || creditM.isPending
        ? "advance"
        : holdM.isPending
          ? "hold"
          : dispatchM.isPending
            ? "dispatch"
            : coordinatorM.isPending || milestonesM.isPending || focGmM.isPending
              ? "group"
              : reEntryS1M.isPending || reEntryS2M.isPending
                ? "reentry"
                : cancelM.isPending
                  ? "cancel"
                  : null;
  const railGroups: RailGroup[] = [
    { key: "folio", label: "On creating the folio", items: BK.folio },
    { key: "disclosure", label: "On recording cancellation terms", items: BK.disclosure },
    { key: "advance", label: "On recording the advance", items: BK.advance },
    { key: "hold", label: "On placing the committed hold", items: BK.hold },
    { key: "dispatch", label: "On dispatching the proforma", items: BK.dispatch },
    { key: "group", label: "On group / corporate setup", items: BK.group },
    { key: "reentry", label: "On opening a new segment", items: BK.reentry },
    { key: "cancel", label: "On cancelling the booking", items: BK.cancel },
  ];

  return (
    <div className="bx-split">
      <div className="bx-main">
      <div className="speak">
        <div className="now">Do this next</div>
        <h2>Hold the rooms and set up the booking.</h2>
        <p>
          Lay the operational and financial foundation: a provisional folio, the cancellation terms, the
          advance, and a committed hold on the room. Nothing is frozen yet — that happens at Confirm.
        </p>
      </div>

      {/* 1. Provisional folio & billing model */}
      <div className="block">
        <BlockH>Provisional folio &amp; billing model</BlockH>
        {folio?.billingModel && !editingBilling ? (
          <div className="fact b-bound" style={{ padding: "9px 12px", fontSize: 12.5, alignItems: "center", gap: 8 }}>
            <Check style={{ width: 14, height: 14, color: "var(--green-d)", flex: "0 0 auto" }} />
            <span style={{ flex: "1 1 auto" }}>
              {BILLING_LABEL[folio.billingModel] ?? folio.billingModel} — <b>Updated</b>
              <span style={{ display: "block", color: "var(--ink-3)", fontSize: 11, marginTop: 2 }}>
                Folio {folio.state}
              </span>
            </span>
            <button
              className="btn btn-ghost btn-sm"
              onClick={() => {
                // Re-seed the select from the folio so Change always opens on the saved value,
                // not whatever the select held before a cancelled edit.
                setBillingModel(folio.billingModel ?? "GUEST_PAY");
                setEditingBilling(true);
              }}
            >
              Change
            </button>
          </div>
        ) : (
          <>
            {folio && (
              <div className="fact b-transit" style={{ marginBottom: 11, padding: "7px 11px", fontSize: 12.5 }}>
                Folio {folio.state}
                {folio.billingModel ? ` · currently ${BILLING_LABEL[folio.billingModel] ?? folio.billingModel}` : ""}
              </div>
            )}
            <div className="field">
              <label>Billing model</label>
              <select value={billingModel} onChange={(e) => setBillingModel(e.target.value)}>
                {BILLING_MODELS.map((m) => (
                  <option key={m} value={m}>
                    {BILLING_LABEL[m]}
                  </option>
                ))}
              </select>
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              <button
                className="btn btn-primary"
                disabled={folioM.isPending}
                onClick={() => folioM.mutate(undefined, { onSuccess: () => setEditingBilling(false) })}
              >
                {folioM.isPending ? "Saving…" : folio ? "Update billing model" : "Create provisional folio"}
              </button>
              {editingBilling && (
                <button className="btn btn-ghost" onClick={() => setEditingBilling(false)}>
                  Cancel
                </button>
              )}
            </div>
          </>
        )}
      </div>

      {/* 2. Cancellation disclosure */}
      <div className="block">
        <BlockH>Cancellation terms shown to guest</BlockH>
        {disclosure ? (
          <div className="fact b-bound" style={{ padding: "9px 12px", fontSize: 12.5, alignItems: "flex-start" }}>
            <Check style={{ width: 14, height: 14, color: "var(--green-d)", flex: "0 0 auto", marginTop: 2 }} />
            <span>
              {disclosure.noShowTreatmentStatement}
              <span style={{ display: "block", color: "var(--ink-3)", fontSize: 11, marginTop: 2 }}>
                Recorded {disclosure.disclosedAt.slice(0, 16).replace("T", " ")}
              </span>
            </span>
          </div>
        ) : (
          <>
            <div className="field">
              <label>No-show treatment statement</label>
              <input value={noShowStatement} onChange={(e) => setNoShowStatement(e.target.value)} />
            </div>
            <button className="btn btn-ghost" disabled={disclosureM.isPending || !noShowStatement.trim()} onClick={() => disclosureM.mutate()}>
              {disclosureM.isPending ? "Saving…" : "Record cancellation terms"}
            </button>
          </>
        )}
      </div>

      {/* 3. What the guest must pay — set FIRST: the proforma below prints exactly these
          figures as "Advance due now" / "Advance received" (2026-08-01, operator ordering:
          requirement → proforma → money received). */}
      <div className="block">
        <BlockH>
          <Banknote style={{ width: 13, height: 13 }} />
          What the guest must pay
        </BlockH>
        {paymentStatus && (
          <div className="fact b-transit" style={{ marginBottom: 6, padding: "7px 11px", fontSize: 12.5, width: "100%", justifyContent: "space-between" }}>
            <span>
              Received {money(paymentStatus.totalReceived, folio?.lines?.[0]?.currency)} / required{" "}
              {money(paymentStatus.requiredAmount, folio?.lines?.[0]?.currency)}
            </span>
            <span className={`tag ${paymentStatus.satisfied ? "" : "warn"}`}>
              {paymentStatus.satisfied ? "Satisfied" : `Short ${money(paymentStatus.shortfall)}`}
            </span>
          </div>
        )}
        {paymentStatus && (
          <p style={{ fontSize: 11, color: "var(--ink-3)", margin: "0 0 11px" }}>
            {paymentStatus.requirementSource === "OPERATOR"
              ? paymentStatus.requirementBasis?.mode === "PERCENT"
                ? `Requirement set at the desk — ${paymentStatus.requirementBasis.percent}% of the quote total (${money(paymentStatus.requirementBasis.baseTotal ?? null)})`
                : "Requirement set at the desk — flat amount"
              : "Requirement from the hotel's default thresholds — set a booking-specific one here"}
            {paymentStatus.creditExtensionActive && paymentStatus.creditExtensionExpiresAt
              ? ` · credit extension active until ${paymentStatus.creditExtensionExpiresAt.slice(0, 16).replace("T", " ")}`
              : paymentStatus.creditExtensionActive
                ? " · credit extension active (no time limit)"
                : paymentStatus.creditExtensionExpired
                  ? " · a credit extension EXPIRED — it no longer counts"
                  : ""}
          </p>
        )}
        {/* What the guest must pay — flat Nu or % of the quote. The % is converted by the
            BACKEND against the operative quotation (no money math in the desk); the resolved
            figure lands in "required" above and prints as "Advance due now" on the proforma. */}
        <div>
          <div className="frow">
            <div className="field">
              <label>Set as</label>
              <select value={advReqMode} onChange={(e) => setAdvReqMode(e.target.value as "AMOUNT" | "PERCENT")} disabled={!folio}>
                <option value="AMOUNT">Flat amount (Nu)</option>
                <option value="PERCENT">% of quote total</option>
              </select>
            </div>
            <div className="field">
              <label>{advReqMode === "AMOUNT" ? "Amount (Nu)" : "Percent (1–100)"}</label>
              <input
                type="number"
                min={0.01}
                max={advReqMode === "PERCENT" ? 100 : undefined}
                step={advReqMode === "PERCENT" ? "1" : "0.01"}
                value={advReqValue}
                onChange={(e) => setAdvReqValue(e.target.value)}
                disabled={!folio}
              />
            </div>
          </div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <button className="btn btn-ghost btn-sm" disabled={!folio || !advReqValue || advReqM.isPending} onClick={() => advReqM.mutate()}>
              {advReqM.isPending ? "Setting…" : "Set requirement"}
            </button>
            {paymentStatus?.requirementSource === "OPERATOR" && (
              <button className="btn btn-ghost btn-sm" disabled={advReqClearM.isPending} onClick={() => advReqClearM.mutate()}>
                {advReqClearM.isPending ? "Clearing…" : "Clear — use hotel default"}
              </button>
            )}
          </div>
          {advReqMode === "PERCENT" && (
            <p style={{ fontSize: 11, color: "var(--ink-3)", margin: "6px 0 0", lineHeight: 1.5 }}>
              Converted against the current quote when you set it — if the quote is renegotiated,
              set the requirement again to track the new total.
            </p>
          )}
        </div>
      </div>

      {/* 4. Proforma invoice — reflects the advance figures above; emailing it is optional */}
      <div className="block">
        <BlockH>
          <FileCheck style={{ width: 13, height: 13 }} />
          Proforma invoice
        </BlockH>
        {proformaInvoices.length === 0 ? (
          <p style={{ fontSize: 12, color: "var(--ink-3)", margin: 0 }}>A proforma invoice is created together with the folio.</p>
        ) : (
          <>
            {multiSegment && (
              <p style={{ fontSize: 11.5, color: "var(--ink-3)", margin: "0 0 6px" }}>
                This booking has been re-worked — proformas from earlier segments stay here for
                reference; the current segment&rsquo;s proforma is the live one.
              </p>
            )}
            {proformaInvoices.map((inv) => {
              const segNo = segmentNoForDate(inv.createdAt);
              const isCurrent = !multiSegment || segNo == null || segNo === currentSegmentNo;
              const previewOpen = proformaPreviewId === inv.id;
              return (
                <div key={inv.id}>
                  <div
                    className="fact b-transit"
                    style={{
                      marginBottom: 9,
                      padding: "6px 11px",
                      fontSize: 12,
                      justifyContent: "space-between",
                      width: "100%",
                      opacity: isCurrent ? 1 : 0.75,
                    }}
                  >
                    <span style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                      <span className="mono">{inv.id}</span>
                      {(inv.versionNumber ?? 1) > 1 && <span className="tag">v{inv.versionNumber}</span>}
                    </span>
                    <span style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                      {multiSegment && (
                        <span
                          className="tag"
                          style={
                            isCurrent
                              ? { borderColor: "var(--green-t2)", background: "var(--green-t)", color: "var(--green-d)" }
                              : undefined
                          }
                          title={
                            isCurrent
                              ? "From the segment you are working now"
                              : "From an earlier pass of this booking — kept for reference"
                          }
                        >
                          {segNo != null ? `Segment ${segNo}` : "Earlier segment"}
                          {isCurrent && segNo != null ? " · current" : ""}
                        </span>
                      )}
                      <span className="tag">{invoiceStateLabel(inv)}</span>
                      <button
                        type="button"
                        className="btn btn-ghost btn-sm"
                        onClick={() => setProformaPreviewId((cur) => (cur === inv.id ? null : inv.id))}
                        title="Show the proforma document right here — no PDF needed"
                      >
                        {previewOpen ? <EyeOff style={{ width: 14, height: 14 }} /> : <Eye style={{ width: 14, height: 14 }} />}
                        {previewOpen ? "Hide" : "View"}
                      </button>
                      {session && <PdfButton label="PDF" open={() => openInvoicePdf(session, inv.id)} />}
                    </span>
                  </div>
                  {previewOpen && <ProformaPreview invoiceId={inv.id} />}
                </div>
              );
            })}
            <p style={{ fontSize: 11.5, color: "var(--ink-3)", margin: "0 0 8px", lineHeight: 1.5 }}>
              The document carries the advance figures from above — what&rsquo;s been received and
              &ldquo;Advance due now&rdquo;. The proforma already counts for the confirm checklist —
              emailing it to the guest is <b>optional</b>, only if they ask for it.
            </p>
            <div className="field">
              <label>Dispatch to (optional)</label>
              <input value={dispatchTo} onChange={(e) => setDispatchTo(e.target.value)} />
            </div>
            <button className="btn btn-ghost" disabled={dispatchM.isPending || !proformaInvoices.some((i) => i.state === "DRAFT")} onClick={() => dispatchM.mutate()}>
              {dispatchM.isPending
                ? "Dispatching…"
                : proformaInvoices.some((i) => i.dispatchedAt != null)
                  ? "✓ Proforma dispatched"
                  : "Dispatch proforma invoice"}
            </button>
          </>
        )}
      </div>

      {/* 4b. Guest's answer on the proforma — only meaningful once it has actually been sent.
          Evidence for the file; it gates nothing (see communication-acceptance.tsx). */}
      {proformaInvoices.some((i) => i.dispatchedAt != null) && (
        <CommunicationAcceptanceBlock entryId={entry.id} commType="PROFORMA_INVOICE" />
      )}

      {/* 5. Money received from the guest — after the proforma, so the page reads in the
          order the desk works: set the requirement, show/send the bill, take the money. */}
      <div className="block">
        <BlockH>
          <Banknote style={{ width: 13, height: 13 }} />
          Money received from the guest
        </BlockH>
        {paymentStatus && (
          <p style={{ fontSize: 11.5, color: "var(--ink-3)", margin: "0 0 9px" }}>
            Received {money(paymentStatus.totalReceived)} of {money(paymentStatus.requiredAmount)} required
            {paymentStatus.satisfied ? " — satisfied" : ""}.
          </p>
        )}
        {inPayments.length > 0 && (
          <p style={{ fontSize: 11.5, color: "var(--ink-3)", margin: "0 0 11px" }}>
            {/* Count the rows here (not money), and take the total from the server's payment-status
                above — summing the amounts in the browser drifts on partial payments. */}
            {inPayments.length} payment{inPayments.length === 1 ? "" : "s"} on this booking
            {folio?.advancePaymentReconciliationComplete ? " · reconciled" : ""}
          </p>
        )}
        {folio && !proformaDispatchedNow && (
          <p style={{ fontSize: 11.5, color: "var(--warn)", margin: "0 0 9px", lineHeight: 1.5 }}>
            Dispatch the proforma invoice above first — payments are logged against the bill the
            guest received, so this form unlocks once it has gone out.
          </p>
        )}
        <div className="frow">
          <div className="field">
            <label>Amount received (Nu)</label>
            <input
              type="number"
              min={0.01}
              step="0.01"
              value={paymentAmount}
              onChange={(e) => {
                setPaymentAmount(e.target.value);
                if (paymentM.isSuccess) paymentM.reset();
              }}
              disabled={!folio || !proformaDispatchedNow}
            />
          </div>
          <div className="field">
            <label>Notes</label>
            <input value={paymentNotes} onChange={(e) => setPaymentNotes(e.target.value)} disabled={!folio || !proformaDispatchedNow} />
          </div>
        </div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <button
            className="btn btn-ghost btn-sm"
            disabled={!folio || !proformaDispatchedNow || !paymentAmount || paymentM.isPending}
            onClick={() => paymentM.mutate()}
          >
            {paymentM.isPending ? "Logging…" : paymentM.isSuccess ? "✓ Payment logged" : "Log payment received"}
          </button>
          <button
            className="btn btn-ghost btn-sm"
            disabled={!folio || reconcileM.isPending || !!folio?.advancePaymentReconciliationComplete}
            onClick={() => reconcileM.mutate()}
          >
            {reconcileM.isPending
              ? "Reconciling…"
              : folio?.advancePaymentReconciliationComplete || reconcileM.isSuccess
                ? "✓ Reconciled"
                : "Mark reconciled"}
          </button>
          <button className="btn btn-ghost btn-sm" disabled={!folio || paymentStatusQuery.isFetching} onClick={() => paymentStatusQuery.refetch()}>
            <RefreshCw style={{ width: 12, height: 12 }} />
            Refresh
          </button>
        </div>
        {elevated && (
          <div style={{ marginTop: 12, borderTop: "1px dashed var(--line-2)", paddingTop: 11 }}>
            <div style={{ fontSize: 11, fontWeight: 600, color: "var(--ink-3)", marginBottom: 7 }}>Credit extension (FOM+)</div>
            <p style={{ fontSize: 11, color: "var(--ink-3)", margin: "0 0 7px", lineHeight: 1.5 }}>
              Lets the booking proceed without the advance, up to the ceiling. Give it a time limit
              and it stops counting when the clock runs out — the advance becomes due again.
            </p>
            <div className="frow">
              <div className="field">
                <label>Ceiling amount</label>
                <input type="number" value={creditCeiling} onChange={(e) => setCreditCeiling(e.target.value)} />
              </div>
              <div className="field">
                <label>Reason</label>
                <input value={creditReason} onChange={(e) => setCreditReason(e.target.value)} />
              </div>
              <div className="field">
                <label>Valid for (hours, optional)</label>
                <input
                  type="number"
                  min={1}
                  placeholder="No limit"
                  value={creditHours}
                  onChange={(e) => setCreditHours(e.target.value)}
                />
              </div>
            </div>
            <button className="btn btn-ghost btn-sm" disabled={creditM.isPending || creditM.isSuccess || !creditCeiling || !creditReason.trim() || !folio} onClick={() => creditM.mutate()}>
              {creditM.isPending ? "Approving…" : creditM.isSuccess ? "✓ Credit extension approved" : "Approve credit extension"}
            </button>
          </div>
        )}
      </div>

      {/* 6. Committed hold */}
      <div className="block">
        <BlockH>
          <Lock style={{ width: 13, height: 13 }} />
          Committed hold
        </BlockH>
        {hold ? (
          <div className="fact b-bound" style={{ padding: "9px 12px", fontSize: 12.5 }}>
            <Check style={{ width: 14, height: 14, color: "var(--green-d)" }} />
            Hold {hold.state} · room {hold.roomId?.slice(0, 10) ?? "—"} · expires {hold.expiresAt.slice(0, 16).replace("T", " ")}
          </div>
        ) : (
          <>
            <div className="field">
              <label>Commercial justification</label>
              <input value={holdJustification} onChange={(e) => setHoldJustification(e.target.value)} />
            </div>
            <button
              className="btn btn-primary"
              disabled={holdM.isPending || !preferredRoomId || !holdJustification.trim() || !folio?.billingModel || !disclosure}
              onClick={() => holdM.mutate()}
            >
              {holdM.isPending ? "Placing…" : "Place committed hold"}
            </button>
            {!disclosure && <p style={{ fontSize: 11.5, color: "var(--warn)", marginBottom: 0 }}>Record cancellation terms before placing the hold.</p>}
            {!preferredRoomId && <p style={{ fontSize: 11.5, color: "var(--warn)", marginBottom: 0 }}>No preferred room — complete Inquiry first.</p>}
          </>
        )}
      </div>

      {/* Group / corporate (conditional) */}
      {(isGroupLike || needsMilestones) && (
        <div className="block">
          <BlockH>Group / corporate requirements</BlockH>
          {isGroupLike && (
            <>
              <div className="frow">
                <div className="field">
                  <label>Coordinator name</label>
                  <input value={coordinatorName} onChange={(e) => setCoordinatorName(e.target.value)} />
                </div>
                <div className="field">
                  <label>Authority scope</label>
                  <input value={coordinatorScope} onChange={(e) => setCoordinatorScope(e.target.value)} />
                </div>
              </div>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: needsMilestones ? 12 : 0 }}>
                <button className="btn btn-ghost btn-sm" disabled={coordinatorM.isPending || coordinatorM.isSuccess || !coordinatorName.trim() || !coordinatorScope.trim()} onClick={() => coordinatorM.mutate()}>
                  {coordinatorM.isPending ? "Confirming…" : coordinatorM.isSuccess ? "✓ Coordinator confirmed" : "Confirm coordinator"}
                </button>
                {gm && (
                  <button className="btn btn-ghost btn-sm" disabled={focGmM.isPending || focGmM.isSuccess} onClick={() => focGmM.mutate()}>
                    {focGmM.isPending ? "Approving…" : focGmM.isSuccess ? "✓ FOC GM approved" : "FOC GM approval"}
                  </button>
                )}
              </div>
            </>
          )}
          {needsMilestones && (
            <>
              <div className="field">
                <label>Payment milestone template</label>
                <input value={milestoneTemplate} onChange={(e) => setMilestoneTemplate(e.target.value)} />
              </div>
              <button className="btn btn-ghost btn-sm" disabled={milestonesM.isPending || milestonesM.isSuccess} onClick={() => milestonesM.mutate()}>
                {milestonesM.isPending ? "Scheduling…" : milestonesM.isSuccess ? "✓ Milestones scheduled" : "Schedule milestones"}
              </button>
            </>
          )}
        </div>
      )}

      {/* Back-flow (FOM+) */}
      {elevated && (
        <div className="block">
          <BlockH>
            <Shield style={{ width: 13, height: 13 }} />
            Open a new segment (FOM+)
          </BlockH>
          <div className="field">
            <label>Reason</label>
            <input value={reEntryReason} onChange={(e) => setReEntryReason(e.target.value)} placeholder="Why re-open?" />
          </div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <button className="btn btn-ghost btn-sm" disabled={reEntryS2M.isPending} onClick={() => reEntryS2M.mutate()}>
              Renegotiate rate (Negotiation)
            </button>
            <button className="btn btn-ghost btn-sm" disabled={reEntryS1M.isPending} onClick={() => reEntryS1M.mutate()}>
              Reconfigure dates / room (Inquiry)
            </button>
          </div>
        </div>
      )}

      {/* Cancel (terminal) */}
      <div className="block" style={{ borderColor: "#e2b3ac" }}>
        <BlockH>Cancel this booking</BlockH>
        <p style={{ fontSize: 12, color: "var(--ink-2)", marginTop: 0, lineHeight: 1.5 }}>
          Releases the committed hold, supersedes any proforma invoice, cancels timers, applies the disclosed
          penalty and refunds the net advance. The booking becomes terminal — there&rsquo;s no undo.
        </p>
        <div className="field">
          <label>Reason</label>
          <input value={cancelReason} onChange={(e) => setCancelReason(e.target.value)} placeholder="e.g. guest changed plans" />
        </div>
        <button className="btn btn-ghost" style={{ borderColor: "#e2b3ac", color: "var(--stop)" }} onClick={() => setCancelOpen(true)}>
          Cancel booking
        </button>
      </div>
      </div>

      <BackendRail entryId={entry.id} groups={railGroups} activeKeys={activeKeys} firingKey={firingKey} />

      <DeskConfirmModal
        open={cancelOpen}
        tone="danger"
        title="Cancel this booking?"
        subtitle={`${entry.id}`}
        why="Cancelling at setup is terminal. Here is exactly what happens:"
        consequences={[
          "The committed hold is released — the room returns to the available pool.",
          "Any proforma invoice is superseded and its timers cancelled.",
          <>The disclosed cancellation <b>penalty</b> (if any) is posted; the net advance refunds.</>,
          "The booking becomes terminal — this cannot be undone.",
        ]}
        confirmLabel="Cancel booking"
        cancelLabel="Keep booking"
        pending={cancelM.isPending}
        onConfirm={() => cancelM.mutate()}
        onClose={() => setCancelOpen(false)}
      />
    </div>
  );
}
