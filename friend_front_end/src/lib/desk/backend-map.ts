/**
 * Curated "what the backend does" map, per S1–S9 stage.
 *
 * This is the spec-derived half of the Backend view (the live half — actual timers
 * and the decision-journey trace — is layered on top at render time). Each entry is
 * curated from the SIG (docs/SIG-S*.md) + DEV-SPEC-001 (docs/dev-spec/) and verified
 * against the code (back_end/src/policies, /state-machines, /engines, /workers,
 * /services). Keep `ref` pointing at the real module/policy id so it stays auditable.
 *
 * Rollout status: S1 is fully curated. S2–S9 are a solid first pass (key state
 * machines / policies / engines / workers / timers / handoffs) to be deepened.
 */
import type { Stage } from "@/types/api";

export type BackendItem = {
  /** Human-facing name (policy id, worker code, engine, etc.). */
  name: string;
  /** Optional code/spec reference (file or policy id) — shown as a mono sub-label. */
  ref?: string;
  /** One-line plain-English explanation of what it does at this stage. */
  detail: string;
};

export type StageBackend = {
  stage: Stage;
  /** Operator-facing step label (matches DESK_STEPS). */
  deskStep: string;
  /** What the stage is for, in one line. */
  summary: string;
  stateMachines: BackendItem[];
  policies: BackendItem[];
  engines: BackendItem[];
  /** Background workers + the timers they own. */
  workersTimers: BackendItem[];
  handoffs: BackendItem[];
  services: BackendItem[];
  /** Admin-editable tunables (registry policies / ConfigurationEntry keys) in play. */
  configKeys: BackendItem[];
};

const S1: StageBackend = {
  stage: "S1",
  deskStep: "Inquiry",
  summary:
    "Inquiry intake + live availability search. Mints the Entry, runs availability, records a preferred option, and arms the expiry/dwell timers.",
  stateMachines: [
    { name: "S1 state machine", ref: "state-machines/s1-state-machine.ts", detail: "Guards (ACTIVE,S1) → (ACTIVE,S2/S3), (ACTIVE,S1) ↔ (PARKED,S1), and (ACTIVE,S1) → (EXPIRED)." },
    { name: "Entry lifecycle state machine", ref: "state-machines/entry-lifecycle-state-machine.ts", detail: "Owns the overall status (ACTIVE / PARKED / EXPIRED / CANCELLED) across every stage." },
  ],
  policies: [
    { name: "Policy 1 — entry status & stage gates", ref: "p01-s1-entry-status-and-stage-gates.ts", detail: "Park requires ACTIVE; unpark requires PARKED; blocks actions on EXPIRED entries." },
    { name: "Park allowed-stages guard", ref: "p01-entry-park-allowed-stages.ts", detail: "Entry-level park/unpark is valid only at S1 or S2." },
    { name: "Optimistic-lock match", ref: "p01-entry-version-optimistic-lock-match.ts", detail: "Rejects stage progression if the client's entry version is stale." },
    { name: "Availability query params", ref: "p01-availability-query-params-s1.ts", detail: "Validates the dates / guest-count / room-type of an availability search." },
    { name: "Policy 3 — initial custodian assignment", ref: "p03-initial-custodian-assignment.ts", detail: "Assigns the owning actor from sourceChannel; throws on an unknown channel." },
    { name: "Policy 12 — duplicate-inquiry S1 exit guard", ref: "p12 · registry.duplicateInquiry.blockS1Exit", detail: "Optionally blocks S1→S2 when a duplicate inquiry is detected." },
    { name: "Policy 14 — shadow inventory L4-only", ref: "p14 · registry.shadowInventory.l4Only", detail: "Restricts shadow-inventory availability to L4 actors." },
    { name: "Policy 64 — group detection at entry creation", ref: "p64 · registry.groupDetection.guestCountThreshold", detail: "Flags the entry GROUP when guest count crosses the threshold." },
    { name: "Child / capacity validation", ref: "capacity-validation-service.ts", detail: "BLOCK-severity checks at intake: unaccompanied-minor, adult:child ratio, over-capacity vs room type." },
  ],
  engines: [
    { name: "Availability engine", ref: "engines/availability-engine.ts", detail: "Computes available / deficient / unavailable rooms for the requested window." },
    { name: "Pricing pipeline (indicative)", ref: "engines/pricing-pipeline-engine.ts", detail: "Attaches an indicative-only nightly rate to the availability result (not a quote)." },
  ],
  workersTimers: [
    { name: "W20 — Entry expiry", ref: "ENTRY_EXPIRY · w20-entry-expiry-worker.ts", detail: "Expires the entry if it sits at S1 past its TTL. Paused on park, re-armed on unpark." },
    { name: "W1 — Stage-dwell monitor", ref: "STAGE_DWELL_MONITOR · w1-stage-dwell-monitor.ts", detail: "Fires dwell warnings/escalations and marks availability results stale." },
    { name: "W16 — Processing-lock expiry", ref: "PROCESSING_LOCK_TTL · w16-processing-lock-expiry-worker.ts", detail: "Releases the S1 processing lock if it is not cleared within its TTL." },
  ],
  handoffs: [],
  services: [
    { name: "s1-inquiry-service", ref: "services/domain/s1-inquiry-service.ts", detail: "Creates the inquiry, links travel-agent / corporate party, resolves custodian." },
    { name: "s1-entry-service", ref: "services/domain/s1-entry-service.ts", detail: "Creates the entry, park/unpark, expiry, intake-field edits." },
    { name: "s1-availability-service", ref: "services/domain/s1-availability-service.ts", detail: "Runs the availability query and records the selected option on the configuration." },
    { name: "s1-processing-lock-service", ref: "services/domain/s1-processing-lock-service.ts", detail: "Places/releases the per-entry processing lock during intake." },
  ],
  configKeys: [
    { name: "registry.s1Expiry.minutes", detail: "TTL before an idle S1 entry expires (W20)." },
    { name: "registry.duplicateInquiry.blockS1Exit", detail: "Whether duplicate detection blocks S1 exit (Policy 12)." },
    { name: "registry.groupDetection.guestCountThreshold", detail: "Guest count at which an entry is auto-flagged GROUP (Policy 64)." },
    { name: "registry.shadowInventory.l4Only", detail: "Restrict shadow inventory to L4 (Policy 14)." },
  ],
};

const S2: StageBackend = {
  stage: "S2",
  deskStep: "Quote",
  summary: "Quotation lifecycle (draft → send → acceptance), discounts within authority, optional speculative hold.",
  stateMachines: [
    { name: "S2 quotation state machine", ref: "state-machines/s2-quotation-state-machine.ts", detail: "DRAFT → SENT → ACCEPTED / SUPERSEDED / EXPIRED." },
    { name: "S2→S3 state machine", ref: "state-machines/s2-s3-state-machine.ts", detail: "Guards progression from quotation to the committed-hold setup stage." },
  ],
  policies: [
    { name: "Policy 23 — discount actor ceiling", ref: "p23 · registry.discount.actorCeiling", detail: "Caps the discount each actor level may apply without escalation." },
    { name: "Below-MSR approval", ref: "pricing / s2-quotation-service", detail: "Rates below minimum-sellable require L3; skipped for negotiated agent rates." },
  ],
  engines: [
    { name: "Pricing pipeline engine", ref: "engines/pricing-pipeline-engine.ts", detail: "Builds the quotation's nightly rate, discounts, and totals." },
    { name: "Tax engine", ref: "engines/tax-engine.ts", detail: "Applies tax lines to the quoted total." },
  ],
  workersTimers: [
    { name: "W15 — Quotation validity", ref: "QUOTATION_VALIDITY_W15 · w15-quotation-expiry-worker.ts", detail: "Expires a sent quotation after its validity window." },
    { name: "W22 — Acknowledgement window", ref: "ACKNOWLEDGEMENT_WINDOW_W22 · w22-acknowledgement-window-worker.ts", detail: "Tracks the guest acknowledgement SLA on a sent quote." },
    { name: "W2 — Speculative hold expiry", ref: "SPECULATIVE_HOLD_EXPIRY_W2 · w2-speculative-hold-expiry-worker.ts", detail: "Releases a speculative hold if it is not converted in time." },
  ],
  handoffs: [],
  services: [
    { name: "s2-quotation-service", ref: "services/domain/s2-quotation-service.ts", detail: "Create/send/accept/supersede quotations; resolves agent/corporate rate cards." },
    { name: "s2-hold-service", ref: "services/domain/s2-hold-service.ts", detail: "Places/releases speculative holds within threshold." },
  ],
  configKeys: [
    { name: "registry.quotationValidity.days", detail: "Validity window for a sent quotation (W15)." },
    { name: "registry.discount.actorCeiling", detail: "Per-level discount ceiling (Policy 23)." },
    { name: "registry.s2HoldExpiry.minutes", detail: "Speculative-hold TTL (W2)." },
  ],
};

const S3: StageBackend = {
  stage: "S3",
  deskStep: "Set up",
  summary: "Provisional folio + billing model, cancellation disclosure, advance payment, committed hold, proforma dispatch.",
  stateMachines: [
    { name: "S2→S3 state machine", ref: "state-machines/s2-s3-state-machine.ts", detail: "Guards the committed-hold setup and the S3→S4 confirmation prep." },
    { name: "S3 re-entry state machine", ref: "state-machines/s3-reentry-state-machine.ts", detail: "Governs S3→S1 / re-entry when dates or room type are reconfigured." },
  ],
  policies: [
    { name: "Policy 34 — disclosure before committed hold", ref: "p34 / s3-hold-service", detail: "Cancellation terms must be disclosed before a committed hold can be placed." },
    { name: "Hold expiry / advance gates", ref: "registry.holdExpiry.minutes", detail: "Committed-hold TTL and advance-payment reconciliation gates." },
  ],
  engines: [
    { name: "Pricing pipeline engine", ref: "engines/pricing-pipeline-engine.ts", detail: "Prices the proforma invoice and the advance requirement." },
  ],
  workersTimers: [
    { name: "W3 — Committed hold expiry", ref: "COMMITTED_HOLD_EXPIRY_W3 · w3-committed-hold-expiry-worker.ts", detail: "Releases the committed hold if not confirmed before TTL." },
    { name: "W34 — Advance-payment follow-up", ref: "ADVANCE_PAYMENT_FOLLOW_UP_W34 · w34-advance-payment-follow-up-worker.ts", detail: "Chases the advance payment within its window." },
  ],
  handoffs: [],
  services: [
    { name: "s3-hold-service", ref: "services/domain/s3-hold-service.ts", detail: "Places/releases the committed hold." },
    { name: "folio + cancellation services", ref: "services/application/cancellation-service.ts", detail: "Provisional folio, advance reconciliation, S3 cancellation path." },
  ],
  configKeys: [
    { name: "registry.holdExpiry.minutes", detail: "Committed-hold TTL (W3)." },
    { name: "advancePayment.*", detail: "Advance requirement + reconciliation thresholds." },
  ],
};

const S4: StageBackend = {
  stage: "S4",
  deskStep: "Confirm",
  summary: "Reservation confirmation — the first commitment boundary. Freezes rates and arms the pre-arrival window.",
  stateMachines: [
    { name: "Entry lifecycle state machine", ref: "state-machines/entry-lifecycle-state-machine.ts", detail: "Transitions the confirmed entry to S4 and then opens pre-arrival (S5)." },
  ],
  policies: [
    { name: "Confirmation authority thresholds", ref: "confirmation.authorityThresholds", detail: "Required actor level to confirm depending on overlap / conference / value." },
    { name: "Policy 4 — active at S1 and S4", ref: "p04 (re-entry authority)", detail: "Governs re-entry authority to/from confirmation." },
  ],
  engines: [
    { name: "Pricing pipeline (freeze)", ref: "engines/pricing-pipeline-engine.ts", detail: "Freezes the confirmed rate so it carries unchanged through later stages." },
    { name: "Overbooking detection engine", ref: "engines/overbooking-detection-engine.ts", detail: "Checks for overbooking at confirmation." },
  ],
  workersTimers: [
    { name: "W4 — Pre-arrival countdown", ref: "PRE_ARRIVAL_COUNTDOWN_W4 · activatePreArrival", detail: "Opens the pre-arrival window (S5) and arms its countdown after confirmation." },
  ],
  handoffs: [],
  services: [
    { name: "confirmReservation", ref: "services/domain (S4 confirmation)", detail: "Confirms the reservation, freezes the rate, mints reservation records." },
  ],
  configKeys: [
    { name: "confirmation.authorityThresholds", detail: "Authority bands required to confirm." },
    { name: "overbooking.*", detail: "Overbooking tolerance at confirmation." },
  ],
};

const S5: StageBackend = {
  stage: "S5",
  deskStep: "Arrival",
  summary: "Pre-arrival window: H1 handoff, room assignment, pre-arrival tasks, advance reconcile, no-show cutoff.",
  stateMachines: [
    { name: "Entry lifecycle state machine", ref: "state-machines/entry-lifecycle-state-machine.ts", detail: "Holds the entry in pre-arrival; guards S5→S6 on guest-present." },
  ],
  policies: [
    { name: "Policy 28 / 44 — advance + credit ceiling", ref: "p28 / p44", detail: "Advance reconciliation and credit-ceiling proximity acknowledgement before check-in." },
    { name: "No-show grace", ref: "registry.noShow.graceMinutes", detail: "Grace before the no-show cutoff fires." },
    { name: "Assigned-room readiness", ref: "p01-assigned-room-physical-readiness-for-arrival.ts", detail: "Assigned room must be ready (or deficiency acknowledged) for arrival." },
  ],
  engines: [
    { name: "Room-assignment suggestion engine", ref: "engines/room-assignment-suggestion-engine.ts", detail: "Suggests a room from the committed hold / preferred option / catalog." },
    { name: "Credit-ceiling monitor engine", ref: "engines/credit-ceiling-monitor-engine.ts", detail: "Tracks received vs ceiling for the tier-2 acknowledgement gate." },
  ],
  workersTimers: [
    { name: "W4 — Pre-arrival countdown", ref: "PRE_ARRIVAL_COUNTDOWN_W4 · w4", detail: "Runs the pre-arrival countdown toward the no-show cutoff." },
    { name: "W5 — No-show cutoff", ref: "NO_SHOW_CUTOFF_W5 · w5", detail: "Determines no-show at the cutoff if the guest has not arrived." },
    { name: "W23 — Room-readiness SLA", ref: "ROOM_READINESS_SLA_W23 · w23-room-readiness-sla-worker.ts", detail: "Tracks the SLA for readying the assigned room." },
    { name: "W25 — H1 acceptance", ref: "H?_ACCEPTANCE_W25 · w25-handoff-acceptance-worker.ts", detail: "Tracks the acceptance window on the H1 handoff." },
  ],
  handoffs: [
    { name: "H1 — reservations → front desk", ref: "handoff-service (H1)", detail: "Accept (checklist) then fulfil before the guest can check in." },
  ],
  services: [
    { name: "pre-arrival + room-assignment services", ref: "services/domain (pre-arrival, room-assignment)", detail: "H1 accept/fulfil, room assignment, task complete/waive, advance reconcile." },
  ],
  configKeys: [
    { name: "registry.noShow.graceMinutes", detail: "No-show grace window (W5)." },
    { name: "registry.creditCeiling.*", detail: "Tier-2 percent + advisory thresholds." },
  ],
};

const S6: StageBackend = {
  stage: "S6",
  deskStep: "Check-in",
  summary: "Identity verification, VIP arrival routing, registration + keys. Check-in goes live (folio LIVE, room occupied).",
  stateMachines: [
    { name: "Entry lifecycle state machine", ref: "state-machines/entry-lifecycle-state-machine.ts", detail: "Guards S6→S7; VIP arrival ack is blocking for S6 readiness." },
  ],
  policies: [
    { name: "Policy 16 — identity verification", ref: "p16 (identity verification)", detail: "A verification event is required before check-in completion (VIP path still records one)." },
    { name: "Policy 44 / 45 — credit ceiling gate", ref: "p44 / p45 · registry.creditCeiling.tier2Percent", detail: "Tier-2 credit-ceiling acknowledgement gate at check-in." },
    { name: "VIP notification routing", ref: "registry.vip.notificationRoutingPerTier", detail: "Routes VIP arrival notifications per tier (blocking for readiness)." },
  ],
  engines: [
    { name: "Credit-ceiling monitor engine", ref: "engines/credit-ceiling-monitor-engine.ts", detail: "Evaluates ceiling proximity at the check-in gate." },
  ],
  workersTimers: [
    { name: "W14 — VIP arrival notification", ref: "VIP_ARRIVAL_NOTIFICATION_W14 · w14", detail: "Async VIP staff ping after the VIP commencement record." },
    { name: "W25 — H2/H3 acceptance", ref: "H2_H3_ACCEPTANCE_W25 · w25", detail: "Tracks acceptance of the H2/H3 handoffs created at go-live." },
  ],
  handoffs: [
    { name: "H2 / H3 — created at go-live", ref: "handoff-service (H2/H3)", detail: "Housekeeping / department handoffs minted when check-in completes." },
  ],
  services: [
    { name: "check-in service", ref: "services/domain (completeCheckInToS7)", detail: "Verifies identity, registers, issues keys, takes folio LIVE, marks room occupied." },
  ],
  configKeys: [
    { name: "registry.vipArrivalAck.seconds", detail: "VIP arrival acknowledgement window." },
    { name: "registry.vip.notificationRoutingPerTier", detail: "VIP routing per tier (SIG-S6 §9)." },
  ],
};

const S7: StageBackend = {
  stage: "S7",
  deskStep: "Stay",
  summary: "In-house: live folio charge posting under credit-ceiling gates, night audit, H4 pre-checkout, disputes.",
  stateMachines: [
    { name: "Entry lifecycle state machine", ref: "state-machines/entry-lifecycle-state-machine.ts", detail: "Guards S7→S8; night audit must have run." },
  ],
  policies: [
    { name: "Policy 45 — credit-ceiling charge gate", ref: "p45 · registry.creditCeiling.softGatePercent", detail: "Soft gate at 100% and hard gate at tier-2 percent on charge posting." },
    { name: "Deficient-resolution deadline", ref: "registry.deficientResolution.deadlineHours", detail: "Deadline to resolve a room deficiency raised in-house." },
    { name: "Handoff acceptance window", ref: "registry.handoffAck.seconds", detail: "Acceptance SLA for the H2 + H4 handoffs." },
  ],
  engines: [
    { name: "Night-audit engine", ref: "engines/night-audit-engine.ts", detail: "Runs the nightly audit / stay-night roll." },
    { name: "Credit-ceiling monitor engine", ref: "engines/credit-ceiling-monitor-engine.ts", detail: "Drives tier-1/tier-2 advisory thresholds during the stay." },
    { name: "Dispute-gate engine", ref: "engines/dispute-gate-engine.ts", detail: "Gates progression while a billing dispute is open." },
    { name: "Pricing + tax engines", ref: "engines/pricing-pipeline-engine.ts, tax-engine.ts", detail: "Price posted charges, corrections, and credit notes." },
  ],
  workersTimers: [
    { name: "W6 — Night audit", ref: "NIGHT_AUDIT_W6 · w6", detail: "Schedules the nightly audit run." },
    { name: "W12 — Credit-ceiling monitoring", ref: "CREDIT_CEILING_MONITORING_W12 · w12", detail: "Emits advisory credit-ceiling thresholds as charges accrue." },
    { name: "W25 — H4 pre-checkout acceptance", ref: "H4_ACCEPTANCE_W25 · w25", detail: "Tracks the H4 pre-checkout handoff acceptance window." },
    { name: "W27 — Dispute SLA", ref: "DISPUTE_SLA_W27 · w27-dispute-sla-worker.ts", detail: "Tracks the SLA on an open dispute." },
    { name: "W10 — Deficient-resolution deadline", ref: "DEFICIENT_RESOLUTION_DEADLINE_W10 · w10", detail: "Fires when a room deficiency passes its resolution deadline." },
  ],
  handoffs: [
    { name: "H2 / H3 / H4", ref: "handoff-service (H2/H3/H4)", detail: "In-house housekeeping/department + the H4 pre-checkout handoff (create → accept → fulfil)." },
  ],
  services: [
    { name: "s7-folio-lines-service", ref: "services/domain/s7-folio-lines-service.ts", detail: "Post charge / correction / credit note; advisory credit-ceiling thresholds." },
  ],
  configKeys: [
    { name: "registry.creditCeiling.advisoryThresholds", detail: "Tier-1/tier-2 advisory percentages (W12)." },
    { name: "registry.handoffAck.seconds", detail: "H2 + H4 acceptance windows." },
    { name: "registry.deficientResolution.deadlineHours", detail: "Room-deficiency resolution deadline (W10)." },
  ],
};

const S8: StageBackend = {
  stage: "S8",
  deskStep: "Check-out",
  summary: "Checkout: final bill, key return, room inspection, settlement (the last commitment boundary), final invoice.",
  stateMachines: [
    { name: "S8→S9 state machine", ref: "state-machines/s8-s9-state-machine.ts", detail: "Guards S8→S9 closure and S8→S7 re-entry for extra charges." },
  ],
  policies: [
    { name: "FOM override authority", ref: "fomOverride.frequency", detail: "Front-office-manager overrides at checkout and their frequency limit." },
    { name: "Settlement gates", ref: "settlement service", detail: "Folio must settle (method / ref / partial / FOM-ack) before closure." },
  ],
  engines: [
    { name: "Tax engine + document generation", ref: "engines/tax-engine.ts, doc-gen", detail: "Finalises the invoice totals and renders the final invoice." },
  ],
  workersTimers: [
    { name: "W26 — Checkout time", ref: "CHECKOUT_TIME_W26 · w26-checkout-time-worker.ts", detail: "Late-checkout timer / cutoff." },
    { name: "W9 — Post-checkout inspection", ref: "POST_CHECKOUT_INSPECTION_W9 · w9", detail: "Schedules room inspection after checkout." },
    { name: "W24 — Housekeeping SLA", ref: "HOUSEKEEPING_SLA_W24 · w24", detail: "Tracks the housekeeping turnaround SLA." },
    { name: "W32 — FOM override frequency", ref: "FOM_OVERRIDE_FREQUENCY_W32 · w32/w33", detail: "Monitors FOM override frequency." },
  ],
  handoffs: [
    { name: "H4 — pre-checkout", ref: "handoff-service (H4)", detail: "Fulfilled as part of the checkout flow." },
  ],
  services: [
    { name: "checkout + settlement + s8-re-entry", ref: "services/domain/s8-re-entry-service.ts", detail: "Final bill, settlement, room inspection, S8→S7 re-entry." },
  ],
  configKeys: [
    { name: "checkout.cutoffTime", detail: "Standard checkout cutoff (W26)." },
    { name: "registry.fomOverride.frequency", detail: "FOM override frequency cap (W32)." },
  ],
};

const S9: StageBackend = {
  stage: "S9",
  deskStep: "Closed",
  summary: "Post-stay: invoices, payment follow-up, government submission, feedback, lost & found retention. Terminal once sealed.",
  stateMachines: [
    { name: "S8→S9 state machine", ref: "state-machines/s8-s9-state-machine.ts", detail: "Seals the stay into the terminal closed state." },
  ],
  policies: [
    { name: "Payment follow-up window", ref: "registry.advancePaymentFollowUp.windowSeconds", detail: "Window for chasing outstanding payment post-stay." },
    { name: "Lost & found retention", ref: "registry.lostFound.retentionWarning.days", detail: "Retention + warning offset for lost-and-found items." },
    { name: "Government submission", ref: "s9-service", detail: "Submits the required guest/stay record to the government." },
  ],
  engines: [
    { name: "Document generation + tax", ref: "doc-gen, engines/tax-engine.ts", detail: "Renders final invoices/receipts and any post-stay documents." },
  ],
  workersTimers: [
    { name: "W28 — Feedback solicitation", ref: "FEEDBACK_SOLICITATION_W28 · w28", detail: "Sends the feedback survey email after checkout." },
    { name: "W34 / W8 — Payment follow-up", ref: "PAYMENT_FOLLOW_UP_W8 · w34/w8", detail: "Chases outstanding payment post-stay." },
    { name: "W21 — Payment milestone", ref: "PAYMENT_MILESTONE_W21 · w21", detail: "Tracks scheduled payment milestones." },
    { name: "W11 — Commission rate missing", ref: "COMMISSION_RATE_MISSING_W11 · w11", detail: "Flags missing agent commission rates for commission due." },
    { name: "W30 — Lost & found retention", ref: "LOST_FOUND_RETENTION_W30 · w30-lost-found-retention-worker.ts", detail: "Warns before lost-and-found retention lapses." },
  ],
  handoffs: [],
  services: [
    { name: "s9-service", ref: "services/domain/s9-service.ts", detail: "Invoices, payment follow-up, government submission, feedback, lost & found." },
  ],
  configKeys: [
    { name: "registry.advancePaymentFollowUp.windowSeconds", detail: "Payment follow-up window (W34)." },
    { name: "registry.lostFound.retentionWarning.days", detail: "Lost & found retention warning offset (W30)." },
  ],
};

export const STAGE_BACKEND: Record<string, StageBackend> = { S1, S2, S3, S4, S5, S6, S7, S8, S9 };

export const STAGE_ORDER: Stage[] = ["S1", "S2", "S3", "S4", "S5", "S6", "S7", "S8", "S9"];

/** Section render order + friendly labels for the Backend view. */
export const BACKEND_SECTIONS: { key: keyof StageBackend; label: string }[] = [
  { key: "stateMachines", label: "State machines" },
  { key: "policies", label: "Policies" },
  { key: "engines", label: "Engines" },
  { key: "workersTimers", label: "Workers & timers" },
  { key: "handoffs", label: "Handoffs" },
  { key: "services", label: "Services" },
  { key: "configKeys", label: "Admin-tunable config" },
];
