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
import { stayIsOnTripBill } from "./bill-view-service.js";
import { sumMoney, toDecimal } from "../../lib/money.js";
import { resolveNoShowGraceMinutes, timerShowsFrom } from "../../lib/expected-arrival.js";
import { withoutClocksOfRepliesOff } from "../../lib/reply-waits.js";
import { readBookingRooms, roomUnitsOf, sealHasBookingRooms } from "../../lib/booking-rooms.js";
import { currentPassSeal } from "./room-placement-service.js";
import { effectiveCheckOutDate, hotelTodayUtc, utcDateOnly } from "../../lib/stay-dates.js";
import { rowsInUse } from "../../lib/rooms-in-use.js";

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
  /** How it ended and what was said — so the lists can say more than "Expired" (2026-10-01). */
  closedAs: true,
  closedReason: true,
  version: true,
  createdAt: true,
  updatedAt: true,
  guestProfile: {
    select: { id: true, title: true, firstName: true, lastName: true, email: true, phone: true, vipTier: true, nationality: true },
  },
  inquiry: {
    select: {
      id: true,
      referenceNumber: true,
      sourceChannel: true,
      cameInAs: true,
      defaultCustodianId: true,
      notes: true,
      // The caller (2026-10-12): an inquiry has no guest named until Wrap up, so the lists name
      // whoever rang until then.
      callerTitle: true,
      callerFirstName: true,
      callerLastName: true,
      callerPhone: true,
      callerEmail: true,
      // The desk's own note to tell same-named guests apart (2026-11-25).
      deskTag: true,
      travelAgent: { select: { id: true, displayName: true } },
      corporateAccount: { select: { id: true, displayName: true } },
    },
  },
  reservation: { select: { id: true, confirmedAt: true, confirmationVoucherSent: true, frozenCheckInDate: true, frozenCheckOutDate: true } },
  folio: {
    select: {
      id: true,
      state: true,
      billingModel: true,
      // The proforma in force, for "running out" and "ran out" on the lists (2026-11-05).
      invoices: {
        where: { invoiceType: "PROFORMA" as const, state: { not: "SUPERSEDED" as const } },
        orderBy: { versionNumber: "desc" as const },
        take: 1,
        select: { validUntil: true, lapsedAt: true, dispatchedAt: true },
      },
    },
  },
  committedHold: { select: { state: true, expiresAt: true } },
  speculativeHolds: {
    where: { state: "PLACED" as const },
    orderBy: { expiresAt: "asc" as const },
    take: 1,
    select: { expiresAt: true },
  },
  quotations: {
    orderBy: { createdAt: "desc" as const },
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
  // The rest of the bill at check-in (2026-10-29): a request the FOM must answer, or the FOM's
  // "pay during the stay by …" the desk is reminded on.
  // Waiting for the FOM (2026-11-26): a guest asking to leave owing at Check-out, and a change
  // to the booking prepared at Negotiation — the bell lists both for the FOM and the GM.
  leaveOwingRequests: {
    where: { status: "REQUESTED" },
    orderBy: { requestedAt: "desc" as const },
    take: 1,
    select: { id: true, amountOwed: true, guestWords: true, requestedAt: true },
  },
  // A room booked by mistake the desk asks to remove (2026-11-26).
  roomRemovalRequests: {
    where: { status: "REQUESTED" },
    orderBy: { requestedAt: "desc" as const },
    take: 1,
    select: { id: true, roomNumbers: true, reason: true, requestedAt: true },
  },
  // A charge on a settled bill the desk asks the FOM to correct (2026-11-26).
  chargeCorrectionRequests: {
    where: { status: "REQUESTED" },
    orderBy: { requestedAt: "desc" as const },
    take: 1,
    select: { id: true, reason: true, requestedAt: true },
  },
  negotiationAmendmentRequests: {
    where: { state: "REQUESTED" as const },
    orderBy: { requestedAt: "desc" as const },
    take: 1,
    select: { id: true, summary: true, requestedAt: true },
  },
  checkInPaymentDeferrals: {
    where: { status: { in: ["REQUESTED", "APPROVED"] } },
    orderBy: { createdAt: "desc" as const },
    take: 2,
    select: { id: true, status: true, payBy: true, dueBy: true, stillToPay: true, requestedAt: true },
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
  /** The rooms the booking is in now, in number order (lib/rooms-in-use.ts): never a room left
   *  mid-stay or one never slept in. */
  roomNumbers: string[];
  /**
   * The rooms a booking holds before they are handed out at Arrival (2026-11-24, client: "for walk
   * in for 1 week stay, the room no is not showing"): read off the booking's own pick. At Arrival the
   * system's rooms are the proposal, named by number; before it a room the system chose and may still
   * move is counted by its type ("1 Executive Apartment"), a room given by number is named. Null when
   * the rooms are handed out (`roomNumbers`), or the booking holds none.
   */
  roomsHeld: { numbers: string[]; byType: Array<{ name: string; count: number }> } | null;
  /**
   * Which stay of its enquiry this booking is, when the enquiry has more than one (2026-11-10,
   * operator: "show stay 1 of 2"). Numbered as the booking's own head numbers them: every stay on
   * the enquiry, by check-in. Null for a booking on its own.
   */
  stay: { no: number; of: number } | null;
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
  // Which stay of its trip each booking is — one query for every enquiry on the page.
  const inquiryIds = [...new Set(rows.map((r) => r.inquiryId))];
  const siblings = inquiryIds.length
    ? await prisma.entry.findMany({
        where: { inquiryId: { in: inquiryIds } },
        orderBy: [{ checkInDate: "asc" }, { createdAt: "asc" }],
        select: { id: true, inquiryId: true },
      })
    : [];
  const staysOf = new Map<string, string[]>();
  for (const s of siblings) staysOf.set(s.inquiryId, [...(staysOf.get(s.inquiryId) ?? []), s.id]);

  const heldOf = await roomsHeldBeforeHandOut(prisma, rows);

  const reasonOf = new Map<string, string>();
  for (const t of parkTraces) {
    if (!t.entryId || reasonOf.has(t.entryId)) continue;
    const reason = (t.payload as { reason?: unknown } | null)?.reason;
    if (typeof reason === "string" && reason.trim()) reasonOf.set(t.entryId, reason.trim());
  }

  const hotelToday = hotelTodayUtc();
  return rows.map((r) => {
    // The rooms the booking is in now — never a room left mid-stay or one never slept in
    // (2026-11-26, lib/rooms-in-use.ts; the Today list named 4 rooms on a 3-room booking).
    const numbers = new Set<string>();
    for (const a of rowsInUse(r.currentStage, r.roomAssignments, { checkout: effectiveCheckOutDate(r), hotelToday })) {
      if (a.room?.roomNumber) numbers.add(a.room.roomNumber);
    }
    const follow = r.timers.find((t) => t.timerCode === "PARKING_FOLLOW_UP");
    return {
      ...r,
      custodianName: r.inquiry?.defaultCustodianId ? nameOf.get(r.inquiry.defaultCustodianId) ?? null : null,
      parkReason: reasonOf.get(r.id) ?? null,
      parkFollowUpAt: r.status === "PARKED" && follow ? follow.firesAt.toISOString() : null,
      roomNumbers: [...numbers].sort((a, b) => a.localeCompare(b, "en", { numeric: true })),
      roomsHeld: numbers.size ? null : heldOf.get(r.id) ?? null,
      stay: (() => {
        const all = staysOf.get(r.inquiryId) ?? [];
        return all.length > 1 ? { no: all.indexOf(r.id) + 1, of: all.length } : null;
      })(),
    };
  });
}

/** Steps where a booking holds rooms that are not handed out yet: Set up, Reserve, Arrival. */
const HOLDING_STAGES = new Set<string>(["S3", "S4", "S5"]);

/**
 * The rooms each booking holds before Arrival hands them out — the rule `describeBookingRooms` names
 * them by (docs/room-types-until-arrival.md): from Arrival the system's rooms are proposed by number;
 * before it a room the system may still move is named by its type. Two queries for the whole list.
 */
async function roomsHeldBeforeHandOut(
  prisma: Db,
  rows: Array<{ id: string; status: EntryStatus; currentStage: Stage; checkInDate: Date | null; checkOutDate: Date | null; roomAssignments: unknown[] }>,
): Promise<Map<string, { numbers: string[]; byType: Array<{ name: string; count: number }> }>> {
  const out = new Map<string, { numbers: string[]; byType: Array<{ name: string; count: number }> }>();
  const need = rows.filter(
    (r) =>
      r.roomAssignments.length === 0 &&
      HOLDING_STAGES.has(r.currentStage) &&
      (r.status === "ACTIVE" || r.status === "PARKED") &&
      !!r.checkInDate &&
      !!r.checkOutDate,
  );
  if (!need.length) return out;
  const ids = need.map((r) => r.id);
  const [segments, seals, rooms] = await Promise.all([
    prisma.segment.findMany({ where: { entryId: { in: ids } }, orderBy: { segmentNumber: "desc" }, select: { id: true, entryId: true } }),
    prisma.availabilityConfiguration.findMany({
      where: { entryId: { in: ids }, sealedAt: { not: null } },
      orderBy: { sealedAt: "desc" },
      select: { entryId: true, segmentId: true, optionSelected: true },
    }),
    prisma.room.findMany({ select: { id: true, roomNumber: true, roomTypeId: true, roomType: { select: { name: true } } } }),
  ]);
  const info = new Map(rooms.map((r) => [r.id, r] as const));
  const segOf = new Map<string, { id: string }>();
  for (const s of segments) if (!segOf.has(s.entryId)) segOf.set(s.entryId, { id: s.id });
  const sealsOf = new Map<string, Array<{ segmentId: string | null; optionSelected: unknown }>>();
  for (const c of seals) sealsOf.set(c.entryId, [...(sealsOf.get(c.entryId) ?? []), c]);
  const byNumber = (a: string, b: string) => a.localeCompare(b, "en", { numeric: true });

  for (const r of need) {
    const seg = segOf.get(r.id);
    const seal = currentPassSeal({ segments: seg ? [seg] : [], availabilityConfigs: sealsOf.get(r.id) ?? [] });
    if (!seal) continue;
    const bookingRooms = readBookingRooms(seal, { checkIn: utcDateOnly(r.checkInDate!), checkOut: utcDateOnly(r.checkOutDate!) }, (id) => info.get(id)?.roomTypeId);
    const units = roomUnitsOf(bookingRooms);
    if (!units.length) continue;
    const atArrival = r.currentStage === "S5";
    const byType = sealHasBookingRooms(seal);
    const numbers = new Set<string>();
    // A quiet room counted by its type, night by night, so a room the system moved part-way is one room.
    const quietPerNight = new Map<string, Map<string, number>>();
    for (const u of units) {
      const no = info.get(u.roomId)?.roomNumber;
      if (atArrival || !(byType && u.quiet)) {
        if (no) numbers.add(no);
        continue;
      }
      for (const night of u.nights) {
        const m = quietPerNight.get(u.roomTypeId) ?? new Map<string, number>();
        m.set(night, (m.get(night) ?? 0) + 1);
        quietPerNight.set(u.roomTypeId, m);
      }
    }
    const typeRows = [...quietPerNight.entries()]
      .map(([typeId, m]) => ({
        name: rooms.find((x) => x.roomTypeId === typeId)?.roomType?.name ?? "Room",
        count: Math.max(...m.values()),
      }))
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
    if (!numbers.size && !typeRows.length) continue;
    out.set(r.id, { numbers: [...numbers].sort(byNumber), byType: typeRows });
  }
  return out;
}

export type DeskMoneyRow = {
  entryId: string;
  currency: string | null;
  headline: { amount: number | null; kind: "STAY_TOTAL" | "BILLED_SO_FAR" | null; frozen: boolean };
  /** `refunded` and `writtenOff` (2026-11-10) say where money paid went on a closed bill. */
  folio: {
    state: string;
    billedSoFar: number | null;
    paymentsReceived: number | null;
    outstandingBalance: number | null;
    refunded: number | null;
    writtenOff: number | null;
  } | null;
  /** What the whole stay comes to (2026-11-10): the stay as priced plus what was added to it — the
   *  billing summary's `stayWithAdded`. Null when the booking has no priced stay total. */
  totalAmount: number | null;
  /** What the guest still owes on the whole stay, nights not billed yet included (2026-11-24) — the
   *  billing summary's `stillToPay`; Today's lists show it as the balance due. */
  stillToPay: { amount: number; paidAhead: number; notBilledYet: number } | null;
  shortened: boolean;
  /**
   * The whole trip, when the booking is one stay of several on its enquiry (2026-11-10, operator:
   * "it only pulls one stay"): each figure is the stays' own added up, the stays being the ones the
   * trip's bill shows. Null for a booking on its own.
   */
  trip: {
    inquiryId: string;
    stays: Array<{ entryId: string; stayNo: number; checkIn: string | null; checkOut: string | null; stage: string; status: string }>;
    totalAmount: number | null;
    billedSoFar: number;
    paymentsReceived: number;
    outstandingBalance: number;
    /** Money paid over on a stay — kept as that stay's, never netted against another's balance. */
    paidAhead: number;
    refunded: number;
    writtenOff: number;
  } | null;
};

/**
 * The money line for many bookings at once — each row IS the booking header's own
 * billing summary, trimmed to what a list shows. Runs a few at a time so a page of fifty does not
 * open fifty transactions together.
 */
/**
 * The clocks running on a booking, for the list (2026-09-25, operator: "show the most important
 * timer running for that reservation in the table as well").
 *
 * The soonest few, not just one: the desk names a clock by its code and has no name for every
 * code the engine arms, so it takes the first it can name. `running` is the whole count, so the
 * row can say there is more than the one it shows.
 */
export type DeskTimerRow = {
  entryId: string;
  running: number;
  next: Array<{ timerCode: string; timerType: string; stageContext: string | null; firesAt: string; showsFrom?: string | null; handoffType?: string | null }>;
};

export async function deskTimersFor(prisma: Db, entryIds: string[]): Promise<DeskTimerRow[]> {
  const ids = [...new Set(entryIds)].slice(0, 100);
  if (ids.length === 0) return [];
  const scheduled = await prisma.timerRecord.findMany({
    where: { entryId: { in: ids }, status: "SCHEDULED" },
    select: { entryId: true, timerCode: true, timerType: true, stageContext: true, firesAt: true, entityType: true, entityId: true, createdAt: true },
    orderBy: { firesAt: "asc" },
  });
  const rows = await withoutClocksOfRepliesOff(prisma, scheduled);
  // The no-show cut-off shows only from the start of its grace (2026-10-29).
  const grace = rows.some((r) => r.timerCode === "NO_SHOW_CUTOFF_W5") ? await resolveNoShowGraceMinutes(prisma as never).catch(() => null) : null;
  // The acceptance clock is one code for housekeeping and the kitchen alike; the handoff behind
  // it says which. One query for the lot, so the row can name the department.
  const handoffIds = rows.filter((r) => r.entityType === "HandoffRecord" && r.entityId).map((r) => r.entityId as string);
  const handoffTypeById = new Map<string, string>(
    handoffIds.length
      ? (await prisma.handoffRecord.findMany({ where: { id: { in: handoffIds } }, select: { id: true, handoffType: true } })).map((h) => [h.id, h.handoffType])
      : [],
  );
  const byEntry = new Map<string, DeskTimerRow>();
  for (const id of ids) byEntry.set(id, { entryId: id, running: 0, next: [] });
  for (const r of rows) {
    if (!r.entryId) continue;
    const row = byEntry.get(r.entryId);
    if (!row) continue;
    row.running += 1;
    if (row.next.length < 8) {
      row.next.push({
        timerCode: r.timerCode,
        timerType: r.timerType,
        stageContext: r.stageContext ?? null,
        firesAt: r.firesAt.toISOString(),
        showsFrom: timerShowsFrom(r, grace)?.toISOString() ?? null,
        handoffType: r.entityType === "HandoffRecord" && r.entityId ? (handoffTypeById.get(r.entityId) ?? null) : null,
      });
    }
  }
  return [...byEntry.values()].filter((r) => r.running > 0);
}

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
              refunded: s.folio.refunded,
              writtenOff: s.folio.writtenOff,
            }
          : null,
        totalAmount: s.stayWithAdded,
        stillToPay: s.stillToPay,
        shortened: !!s.stayTotal.earlyDeparture,
        trip: null,
      });
    }
  }
  await addTripMoney(prisma, out);
  return out;
}

/** Each booking's trip, its stays' figures added up (Decimal), the stays the trip's bill shows. */
async function addTripMoney(prisma: Db, rows: DeskMoneyRow[]): Promise<void> {
  if (!rows.length) return;
  const own = await prisma.entry.findMany({ where: { id: { in: rows.map((r) => r.entryId) } }, select: { id: true, inquiryId: true } });
  const inquiryOf = new Map(own.map((e) => [e.id, e.inquiryId]));
  const inquiryIds = [...new Set(own.map((e) => e.inquiryId))];
  const stays = await prisma.entry.findMany({
    where: { inquiryId: { in: inquiryIds } },
    orderBy: { checkInDate: "asc" },
    select: {
      id: true,
      inquiryId: true,
      status: true,
      currentStage: true,
      checkInDate: true,
      checkOutDate: true,
      folio: { select: { _count: { select: { lines: true, payments: true } } } },
    },
  });
  const byInquiry = new Map<string, typeof stays>();
  for (const s of stays) byInquiry.set(s.inquiryId, [...(byInquiry.get(s.inquiryId) ?? []), s]);
  const summaries = new Map<string, Awaited<ReturnType<typeof buildEntryBillingSummary>> | null>();
  for (const r of rows) {
    const inq = inquiryOf.get(r.entryId);
    const all = inq ? byInquiry.get(inq) ?? [] : [];
    const onBill = all.filter((s) => s.id === r.entryId || stayIsOnTripBill({ status: s.status, folio: s.folio ? { lines: s.folio._count.lines, payments: s.folio._count.payments } : null }));
    if (onBill.length < 2) continue;
    for (const s of onBill) {
      if (!summaries.has(s.id)) summaries.set(s.id, await buildEntryBillingSummary(prisma, s.id).catch(() => null));
    }
    const sums = onBill.map((s) => summaries.get(s.id) ?? null);
    const total = sums.some((x) => x == null || (x.stayWithAdded == null && x.headline.amount == null))
      ? null
      : Number(sumMoney(sums.map((x) => x!.stayWithAdded ?? x!.headline.amount ?? 0)).toFixed(2));
    const add = (pick: (x: NonNullable<(typeof sums)[number]>) => number | null | undefined) =>
      Number(sumMoney(sums.map((x) => (x ? toDecimal(pick(x) ?? 0) : toDecimal(0)))).toFixed(2));
    // Money moved between the stays is neither received nor refunded for the trip (2026-11-10) —
    // the trip's bill's own rule (pairTripMoves): a move whose two halves are both on it.
    const moves = await prisma.paymentRecord.findMany({
      where: { folio: { entryId: { in: onBill.map((s) => s.id) } }, tripTransferRef: { not: null } },
      select: { amount: true, paymentDirection: true, tripTransferRef: true },
    });
    const byRef = new Map<string, typeof moves>();
    for (const m of moves) byRef.set(m.tripTransferRef!, [...(byRef.get(m.tripTransferRef!) ?? []), m]);
    let movedIn = toDecimal(0);
    let movedOut = toDecimal(0);
    for (const halves of byRef.values()) {
      const out = halves.find((h) => h.paymentDirection === "OUT");
      const into = halves.find((h) => h.paymentDirection === "IN");
      if (!out || !into || halves.length !== 2) continue;
      movedIn = movedIn.add(toDecimal(into.amount));
      movedOut = movedOut.add(toDecimal(out.amount));
    }
    r.trip = {
      inquiryId: inq!,
      stays: onBill.map((s) => ({
        entryId: s.id,
        stayNo: all.indexOf(s) + 1,
        checkIn: s.checkInDate ? s.checkInDate.toISOString().slice(0, 10) : null,
        checkOut: s.checkOutDate ? s.checkOutDate.toISOString().slice(0, 10) : null,
        stage: String(s.currentStage),
        status: String(s.status),
      })),
      totalAmount: total,
      billedSoFar: add((x) => x.folio?.billedSoFar),
      paymentsReceived: Number(toDecimal(add((x) => x.folio?.paymentsReceived)).sub(movedIn).toFixed(2)),
      outstandingBalance: add((x) => x.folio?.outstandingBalance),
      paidAhead: add((x) => x.folio?.overpaid),
      refunded: Number(toDecimal(add((x) => x.folio?.refunded)).sub(movedOut).toFixed(2)),
      writtenOff: add((x) => x.folio?.writtenOff),
    };
  }
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

/* ---------- the alerts the system sent ---------- */

export const DESK_ALERTS_MAX = 400;

/** What a sent alert was about (2026-10-23) — one word per writer in notification-service / W14. */
export type DeskAlertKind = "STAGE_DWELL" | "EXPIRED" | "PAYMENT_REMINDER" | "PAY_LATER_ASKED" | "LEAVE_OWING_ASKED" | "CHARGE_CORRECTION_ASKED" | "ROOM_REMOVAL_ASKED" | "VIP_ARRIVAL" | "BLOCK_ENDED" | "REFUND_DUE" | "OTHER";
/** Who an alert was routed to — the tiers `notification.routing.*` names. */
export type DeskAlertTarget = "OPERATOR" | "FOM" | "GM";

const ALERT_KIND: Record<string, DeskAlertKind> = {
  "NOTIFICATION.STAGE_DWELL_DISPATCHED": "STAGE_DWELL",
  "NOTIFICATION.OPERATOR_EXPIRY_DISPATCHED": "EXPIRED",
  "NOTIFICATION.INTERIM_PAYMENT_REMINDER_DISPATCHED": "PAYMENT_REMINDER",
  "NOTIFICATION.CHECKIN_PAYMENT_REMINDER_DISPATCHED": "PAYMENT_REMINDER",
  "NOTIFICATION.CHECKIN_PAYMENT_DEFERRAL_REQUESTED": "PAY_LATER_ASKED",
  "NOTIFICATION.LEAVE_OWING_REQUESTED": "LEAVE_OWING_ASKED",
  "NOTIFICATION.CHARGE_CORRECTION_REQUESTED": "CHARGE_CORRECTION_ASKED",
  "NOTIFICATION.ROOM_REMOVAL_REQUESTED": "ROOM_REMOVAL_ASKED",
  "NOTIFICATION.VIP_ARRIVAL_W14_PROCESSED": "VIP_ARRIVAL",
  "NOTIFICATION.BLOCK_TIME_ENDED": "BLOCK_ENDED",
  "NOTIFICATION.REFUND_DUE": "REFUND_DUE",
};
const TARGETS = new Set<DeskAlertTarget>(["OPERATOR", "FOM", "GM"]);

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v : null);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && v.trim() && Number.isFinite(Number(v)) ? Number(v) : null);

/**
 * The alerts the system sent — the `NOTIFICATION.*` traces — newest first, each read into one
 * shape the desk can word: what it was about, who it was routed to, how severe, and the booking
 * it concerns as that booking stands NOW (so the desk can say whether it has moved on). Read-only;
 * the trace is the record and nothing here changes it.
 */
/**
 * What waits for the FOM, GM or an admin right now (2026-11-26, operator: "when front desk asks for
 * permission, the notification on FOM or higher doesn't update unless I refresh the tab"). A small
 * list the bell asks for every few seconds; when it changes the bell reads the bookings again.
 */
export async function listWaitingForFom(prisma: Db) {
  const live = { status: "ACTIVE" as const };
  const [owing, corrections, changes, payLater, removals] = await Promise.all([
    prisma.leaveOwingRequest.findMany({ where: { status: "REQUESTED", entry: live }, select: { id: true, entryId: true, requestedAt: true } }),
    prisma.chargeCorrectionRequest.findMany({ where: { status: "REQUESTED", entry: live }, select: { id: true, entryId: true, requestedAt: true } }),
    prisma.negotiationAmendmentRequest.findMany({ where: { state: "REQUESTED", entry: live }, select: { id: true, entryId: true, requestedAt: true } }),
    prisma.checkInPaymentDeferral.findMany({ where: { status: "REQUESTED", entry: live }, select: { id: true, entryId: true, requestedAt: true } }),
    prisma.roomRemovalRequest.findMany({ where: { status: "REQUESTED", entry: live }, select: { id: true, entryId: true, requestedAt: true } }),
  ]);
  const items = [
    ...owing.map((r) => ({ kind: "LEAVE_OWING" as const, ...r })),
    ...corrections.map((r) => ({ kind: "CHARGE_CORRECTION" as const, ...r })),
    ...changes.map((r) => ({ kind: "NEGOTIATION_CHANGE" as const, ...r })),
    ...payLater.map((r) => ({ kind: "PAY_LATER" as const, ...r })),
    ...removals.map((r) => ({ kind: "ROOM_REMOVE" as const, ...r })),
  ].map((r) => ({ kind: r.kind, id: r.id, entryId: r.entryId, requestedAt: r.requestedAt.toISOString() }));
  return { items, key: items.map((i) => `${i.kind}:${i.id}`).sort().join("|") };
}

export async function listDeskAlerts(prisma: Db, q: { from: Date; to: Date; limit?: number }) {
  const limit = Math.min(Math.max(Math.trunc(q.limit ?? DESK_ALERTS_MAX), 1), DESK_ALERTS_MAX);
  const rows = await prisma.traceEvent.findMany({
    where: { eventType: { startsWith: "NOTIFICATION." }, timestamp: { gte: q.from, lt: q.to } },
    orderBy: { timestamp: "desc" },
    take: limit,
    select: { id: true, eventType: true, entityType: true, entityId: true, entryId: true, stageContext: true, payload: true, timestamp: true },
  });
  const entryIdOf = (r: (typeof rows)[number]) => {
    const p = (r.payload ?? {}) as Record<string, unknown>;
    return r.entryId ?? str(p.entryId) ?? (r.entityType === "Entry" ? r.entityId : null);
  };
  const ids = [...new Set(rows.map(entryIdOf).filter((x): x is string => !!x))];
  const entries = ids.length
    ? await prisma.entry.findMany({
        where: { id: { in: ids } },
        select: {
          id: true,
          currentStage: true,
          status: true,
          closedAs: true,
          checkInDate: true,
          checkOutDate: true,
          guestProfile: { select: { title: true, firstName: true, lastName: true } },
          inquiry: { select: { callerTitle: true, callerFirstName: true, callerLastName: true, callerPhone: true, callerEmail: true } },
        },
      })
    : [];
  const byId = new Map(entries.map((e) => [e.id, e]));
  return rows.map((r) => {
    const p = (r.payload ?? {}) as Record<string, unknown>;
    const entryId = entryIdOf(r);
    const targets = (Array.isArray(p.targets) ? p.targets : []).filter((t): t is DeskAlertTarget => typeof t === "string" && TARGETS.has(t as DeskAlertTarget));
    const severity = str(p.severity);
    return {
      id: r.id,
      at: r.timestamp,
      kind: ALERT_KIND[r.eventType] ?? ("OTHER" as DeskAlertKind),
      eventType: r.eventType,
      entryId,
      stage: str(p.stage) ?? r.stageContext ?? null,
      severity: severity === "WARNING" || severity === "CRITICAL" || severity === "ESCALATION" ? severity : null,
      targets,
      secondsInStage: num(p.secondsInStage),
      reason: str(p.reason),
      payment:
        r.eventType === "NOTIFICATION.INTERIM_PAYMENT_REMINDER_DISPATCHED"
          ? { kind: str(p.kind), remaining: num(p.remaining), remindersSent: num(p.remindersSent), dueBy: str(p.dueBy), billed: p.billed === true }
          : r.eventType === "NOTIFICATION.CHECKIN_PAYMENT_REMINDER_DISPATCHED"
            ? { kind: "CHECKIN", remaining: num(p.remaining), remindersSent: num(p.remindersSent), dueBy: str(p.dueBy), billed: false }
            : r.eventType === "NOTIFICATION.CHECKIN_PAYMENT_DEFERRAL_REQUESTED"
              ? { kind: "PAY_LATER", remaining: num(p.stillToPay), remindersSent: null, dueBy: null, billed: false }
              : r.eventType === "NOTIFICATION.LEAVE_OWING_REQUESTED"
                ? { kind: "LEAVE_OWING", remaining: num(p.amountOwed), remindersSent: null, dueBy: null, billed: false }
              : r.eventType === "NOTIFICATION.CHARGE_CORRECTION_REQUESTED"
                ? { kind: "CHARGE_CORRECTION", remaining: num(p.netAfter), remindersSent: null, dueBy: null, billed: false }
              : r.eventType === "NOTIFICATION.REFUND_DUE"
                ? { kind: "REFUND", remaining: num(p.amount), remindersSent: null, dueBy: null, billed: false }
              : null,
      booking: entryId ? (byId.get(entryId) ?? null) : null,
    };
  });
}
