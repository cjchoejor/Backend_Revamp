import type { Prisma, PrismaClient } from "@prisma/client";

/**
 * Is this the same stay entered twice? (2026-11-24, operator: "say there is a booking made by a
 * travel agent named Bhutan INC for guest name Dorji … now another user does the same kind of
 * booking … somewhere in the stages it tells the user to acknowledge that it isn't a mistake").
 *
 * "The same guest" was only ever the same guest RECORD. An agency's guest usually comes with no
 * phone and no email, so a second desk typing "Dorji" again makes a second record, and nothing
 * asked. Now the same guest is:
 *  - SAME_GUEST — the same guest record, on any booking; or
 *  - SAME_NAME — the same name (case and spacing aside) booked through the same travel agent or
 *    company. Not for a walk-in or direct guest: their names are often shared, and a phone or an
 *    email on file already makes them one record.
 * Both bookings live (active or parked), on different enquiries (a trip's stays never share a
 * night), sharing at least one night. It is a question for the desk, never a refusal.
 */

type Db = PrismaClient | Prisma.TransactionClient;

export type SameGuestWhy = "SAME_GUEST" | "SAME_NAME";

export type SameGuestStay = {
  entryId: string;
  inquiryId: string;
  checkInDate: Date;
  checkOutDate: Date;
  currentStage: string;
  status: string;
  guestName: string;
  why: SameGuestWhy;
  /** The agency or company both went through, for SAME_NAME. */
  partyName: string | null;
};

/** A person's name as compared: first and last, spaces collapsed, case aside. The title is apart. */
export function guestNameKey(g: { firstName?: string | null; lastName?: string | null } | null | undefined): string {
  if (!g) return "";
  return `${g.firstName ?? ""} ${g.lastName ?? ""}`.trim().replace(/\s+/g, " ").toLowerCase();
}

const fullName = (g: { title?: string | null; firstName?: string | null; lastName?: string | null } | null | undefined) =>
  g ? [g.title, g.firstName, g.lastName].filter((x) => !!x && String(x).trim()).join(" ") : "";

/** The party a booking came through, as a `where` on its enquiry — or null for a direct booking. */
export function partyWhere(inq: { travelAgentId: string | null; corporateAccountId: string | null } | null | undefined) {
  if (inq?.travelAgentId) return { travelAgentId: inq.travelAgentId };
  if (inq?.corporateAccountId) return { corporateAccountId: inq.corporateAccountId };
  return null;
}

/** Other live bookings that may be this one entered twice, the earliest stay first. */
export async function findSameGuestStays(db: Db, entryId: string): Promise<SameGuestStay[]> {
  const me = await db.entry.findUnique({
    where: { id: entryId },
    select: {
      id: true,
      inquiryId: true,
      guestProfileId: true,
      checkInDate: true,
      checkOutDate: true,
      guestProfile: { select: { firstName: true, lastName: true } },
      inquiry: {
        select: {
          travelAgentId: true,
          corporateAccountId: true,
          travelAgent: { select: { displayName: true } },
          corporateAccount: { select: { displayName: true } },
        },
      },
    },
  });
  if (!me || !me.checkInDate || !me.checkOutDate) return [];
  const party = partyWhere(me.inquiry);
  const myName = guestNameKey(me.guestProfile);
  const partyName = me.inquiry?.travelAgent?.displayName ?? me.inquiry?.corporateAccount?.displayName ?? null;
  const ways: Prisma.EntryWhereInput[] = [];
  if (me.guestProfileId) ways.push({ guestProfileId: me.guestProfileId });
  if (party && myName) ways.push({ inquiry: party, guestProfileId: { not: null } });
  if (!ways.length) return [];

  const rows = await db.entry.findMany({
    where: {
      id: { not: me.id },
      inquiryId: { not: me.inquiryId },
      status: { in: ["ACTIVE", "PARKED"] },
      checkInDate: { lt: me.checkOutDate },
      checkOutDate: { gt: me.checkInDate },
      OR: ways,
    },
    orderBy: [{ checkInDate: "asc" }, { createdAt: "asc" }],
    select: {
      id: true,
      inquiryId: true,
      guestProfileId: true,
      checkInDate: true,
      checkOutDate: true,
      currentStage: true,
      status: true,
      guestProfile: { select: { title: true, firstName: true, lastName: true } },
    },
  });
  const out: SameGuestStay[] = [];
  for (const r of rows) {
    const sameRecord = !!me.guestProfileId && r.guestProfileId === me.guestProfileId;
    const sameName = !sameRecord && !!myName && guestNameKey(r.guestProfile) === myName;
    if (!sameRecord && !sameName) continue;
    out.push({
      entryId: r.id,
      inquiryId: r.inquiryId,
      checkInDate: r.checkInDate!,
      checkOutDate: r.checkOutDate!,
      currentStage: r.currentStage,
      status: r.status,
      guestName: fullName(r.guestProfile),
      why: sameRecord ? "SAME_GUEST" : "SAME_NAME",
      partyName: sameRecord ? null : partyName,
    });
  }
  return out;
}
