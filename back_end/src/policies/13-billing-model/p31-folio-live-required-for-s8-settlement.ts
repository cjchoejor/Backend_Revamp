import { FolioState, Stage } from "@prisma/client";
import { StateTransitionError } from "../../lib/errors.js";

/**
 * Policy 31 — folio must be LIVE before S8 settlement in this slice.
 *
 * A settlement scoped to ONE payer's share (`bucketScoped` — the guest's own extras, the
 * agency's package) may also run on an OUTSTANDING folio (2026-09-18): settling the first payer
 * leaves the folio OUTSTANDING, and refusing that meant the second payer could never settle —
 * the same trap the room-slice payments were freed from (PMS-237).
 */
export function enforceFolioLiveForS8Settlement(input: { folioState: FolioState; bucketScoped?: boolean }) {
  if (input.folioState === FolioState.LIVE) return;
  if (input.bucketScoped && input.folioState === FolioState.OUTSTANDING) return;
  throw new StateTransitionError("Folio must be LIVE to settle at S8");
}

/**
 * Policy 31 — a payment against ONE slice of the folio (PMS-237, 2026-09-09) needs the folio
 * OPEN, not LIVE. The distinction matters because settling the first room flips the folio to
 * OUTSTANDING, and refusing OUTSTANDING would mean the second room could never pay — the exact
 * flow the operator asked for. SETTLED / CLOSED still refuse: that money is a post-stay
 * receipt against the invoice, which is S9's own path.
 */
export function enforceFolioOpenForTargetPayment(input: { folioState: FolioState }) {
  if (input.folioState === FolioState.LIVE || input.folioState === FolioState.OUTSTANDING) return;
  throw new StateTransitionError(
    `The folio is ${input.folioState} — money can only be taken against a room or space while the bill is open`,
    "FOLIO_NOT_OPEN",
  );
}

/**
 * Policy 31 — where a slice payment is valid: in-house (S7), at check-out (S8) and post-stay
 * (S9). Operator ruling 2026-09-09: "in stay, they might pay, so keep that option to pay in
 * stay as well … make the same changes to s9 as well." Before S7 the folio is provisional and
 * money is the S3 advance, which has its own path and its own gates.
 */
const TARGET_PAYMENT_STAGES: Stage[] = [Stage.S7, Stage.S8, Stage.S9];

export function enforceEntryStageForTargetPayment(input: { currentStage: Stage }) {
  if (TARGET_PAYMENT_STAGES.includes(input.currentStage)) return;
  throw new StateTransitionError(
    `Money can be taken against a room or space during the stay, at check-out or after (S7–S9) — this booking is at ${input.currentStage}`,
    "TARGET_PAYMENT_STAGE",
  );
}
