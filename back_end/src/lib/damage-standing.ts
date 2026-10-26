import type { Prisma, PrismaClient } from "@prisma/client";
import { readBookingInspectionStanding } from "./room-inspection-standing.js";

type DbClient = PrismaClient | Prisma.TransactionClient;

/**
 * The damage a booking's room inspections found, and how each was answered (2026-10-26, SIG-S8
 * §253: "damage assessment complete or governed-deferred" before the move to Closed).
 *
 * Found first: a damage noted on an inspection went nowhere — nothing asked whether to charge the
 * guest for it, the bill settled without it, and the booking sealed with it on record and unbilled.
 *
 * A room's damage is its STANDING inspection's (the room's newest record, as every inspection gate
 * reads it) when that record is an inspection, not a put-off, and found damage. Its answer is on the
 * same record:
 * - null    — not answered: the bill is not settled, and the booking does not leave Check-out.
 * - LATER   — decided after departure: the booking may leave Check-out, but is not sealed.
 * - CHARGED — a charge posted for it (`damageFolioLineId`).
 * - WAIVED  — the FOM waived it, with a reason.
 */
export type DamageAnswer = "CHARGED" | "WAIVED" | "LATER";

export type BookingDamage = {
  inspectionId: string;
  roomId: string;
  roomNumber: string;
  damageNotes: string | null;
  inspectedAt: Date;
  inspectedBy: string;
  answer: DamageAnswer | null;
  answerNote: string | null;
  answeredBy: string | null;
  answeredAt: Date | null;
  folioLineId: string | null;
  faultId: string | null;
};

export async function readBookingDamages(db: DbClient, entryId: string): Promise<BookingDamage[]> {
  const standing = await readBookingInspectionStanding(db, entryId);
  const out: BookingDamage[] = [];
  for (const r of standing.rooms) {
    const s = r.standing;
    if (s.state !== "DONE" || !s.inspection.damageFound) continue;
    const i = s.inspection;
    out.push({
      inspectionId: i.id,
      roomId: r.roomId,
      roomNumber: r.roomNumber,
      damageNotes: i.damageNotes,
      inspectedAt: i.inspectedAt,
      inspectedBy: i.inspectedBy,
      answer: (i.damageAnswer as DamageAnswer | null) ?? null,
      answerNote: i.damageAnswerNote,
      answeredBy: i.damageAnsweredBy,
      answeredAt: i.damageAnsweredAt,
      folioLineId: i.damageFolioLineId,
      faultId: i.damageFaultId,
    });
  }
  return out;
}

/** Rooms whose damage has no answer yet — what settlement and the move to Closed wait for. */
export const unansweredDamageRooms = (d: BookingDamage[]) => d.filter((x) => !x.answer).map((x) => x.roomNumber);

/** Rooms whose damage is not yet charged or waived — what sealing the booking waits for. */
export const undecidedDamageRooms = (d: BookingDamage[]) =>
  d.filter((x) => x.answer !== "CHARGED" && x.answer !== "WAIVED").map((x) => x.roomNumber);
