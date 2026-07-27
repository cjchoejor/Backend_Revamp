/**
 * ModeConfiguration.autoFulfilmentConditions evaluator.
 *
 * The seeded modes carry `{ stage, condition }` pairs that describe when a stage may be
 * short-circuited during a backflow-driven journey. Example: `ROOM_CHANGE @ S2 =
 * SAME_RATE_AS_FROZEN_RESERVATION` — a room change that keeps the same rate doesn't need
 * re-quotation; S2 auto-fulfils and the entry can proceed straight to S3.
 *
 * How it's used:
 *   1. After a backflow lands at its target stage, the caller invokes
 *      `evaluateAutoFulfilment(mode, currentStage, entryFacts)`.
 *   2. If the returned `skip` is true, the caller advances the entry past this stage
 *      (typically by calling the appropriate forward-progression function).
 *   3. Trace `MODE.AUTO_FULFILMENT_APPLIED` is written so the operator can see WHY the stage
 *      was skipped without any manual click.
 *
 * Adding a new condition:
 *   - Add it to the mode row via /admin/modes (persists in `autoFulfilmentConditions` JSON).
 *   - Register an evaluator in `EVALUATORS` below with the exact condition string.
 *   - Any unknown condition returns `{ skip: false, reason: "UNKNOWN_CONDITION" }` — safe default.
 */
import type { ResolvedMode } from "./mode-registry-runtime.js";

export type EntryFacts = {
  entryId: string;
  currentStage: string;
  /** Reservation.frozenRate (as Decimal-safe string) — present after S4 confirmation. */
  frozenRate?: string | null;
  /** Quotation.commercialTerms.effectiveRate proposed by the current attempt at this stage. */
  proposedEffectiveRate?: string | null;
  /** Detected group size at the time of the transition. */
  guestCount?: number | null;
  /** Group-detection threshold from registry.groupDetection.guestCountThreshold at the time of the entry's creation. */
  groupThresholdAtCreation?: number | null;
  /** For DATE_EXTENSION: are the extra nights already reflected in a CommittedHold covering them? */
  inventoryAlreadyCommittedForNewNights?: boolean;
};

type Evaluator = (facts: EntryFacts) => { skip: boolean; reason: string };

/**
 * Registry of known conditions → evaluators.
 *
 * Each returns `skip: true` only when the evaluator can prove the condition holds. Unknown
 * inputs (missing fields, ambiguous state) return `skip: false` with an explanation string.
 */
const EVALUATORS: Record<string, Evaluator> = {
  // ROOM_CHANGE @ S2: skip re-quotation when the proposed effective rate equals the frozen rate
  // on the reservation. Uses string compare on 2dp Decimal values so 100.00 vs 100 both match.
  SAME_RATE_AS_FROZEN_RESERVATION: (f) => {
    if (!f.frozenRate || !f.proposedEffectiveRate) {
      return { skip: false, reason: "MISSING_RATE_FACTS" };
    }
    const a = Number.parseFloat(String(f.frozenRate)).toFixed(2);
    const b = Number.parseFloat(String(f.proposedEffectiveRate)).toFixed(2);
    if (a === b) return { skip: true, reason: `Rates match at ${a} — skipping S2 re-quotation` };
    return { skip: false, reason: `Rates differ: frozen=${a} proposed=${b}` };
  },

  // DATE_EXTENSION @ S3: skip re-hold when the new nights are already inside a live hold.
  INVENTORY_ALREADY_COMMITTED_FOR_NEW_NIGHTS: (f) => {
    if (f.inventoryAlreadyCommittedForNewNights === true) {
      return { skip: true, reason: "Extra nights already covered by an active CommittedHold" };
    }
    return { skip: false, reason: "Extra nights not covered by any existing hold — re-hold required" };
  },

  // GUEST_COMPOSITION_CHANGE @ S2: skip re-validation when new guest count stays under the
  // original group-threshold used to classify the entry (no group re-detection needed).
  WITHIN_ORIGINAL_GROUP_THRESHOLD: (f) => {
    if (f.guestCount == null || f.groupThresholdAtCreation == null) {
      return { skip: false, reason: "MISSING_GROUP_FACTS" };
    }
    if (f.guestCount <= f.groupThresholdAtCreation) {
      return { skip: true, reason: `${f.guestCount} guests ≤ threshold ${f.groupThresholdAtCreation} — no re-classification needed` };
    }
    return { skip: false, reason: `${f.guestCount} guests > threshold ${f.groupThresholdAtCreation} — S2 re-validation required` };
  },
};

/**
 * For a given mode + stage, evaluate every declared condition and return the FIRST that
 * yields `skip: true`. If none, return `skip: false` with a summary of what was checked.
 * The `at` field is a stable identifier (mode+stage) for the trace payload.
 */
export function evaluateAutoFulfilment(
  mode: ResolvedMode,
  currentStage: string,
  facts: EntryFacts,
): { skip: boolean; reason: string; at: string; matchedCondition: string | null } {
  const at = `${mode.modeKey}@${currentStage}`;
  const applicable = mode.autoFulfilmentConditions.filter((c) => c.stage === currentStage);
  if (applicable.length === 0) return { skip: false, reason: "NO_CONDITIONS_DECLARED", at, matchedCondition: null };
  const notes: string[] = [];
  for (const c of applicable) {
    const ev = EVALUATORS[c.condition];
    if (!ev) {
      notes.push(`${c.condition}: UNKNOWN_CONDITION`);
      continue;
    }
    const r = ev(facts);
    if (r.skip) return { skip: true, reason: r.reason, at, matchedCondition: c.condition };
    notes.push(`${c.condition}: ${r.reason}`);
  }
  return { skip: false, reason: notes.join("; "), at, matchedCondition: null };
}
