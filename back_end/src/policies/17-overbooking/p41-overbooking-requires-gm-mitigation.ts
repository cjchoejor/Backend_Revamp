import type { PrismaClient } from "@prisma/client";
import { PolicyGateBlockedError } from "../../lib/errors.js";
import type { ClaimSpan } from "../../lib/entry-inventory-claim.js";
import { detectOverbooking, detectOverbookingForSpans, type OverbookingResult } from "../../engines/overbooking-detection-engine.js";

/** A detected overbooking stands unless the GM approved it and the mitigation plan is not open. */
async function refuseUnlessGmMitigated(prisma: PrismaClient, entryId: string, over: OverbookingResult, message: string) {
  if (!over.overbookingDetected) return;
  const existing = await prisma.otaConflictOverbookingRecord.findUnique({ where: { entryId } }).catch(() => null);
  if (!existing || !existing.gmApprovalActorId || existing.mitigationPlanStatus === "OPEN") {
    throw new PolicyGateBlockedError("OVERBOOKING_REQUIRES_GM", message);
  }
}

export async function enforceOverbookingRequiresGmMitigationBeforeConfirmation(
  prisma: PrismaClient,
  input: { entryId: string; otaSource: boolean },
) {
  const over = await detectOverbooking(prisma, { entryId: input.entryId, otaSource: input.otaSource });
  await refuseUnlessGmMitigated(
    prisma,
    input.entryId,
    over,
    `Overbooking detected (${over.triggerType}): GM approval + mitigation required before confirmation`,
  );
}

/**
 * The same gate, asked of a plan BEFORE it is committed (2026-09-19) — the room-change and stay
 * extension walks re-freeze at the end, after an irreversible re-entry, so a refusal there left an
 * in-house booking stranded at Set up. Asked here first, the walk refuses with the booking untouched.
 */
export async function enforceNoOverbookingForPlannedStay(
  prisma: PrismaClient,
  input: { entryId: string; otaSource: boolean; spans: ClaimSpan[] },
) {
  const over = await detectOverbookingForSpans(prisma, input);
  if (!over.overbookingDetected) return;
  const rooms = await prisma.room.findMany({
    where: { id: { in: over.conflicts.map((c) => c.roomId) } },
    select: { id: true, roomNumber: true },
  });
  const numberOf = new Map(rooms.map((r) => [r.id, r.roomNumber]));
  const detail = over.conflicts
    .map((c) => `Room ${numberOf.get(c.roomId) ?? c.roomId.slice(0, 6)} is also claimed by ${c.peerEntryIds.join(", ")} on the same nights`)
    .join("; ");
  await refuseUnlessGmMitigated(
    prisma,
    input.entryId,
    over,
    `${detail} — the change would overbook it (${over.triggerType}); GM approval and a mitigation plan are needed first. Nothing was changed.`,
  );
}
