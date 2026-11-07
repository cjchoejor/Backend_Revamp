import type { PrismaClient } from "@prisma/client";
import { AppError, NotFoundError, ValidationError } from "../../lib/errors.js";
import { setEntryGuest } from "./inquiry-caller-service.js";
import { progressS1ToS2 } from "../../state-machines/s1-state-machine.js";
import { unparkEntry } from "./s1-entry-service.js";
import { parkedByTripSwitch } from "./trip-switch-service.js";

/**
 * A TRIP AT INQUIRY (2026-11-07, operator: "stage one can be done together here"; rulings the same
 * day: one Continue moves every stay; the same guest for both). A trip's stays still at Inquiry are
 * worked on one page — each stay's own stay row and its own rooms — and these are the two acts that
 * reach across them: naming the guest on every stay, and moving every stay to Negotiation. Each is
 * the ordinary act on each stay, with every check it has.
 */

type Actor = { actorId: string; level: "L1" | "L2" | "L3" | "L4" };

/** The other live stays of this booking's enquiry still at Inquiry, in the order they come. */
export async function otherStaysAtInquiry(prisma: PrismaClient, entryId: string) {
  const entry = await prisma.entry.findUnique({ where: { id: entryId }, select: { inquiryId: true } });
  if (!entry) throw new NotFoundError("Entry");
  return prisma.entry.findMany({
    where: { inquiryId: entry.inquiryId, id: { not: entryId }, status: { in: ["ACTIVE", "PARKED"] }, currentStage: "S1" },
    orderBy: [{ checkInDate: "asc" }, { createdAt: "asc" }],
    select: { id: true, status: true, guestProfileId: true },
  });
}

const words = (e: unknown) => (e instanceof AppError ? e.body.message : e instanceof Error ? e.message : String(e));

/**
 * The same guest on the trip's other stays still at Inquiry (ruling: "the same guest for both").
 * Each is named as a guest on file, so every check naming has runs on it; one already naming them
 * is left alone. A refusal on one stay is said, never hidden, and does not undo the others.
 */
export async function nameGuestOnTripStays(
  prisma: PrismaClient,
  actor: Actor,
  entryId: string,
  guestProfileId: string,
  opts?: { arrivingIsGuest?: boolean },
) {
  const out: Array<{ entryId: string; named: boolean; message: string | null }> = [];
  for (const s of await otherStaysAtInquiry(prisma, entryId)) {
    if (s.guestProfileId === guestProfileId) {
      out.push({ entryId: s.id, named: false, message: null });
      continue;
    }
    try {
      await setEntryGuest(prisma, actor, s.id, { mode: "EXISTING", guestProfileId, arrivingIsGuest: opts?.arrivingIsGuest });
      out.push({ entryId: s.id, named: true, message: null });
    } catch (e) {
      out.push({ entryId: s.id, named: false, message: words(e) });
    }
  }
  return out;
}

/**
 * Move every stay of the trip still at Inquiry to Negotiation (ruling: "one Continue moves every
 * stay"). This stay first, through its own move and every gate it has; then each other stay — one
 * a trip switch parked is resumed first, one a person parked is left as it is and said. A stay
 * whose move is refused stays at Inquiry and is named with the reason.
 */
export async function moveTripToNegotiation(prisma: PrismaClient, actor: Actor, entryId: string, clientVersion?: number) {
  const entry = await prisma.entry.findUnique({ where: { id: entryId }, select: { currentStage: true, version: true } });
  if (!entry) throw new NotFoundError("Entry");
  if (entry.currentStage !== "S1") throw new ValidationError("This stay has already moved on from Inquiry.");
  const others = await otherStaysAtInquiry(prisma, entryId);
  await progressS1ToS2(prisma, entryId, actor.actorId, clientVersion ?? entry.version);
  const moved: string[] = [entryId];
  const notMoved: Array<{ entryId: string; message: string }> = [];
  for (const s of others) {
    try {
      if (s.status === "PARKED") {
        if (!(await parkedByTripSwitch(prisma, s.id))) {
          notMoved.push({ entryId: s.id, message: "It was parked by a person — resume it, then move it on its own page." });
          continue;
        }
        await unparkEntry(prisma, s.id, actor.actorId, { cause: "TRIP_MOVES_ON", movedWith: entryId });
      }
      // Read after the resume, which moves the version.
      const now = await prisma.entry.findUnique({ where: { id: s.id }, select: { version: true } });
      await progressS1ToS2(prisma, s.id, actor.actorId, now?.version);
      moved.push(s.id);
    } catch (e) {
      notMoved.push({ entryId: s.id, message: words(e) });
    }
  }
  return { moved, notMoved };
}
