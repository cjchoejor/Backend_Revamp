import type { PrismaClient } from "@prisma/client";
import { RoomPhysicalState, Stage } from "@prisma/client";
import { NotFoundError, PolicyGateBlockedError, StageGateBlockedError, ValidationError } from "../lib/errors.js";

export type DeficientAck = {
  acknowledgementActorId: string;
  acknowledgementAt: string;
  decisionTaken: string;
};

function parseAck(iso: string): Date {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) throw new ValidationError("Invalid acknowledgementAt datetime");
  return d;
}

export async function assignRoom(
  prisma: PrismaClient,
  entryId: string,
  roomId: string,
  actorId: string,
  notes: string | undefined,
  deficientAcknowledgement: DeficientAck | undefined,
) {
  const entry = await prisma.entry.findUnique({
    where: { id: entryId },
    include: { reservation: true, committedHold: true },
  });

  if (!entry) throw new NotFoundError("Entry");
  if (entry.currentStage !== Stage.S5) {
    throw new StageGateBlockedError("Entry must be at stage S5 for room assignment", "NOT_AT_S5");
  }

  const existing = await prisma.roomAssignment.findFirst({ where: { entryId } });
  if (existing) {
    throw new PolicyGateBlockedError("ROOM_ASSIGNMENT_IMMUTABLE", "This entry already has a room assignment (immutable in S5 slice)");
  }

  const hold = entry.committedHold;
  if (!hold) {
    throw new StageGateBlockedError("No committed hold for this entry", "NO_COMMITTED_HOLD");
  }

  const room = await prisma.room.findUnique({
    where: { id: roomId },
    include: { deficientConditionRecords: { where: { status: "UNRESOLVED" } } },
  });

  if (!room) throw new NotFoundError("Room");

  if (room.roomTypeId !== hold.roomTypeId) {
    throw new PolicyGateBlockedError("ROOM_TYPE_MISMATCH", "Room does not match confirmed room type on hold");
  }

  const arrival = entry.reservation?.frozenCheckInDate ?? entry.checkInDate;
  if (!arrival) throw new StageGateBlockedError("No arrival date on reservation", "NO_ARRIVAL_DATE");

  const validPhysical =
    room.physicalState === RoomPhysicalState.AVAILABLE_CLEAN ||
    room.physicalState === RoomPhysicalState.AVAILABLE_INSPECTED ||
    (room.physicalState === RoomPhysicalState.UNDER_MAINTENANCE &&
      room.expectedReadyAt != null &&
      room.expectedReadyAt <= arrival);

  if (!validPhysical) {
    if (room.physicalState === RoomPhysicalState.UNDER_MAINTENANCE && !room.expectedReadyAt) {
      throw new PolicyGateBlockedError(
        "UNDER_MAINTENANCE_WITHOUT_SCHEDULE",
        "Room is under maintenance without expectedReadyAt before arrival",
      );
    }
    throw new PolicyGateBlockedError("ROOM_NOT_ASSIGNABLE_PHYSICAL_STATE", `Room physical state is ${room.physicalState}`);
  }

  const activeDef = room.deficientConditionRecords[0];
  const isDeficient = !!activeDef;

  if (isDeficient) {
    if (!deficientAcknowledgement?.acknowledgementActorId || !deficientAcknowledgement?.acknowledgementAt) {
      throw new PolicyGateBlockedError(
        "DEFICIENT_ACKNOWLEDGEMENT_REQUIRED",
        "DEFICIENT room requires acknowledgement payload",
      );
    }
    const ackAt = parseAck(deficientAcknowledgement.acknowledgementAt);
    return prisma.roomAssignment.create({
      data: {
        entryId,
        roomId,
        assignedBy: actorId,
        deficientAtAssignment: true,
        deficientConditionRecordId: activeDef.id,
        acknowledgementActorId: deficientAcknowledgement.acknowledgementActorId,
        acknowledgementAt: ackAt,
        notes,
      },
    });
  }

  if (deficientAcknowledgement) {
    throw new ValidationError("deficientAcknowledgement must not be sent when room is not DEFICIENT");
  }

  return prisma.roomAssignment.create({
    data: {
      entryId,
      roomId,
      assignedBy: actorId,
      deficientAtAssignment: false,
      notes,
    },
  });
}
