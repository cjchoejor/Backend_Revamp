import { EntryStatus, Stage } from "@prisma/client";
import { StateTransitionError } from "../../lib/errors.js";

/**
 * Stages at which a park may be placed.
 *
 * Authority — DEV-SPEC-001 Part 3 §3.2.8 (canonical entry state model):
 *   `Parking: any (ACTIVE, Sn) ──► (PARKED, Sn) — entry or inquiry level`
 *
 * The per-stage SIGs each restate it for their own stage and none narrows it:
 *   SIG-S1 §3.2/§3.3 (S1) · SIG-S2 §3.3 + transition table (S2) · SIG-S3 transition
 *   table (S3, "Park operation / Custodian / dwell mode changes to PARKED") ·
 *   SIG-S4 §2.1 + §3.1 ("`(ACTIVE, S4)` or `(PARKED, S4)`") · SIG-S5 §3.1 (S5, and the
 *   no-show timer keeps running) · SIG-S7 §7 (PARKED dwell mode at S7).
 *   Part 13's policy-class × stage matrix lists Expiry/parking at S1, S2, S3, S5, S7, S9.
 *
 * S6 and S8 are the only stages no document mentions explicitly; Part 3's "any (ACTIVE, Sn)"
 * governs there. This module previously allowed S1/S2 only — a narrowing with no spec basis
 * that blocked the S3/S4/S5 parks the SIGs mandate.
 */
const PARKABLE_STAGES: ReadonlySet<Stage> = new Set([
  Stage.S1,
  Stage.S2,
  Stage.S3,
  Stage.S4,
  Stage.S5,
  Stage.S6,
  Stage.S7,
  Stage.S8,
  Stage.S9,
]);

/**
 * Predicate form — used by the inquiry-level cascade to SKIP an ineligible child entry rather
 * than fail the whole inquiry park.
 */
export function isEntryParkAllowedForStage(currentStage: Stage): boolean {
  return PARKABLE_STAGES.has(currentStage);
}

/** DEV-SPEC-001 Part 3 §3.2.8 — entry-level park is valid from any (ACTIVE, Sn). */
export function enforceEntryParkAllowedForCurrentStage(input: { currentStage: Stage }) {
  if (isEntryParkAllowedForStage(input.currentStage)) return;
  throw new StateTransitionError(
    `Entry park is not supported at ${input.currentStage}`,
    "PARK_STAGE_NOT_ALLOWED",
  );
}

/**
 * The stage whose expiry TTL a park suspends and an unpark restores.
 *
 * Only S1 carries an `ENTRY_EXPIRY` timer: it is registered at entry creation
 * (`s1-entry-service.createEntry`) and cancelled for good on S1→S2
 * (`s1-state-machine.progressS1ToS2`, "the entry has left S1 — the S1 inquiry-expiry is moot").
 * Nothing re-registers it at any later stage.
 *
 * So an unpark at S2+ must NOT re-arm one. Doing so manufactured a death clock that the entry
 * never had: an unparked S2 entry would expire on the S1 TTL, and — via the inquiry-level
 * cascade, which parks at any stage — an unparked S5/S7 entry would be marked EXPIRED with its
 * rooms released while the guest was in-house.
 */
export function entryExpiryTimerAppliesAtStage(stage: Stage): boolean {
  return stage === Stage.S1;
}

/** Policy 1 — a park may only be placed on an ACTIVE entry (re-exported for the cascade path). */
export function isEntryStatusParkable(status: EntryStatus): boolean {
  return status === EntryStatus.ACTIVE;
}
