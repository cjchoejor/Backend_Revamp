/**
 * Reads for the redesigned desk's list screens (2026-09-17) — Today, Bookings, Billing.
 *
 * The redesign's lists answer questions the entry list never carried: who booked it (the agent
 * or company by NAME), which rooms it holds, whether the confirmation went out, whether the
 * advance is still owed, where the bill stands, who the custodian is, why it was parked and
 * when to follow it up. Each list used to either show a dash there or fetch every booking in
 * full. These reads are PURE AGGREGATION — nothing is written, no rule is applied, no money is
 * computed here: the list read carries no money at all, and the balances come from the one
 * billing-summary service the booking header already uses (SS01-P3, "balances for a list of
 * bookings in one call"), so a figure on Today can never disagree with the same figure inside
 * the booking.
 */
import type { EntryStatus, Prisma, PrismaClient, Stage } from "@prisma/client";
import { buildEntryBillingSummary } from "./entry-billing-summary-service.js";

type Db = PrismaClient;

export const DESK_LIST_MAX = 500;

const listSelect = {
  id: true,
  inquiryId: true,
  segmentNumber: true,
  status: true,
  currentStage: true,
  useType: true,
  guestCount: true,
  adultCount: true,
  childCount: true,
  numberOfRooms: true,
  checkInDate: true,
  checkOutDate: true,
  actualCheckOutDate: true,
  walkInCompressed: true,
  groupBillingMode: true,
  reservationPaymentPending: true,
  parkedAt: true,
  contactPersonName: true,
  contactPersonPhone: true,
  closedAt: true,
  version: true,
  createdAt: true,
  updatedAt: true,
  guestProfile: {
    select: { id: true, firstName: true, lastName: true, email: true, phone: true, vipTier: true, nationality: true },
  },
  inquiry: {
    select: {
      id: true,
      referenceNumber: true,
      sourceChannel: true,
      defaultCustodianId: true,
      notes: true,
      travelAgent: { select: { id: true, displayName: true } },
      corporateAccount: { select: { id: true, displayName: true } },
    },
  },
  reservation: { select: { id: true, confirmedAt: true, confirmationVoucherSent: true } },
  folio: { select: { id: true, state: true, billingModel: true } },
  committedHold: { select: { state: true, expiresAt: true } },
  speculativeHolds: {
    where: { state: "PLACED" as const },
    orderBy: { expiresAt: "asc" as const },
    take: 1,
    select: { expiresAt: true },
  },
  quotations: {
    orderBy: { versionNumber: "desc" as const },
    take: 1,
    select: { referenceNumber: true, state: true, validUntil: true, sentAt: true },
  },
  roomAssignments: {
    select: { roomId: true, startDate: true, endDate: true, room: { select: { roomNumber: true } } },
  },
  earlyDeparture: { select: { departureDate: true } },
  noShowDetermination: { select: { id: true, createdAt: true } },
  interimPaymentRequests: {
    where: { state: { in: ["REQUESTED", "BILLED"] as Array<"REQUESTED" | "BILLED"> } },
    select: { id: true, kind: true, state: true, dueBy: true, remindersSent: true, promiseKind: true, promisedBy: true },
    take: 3,
  },
  timers: {
    where: { status: "SCHEDULED" as const },
    orderBy: { firesAt: "asc" as const },
    take: 6,
    select: { timerCode: true, timerType: true, firesAt: true },
  },
} satisfies Prisma.EntrySelect;

export type DeskListRow = Prisma.EntryGetPayload<{ select: typeof listSelect }> & {
  custodianName: string | null;
  /** The reason recorded when the booking was parked (the latest ENTRY.PARKED trace). */
  parkReason: string | null;
  /** When the park runs out — the PARKING_FOLLOW_UP clock. */
  parkFollowUpAt: string | null;
  /** Distinct room numbers the booking holds, in number order. */
  roomNumbers: string[];
};

/**
 * Every booking the desk may need to find, newest activity first. `status` / `stage` narrow it;
 * the screens search and filter by date in memory (SS02-P2 moves that here when the list grows
 * past what one read carries).
 */
export async function listDeskBookings(
  prisma: Db,
  query: { limit: number; status?: EntryStatus; stage?: Stage; guestProfileId?: string },
): Promise<DeskListRow[]> {
  const where: Prisma.EntryWhereInput = {};
  if (query.status) where.status = query.status;
  if (query.stage) where.currentStage = query.stage;
  if (query.guestProfileId) where.guestProfileId = query.guestProfileId;

  const rows = await prisma.entry.findMany({
    where,
    orderBy: { updatedAt: "desc" },
    take: Math.min(DESK_LIST_MAX, Math.max(1, query.limit)),
    select: listSelect,
  });

  // Names, not ids: the custodians and the park reasons, each in one query.
  const custodianIds = [...new Set(rows.map((r) => r.inquiry?.defaultCustodianId).filter((x): x is string => !!x))];
  const staff = custodianIds.length
    ? await prisma.staffUser.findMany({ where: { id: { in: custodianIds } }, select: { id: true, fullName: true } })
    : [];
  const nameOf = new Map(staff.map((s) => [s.id, s.fullName]));

  const parkedIds = rows.filter((r) => r.status === "PARKED").map((r) => r.id);
  const parkTraces = parkedIds.length
    ? await prisma.traceEvent.findMany({
        where: { entryId: { in: parkedIds }, eventType: "ENTRY.PARKED" },
        orderBy: { timestamp: "desc" },
        select: { entryId: true, payload: true },
      })
    : [];
  const reasonOf = new Map<string, string>();
  for (const t of parkTraces) {
    if (!t.entryId || reasonOf.has(t.entryId)) continue;
    const reason = (t.payload as { reason?: unknown } | null)?.reason;
    if (typeof reason === "string" && reason.trim()) reasonOf.set(t.entryId, reason.trim());
  }

  return rows.map((r) => {
    const numbers = new Set<string>();
    for (const a of r.roomAssignments) if (a.room?.roomNumber) numbers.add(a.room.roomNumber);
    const follow = r.timers.find((t) => t.timerCode === "PARKING_FOLLOW_UP");
    return {
      ...r,
      custodianName: r.inquiry?.defaultCustodianId ? nameOf.get(r.inquiry.defaultCustodianId) ?? null : null,
      parkReason: reasonOf.get(r.id) ?? null,
      parkFollowUpAt: r.status === "PARKED" && follow ? follow.firesAt.toISOString() : null,
      roomNumbers: [...numbers].sort((a, b) => a.localeCompare(b, "en", { numeric: true })),
    };
  });
}

export type DeskMoneyRow = {
  entryId: string;
  currency: string | null;
  headline: { amount: number | null; kind: "STAY_TOTAL" | "BILLED_SO_FAR" | null; frozen: boolean };
  folio: { state: string; billedSoFar: number | null; paymentsReceived: number | null; outstandingBalance: number | null } | null;
  shortened: boolean;
};

/**
 * The money line for many bookings at once — each row IS the booking header's own
 * billing summary, trimmed to what a list shows. Runs a few at a time so a page of fifty does not
 * open fifty transactions together.
 */
export async function deskMoneyFor(prisma: Db, entryIds: string[]): Promise<DeskMoneyRow[]> {
  const ids = [...new Set(entryIds)].slice(0, 100);
  const out: DeskMoneyRow[] = [];
  const CONCURRENCY = 6;
  for (let i = 0; i < ids.length; i += CONCURRENCY) {
    const batch = ids.slice(i, i + CONCURRENCY);
    const summaries = await Promise.all(
      batch.map(async (id) => {
        try {
          return await buildEntryBillingSummary(prisma, id);
        } catch {
          return null; // a booking that no longer exists simply has no money line
        }
      }),
    );
    for (const s of summaries) {
      if (!s) continue;
      out.push({
        entryId: s.entryId,
        currency: s.currency,
        headline: s.headline,
        folio: s.folio
          ? {
              state: s.folio.state,
              billedSoFar: s.folio.billedSoFar,
              paymentsReceived: s.folio.paymentsReceived,
              outstandingBalance: s.folio.outstandingBalance,
            }
          : null,
        shortened: !!s.stayTotal.earlyDeparture,
      });
    }
  }
  return out;
}

/** Staff names for attribution lines — who recorded a fact, who holds a booking. Names only. */
export async function listStaffNames(prisma: Db) {
  const rows = await prisma.staffUser.findMany({
    select: { id: true, fullName: true, actorLevel: true, role: true, isActive: true },
    orderBy: { fullName: "asc" },
  });
  return rows;
}

export const DESK_ACTIVITY_MAX = 300;

/**
 * What happened at the hotel in a window — the desk's read-only Audit (SS00 second row). The
 * trace, newest first, optionally narrowed to one person or one booking, with the actor's name.
 * The admin audit trail stays the full surface; this is the operational slice of it.
 */
export async function listDeskActivity(
  prisma: Db,
  q: { from: Date; to: Date; actorId?: string; entryId?: string; limit?: number },
) {
  const limit = Math.min(Math.max(Math.trunc(q.limit ?? 200), 1), DESK_ACTIVITY_MAX);
  const rows = await prisma.traceEvent.findMany({
    where: {
      timestamp: { gte: q.from, lt: q.to },
      ...(q.actorId ? { actorId: q.actorId } : {}),
      ...(q.entryId ? { OR: [{ entryId: q.entryId }, { entityId: q.entryId }] } : {}),
    },
    orderBy: { timestamp: "desc" },
    take: limit,
    select: {
      id: true,
      eventType: true,
      actorId: true,
      actorLevel: true,
      entityType: true,
      entityId: true,
      payload: true,
      timestamp: true,
      stageContext: true,
      entryId: true,
    },
  });
  const ids = [...new Set(rows.map((r) => r.actorId))];
  const staff = ids.length
    ? await prisma.staffUser.findMany({ where: { id: { in: ids } }, select: { id: true, fullName: true } })
    : [];
  const names = new Map(staff.map((s) => [s.id, s.fullName]));
  return rows.map((r) => ({ ...r, actorName: names.get(r.actorId) ?? null }));
}
