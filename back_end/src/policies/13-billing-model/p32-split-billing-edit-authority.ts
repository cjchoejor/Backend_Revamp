import { AuthorizationError, PolicyGateBlockedError, ValidationError } from "../../lib/errors.js";

/**
 * Split-billing edit authority + stage gate (Phase 2 of split-billing, 2026-07-25).
 *
 * Distinct from `p32-billing-model-mid-stay-transition.ts` which governs the WHOLE-FOLIO
 * primary-model transition and blocks S8/S9. This policy governs the SPLIT-BILLING map +
 * per-line reassignment operations, which the user explicitly wants available through
 * settlement + closure (e.g., agent agrees to cover an F&B charge at settlement time —
 * operator flips one line to DIRECT_BILL).
 *
 * ## Rules
 *
 * - **Editable stages:** S3, S5, S6, S7, S8, S9 — the operator can change defaults or
 *   reassign lines any time the folio is live or being settled/closed.
 * - **Forbidden stages:** S1, S2 (pre-folio), S4 (fixation is atomic with confirmation —
 *   changing split here would race with `Reservation.frozenBillingModel`), TERMINAL.
 * - **Authority:** L1 for S3/S5/S6/S7 (front-desk works the daily flow). L2 (FOM) minimum
 *   at S8/S9 — settlement-time flips have money implications; FOM sign-off is required.
 *
 * ## Allowed billing-model values
 *
 * The `newValue` must be one of the runtime-recognised strings — `GUEST_PAY`,
 * `DIRECT_BILL`, `GOVERNMENT`. Anything else is a ValidationError so the caller sees
 * the exact set they can pick from.
 */

type ActorLevel = "L1" | "L2" | "L3" | "L4" | "SYSTEM";

/** Runtime-recognised billing-model values. Extending this list also requires updating the
 *  seed config (`billingModel.availablePerSource`) and the settlement service. */
export const SPLIT_BILLING_ALLOWED_VALUES = ["GUEST_PAY", "DIRECT_BILL", "GOVERNMENT"] as const;
export type SplitBillingModel = (typeof SPLIT_BILLING_ALLOWED_VALUES)[number];

const EDITABLE_STAGES = new Set(["S3", "S5", "S6", "S7", "S8", "S9"]);
const SETTLEMENT_STAGES = new Set(["S8", "S9"]);

export function enforceSplitBillingEditAllowed(input: { currentStage: string; actorLevel: ActorLevel }): void {
  if (!EDITABLE_STAGES.has(input.currentStage)) {
    throw new PolicyGateBlockedError(
      "SPLIT_BILLING_EDIT_FORBIDDEN_AT_STAGE",
      `Split-billing edits are not allowed at stage ${input.currentStage}. Allowed: S3, S5, S6, S7, S8, S9.`,
    );
  }
  if (SETTLEMENT_STAGES.has(input.currentStage)) {
    // L2+ required at settlement/closure. L1 is not enough.
    const isL1 = input.actorLevel === "L1";
    if (isL1) {
      throw new AuthorizationError(
        `FOM (L2) authority or higher is required to change split-billing at ${input.currentStage}.`,
      );
    }
  }
}

/** Reject unknown billing-model strings early so the operator sees the valid set. */
export function enforceSplitBillingValueAllowed(value: string): SplitBillingModel {
  const trimmed = value?.trim();
  if (!trimmed) throw new ValidationError("billingModel is required");
  if (!(SPLIT_BILLING_ALLOWED_VALUES as readonly string[]).includes(trimmed)) {
    throw new ValidationError(
      `Unknown billing model "${trimmed}". Allowed: ${SPLIT_BILLING_ALLOWED_VALUES.join(", ")}.`,
    );
  }
  return trimmed as SplitBillingModel;
}
