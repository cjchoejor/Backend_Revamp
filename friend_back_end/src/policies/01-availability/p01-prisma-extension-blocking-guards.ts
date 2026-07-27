import type { PrismaClient } from "@prisma/client";
import { PolicyGateBlockedError, StateTransitionError } from "../../lib/errors.js";

/** Prisma extension: Reservation row is append-only after creation (SIG-S6/S7). */
export function throwReservationMutationForbidden(): never {
  throw new PolicyGateBlockedError(
    "RESERVATION_IMMUTABLE",
    "Reservation is immutable after creation; create a new segment + reservation for amendments",
  );
}

/** Prisma extension: bulk OTA overbooking updates cannot change trigger semantics. */
export function throwOtaOverbookingTriggerUpdateManyForbidden(): never {
  throw new PolicyGateBlockedError(
    "OVERBOOKING_TRIGGER_IMMUTABLE",
    "OtaConflictOverbookingRecord updates must be per-record and cannot change triggerType",
  );
}

/** Prisma extension: triggerType cannot change once set. */
export async function enforceOtaOverbookingTriggerTypeUnchanged(
  base: PrismaClient,
  where: unknown,
  data: { triggerType?: string } | undefined,
): Promise<void> {
  if (!data?.triggerType) return;
  const cur = await base.otaConflictOverbookingRecord.findFirst({ where: where as any });
  if (cur && cur.triggerType !== data.triggerType) {
    throw new PolicyGateBlockedError(
      "OVERBOOKING_TRIGGER_IMMUTABLE",
      "OtaConflictOverbookingRecord.triggerType is immutable once set",
    );
  }
}

/** Prisma extension: LIVE folios only via FolioService.convertToLive. */
export function throwFolioLiveCreateForbidden(): never {
  throw new PolicyGateBlockedError("FOLIO_LIVE_CREATE_FORBIDDEN", "LIVE folios must be created via FolioService.convertToLive()");
}

/** Prisma extension: SETTLED requires zero outstanding balance. */
export async function enforceFolioSettledOutstandingGuard(
  base: PrismaClient,
  where: unknown,
  data: { state?: string; outstandingBalance?: unknown } | undefined,
): Promise<void> {
  if (data?.state !== "SETTLED") return;
  const cur = await base.folio.findFirst({ where: where as any });
  const nextOutRaw =
    data?.outstandingBalance !== undefined && data?.outstandingBalance !== null
      ? data.outstandingBalance
      : cur?.outstandingBalance;
  const out = nextOutRaw != null ? Number((nextOutRaw as any).toString?.() ?? nextOutRaw) : 0;
  if (out > 0) {
    throw new StateTransitionError("Cannot set SETTLED while outstanding balance remains", "SETTLED_WITH_BALANCE_FORBIDDEN");
  }
}

/** Prisma extension: LIVE folio cannot revert to PROVISIONAL. */
export async function enforceFolioCannotRevertLiveToProvisional(
  base: PrismaClient,
  where: unknown,
  data: { state?: string } | undefined,
): Promise<void> {
  if (data?.state !== "PROVISIONAL") return;
  const cur = await base.folio.findFirst({ where: where as any });
  if (cur?.state === "LIVE") {
    throw new StateTransitionError("LIVE folio cannot revert to PROVISIONAL", "FOLIO_REVERSION_FORBIDDEN");
  }
}

/** Prisma extension: FolioLine is immutable after posting. */
export function throwFolioLineMutationForbidden(): never {
  throw new StateTransitionError("FolioLine is immutable after posting", "FOLIO_LINE_IMMUTABLE");
}

/** Prisma extension: VIP arrival notification events are immutable. */
export function throwVipArrivalNotificationMutationForbidden(): never {
  throw new PolicyGateBlockedError("VIP_NOTIFICATION_IMMUTABLE", "VIPArrivalNotificationEvent is immutable after creation");
}

/** Prisma extension: night audit records are immutable after creation. */
export function throwNightAuditRecordMutationForbidden(): never {
  throw new PolicyGateBlockedError("NIGHT_AUDIT_IMMUTABLE", "NightAuditRecord is immutable after creation");
}

/** Prisma extension: dispute gate override records are immutable after creation. */
export function throwDisputeGateOverrideMutationForbidden(): never {
  throw new PolicyGateBlockedError("DISPUTE_OVERRIDE_IMMUTABLE", "DisputeGateOverrideRecord is immutable after creation");
}

/** Prisma extension: roomId cannot change on an existing RoomAssignment. */
export async function enforceRoomAssignmentRoomIdUnchangedIfProvided(
  base: PrismaClient,
  where: unknown,
  data: { roomId?: string } | undefined,
): Promise<void> {
  if (!data?.roomId) return;
  const cur = await base.roomAssignment.findFirst({ where: where as any });
  if (cur && cur.roomId !== data.roomId) {
    throw new PolicyGateBlockedError(
      "ROOM_CHANGE_FORBIDDEN_DIRECT_EDIT",
      "Room change must be governed via segment/re-entry; direct RoomAssignment.roomId edit is forbidden",
    );
  }
}

/** Prisma extension: bulk RoomAssignment updates are forbidden. */
export function throwRoomAssignmentUpdateManyForbidden(): never {
  throw new PolicyGateBlockedError("ROOM_ASSIGNMENT_UPDATE_FORBIDDEN", "RoomAssignment is immutable; create a new assignment for changes");
}

/** Prisma extension: OCCUPIED → DEPARTED_CLEAN must go through DEPARTED_DIRTY. */
export async function enforceRoomOccupiedToDepartedCleanPath(
  base: PrismaClient,
  where: unknown,
  data: { currentClaimState?: string } | undefined,
): Promise<void> {
  if (data?.currentClaimState !== "DEPARTED_CLEAN") return;
  const cur = await base.room.findFirst({ where: where as any });
  if (cur?.currentClaimState === "OCCUPIED") {
    throw new StateTransitionError(
      "Room must transition OCCUPIED→DEPARTED_DIRTY before DEPARTED_CLEAN",
      "INVALID_ROOM_STATE_TRANSITION",
    );
  }
}
