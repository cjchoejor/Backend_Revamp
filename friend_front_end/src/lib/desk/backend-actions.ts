/**
 * Per-action "what runs in the backend" attribution for S2–S9, surfaced inline on each
 * desk step (mirrors the S1_BACKEND map that lives in inquiry-step). Curated from the
 * SIG / DEV-SPEC; `ref` points at the real module / policy id so it stays auditable.
 *
 * Shape: STAGE_ACTIONS[stage][actionKey] = BackendItem[].
 */
import type { BackendItem } from "./backend-map";

export const STAGE_ACTIONS: Record<string, Record<string, BackendItem[]>> = {
  // ───────── Intake · before S1 (the "Start a booking" page) ─────────
  INTAKE: {
    lookups: [
      { name: "Guest phone match", ref: "searchGuestProfiles · /api/guest-profiles/search", detail: "Typing a known number surfaces the existing guest profile so you reuse it instead of duplicating." },
      { name: "Travel-agent / corporate lookup", ref: "/api/lookups/travel-agents · /corporate-accounts", detail: "L1 party search to link the inquiry to a negotiated rate card (Phase B/C)." },
      { name: "Child-policy snapshot", ref: "getChildPolicy · /api/lookups/child-policy", detail: "Caps the child-age inputs at the configured unaccompanied-minor age." },
    ],
    create: [
      { name: "createGuestProfile", ref: "services/domain (guest profile)", detail: "Creates the guest profile when it's a new guest (skipped when an existing one is adopted)." },
      { name: "createInquiry → s1-inquiry-service", ref: "services/domain/s1-inquiry-service.ts", detail: "Creates the inquiry, validates the linked party, records the sourceChannel + notes." },
      { name: "Policy 3 — custodian assignment", ref: "p03-initial-custodian-assignment.ts", detail: "Assigns the owning actor from the sourceChannel (throws on an unknown channel)." },
      { name: "createEntry → s1-entry-service", ref: "services/domain/s1-entry-service.ts", detail: "Creates the Entry + head-count breakdown (adultCount / childCount / childAges)." },
      { name: "Policy 64 — group detection", ref: "p64 · registry.groupDetection.guestCountThreshold", detail: "Flags the entry GROUP when guest count crosses the threshold." },
      { name: "Child / capacity validation", ref: "capacity-validation-service.ts", detail: "BLOCK checks at intake: unaccompanied-minor, adult:child ratio, over-capacity vs room type." },
      { name: "W20 — ENTRY_EXPIRY armed", ref: "ENTRY_EXPIRY · w20-entry-expiry-worker.ts", detail: "Arms the S1 expiry timer (registry.s1Expiry.minutes) on the new entry." },
      { name: "S1 state machine", ref: "state-machines/s1-state-machine.ts", detail: "Sets the new entry to the (ACTIVE, S1) composite state." },
    ],
  },

  // ───────── S2 · Quote ─────────
  S2: {
    build: [
      { name: "Pricing pipeline engine", ref: "engines/pricing-pipeline-engine.ts", detail: "Builds the nightly rate, discounts and totals for the quotation." },
      { name: "Tax engine", ref: "engines/tax-engine.ts", detail: "Applies tax lines to the quoted total." },
      { name: "Agent / corporate rate resolution", ref: "lib/agent-rate-resolution.ts", detail: "Overrides with the negotiated rate-card rate when the inquiry is linked to a party." },
      { name: "s2-quotation-service.createQuotation", ref: "services/domain/s2-quotation-service.ts", detail: "Persists the draft quotation + commercial terms." },
    ],
    discount: [
      { name: "Policy 23 — discount actor ceiling", ref: "p23 · registry.discount.actorCeiling", detail: "Caps the discount an actor level may apply without escalation." },
      { name: "Below-MSR approval", ref: "pricing / s2-quotation-service", detail: "Rates below minimum-sellable require L3 (skipped for negotiated agent rates)." },
    ],
    send: [
      { name: "s2-quotation-service.sendQuotation", ref: "services/domain/s2-quotation-service.ts", detail: "Marks the quote SENT and emails it to the guest." },
      { name: "W15 — quotation validity armed", ref: "QUOTATION_VALIDITY_W15 · w15", detail: "Arms the validity timer (registry.quotationValidity.days)." },
      { name: "W22 — acknowledgement window", ref: "ACKNOWLEDGEMENT_WINDOW_W22 · w22", detail: "Tracks the guest acknowledgement SLA." },
      { name: "Quotation email", ref: "stage-email-helpers · QUOTATION_EMAIL", detail: "Threaded guest email with rate / total / validity." },
    ],
    accept: [
      { name: "S2 quotation state machine", ref: "state-machines/s2-quotation-state-machine.ts", detail: "SENT → ACCEPTED on recorded guest acceptance." },
    ],
    hold: [
      { name: "s2-hold-service", ref: "services/domain/s2-hold-service.ts", detail: "Places a speculative hold within the placement threshold." },
      { name: "W2 — speculative hold expiry", ref: "SPECULATIVE_HOLD_EXPIRY_W2 · w2", detail: "Releases the hold if not converted before TTL (registry.s2HoldExpiry.minutes)." },
    ],
    advance: [
      { name: "S2→S3 state machine", ref: "state-machines/s2-s3-state-machine.ts", detail: "Requires all S2 exit evidence before advancing to setup." },
      { name: "Optimistic-lock match", ref: "p01-entry-version-optimistic-lock-match.ts", detail: "Rejects the advance if the entry version is stale." },
    ],
  },

  // ───────── S3 · Set up ─────────
  S3: {
    folio: [
      { name: "FolioService.getOrCreate", ref: "services/domain (folio)", detail: "Creates / returns the provisional folio and sets the billing model." },
    ],
    disclosure: [
      { name: "Policy 34 — disclosure before hold", ref: "p34 / s3-hold-service", detail: "Cancellation terms must be disclosed before a committed hold can be placed." },
    ],
    advance: [
      { name: "Advance payment service", ref: "services/domain (advance payment)", detail: "Records / reconciles the advance and recomputes payment status." },
      { name: "W34 — advance follow-up", ref: "ADVANCE_PAYMENT_FOLLOW_UP_W34 · w34", detail: "Chases the advance within its window." },
    ],
    hold: [
      { name: "s3-hold-service", ref: "services/domain/s3-hold-service.ts", detail: "Places the committed hold against the room type." },
      { name: "W3 — committed hold expiry", ref: "COMMITTED_HOLD_EXPIRY_W3 · w3 · registry.holdExpiry.minutes", detail: "Releases the committed hold if not confirmed before TTL." },
    ],
    dispatch: [
      { name: "dispatchInvoice (PROFORMA)", ref: "stage-email-helpers · PROFORMA_INVOICE_EMAIL", detail: "Issues + emails the proforma invoice with the balance due." },
    ],
    group: [
      { name: "FOC validation engine", ref: "engines/foc-validation-engine.ts", detail: "Validates FOC entitlement; GM approval recorded for group FOC." },
      { name: "Group billing coordination", ref: "services/domain (group)", detail: "Coordinator + payment milestones for GROUP entries." },
    ],
    reentry: [
      { name: "S3 re-entry state machine", ref: "state-machines/s3-reentry-state-machine.ts", detail: "Governs FOM re-entry back to Quote / Inquiry." },
      { name: "Re-entry consequence engine", ref: "engines/re-entry-consequence-engine.ts", detail: "Computes the consequences (new segment, sealed prior) of a re-entry." },
    ],
    cancel: [
      { name: "cancelEntryAtS3", ref: "services/application/cancellation-service.ts", detail: "Releases hold, supersedes invoices, posts penalty, transitions to CANCELLED." },
    ],
  },

  // ───────── S4 · Confirm (freeze) ─────────
  S4: {
    confirm: [
      { name: "Confirmation authority thresholds", ref: "confirmation.authorityThresholds", detail: "Required actor level to confirm given overlap / conference / value." },
      { name: "Pricing pipeline (freeze)", ref: "engines/pricing-pipeline-engine.ts", detail: "Freezes the confirmed rate so it carries unchanged downstream." },
      { name: "Overbooking detection engine", ref: "engines/overbooking-detection-engine.ts", detail: "Checks for overbooking at confirmation." },
      { name: "confirmReservation", ref: "services/domain (S4)", detail: "Mints the reservation and transitions to (ACTIVE, S4)." },
    ],
    activate: [
      { name: "activatePreArrival", ref: "services/domain (pre-arrival)", detail: "Opens the pre-arrival window and moves the entry to S5." },
      { name: "W4 — pre-arrival countdown armed", ref: "PRE_ARRIVAL_COUNTDOWN_W4 · w4", detail: "Arms the pre-arrival / no-show countdown." },
    ],
  },

  // ───────── S5 · Arrival ─────────
  S5: {
    handoff: [
      { name: "Handoff service (H1)", ref: "services/infrastructure (handoff)", detail: "Accept (checklist) then fulfil the reservations → front-desk handoff." },
      { name: "W25 — H1 acceptance window", ref: "H?_ACCEPTANCE_W25 · w25", detail: "Tracks the acceptance SLA on the H1 handoff." },
    ],
    assign: [
      { name: "Room-assignment suggestion engine", ref: "engines/room-assignment-suggestion-engine.ts", detail: "Suggests a room from committed hold / preferred / catalog." },
      { name: "Assigned-room readiness", ref: "p01-assigned-room-physical-readiness-for-arrival.ts", detail: "Assigned room must be ready or its deficiency acknowledged." },
    ],
    reconcile: [
      { name: "Policy 28 / 44 — advance + ceiling", ref: "p28 / p44", detail: "Advance reconciliation + credit-ceiling proximity acknowledgement." },
      { name: "Credit-ceiling monitor engine", ref: "engines/credit-ceiling-monitor-engine.ts", detail: "Tracks received vs ceiling for the tier-2 gate." },
      { name: "W5 — no-show cutoff", ref: "NO_SHOW_CUTOFF_W5 · registry.noShow.graceMinutes", detail: "Determines no-show at the cutoff if the guest hasn't arrived." },
    ],
    advance: [
      { name: "Entry lifecycle state machine", ref: "state-machines/entry-lifecycle-state-machine.ts", detail: "Guards S5→S6; requires guest physically present." },
    ],
  },

  // ───────── S6 · Check-in ─────────
  S6: {
    verify: [
      { name: "Policy 16 — identity verification", ref: "p16 (identity verification)", detail: "A verification event is required before check-in completes (VIP path still records one)." },
    ],
    vip: [
      { name: "VIP notification routing", ref: "registry.vip.notificationRoutingPerTier", detail: "Routes VIP arrival notifications per tier (blocking for S6 readiness)." },
      { name: "W14 — VIP arrival notification", ref: "VIP_ARRIVAL_NOTIFICATION_W14 · w14", detail: "Async VIP staff ping after the commencement record." },
    ],
    commit: [
      { name: "completeCheckInToS7", ref: "services/domain (check-in)", detail: "Takes the folio LIVE, marks the room occupied, mints H2/H3 — the second commitment boundary." },
      { name: "Policy 44 / 45 — credit ceiling gate", ref: "p44 / p45 · registry.creditCeiling.tier2Percent", detail: "Tier-2 credit-ceiling acknowledgement gate at check-in." },
      { name: "W25 — H2/H3 acceptance", ref: "H2_H3_ACCEPTANCE_W25 · w25", detail: "Tracks acceptance of the handoffs created at go-live." },
    ],
  },

  // ───────── S7 · Stay ─────────
  S7: {
    charge: [
      { name: "s7-folio-lines-service", ref: "services/domain/s7-folio-lines-service.ts", detail: "Posts charge / correction / credit note to the live folio." },
      { name: "Policy 45 — credit-ceiling charge gate", ref: "p45 · registry.creditCeiling.softGatePercent", detail: "Soft gate at 100% and hard gate at tier-2 percent on posting." },
      { name: "W12 — credit-ceiling monitoring", ref: "CREDIT_CEILING_MONITORING_W12 · w12", detail: "Emits advisory thresholds as charges accrue." },
    ],
    nightAudit: [
      { name: "Night-audit engine", ref: "engines/night-audit-engine.ts", detail: "Runs the nightly audit / stay-night roll." },
      { name: "W6 — night audit", ref: "NIGHT_AUDIT_W6 · w6", detail: "Schedules the nightly audit run." },
    ],
    handoff: [
      { name: "Handoff service (H4 pre-checkout)", ref: "services/infrastructure (handoff)", detail: "Create → accept → fulfil the H4 pre-checkout handoff." },
      { name: "W25 — H4 acceptance", ref: "H4_ACCEPTANCE_W25 · registry.handoffAck.seconds", detail: "Tracks the H4 acceptance window." },
    ],
    dispute: [
      { name: "Dispute-gate engine", ref: "engines/dispute-gate-engine.ts", detail: "Gates progression while a billing dispute is open." },
      { name: "W27 — dispute SLA", ref: "DISPUTE_SLA_W27 · w27", detail: "Tracks the SLA on an open dispute." },
    ],
    advance: [
      { name: "Entry lifecycle state machine", ref: "state-machines/entry-lifecycle-state-machine.ts", detail: "Guards S7→S8; night audit must have run." },
    ],
  },

  // ───────── S8 · Check-out ─────────
  S8: {
    keyReturn: [
      { name: "Key return record", ref: "recordKeyReturn · services/domain (checkout)", detail: "Records keys returned vs issued; a mismatch requires a reconciliation note." },
    ],
    inspection: [
      { name: "Room inspection + W9", ref: "POST_CHECKOUT_INSPECTION_W9 · w9", detail: "Records inspection / deficiency / damage; schedules post-checkout inspection." },
      { name: "W24 — housekeeping SLA", ref: "HOUSEKEEPING_SLA_W24 · w24", detail: "Tracks the housekeeping turnaround SLA." },
    ],
    settle: [
      { name: "Settlement service", ref: "services/domain (settlement)", detail: "Takes payment — the last commitment boundary; folio closes, room released." },
      { name: "FOM override frequency", ref: "registry.fomOverride.frequency · W32", detail: "FOM overrides at checkout and their frequency cap." },
      { name: "Tax engine + doc generation", ref: "engines/tax-engine.ts, doc-gen", detail: "Finalises totals and renders the final invoice." },
    ],
    reentry: [
      { name: "s8-re-entry-service", ref: "services/domain/s8-re-entry-service.ts", detail: "S8→S7 re-entry to post extra charges." },
    ],
    advance: [
      { name: "S8→S9 state machine", ref: "state-machines/s8-s9-state-machine.ts", detail: "Seals the stay into the closed state." },
    ],
  },

  // ───────── S9 · Closed (post-stay, background) ─────────
  S9: {
    background: [
      { name: "W28 — feedback solicitation", ref: "FEEDBACK_SOLICITATION_W28 · w28", detail: "Sends the feedback survey email after checkout." },
      { name: "W34 / W8 — payment follow-up", ref: "PAYMENT_FOLLOW_UP_W8 · registry.advancePaymentFollowUp.windowSeconds", detail: "Chases outstanding payment post-stay." },
      { name: "W30 — lost & found retention", ref: "LOST_FOUND_RETENTION_W30 · registry.lostFound.retentionWarning.days", detail: "Warns before lost-and-found retention lapses." },
      { name: "s9-service", ref: "services/domain/s9-service.ts", detail: "Invoices, government submission, payment follow-up, lost & found." },
    ],
  },
};
