import { Stage } from "@prisma/client";
import { StageGateBlockedError } from "../../lib/errors.js";

/** Policy 1 — S3 stage placement for committed-hold placement, folio/billing setup, and related S3 domain ops. */
export function enforceEntryAtS3ForS3DomainOperations(input: { currentStage: Stage }) {
  if (input.currentStage === Stage.S3) return;
  throw new StageGateBlockedError("Entry must be at S3", "NOT_AT_S3");
}
