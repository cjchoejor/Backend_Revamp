"use client";

import { useEffect, useMemo, useRef, useState } from "react";
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
import { countdownTo } from "@/lib/desk/timers";
import { listEntryCommunications } from "@/lib/api/entries";
import { openInvoicePdf } from "@/lib/api/documents";
import { PdfButton } from "./pdf-button";
import { BackendRail, type RailGroup } from "./backend-inline";
import { STAGE_ACTIONS } from "@/lib/desk/backend-actions";
import type { EntryDetail } from "@/types/api";
import { preferredHoldRoomId } from "@/types/api";
import { DeskConfirmModal } from "./confirm-modal";
import { CommunicationAcceptanceBlock } from "./communication-acceptance";
import { CompetingClaimsBanner } from "./competing-claims";
import { ProformaPreview } from "./quotation-preview";
import {
  AdvancePlanCapture,
  AdvancePlanFacts,
  CreditExpiryPicker,
  expiryModeForPlanDue,
  InstallmentHistory,
  resolveCreditExpiry,
  type CreditExpiryChoice,
} from "./advance-settlement";

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
  // Anchor room, same pick the S2 hold uses (2026-08-06) — placeCommittedHold pins ALL sealed
  // rooms regardless, but the primary decides which speculative hold gets upgraded, so the two
  // steps must agree on it.
  const preferredRoomId = preferredHoldRoomId(sealedPreferred?.optionSelected ?? null);
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
  // Guest's answer to THIS segment's dispatched proforma — mirrors the backend's
  // `enforceProformaGuestAnswerRecordedBeforeAdvancePayment` (2026-08-03): once the bill went
  // out, money can only be logged after the guest's reply is on record. Shares the
  // ["entry-communications"] cache with the reply block below.
  const commsForGateQuery = useQuery({
    queryKey: ["entry-communications", entry.id],
    queryFn: () => listEntryCommunications(session!, entry.id),
    enabled: !!session,
  });
  const segStartIsoForComms = (entry.segments ?? [])[0]?.startedAt ?? null;
  const latestProformaComm = (commsForGateQuery.data?.items ?? []).find(
    (c) =>
      c.commType === "PROFORMA_INVOICE" &&
      c.direction === "OUTBOUND" &&
      c.sendStatus === "DISPATCHED" &&
      (!segStartIsoForComms || (c.createdAt ?? "") >= segStartIsoForComms),
  );
  // Locked while dispatched-but-unanswered; also while the feed is still loading (brief, safe).
  const paymentLockedForAnswer = proformaDispatchedNow && latestProformaComm?.acknowledgementStatus !== "RECEIVED";
  // The live issue — newest non-superseded (a changed advance requirement supersedes the sent
  // one and mints a new version; rows are createdAt-desc so the first live row is the current).
  const currentProformaId = proformaInvoices.find((i) => i.state !== "SUPERSEDED")?.id ?? null;
  const invoiceStateLabel = (inv: { state: string; dispatchedAt?: string | null }): string =>
    inv.dispatchedAt
      ? "Dispatched"
      : inv.state === "DRAFT"
        ? "Ready to send"
        : inv.state.charAt(0) + inv.state.slice(1).toLowerCase();
  const inPayments = (folio?.payments ?? []).filter((p) => /IN/i.test(p.paymentDirection ?? "") && !/OUT|REFUND/i.test(p.paymentDirection ?? ""));
  const isGroupLike = entry.useType === "GROUP" || entry.useType === "CONFERENCE";
  const needsMilestones = entry.useType === "CORPORATE" || entry.useType === "CONFERENCE";

  // Billing-model default follows who booked (2026-08-07, operator request): a travel-agent
  // booking settles by voucher, so pre-select TOUR_OPERATOR_VOUCHER; everyone else defaults to
  // Guest pays. Only a DEFAULT — the select stays fully changeable, and a saved model wins.
  const isTravelAgentBooking =
    !!entry.inquiry?.travelAgentId || entry.inquiry?.sourceChannel === "TRAVEL_AGENT";
  const defaultBillingModel = isTravelAgentBooking ? "TOUR_OPERATOR_VOUCHER" : "GUEST_PAY";
  const [billingModel, setBillingModel] = useState(folio?.billingModel ?? defaultBillingModel);
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
  // Time limit on the credit extension — aligned to the guest's payment plan (promised date /
  // check-in / check-out) or a plain hours count (2026-08-07; was hours-only).
  const [creditExpiry, setCreditExpiry] = useState<CreditExpiryChoice>({ mode: "NONE", hours: "" });
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

  /**
   * "Amount received" prefill (2026-08-03, operator request; narrowed 2026-08-07). The figure
   * is `shortfall` — the BACKEND's own `requiredAmount − totalReceived`, never re-derived here
   * (no-money-math rule) — but it only prefills while NOTHING has been paid yet. After a
   * partial payment the box refilling with the remainder read like the guest owed a second
   * payment right now (operator report: asked 5,000, logged 2,000, box showed 3,000). Once any
   * payment exists the box stays blank; the "still owed" hint below and the credit-extension
   * ceiling default carry the remainder instead. `paymentAmountEditedRef` latches on the first
   * keystroke so a deliberately different figure is never overwritten by a refetch.
   */
  const suggestedPaymentAmount =
    paymentStatus && paymentStatus.shortfall > 0 && paymentStatus.totalReceived === 0
      ? String(paymentStatus.shortfall)
      : "";
  const paymentAmountEditedRef = useRef(false);
  useEffect(() => {
    if (paymentAmountEditedRef.current) return;
    setPaymentAmount(suggestedPaymentAmount);
  }, [suggestedPaymentAmount]);
  // The credit-extension ceiling defaults to the shortfall — covering the uncovered remainder
  // is exactly what the extension is for (2026-08-07, operator request). Same latch pattern.
  const suggestedCeiling = paymentStatus && paymentStatus.shortfall > 0 ? String(paymentStatus.shortfall) : "";
  const creditCeilingEditedRef = useRef(false);
  useEffect(() => {
    if (creditCeilingEditedRef.current) return;
    setCreditCeiling(suggestedCeiling);
  }, [suggestedCeiling]);
  // "Cover the gate until" follows the guest's own plan (promised date / check-in / check-out)
  // until the operator touches the dropdown — then their choice wins (it stays changeable).
  const creditExpiryTouchedRef = useRef(false);
  const planDueAt = paymentStatus?.paymentPlan?.balanceDueAt ?? null;
  const planPromisedBy = paymentStatus?.paymentPlan?.promisedBy ?? null;
  useEffect(() => {
    if (creditExpiryTouchedRef.current) return;
    const mode = expiryModeForPlanDue(planDueAt, {
      promisedBy: planPromisedBy,
      checkInDate: entry.checkInDate,
      checkOutDate: entry.checkOutDate,
    });
    if (mode) setCreditExpiry((c) => (c.mode === mode ? c : { ...c, mode }));
  }, [planDueAt, planPromisedBy, entry.checkInDate, entry.checkOutDate]);

  // Advance-payment window countdown (backend fact: proforma dispatch → check-in date).
  // 30s tick keeps the label honest without re-rendering every second.
  const advanceWindow = paymentStatus?.advanceWindow ?? null;
  const [advanceNowTick, setAdvanceNowTick] = useState(() => Date.now());
  useEffect(() => {
    if (!advanceWindow?.active) return;
    const t = setInterval(() => setAdvanceNowTick(Date.now()), 30_000);
    return () => clearInterval(t);
  }, [advanceWindow?.active]);
  const advanceCountdown =
    advanceWindow?.active && advanceWindow.deadline ? countdownTo(advanceWindow.deadline, advanceNowTick) : null;

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ["entry", entry.id] });
    void queryClient.invalidateQueries({ queryKey: ["payment-status", entry.id] });
    void queryClient.invalidateQueries({ queryKey: ["entry-trace", entry.id] });
    void queryClient.invalidateQueries({ queryKey: ["entry-timers", entry.id] });
    // The inline proforma preview recomposes from the folio's current payments + advance
    // requirement — logging a payment or changing the requirement changes the document.
    void queryClient.invalidateQueries({ queryKey: ["invoice-preview"] });
    // Dispatching the proforma CREATES the CommunicationRecord that the "record the guest's
    // answer" block and the S3 checklist item both read. That feed lives on its own query key
    // (shared with CommunicationAcceptanceBlock + booking-workspace) and isn't part of the
    // entry payload, so without this it stayed cached for the app-wide 5-minute staleTime and
    // the reply block only appeared after a page refresh. Re-issuing a proforma (an advance-
    // requirement change) supersedes the old communication too, so this is not dispatch-only.
    void queryClient.invalidateQueries({ queryKey: ["entry-communications", entry.id] });
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
      // Re-arm the prefill: once the refetched status lands, the field refills with whatever
      // is still outstanding (blank when the advance is now settled).
      paymentAmountEditedRef.current = false;
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
          ...resolveCreditExpiry(creditExpiry, {
            promisedBy: paymentStatus?.paymentPlan?.promisedBy,
            checkInDate: entry.checkInDate,
            checkOutDate: entry.checkOutDate,
          }),
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
      if (status.reissuedProforma) {
        // supersededIds empty = the fresh-mint path (a re-entry had superseded every proforma,
        // so nothing live existed to supersede — a new one was generated for this segment).
        toast.success(
          status.reissuedProforma.supersededIds.length > 0
            ? `Advance requirement set — ${money(status.requiredAmount)}. The previous proforma was superseded; a new one (v${status.reissuedProforma.versionNumber}) is ready — dispatch it.`
            : `Advance requirement set — ${money(status.requiredAmount)}. A fresh proforma (v${status.reissuedProforma.versionNumber}) was generated for this segment — dispatch it.`,
        );
      } else {
        toast.success(`Advance requirement set — ${money(status.requiredAmount)}`);
      }
      setAdvReqValue("");
      invalidate();
    },
    onError: (e: unknown) => toast.error(e instanceof ApiError ? e.message : e instanceof Error ? e.message : "Action failed"),
  });
  const advReqClearM = useMutation({
    mutationFn: () => setAdvanceRequirement(session!, entry.id, { mode: "CLEAR" }),
    onSuccess: (status) => {
      toast.success(
        status.reissuedProforma
          ? status.reissuedProforma.supersededIds.length > 0
            ? `Requirement cleared — hotel default applies. The previous proforma was superseded; a new one (v${status.reissuedProforma.versionNumber}) is ready — dispatch it.`
            : `Requirement cleared — hotel default applies. A fresh proforma (v${status.reissuedProforma.versionNumber}) was generated for this segment — dispatch it.`
          : "Requirement cleared — hotel default applies",
      );
      invalidate();
    },
    onError: (e: unknown) => toast.error(e instanceof ApiError ? e.message : "Action failed"),
  });
  const holdM = useMutation(
    wrap(() => {
      if (!preferredRoomId) throw new Error("No preferred room from Inquiry");
      return placeCommittedHold(session!, entry.id, { roomId: preferredRoomId, commercialJustification: holdJustification.trim() });
    }, "Committed hold placed"),
  );
  const dispatchM = useMutation({
    mutationFn: () => {
      const inv = proformaInvoices.find((i) => i.state === "DRAFT") ?? proformaInvoices[0];
      if (!inv) throw new Error("No proforma invoice");
      return dispatchInvoice(session!, inv.id, { dispatchedTo: dispatchTo.trim() || undefined });
    },
    onSuccess: (res) => {
      toast.success("Proforma invoice dispatched");
      // Sending the PI holds the rooms automatically (2026-08-08 operator ruling) — the
      // backend reports what happened, and the hold block below flips to Held on refetch.
      const ah = res.autoHold;
      if (ah?.placed) {
        toast.success("Rooms held for this booking", {
          description:
            "The proforma went to the guest, so the committed hold was placed automatically. It runs on the standard hold clock and frees itself if nothing follows.",
          duration: 9000,
        });
      } else if (ah && !ah.placed && ah.reason !== "ALREADY_HELD") {
        toast.warning("Rooms not auto-held", {
          description: `${ah.message} — place the committed hold manually below.`,
          duration: 10000,
        });
      }
      invalidate();
    },
    onError: (e: unknown) => toast.error(e instanceof ApiError ? e.message : "Action failed"),
  });
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

      {/* Race telltale (2026-08-06): another live booking with a quotation or proforma on the
          same rooms & nights. The committed hold below is what decides the race — this warns the
          operator BEFORE money is taken on rooms someone else may pin first. */}
      <CompetingClaimsBanner entryId={entry.id} />

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
              {!folio?.billingModel && isTravelAgentBooking && billingModel === "TOUR_OPERATOR_VOUCHER" && (
                <p style={{ fontSize: 11, color: "var(--ink-3)", margin: "5px 0 0" }}>
                  Pre-selected — this booking came through a travel agent. Change it if they settle differently.
                </p>
              )}
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
            {/* "Requested" when the desk pinned a figure for this booking; "min threshold"
                when it's the hotel's configured default — "required" blurred the two. */}
            <span>
              Received {money(paymentStatus.totalReceived, folio?.lines?.[0]?.currency)} ·{" "}
              {paymentStatus.requirementSource === "OPERATOR" ? "requested" : "min threshold"}{" "}
              {money(paymentStatus.requiredAmount, folio?.lines?.[0]?.currency)}
            </span>
            <span className={`tag ${paymentStatus.satisfied ? "" : "warn"}`}>
              {paymentStatus.satisfied ? "Satisfied" : `Short ${money(paymentStatus.shortfall)}`}
            </span>
          </div>
        )}
        {paymentStatus && (
          <p style={{ fontSize: 11, color: "var(--ink-3)", margin: "0 0 11px" }}>
            {/* When a pin exists, say EXPLICITLY that it lives on this booking alone and the
                hotel's configured minimum is untouched — a pinned figure was being read as
                "the minimum threshold changed" (2026-08-03). */}
            {paymentStatus.requirementSource === "OPERATOR"
              ? `${
                  paymentStatus.requirementBasis?.mode === "PERCENT"
                    ? `Requested for THIS booking only — ${paymentStatus.requirementBasis.percent}% of the quote total (${money(paymentStatus.requirementBasis.baseTotal ?? null)})`
                    : "Requested for THIS booking only — flat amount"
                } · the hotel's min threshold is unchanged at ${money(paymentStatus.configuredBaseAmount ?? null)}`
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

      {/* 3b. The guest's payment plan — captured BEFORE the proforma goes out (2026-08-08,
          operator ordering: how much → how it will be paid → the bill). The proforma PRINTS
          this plan, and changing it at S3 re-issues the proforma (the capture toasts
          "dispatch it again"). Full / part-now / installments; a dated before-check-in
          promise arms the W38 countdown; at-check-in is collected at that desk. */}
      <AdvancePlanCapture
        entry={entry}
        status={paymentStatus}
        disabled={!folio}
        disabledHint="Create the folio first — the plan is recorded against it."
      />

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
              // Current vs Old (2026-08-01, operator request): a changed advance requirement
              // supersedes a sent proforma and mints a new version — every issue stays listed,
              // the live one marked "Current", the rest "Old", numbered by their version.
              const isCurrentDoc = currentProformaId != null && inv.id === currentProformaId;
              const isOldDoc = inv.state === "SUPERSEDED" || (currentProformaId != null && !isCurrentDoc);
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
                      opacity: isCurrent && !isOldDoc ? 1 : 0.75,
                    }}
                  >
                    <span style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                      <span className="mono">{inv.id}</span>
                      {proformaInvoices.length > 1 && (
                        <span
                          className="tag"
                          style={
                            isCurrentDoc
                              ? { borderColor: "var(--green-t2)", background: "var(--green-t)", color: "var(--green-d)" }
                              : undefined
                          }
                          title={
                            isCurrentDoc
                              ? "The live proforma — the one the guest is held to"
                              : "Superseded issue — kept for the record; the PDF shows what was sent at the time"
                          }
                        >
                          {isCurrentDoc ? `Current · v${inv.versionNumber ?? 1}` : `Old · v${inv.versionNumber ?? 1}`}
                        </span>
                      )}
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
                      {/* Live rows preview by recomposing from current data; OLD rows with a
                          stored/sent artifact embed the FROZEN PDF instead — the document that
                          actually went out (a recomposition would show today's figures under
                          yesterday's number). Old rows with NO artifact (e.g. drafts superseded
                          by a re-entry) are still viewable (2026-08-02, operator request) as a
                          reconstruction, flagged with a caveat strip so nobody mistakes it for
                          what was sent — nothing ever went out for those. */}
                      <button
                        type="button"
                        className="btn btn-ghost btn-sm"
                        onClick={() => setProformaPreviewId((cur) => (cur === inv.id ? null : inv.id))}
                        title={
                          isOldDoc
                            ? inv.pdfStorageKey != null || inv.dispatchedAt != null
                              ? "Show this superseded issue as it was sent (stored PDF)"
                              : "Show this superseded version — reconstructed, it was never sent"
                            : "Show the proforma document right here — no PDF needed"
                        }
                      >
                        {previewOpen ? <EyeOff style={{ width: 14, height: 14 }} /> : <Eye style={{ width: 14, height: 14 }} />}
                        {previewOpen ? "Hide" : "View"}
                      </button>
                      {session && <PdfButton label="PDF" open={() => openInvoicePdf(session, inv.id)} />}
                    </span>
                  </div>
                  {previewOpen && (
                    <ProformaPreview
                      invoiceId={inv.id}
                      frozenPdf={isOldDoc && (inv.pdfStorageKey != null || inv.dispatchedAt != null)}
                      notice={
                        isOldDoc && inv.pdfStorageKey == null && inv.dispatchedAt == null
                          ? "Superseded version that was never rendered or sent — no frozen copy exists, so this is a reconstruction using the booking's current figures."
                          : undefined
                      }
                    />
                  )}
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
      {/* Guest's answer to the proforma — always present on S3 (2026-08-02, operator request:
          after a re-entry the section vanished because only prior-segment dispatches existed).
          Scoped to the CURRENT segment via its startedAt: a sealed segment's dispatch (and its
          recorded answer) never stands in for this segment's; before this segment's proforma
          goes out the block says "nothing to answer" instead of disappearing. */}
      <CommunicationAcceptanceBlock
        entryId={entry.id}
        commType="PROFORMA_INVOICE"
        sinceIso={segments[0]?.startedAt ?? null}
      />

      {/* 5. Money received from the guest — after the proforma, so the page reads in the
          order the desk works: set the requirement, record the plan, show/send the bill,
          take the money. */}
      <div className="block">
        <BlockH>
          <Banknote style={{ width: 13, height: 13 }} />
          Money received from the guest
        </BlockH>
        {paymentStatus && (
          <p style={{ fontSize: 11.5, color: "var(--ink-3)", margin: "0 0 9px" }}>
            Received {money(paymentStatus.totalReceived)} of the{" "}
            {paymentStatus.requirementSource === "OPERATOR" ? "requested" : "min threshold"}{" "}
            {money(paymentStatus.requiredAmount)}
            {(paymentStatus.installments?.length ?? 0) > 1 ? ` in ${paymentStatus.installments!.length} payments` : ""}
            {paymentStatus.satisfied ? " — satisfied" : ""}
            {!paymentStatus.satisfied && paymentStatus.shortfall > 0
              ? ` — ${money(paymentStatus.shortfall)} remaining`
              : ""}
            .
          </p>
        )}
        {/* The payment window: the advance is due between the proforma going out and the
            check-in date. Facts come from payment-status (backend); only the countdown label
            ticks here. Overdue keeps showing until the money arrives or check-in gates catch it. */}
        {advanceWindow && (advanceWindow.active || advanceWindow.overdue) && (
          <div style={{ margin: "0 0 11px", display: "flex", flexDirection: "column", gap: 4, alignItems: "flex-start" }}>
            <span className={`timer ${advanceWindow.overdue ? "crit" : advanceCountdown?.level || "warn"}`}>
              {advanceWindow.overdue
                ? "Advance overdue — check-in date passed with the advance unpaid"
                : `Advance due ${advanceCountdown?.text ?? "before check-in"} · by ${advanceWindow.deadline?.slice(0, 10) ?? ""}`}
            </span>
            <span style={{ fontSize: 11, color: "var(--ink-3)" }}>
              Window opened when the proforma went out
              {advanceWindow.opensAt ? ` (${advanceWindow.opensAt.slice(0, 16).replace("T", " ")})` : ""} — it closes at
              check-in.
            </span>
          </div>
        )}
        {/* The guest's plan + promise countdown + every payment so far (installment history) —
            all backend facts from payment-status, never summed here. */}
        <AdvancePlanFacts status={paymentStatus} />
        <InstallmentHistory status={paymentStatus} currency={folio?.lines?.[0]?.currency} />
        {inPayments.length > 0 && folio?.advancePaymentReconciliationComplete && (
          <p style={{ fontSize: 11.5, color: "var(--ink-3)", margin: "0 0 11px" }}>Advance reconciled.</p>
        )}
        {/* Partial payment + a stated plan → the remainder is legitimate, not an oversight.
            Point the operator at the cover mechanism instead of leaving a red "Short" tag. */}
        {paymentStatus &&
          !paymentStatus.paidInFull &&
          paymentStatus.totalReceived > 0 &&
          paymentStatus.paymentPlan &&
          paymentStatus.paymentPlan.plan !== "FULL" &&
          !paymentStatus.creditExtensionActive && (
            <p style={{ fontSize: 11.5, color: "var(--warn)", margin: "0 0 11px", lineHeight: 1.5 }}>
              The guest still owes {money(paymentStatus.shortfall)} and said the rest comes{" "}
              {paymentStatus.paymentPlan.balanceDueAt === "BEFORE_CHECKIN"
                ? "before check-in"
                : paymentStatus.paymentPlan.balanceDueAt === "AT_CHECKIN"
                  ? "at the check-in desk"
                  : "at check-out"}
              . To move the booking on before the money lands, have an FOM cover the remainder with the
              credit extension below.
            </p>
          )}
        {folio && !proformaDispatchedNow && (
          <p style={{ fontSize: 11.5, color: "var(--warn)", margin: "0 0 9px", lineHeight: 1.5 }}>
            Dispatch the proforma invoice above first — payments are logged against the bill the
            guest received, so this form unlocks once it has gone out.
          </p>
        )}
        {folio && proformaDispatchedNow && paymentLockedForAnswer && (
          <p style={{ fontSize: 11.5, color: "var(--warn)", margin: "0 0 9px", lineHeight: 1.5 }}>
            Note down the guest&rsquo;s response first — the proforma went out, so record their answer
            (verbal or written) in the reply box above. Money can be logged once their reply is on file.
          </p>
        )}
        <div
          onClickCapture={() => {
            // The inputs are disabled, so a stray click lands here — tell the operator WHY
            // instead of leaving a dead form (2026-08-03, operator request).
            if (folio && proformaDispatchedNow && paymentLockedForAnswer) {
              toast("Note down the guest's response first — the reply box is just above this section.");
            }
          }}
        >
        <div className="frow">
          <div className="field">
            <label>Amount received (Nu)</label>
            <input
              type="number"
              min={0.01}
              step="0.01"
              value={paymentAmount}
              onChange={(e) => {
                // First keystroke stops the prefill writing over the operator.
                paymentAmountEditedRef.current = true;
                setPaymentAmount(e.target.value);
                if (paymentM.isSuccess) paymentM.reset();
              }}
              disabled={!folio || !proformaDispatchedNow || paymentLockedForAnswer}
            />
            {paymentStatus && paymentStatus.shortfall > 0 && (
              <div style={{ fontSize: 10.5, color: "var(--ink-3)", marginTop: 3, lineHeight: 1.4 }}>
                {suggestedPaymentAmount !== "" && paymentAmount === suggestedPaymentAmount ? (
                  <>
                    Pre-filled with what&rsquo;s still owed on the advance ({money(paymentStatus.shortfall)}) —
                    change it if the guest paid a different amount.
                  </>
                ) : (
                  <>
                    Still owed on the advance: {money(paymentStatus.shortfall)}.{" "}
                    <button
                      type="button"
                      className="rcb-mini"
                      onClick={() => {
                        paymentAmountEditedRef.current = true;
                        setPaymentAmount(String(paymentStatus.shortfall));
                      }}
                    >
                      Use that
                    </button>
                  </>
                )}
              </div>
            )}
          </div>
          <div className="field">
            <label>Notes</label>
            <input
              value={paymentNotes}
              onChange={(e) => setPaymentNotes(e.target.value)}
              disabled={!folio || !proformaDispatchedNow || paymentLockedForAnswer}
            />
          </div>
        </div>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <button
            className="btn btn-ghost btn-sm"
            disabled={!folio || !proformaDispatchedNow || paymentLockedForAnswer || !paymentAmount || paymentM.isPending}
            onClick={() => paymentM.mutate()}
          >
            {paymentM.isPending ? "Logging…" : paymentM.isSuccess ? "✓ Payment logged" : "Log payment received"}
          </button>
          <button
            className="btn btn-ghost btn-sm"
            // Mirrors the backend's p27 gate (2026-08-07, operator report: the button sat
            // enabled with zero payments and the click could only fail): reconciling needs at
            // least one logged payment, unless the folio is direct-bill-like — there the agent/
            // government settles later and "no advance" is the legitimate position.
            disabled={
              !folio ||
              reconcileM.isPending ||
              !!folio?.advancePaymentReconciliationComplete ||
              !(
                (paymentStatus?.totalReceived ?? 0) > 0 ||
                inPayments.length > 0 ||
                ["DIRECT_BILL", "GOVERNMENT"].includes(folio?.billingModel ?? "")
              )
            }
            title={
              (paymentStatus?.totalReceived ?? 0) > 0 ||
              inPayments.length > 0 ||
              ["DIRECT_BILL", "GOVERNMENT"].includes(folio?.billingModel ?? "")
                ? "Sign off the advance position as accepted — ticks the payment-reconciliation checklist and stops follow-up chasing. Use it when a shortfall is deliberately accepted (e.g. covered by credit or agent-settled)."
                : "Log a payment first — reconciling records that the money position was reviewed, and with nothing received there is nothing to reconcile (direct-bill folios are the exception)."
            }
            onClick={() => reconcileM.mutate()}
          >
            {reconcileM.isPending
              ? "Reconciling…"
              : folio?.advancePaymentReconciliationComplete || reconcileM.isSuccess
                ? "✓ Reconciled"
                : "Mark reconciled"}
          </button>
          <button
            className="btn btn-ghost btn-sm"
            disabled={!folio || paymentStatusQuery.isFetching}
            title="Re-read the payment status from the server — use it if money was logged on another terminal."
            onClick={() => paymentStatusQuery.refetch()}
          >
            <RefreshCw style={{ width: 12, height: 12 }} />
            Refresh
          </button>
        </div>
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
                <input
                  type="number"
                  value={creditCeiling}
                  onChange={(e) => {
                    creditCeilingEditedRef.current = true;
                    setCreditCeiling(e.target.value);
                  }}
                />
                {paymentStatus && paymentStatus.shortfall > 0 && (
                  <div style={{ fontSize: 10.5, color: "var(--ink-3)", marginTop: 3 }}>
                    {creditCeiling === String(paymentStatus.shortfall) ? (
                      <>Pre-filled with what&rsquo;s still owed on the advance.</>
                    ) : (
                      <>
                        Still owed: {money(paymentStatus.shortfall)}.{" "}
                        <button
                          type="button"
                          className="rcb-mini"
                          onClick={() => {
                            creditCeilingEditedRef.current = true;
                            setCreditCeiling(String(paymentStatus.shortfall));
                          }}
                        >
                          Cover that
                        </button>
                      </>
                    )}
                  </div>
                )}
              </div>
              <div className="field">
                <label>Reason</label>
                <input value={creditReason} onChange={(e) => setCreditReason(e.target.value)} />
              </div>
            </div>
            <CreditExpiryPicker
              choice={creditExpiry}
              onChange={(c) => {
                creditExpiryTouchedRef.current = true;
                setCreditExpiry(c);
              }}
              anchors={{
                promisedBy: paymentStatus?.paymentPlan?.promisedBy,
                checkInDate: entry.checkInDate,
                checkOutDate: entry.checkOutDate,
              }}
            />
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
            {/* Auto-placed holds say so — the justification is stamped by the dispatch hook. */}
            {hold.commercialJustification?.startsWith("Auto-held on proforma dispatch") && (
              <span style={{ color: "var(--ink-3)", fontSize: 11 }}> · held automatically when the proforma was sent</span>
            )}
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
            {/* 2026-08-08 ruling: dispatching the PI places this hold automatically. The manual
                button is the path for bookings whose proforma is generated but never sent. */}
            <p style={{ fontSize: 11.5, color: "var(--ink-3)", marginBottom: 0 }}>
              Sending the proforma to the guest places this hold automatically — use the button when the
              proforma isn&rsquo;t being sent.
            </p>
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
