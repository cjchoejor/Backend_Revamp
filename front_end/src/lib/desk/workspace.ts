/**
 * Per-booking derivations for the front-desk workspace.
 *
 * Everything here reads from the real `EntryDetail` the backend returns and
 * shapes it into the operator-language facts the journey canvas and summary
 * rail render. No fabrication — where the API doesn't carry a value we show
 * "—" rather than inventing one.
 */
import type { EntryDetail, QuotationSummary } from "@/types/api";
import { DESK_STEPS, nightsBetween, stepForStage, type DeskStep } from "./model";

export function toNum(v: string | number | null | undefined): number {
  if (v === null || v === undefined) return 0;
  const n = typeof v === "number" ? v : Number(String(v).replace(/,/g, ""));
  return Number.isFinite(n) ? n : 0;
}

/** Money in the mockup's idiom — "Nu 12,345" for BTN, otherwise "<CCY> 12,345". */
export function money(amount: string | number | null | undefined, currency?: string | null): string {
  const n = toNum(amount);
  const sym = !currency || currency.toUpperCase() === "BTN" ? "Nu" : currency.toUpperCase();
  return `${sym} ${n.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
}

/** The quotation that currently represents the offer (latest, not superseded). */
export function activeQuotation(entry: EntryDetail): QuotationSummary | null {
  const qs = entry.quotations ?? [];
  if (qs.length === 0) return null;
  const live = qs.filter((q) => q.state !== "SUPERSEDED");
  const pool = live.length ? live : qs;
  return [...pool].sort((a, b) => (b.versionNumber ?? 0) - (a.versionNumber ?? 0))[0] ?? null;
}

export type FolioView = {
  state: "Not opened" | "Provisional" | "Live" | "Settled";
  frame: "b-live" | "b-transit" | "b-bound";
};

export function folioView(entry: EntryDetail): FolioView {
  const s = entry.folio?.state?.toUpperCase();
  if (!s) return { state: "Not opened", frame: "b-live" };
  if (s === "SETTLED" || s === "CLOSED") return { state: "Settled", frame: "b-bound" };
  if (s === "LIVE") return { state: "Live", frame: "b-bound" };
  return { state: "Provisional", frame: "b-transit" };
}

export type DeskFinancials = {
  currency: string;
  frozen: boolean;
  /** Indicative offer total from the active quotation, if any. */
  indicativeTotal: number | null;
  /** Frozen nightly rate from the reservation, if confirmed. */
  frozenRate: number | null;
  /** Frozen rate × nights when both are known. */
  frozenTotal: number | null;
  nights: number | null;
  advanceReceived: number;
  chargesTotal: number;
  outstanding: number | null;
  folio: FolioView;
};

export function deriveFinancials(entry: EntryDetail): DeskFinancials {
  const quote = activeQuotation(entry);
  const reservation = entry.reservation ?? null;
  const folio = entry.folio ?? null;
  const currency = quote?.currency ?? entry.folio?.lines?.[0]?.currency ?? "BTN";

  const nights =
    nightsBetween(
      reservation?.frozenCheckInDate ?? entry.checkInDate,
      reservation?.frozenCheckOutDate ?? entry.checkOutDate,
    ) ?? null;

  const frozenRate = reservation ? toNum(reservation.frozenRate) : null;
  const frozenTotal = frozenRate !== null && nights ? frozenRate * nights : null;

  const advanceReceived = (folio?.payments ?? [])
    .filter((p) => !/OUT|REFUND/i.test(p.paymentDirection ?? ""))
    .reduce((s, p) => s + toNum(p.amount), 0);

  const chargesTotal = (folio?.lines ?? []).reduce((s, l) => s + toNum(l.amount), 0);

  return {
    currency,
    frozen: !!reservation,
    indicativeTotal: quote ? toNum(quote.totalAmount) : null,
    frozenRate,
    frozenTotal,
    nights,
    advanceReceived,
    chargesTotal,
    outstanding: folio?.outstandingBalance !== undefined ? toNum(folio.outstandingBalance) : null,
    folio: folioView(entry),
  };
}

export type StepState = "done" | "cur" | "future";

export function currentStepOrder(entry: EntryDetail): number {
  if (entry.status === "CLOSED" || entry.currentStage === "TERMINAL") return 9;
  return stepForStage(entry.currentStage).order;
}

/**
 * Furthest step the operator can navigate to. Usually the current step, but the
 * commitment boundary lives between two desk steps and one backend transition:
 * confirming happens *while at S3* and crosses into S4. So an entry at S3 can
 * reach the Confirm step (4) to perform the freeze.
 */
export function maxReachableOrder(entry: EntryDetail): number {
  const cur = currentStepOrder(entry);
  if (entry.currentStage === "S3") return 4;
  return cur;
}

/**
 * S3 exit / pre-confirm readiness (SIG-S3 §exit, SIG-S4) — the gates that must be
 * green before the booking can be frozen at S4. Mirrors the existing S3 workspace
 * checklist. Payment "satisfied" is approximated from folio payments (the server
 * re-validates the real payment-status on confirm).
 */
export function s3Readiness(entry: EntryDetail): Precondition[] {
  const folio = entry.folio;
  const hold = entry.committedHold;
  const inPayments = (folio?.payments ?? []).filter(
    (p) => /IN/i.test(p.paymentDirection ?? "") && !/OUT|REFUND/i.test(p.paymentDirection ?? ""),
  );
  const proforma = (folio?.invoices ?? []).some((i) => i.invoiceType === "PROFORMA");
  return [
    { label: "Quote accepted", met: (entry.quotations ?? []).some((q) => q.state === "ACCEPTED") },
    { label: "Provisional folio & billing model", met: !!folio?.billingModel && folio?.state === "PROVISIONAL" },
    { label: "Cancellation terms recorded", met: !!entry.cancellationDisclosure },
    { label: "Advance payment taken", met: inPayments.length > 0 },
    { label: "Advance reconciled", met: folio?.advancePaymentReconciliationComplete === true },
    { label: "Proforma invoice on folio", met: proforma },
    { label: "Room held", met: hold?.state === "PLACED" || hold?.state === "UPGRADED" },
    {
      label: "Guest contact on file",
      met: !!(entry.guestProfile?.email || entry.guestProfile?.phone),
    },
  ];
}

/** Alias — the confirm step's gate is exactly the S3 exit checklist. */
export function confirmReadiness(entry: EntryDetail): Precondition[] {
  return s3Readiness(entry);
}

export function canConfirm(entry: EntryDetail): boolean {
  return entry.currentStage === "S3" && s3Readiness(entry).every((c) => c.met);
}

/** S1 exit readiness (SIG-S1) — the gates before progressing to Quote (S2). */
export function s1Readiness(entry: EntryDetail): Precondition[] {
  const configs = entry.availabilityConfigs ?? [];
  const preferred = configs.find((c) => c.optionSelected != null && !c.isStale);
  return [
    { label: "Stay dates set", met: !!(entry.checkInDate && entry.checkOutDate) },
    { label: "Guest count set", met: (entry.guestCount ?? 0) >= 1 },
    {
      label: "Guest contact on file",
      met: !!(entry.guestProfile?.email || entry.guestProfile?.phone),
    },
    { label: "Availability searched", met: configs.length > 0 },
    { label: "Preferred room selected", met: !!preferred },
  ];
}

export function canProgressS1(entry: EntryDetail): boolean {
  return (
    entry.currentStage === "S1" &&
    !!(entry.checkInDate && entry.checkOutDate) &&
    s1Readiness(entry).every((c) => c.met)
  );
}

/** S2 exit readiness (SIG-S2) — gates before reservation setup (S3). */
export function s2Readiness(entry: EntryDetail, now: number = Date.now()): Precondition[] {
  const accepted = (entry.quotations ?? []).find((q) => q.state === "ACCEPTED");
  const sealed = (entry.availabilityConfigs ?? []).some((c) => c.sealedAt && c.optionSelected);
  const holds = entry.speculativeHolds ?? [];
  const holdsOk = holds.length === 0 || holds.every((h) => h.state === "PLACED" || h.state === "UPGRADED");
  const validOk = !accepted?.validUntil || new Date(accepted.validUntil).getTime() > now;
  return [
    { label: "Availability sealed from Inquiry", met: sealed },
    { label: "Quote accepted by guest", met: !!accepted },
    { label: "Accepted quote still valid", met: !accepted || validOk },
    { label: "Any holds still healthy", met: holdsOk },
  ];
}

export function canProgressS2(entry: EntryDetail): boolean {
  return (
    entry.currentStage === "S2" &&
    (entry.quotations ?? []).some((q) => q.state === "ACCEPTED") &&
    s2Readiness(entry).every((c) => c.met)
  );
}

/** S5 exit readiness (SIG-S5 §1.5) — gates before check-in (S6). Guest-present is a UI attestation. */
export function s5Readiness(entry: EntryDetail): Precondition[] {
  const h1 = (entry.handoffs ?? []).find((h) => h.handoffType === "H1");
  const tasks = entry.preArrivalTasks ?? [];
  const creditExtended = entry.reservation?.creditCeilingIfExtended != null;
  return [
    { label: "Handoff to front desk fulfilled", met: h1?.state === "FULFILLED" },
    { label: "Room assigned", met: (entry.roomAssignments ?? []).length > 0 },
    {
      label: "Pre-arrival tasks done",
      met: tasks.length > 0 && tasks.every((t) => t.status === "COMPLETE" || t.status === "WAIVED"),
    },
    { label: "Advance reconciled", met: entry.folio?.advancePaymentReconciliationComplete === true },
    {
      label: "Credit ceiling acknowledged",
      met: !creditExtended || !!entry.creditCeilingTier2AcknowledgedAt,
    },
  ];
}

export function canProgressS5(entry: EntryDetail, guestPresent: boolean): boolean {
  return entry.currentStage === "S5" && guestPresent && s5Readiness(entry).every((c) => c.met);
}

/** S6 exit readiness (SIG-S6) — derivable gates before check-in completes (folio goes live → S7). */
export function s6Readiness(entry: EntryDetail): Precondition[] {
  const g = entry.guestProfile;
  const a = (entry.roomAssignments ?? [])[0];
  const ps = a?.room?.physicalState;
  const roomReady = ps
    ? ps === "AVAILABLE_CLEAN" || ps === "AVAILABLE_INSPECTED"
    : a?.deficientAtAssignment
      ? !!(a.acknowledgementActorId && a.acknowledgementAt)
      : !!a;
  const h1 = (entry.handoffs ?? []).find((h) => h.handoffType === "H1");
  const h1Ok = entry.walkInCompressed === true || !h1 || h1.state === "FULFILLED" || h1.state === "CLOSED";
  const isVip = !!g?.vipTier?.trim();
  return [
    { label: "Identity verified", met: !!g?.identityVerifiedAt },
    { label: "Room assigned & ready", met: !!a && roomReady },
    { label: "Advance reconciled", met: entry.folio?.advancePaymentReconciliationComplete === true },
    { label: "Handoff fulfilled", met: h1Ok },
    { label: "VIP arrival notified", met: !isVip || (entry.vipArrivalNotifications ?? []).length > 0 },
  ];
}

/** S7 exit readiness (SIG-S7) — derivable gates before checkout prep (S8). Night audit is reported separately. */
export function s7Readiness(entry: EntryDetail): Precondition[] {
  const folio = entry.folio;
  const h4 = (entry.handoffs ?? []).find((h) => h.handoffType === "H4");
  const h4Init = !!h4 && !h4.rejectedAt && ["CREATED", "ACCEPTED", "FULFILLED", "CLOSED"].includes(h4.state);
  const deficient = entry.roomAssignments?.[0]?.room?.deficientConditionRecords ?? [];
  const deficientFinal =
    deficient.length === 0 ||
    deficient.every((d) => ["RESOLVED", "UNRESOLVED", "DEFICIENT_UNRESOLVED_AT_CHECKOUT"].includes(d.status));
  const openDisputes = (entry.disputes ?? []).filter((d) => d.status === "OPEN" || d.status === "IN_PROGRESS");
  return [
    { label: "Folio is live", met: folio?.state === "LIVE" },
    { label: "Charges posted", met: (folio?.lines ?? []).length > 0 },
    { label: "Pre-checkout handoff started", met: h4Init },
    { label: "Deficiencies resolved", met: deficientFinal },
    { label: "No open disputes", met: openDisputes.length === 0 },
  ];
}

export function canProgressS7(entry: EntryDetail, nightAuditOk: boolean): boolean {
  return entry.currentStage === "S7" && nightAuditOk && s7Readiness(entry).every((c) => c.met);
}

/** S8 exit readiness (SIG-S8) — gates before settlement & close (S9). H5 is auto-created on progress. */
export function s8Readiness(entry: EntryDetail): Precondition[] {
  const folio = entry.folio;
  const room = entry.roomAssignments?.[0]?.room;
  const keyReturn = (entry.keyReturnRecords ?? [])[0];
  const inspection = (entry.roomInspectionRecords ?? [])[0];
  const h4 = (entry.handoffs ?? []).find((h) => h.handoffType === "H4");
  const openDisputes = (entry.disputes ?? []).filter((d) => d.status === "OPEN" || d.status === "IN_PROGRESS");
  return [
    { label: "Folio settled", met: folio?.state === "SETTLED" || folio?.state === "OUTSTANDING" },
    {
      label: "Keys returned",
      met: !!keyReturn && (keyReturn.countReconciled || !!keyReturn.reconciliationNote),
    },
    { label: "Room released to housekeeping", met: room?.currentClaimState === "DEPARTED_DIRTY" },
    { label: "Room inspection recorded", met: !!inspection },
    { label: "Pre-checkout handoff fulfilled", met: !!h4 && (h4.state === "FULFILLED" || h4.isAutoFulfilled === true) },
    { label: "No open disputes", met: openDisputes.length === 0 },
  ];
}

export function canProgressS8(entry: EntryDetail): boolean {
  return entry.currentStage === "S8" && s8Readiness(entry).every((c) => c.met);
}

export function stepStateFor(order: number, currentOrder: number): StepState {
  if (order < currentOrder) return "done";
  if (order === currentOrder) return "cur";
  return "future";
}

export type Precondition = { label: string; met: boolean };

/** Real-state preconditions surfaced in the gate bar for each step. */
export function preconditionsFor(entry: EntryDetail, step: DeskStep): Precondition[] {
  const fin = deriveFinancials(entry);
  const quote = activeQuotation(entry);
  switch (step.key) {
    case "inquiry":
      return [
        {
          label: "Configuration chosen",
          met: !!(entry.availabilityConfigs ?? []).some((c) => c.optionSelected),
        },
      ];
    case "quote":
      return [
        {
          label: "Quote sent to guest",
          met: !!quote && (quote.state === "SENT" || quote.state === "ACCEPTED"),
        },
      ];
    case "setup":
      return s3Readiness(entry);
    case "confirm":
      return [{ label: "Booking confirmed & frozen", met: fin.frozen }];
    case "arrival":
      return s5Readiness(entry);
    case "checkin":
      return fin.folio.state === "Live" || fin.folio.state === "Settled"
        ? [{ label: "Checked in · folio live", met: true }]
        : s6Readiness(entry);
    case "stay":
      return s7Readiness(entry);
    case "checkout":
      return s8Readiness(entry);
    case "closed":
      return [{ label: "Stay sealed", met: !!entry.closedAt || entry.status === "CLOSED" }];
    default:
      return [];
  }
}

export { DESK_STEPS };
