import { EntryStatus, QuotationState, Stage, type PrismaClient } from "@prisma/client";
import { NotFoundError, ValidationError } from "../../lib/errors.js";
import { foldIsoNightsToRanges } from "../../lib/entry-inventory-claim.js";
import { sealAsPerNight } from "../../lib/option-selected-reader.js";
import { findRoomBookingConflicts } from "../../lib/room-booking-conflicts.js";
import { enforceNegotiationAmendmentAuthority } from "../../policies/01-availability/p01-entry-progression-stage-gates.js";
import { declineEntryBeforeSetup } from "../application/cancellation-service.js";
import { validateCapacity } from "./capacity-validation-service.js";
import { resolveDuplicateFlag } from "./duplicate-detection-service.js";
import { amendNegotiationConfiguration } from "./negotiation-amendment-service.js";
import { queryAvailability, selectOption } from "./s1-availability-service.js";
import { updateEntryIntakeFields } from "./s1-entry-service.js";
import { placeSpeculativeHold, releaseSpeculativeHold } from "./s2-hold-service.js";

/**
 * The same guest's other bookings, and combining two of them (2026-10-19).
 *
 * Operator: a switch put Pema Penjor on a night she already held under another booking, and the
 * desk asked whether the system should treat them as two bookings of one person or combine them.
 * The ruling given: they stay two bookings — a booking past Set up carries its own reservation,
 * bill, money and papers, none of which can be folded into another without rewriting what was
 * already recorded or sent. The one case that is safe is the start: both at Inquiry or
 * Negotiation, nothing stamped. There "combine" is exactly two ordinary acts — this booking takes
 * the other's guests and rooms (the Inquiry pick, or Negotiation's Change configuration), then the
 * other ends, COMBINED. Refused for everything else, in words.
 *
 * Further rules, each because a booking carries one party for every night and one set of terms:
 *   - one guest record on both (the same NAME is not the same guest);
 *   - the same nights — a booking cannot carry more guests on some nights than on others;
 *   - booked through the same party (agency, company, or none) — a combine must not mix payers;
 *   - both have their rooms picked, and no room picked by both on the same night.
 */

type Actor = { actorId: string; actorLevel: "L1" | "L2" | "L3" | "L4" };

const COMBINABLE_STAGES = new Set<string>([Stage.S1, Stage.S2]);
const STAGE_WORD: Record<string, string> = {
  S1: "Inquiry",
  S2: "Negotiation",
  S3: "Set up",
  S4: "Reserve",
  S5: "Arrival",
  S6: "Check-in",
  S7: "Stay",
  S8: "Check-out",
  S9: "Closed",
  TERMINAL: "ended",
};
const LIVE = new Set<string>([EntryStatus.ACTIVE, EntryStatus.PARKED]);

const iso = (d: Date) => d.toISOString().slice(0, 10);
const fmtDay = (d: string) =>
  new Date(`${d}T00:00:00.000Z`).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });
const stayWords = (ci: Date | null, co: Date | null) => (ci && co ? `${fmtDay(iso(ci))} – ${fmtDay(iso(co))}` : "no dates yet");
const nameOf = (g: { firstName: string | null; lastName: string | null } | null | undefined) =>
  [g?.firstName, g?.lastName].filter(Boolean).join(" ").trim() || null;

async function loadBooking(prisma: PrismaClient, entryId: string) {
  const e = await prisma.entry.findUnique({
    where: { id: entryId },
    select: {
      id: true,
      inquiryId: true,
      status: true,
      currentStage: true,
      closedAs: true,
      version: true,
      guestProfileId: true,
      adultCount: true,
      childCount: true,
      childAges: true,
      numberOfRooms: true,
      bedTypeRequest: true,
      checkInDate: true,
      checkOutDate: true,
      guestProfile: { select: { firstName: true, lastName: true } },
      inquiry: {
        select: {
          travelAgentId: true,
          corporateAccountId: true,
          ratePackageId: true,
          travelAgent: { select: { displayName: true } },
          corporateAccount: { select: { displayName: true } },
        },
      },
      folio: { select: { id: true } },
      reservations: { select: { id: true }, take: 1 },
      segments: { orderBy: { segmentNumber: "desc" }, take: 1, select: { id: true } },
      availabilityConfigs: {
        where: { sealedAt: { not: null } },
        orderBy: { sealedAt: "desc" },
        take: 10,
        select: { segmentId: true, optionSelected: true },
      },
      speculativeHolds: { where: { state: "PLACED" }, select: { id: true, roomId: true, expiresAt: true } },
      roomAssignments: { select: { roomId: true, startDate: true, endDate: true, room: { select: { roomNumber: true } } } },
      _count: { select: { bookingNotes: true } },
    },
  });
  if (!e) return null;
  const segmentId = e.segments[0]?.id ?? null;
  // The pick of THIS pass — an earlier pass's seal is history.
  const seal = e.availabilityConfigs.find((c) => c.optionSelected && (c.segmentId == null || c.segmentId === segmentId)) ?? null;
  const nights = seal ? sealAsPerNight(seal.optionSelected, { checkIn: e.checkInDate, checkOut: e.checkOutDate }) ?? [] : [];
  const openRequests = await prisma.guestRequest.count({ where: { entryId, state: "ASKED" } });
  return { ...e, segmentId, nights: nights.map((n) => ({ date: n.date, roomIds: n.roomIds.map((r) => r.roomId) })), openRequests };
}
type Booking = NonNullable<Awaited<ReturnType<typeof loadBooking>>>;

function partyWords(b: Booking): string {
  return b.inquiry?.travelAgent?.displayName ?? b.inquiry?.corporateAccount?.displayName ?? "direct";
}
const samePart = (a: Booking, b: Booking) =>
  (a.inquiry?.travelAgentId ?? null) === (b.inquiry?.travelAgentId ?? null) &&
  (a.inquiry?.corporateAccountId ?? null) === (b.inquiry?.corporateAccountId ?? null);

/** Room numbers this booking uses: the rooms it is in, else the rooms its pick holds out for it. */
async function roomNumbersOf(prisma: PrismaClient, b: Booking, roomNo?: Map<string, string>): Promise<string[]> {
  const out = new Set<string>();
  for (const a of b.roomAssignments) {
    if (a.startDate && a.endDate && a.startDate.getTime() >= a.endDate.getTime()) continue;
    if (a.room?.roomNumber) out.add(a.room.roomNumber);
  }
  if (out.size === 0) {
    const ids = [...new Set(b.nights.flatMap((n) => n.roomIds))];
    const map = roomNo ?? new Map((await prisma.room.findMany({ where: { id: { in: ids } }, select: { id: true, roomNumber: true } })).map((r) => [r.id, r.roomNumber]));
    for (const id of ids) {
      const n = map.get(id);
      if (n) out.add(n);
    }
  }
  return [...out].sort((x, y) => x.localeCompare(y, "en", { numeric: true }));
}

/**
 * Why these two cannot be combined, in words — empty when they can as far as the bookings
 * themselves go. The house's own answer (rooms still free, the party fitting) is asked by the
 * preview.
 */
function combineBlockers(kept: Booking, other: Booking, roomNo: Map<string, string>): string[] {
  const out: string[] = [];
  if (kept.id === other.id) return ["That is this booking"];
  if (!kept.guestProfileId || kept.guestProfileId !== other.guestProfileId) {
    out.push("They are not the same guest record — only one guest's own bookings can be combined");
  }
  if (!LIVE.has(String(other.status))) out.push(`${other.id} has ended`);
  if (kept.status === EntryStatus.PARKED) out.push("This booking is parked — resume it first");
  else if (kept.status !== EntryStatus.ACTIVE) out.push("This booking has ended");
  for (const b of [kept, other]) {
    const who = b.id === kept.id ? "This booking" : b.id;
    const stage = String(b.currentStage);
    if (!COMBINABLE_STAGES.has(stage)) {
      out.push(
        `${who} is at ${STAGE_WORD[stage] ?? stage} — past Negotiation a booking has its own reservation, bill and papers, so it is not combined; add the rooms through Change configuration and cancel the other`,
      );
    } else if (b.folio || b.reservations.length > 0) {
      out.push(`${who} has been to Set up before and carries a bill or a reservation — it is not combined`);
    }
  }
  const sameNights =
    !!kept.checkInDate && !!kept.checkOutDate && !!other.checkInDate && !!other.checkOutDate &&
    kept.checkInDate.getTime() === other.checkInDate.getTime() && kept.checkOutDate.getTime() === other.checkOutDate.getTime();
  if (!sameNights) {
    out.push(
      `${other.id} is for ${stayWords(other.checkInDate, other.checkOutDate)} and this booking for ${stayWords(kept.checkInDate, kept.checkOutDate)} — a booking carries one party for every night, so only bookings for the same nights are combined`,
    );
  }
  if (!samePart(kept, other)) {
    out.push(`They are booked through different parties (${partyWords(kept)} and ${partyWords(other)}) — combining would mix who pays`);
  }
  for (const b of [kept, other]) {
    if (b.nights.length === 0 || b.nights.some((n) => n.roomIds.length === 0)) {
      out.push(`${b.id === kept.id ? "This booking" : b.id} has no rooms picked yet — pick them first`);
    }
  }
  if (sameNights && out.length === 0) {
    for (const n of kept.nights) {
      const theirs = new Set(other.nights.find((x) => x.date === n.date)?.roomIds ?? []);
      for (const r of n.roomIds) {
        if (theirs.has(r)) out.push(`Both picked Room ${roomNo.get(r) ?? "?"} on ${fmtDay(n.date)}`);
      }
    }
  }
  return out;
}

async function roomNumberMap(prisma: PrismaClient, ...bs: Booking[]) {
  const ids = [...new Set(bs.flatMap((b) => [...b.nights.flatMap((n) => n.roomIds), ...b.roomAssignments.map((a) => a.roomId)]))];
  const rows = await prisma.room.findMany({ where: { id: { in: ids } }, select: { id: true, roomNumber: true } });
  return new Map(rows.map((r) => [r.id, r.roomNumber]));
}

/* ───────────────────────────── the card ───────────────────────────── */

export type SameGuestBooking = {
  entryId: string;
  inquiryId: string;
  sameEnquiry: boolean;
  stage: string;
  stageWord: string;
  status: string;
  closedAs: string | null;
  live: boolean;
  checkInDate: string | null;
  checkOutDate: string | null;
  rooms: string[];
  /** Live, and its nights overlap this booking's — the case Policy 13 asks about. */
  overlapsThis: boolean;
  combine: { possible: boolean; why: string | null };
};

/**
 * The same guest's other bookings, on any enquiry (2026-10-19) — "This trip" shows only the stays
 * of one enquiry, and a guest's second booking on another enquiry was invisible from the first.
 * Matched on the guest RECORD, never on the name.
 */
export async function listSameGuestBookings(prisma: PrismaClient, entryId: string) {
  const self = await loadBooking(prisma, entryId);
  if (!self) throw new NotFoundError("Entry");
  if (!self.guestProfileId) return { guestProfileId: null, guestName: null, bookings: [] as SameGuestBooking[] };
  const ids = (
    await prisma.entry.findMany({
      where: { guestProfileId: self.guestProfileId, id: { not: entryId } },
      orderBy: [{ checkInDate: "desc" }, { createdAt: "desc" }],
      take: 30,
      select: { id: true },
    })
  ).map((r) => r.id);
  const others = (await Promise.all(ids.map((id) => loadBooking(prisma, id)))).filter((b): b is Booking => !!b);
  const roomNo = await roomNumberMap(prisma, self, ...others);
  const bookings: SameGuestBooking[] = [];
  for (const b of others) {
    const live = LIVE.has(String(b.status));
    const overlapsThis =
      live && LIVE.has(String(self.status)) && !!self.checkInDate && !!self.checkOutDate && !!b.checkInDate && !!b.checkOutDate &&
      b.checkInDate < self.checkOutDate && b.checkOutDate > self.checkInDate;
    const blockers = live ? combineBlockers(self, b, roomNo) : [`${b.id} has ended`];
    bookings.push({
      entryId: b.id,
      inquiryId: b.inquiryId,
      sameEnquiry: b.inquiryId === self.inquiryId,
      stage: String(b.currentStage),
      stageWord: STAGE_WORD[String(b.currentStage)] ?? String(b.currentStage),
      status: String(b.status),
      closedAs: b.closedAs ?? null,
      live,
      checkInDate: b.checkInDate ? iso(b.checkInDate) : null,
      checkOutDate: b.checkOutDate ? iso(b.checkOutDate) : null,
      rooms: await roomNumbersOf(prisma, b, roomNo),
      overlapsThis,
      combine: { possible: blockers.length === 0, why: blockers[0] ?? null },
    });
  }
  return { guestProfileId: self.guestProfileId, guestName: nameOf(self.guestProfile), bookings };
}

/* ───────────────────────────── combine ───────────────────────────── */

export type CombinePreview = {
  ok: boolean;
  refusals: string[];
  authority: { needed: "L1" | "L2"; ok: boolean; why: string };
  kept: { entryId: string; stageWord: string; adults: number; children: number; rooms: string[] };
  other: { entryId: string; stageWord: string; adults: number; children: number; rooms: string[]; notes: number; openRequests: number; holdsBlock: boolean };
  after: {
    adults: number;
    children: number;
    childAges: number[];
    numberOfRooms: number;
    nights: Array<{ date: string; rooms: string[] }>;
    bedTypeRequest: Record<string, number> | null;
  };
  consequences: string[];
};

function mergedBedAsk(a: unknown, b: unknown): Record<string, number> | null {
  const rec = (x: unknown) => (x && typeof x === "object" && !Array.isArray(x) ? (x as Record<string, number>) : null);
  const ra = rec(a);
  const rb = rec(b);
  if (!ra && !rb) return null;
  const out: Record<string, number> = { ...(ra ?? {}) };
  for (const [k, v] of Object.entries(rb ?? {})) out[k] = (out[k] ?? 0) + (Number(v) || 0);
  return out;
}

async function planCombine(prisma: PrismaClient, actor: Actor, keptId: string, otherId: string) {
  const kept = await loadBooking(prisma, keptId);
  if (!kept) throw new NotFoundError("Entry");
  const other = await loadBooking(prisma, otherId);
  if (!other) throw new NotFoundError("Entry");
  const roomNo = await roomNumberMap(prisma, kept, other);
  const refusals = combineBlockers(kept, other, roomNo);

  const adults = (kept.adultCount ?? 0) + (other.adultCount ?? 0);
  const childAges = [...(kept.childAges ?? []), ...(other.childAges ?? [])];
  const children = (kept.childCount ?? kept.childAges?.length ?? 0) + (other.childCount ?? other.childAges?.length ?? 0);
  const nights = kept.nights.map((n) => ({
    date: n.date,
    roomIds: [...new Set([...n.roomIds, ...(other.nights.find((x) => x.date === n.date)?.roomIds ?? [])])],
  }));
  const numberOfRooms = Math.max(0, ...nights.map((n) => n.roomIds.length));
  const bedTypeRequest = mergedBedAsk(kept.bedTypeRequest, other.bedTypeRequest);

  // Who may change this booking: Negotiation's own rule — once its quotation has gone to the
  // guest (or been accepted), the FOM.
  let authority: CombinePreview["authority"] = { needed: "L1", ok: true, why: "Adding the rooms before anything is sent is desk work" };
  if (String(kept.currentStage) === Stage.S2 && kept.segmentId) {
    const live = await prisma.quotation.findMany({
      where: { entryId: kept.id, segmentId: kept.segmentId, state: { in: [QuotationState.SENT, QuotationState.ACCEPTED] } },
      select: { state: true },
    });
    try {
      enforceNegotiationAmendmentAuthority({
        actorLevel: actor.actorLevel,
        quotationSent: live.some((q) => q.state === QuotationState.SENT),
        quotationAccepted: live.some((q) => q.state === QuotationState.ACCEPTED),
      });
      if (live.length > 0) authority = { needed: "L2", ok: true, why: "This booking's quotation has gone to the guest — combining is the FOM's" };
    } catch (e) {
      authority = { needed: "L2", ok: false, why: (e as Error).message.replace("changing the rooms or the party", "combining the bookings") };
    }
  }

  // The house's answer, nothing written: every room of the other booking free for this one on
  // its nights (the other's own claim passed over — it is about to let the rooms go to this one),
  // and the party fitting.
  if (refusals.length === 0) {
    const otherRooms = [...new Set(other.nights.flatMap((n) => n.roomIds))];
    for (const roomId of otherRooms) {
      const roomNights = other.nights.filter((n) => n.roomIds.includes(roomId)).map((n) => n.date);
      for (const r of foldIsoNightsToRanges(roomNights)) {
        const clash = await findRoomBookingConflicts(prisma, {
          roomIds: [roomId],
          checkIn: r.startDate,
          checkOut: r.endDate,
          excludeEntryId: kept.id,
          tolerate: [{ entryId: other.id, roomId }],
        });
        if (clash.length > 0) {
          const c = clash[0] as { entryId?: string | null; guestName?: string | null };
          refusals.push(`Room ${roomNo.get(roomId) ?? "?"} is taken on ${stayWords(r.startDate, r.endDate)} by ${[c.entryId, c.guestName].filter(Boolean).join(" · ") || "another booking"}`);
        }
      }
    }
    const largest = await prisma.roomType.aggregate({ _max: { maxCapacity: true } });
    const { issues } = await validateCapacity(prisma, {
      adults,
      childAges,
      numberOfRooms,
      fallbackMaxCapacity: largest._max.maxCapacity ?? 3,
    });
    for (const i of issues.filter((x) => x.severity === "BLOCK")) refusals.push(i.message);
  }

  const consequences = [
    `${other.id} ends — "Combined into ${kept.id}". Its rooms and guests are this booking's from now on`,
    ...(String(kept.currentStage) === Stage.S2 ? ["This booking's quotation is withdrawn — price it again at Negotiation"] : []),
    ...(String(other.currentStage) === Stage.S2 ? [`${other.id}'s quotation is withdrawn with it`] : []),
    ...(other.speculativeHolds.length > 0
      ? kept.speculativeHolds.length > 0
        ? ["This booking's provisional block moves onto every room, keeping its deadline"]
        : [`${other.id}'s provisional block is lifted — mark the rooms again on this booking if they should stay held`]
      : []),
    ...(kept.inquiry?.ratePackageId !== other.inquiry?.ratePackageId ? ["This booking's rate package prices every room"] : []),
    ...(other._count.bookingNotes > 0 || other.openRequests > 0
      ? [
          `${other.id}'s ${[
            other._count.bookingNotes ? `${other._count.bookingNotes} note${other._count.bookingNotes === 1 ? "" : "s"}` : null,
            other.openRequests ? `${other.openRequests} open request${other.openRequests === 1 ? "" : "s"}` : null,
          ]
            .filter(Boolean)
            .join(" and ")} stay on it — add anything still needed here`,
        ]
      : []),
  ];

  const preview: CombinePreview = {
    ok: refusals.length === 0 && authority.ok,
    refusals,
    authority,
    kept: {
      entryId: kept.id,
      stageWord: STAGE_WORD[String(kept.currentStage)] ?? String(kept.currentStage),
      adults: kept.adultCount ?? 0,
      children: kept.childCount ?? 0,
      rooms: await roomNumbersOf(prisma, kept, roomNo),
    },
    other: {
      entryId: other.id,
      stageWord: STAGE_WORD[String(other.currentStage)] ?? String(other.currentStage),
      adults: other.adultCount ?? 0,
      children: other.childCount ?? 0,
      rooms: await roomNumbersOf(prisma, other, roomNo),
      notes: other._count.bookingNotes,
      openRequests: other.openRequests,
      holdsBlock: other.speculativeHolds.length > 0,
    },
    after: {
      adults,
      children,
      childAges,
      numberOfRooms,
      nights: nights.map((n) => ({
        date: n.date,
        rooms: n.roomIds.map((r) => roomNo.get(r) ?? "?").sort((x, y) => x.localeCompare(y, "en", { numeric: true })),
      })),
      bedTypeRequest,
    },
    consequences,
  };
  return { preview, kept, other, nights, adults, children, childAges, numberOfRooms, bedTypeRequest };
}

export async function previewCombineBookings(prisma: PrismaClient, actor: Actor, keptId: string, otherId: string): Promise<CombinePreview> {
  return (await planCombine(prisma, actor, keptId, otherId)).preview;
}

export type CombineOutcome = {
  entryId: string;
  combinedFrom: string;
  stage: string;
  rooms: string[];
  adults: number;
  children: number;
  otherEnded: boolean;
  /** Set when this booking took the rooms but the other could not be ended — end it by hand. */
  otherEndRefused: string | null;
  /** The duplicate flags the combine answered as MERGE — the overlap they raised is gone. */
  flagsResolved: string[];
  notes: string[];
};

/**
 * Combine: this booking takes the other's guests and rooms, then the other ends COMBINED.
 * Order matters, and each step is an ordinary governed act:
 *   1. the other's provisional block is lifted — its rooms are moving to the same guest's other
 *      booking, so nothing is forgone (the amendment's re-mark reasoning);
 *   2. the house is asked for THIS booking's stay with the whole party;
 *   3. this booking takes the party and the rooms — Negotiation's Change configuration, or the
 *      Inquiry pick (intake update + seal) — every check of those acts applies. A refusal here puts
 *      the other's block back and stops, the other untouched;
 *   4. the other ends through the decline's own release, as COMBINED.
 */
export async function executeCombineBookings(
  prisma: PrismaClient,
  actor: Actor,
  input: { keptId: string; otherId: string; reason: string; expectedVersion?: number },
): Promise<CombineOutcome> {
  const reason = input.reason?.trim();
  if (!reason) throw new ValidationError("Say why the bookings are being combined");
  const plan = await planCombine(prisma, actor, input.keptId, input.otherId);
  const { preview, kept, other } = plan;
  if (!preview.authority.ok) throw new ValidationError(preview.authority.why);
  if (!preview.ok) throw new ValidationError(preview.refusals.join(" · "));
  if (input.expectedVersion != null && input.expectedVersion !== kept.version) {
    throw new ValidationError("This booking changed on another screen — reload it and try again.");
  }
  if (!kept.checkInDate || !kept.checkOutDate) throw new ValidationError("This booking has no dates yet");
  const notes: string[] = [];

  // 1. lift the other's marker
  const lifted: Array<{ roomId: string | null }> = [];
  for (const h of other.speculativeHolds) {
    await releaseSpeculativeHold(prisma, other.id, h.id, actor, {
      releaseReason: `Its rooms move to ${kept.id} — the same guest's bookings are being combined: ${reason}`,
      internalReMark: true,
    });
    lifted.push({ roomId: h.roomId });
  }
  const putBackMarker = async () => {
    for (const h of lifted) {
      await placeSpeculativeHold(prisma, other.id, actor, {
        ...(h.roomId ? { roomId: h.roomId } : {}),
        commercialBasis: `Marked again — combining with ${kept.id} did not go ahead`,
      }).catch((e) => notes.push(`${other.id}'s rooms could not be marked again: ${(e as Error).message}`));
    }
  };

  const perNight = plan.nights.map((n) => ({ date: n.date, roomIds: n.roomIds }));
  const party = {
    adultCount: plan.adults,
    childCount: plan.children,
    childAges: plan.childAges,
    numberOfRooms: plan.numberOfRooms,
    ...(plan.bedTypeRequest ? { bedTypeRequest: plan.bedTypeRequest } : {}),
  };
  const why = `Combined with ${other.id} (the same guest's booking for the same nights): ${reason}`;
  try {
    // 2. ask the house for this booking's stay, the whole party
    const search = await queryAvailability(prisma, kept.id, actor.actorId, actor.actorLevel, {
      checkInDate: iso(kept.checkInDate),
      checkOutDate: iso(kept.checkOutDate),
      guestCount: plan.adults + plan.children,
    });
    const configurationId = (search as { configuration: { id: string } }).configuration.id;
    // 3. take the party and the rooms
    if (String(kept.currentStage) === Stage.S2) {
      const out = await amendNegotiationConfiguration(prisma, kept.id, actor, {
        party,
        rooms: { configurationId, perNight },
        reason: why,
      });
      if (!out.applied) throw new ValidationError("The change is waiting for the FOM's approval — combining needs it applied now");
    } else {
      await selectOption(prisma, configurationId, actor.actorId, { perNight }, {
        validateOnly: true,
        stay: { checkInDate: kept.checkInDate, checkOutDate: kept.checkOutDate, numberOfRooms: plan.numberOfRooms },
      });
      await updateEntryIntakeFields(prisma, kept.id, actor.actorId, actor.actorLevel, {
        ...party,
        guestCount: plan.adults + plan.children,
      });
      await selectOption(prisma, configurationId, actor.actorId, { perNight });
    }
  } catch (e) {
    await putBackMarker();
    throw e;
  }

  // 4. the other ends, COMBINED
  let otherEnded = true;
  let otherEndRefused: string | null = null;
  try {
    await declineEntryBeforeSetup(prisma, other.id, actor.actorId, {
      reason: `Combined into ${kept.id}: ${reason}`,
      actorLevel: actor.actorLevel,
      combinedInto: kept.id,
    });
  } catch (e) {
    otherEnded = false;
    otherEndRefused = `${other.id} could not be ended: ${(e as Error).message} — end it by hand`;
  }

  /**
   * The duplicate flag answered (2026-10-19). Naming the guest on file at Wrap up FLAGS the second
   * booking, and the flag blocks its way out of Inquiry; its own "MERGE" answer is what a combine
   * is. A flag records only its enquiry, not the booking it clashed with, so it is answered only
   * once nothing of this guest still overlaps: on this booking's enquiry when no other live
   * booking of the guest overlaps its nights; on the other's when that enquiry has nothing live.
   */
  const flagsResolved: string[] = [];
  if (otherEnded && kept.checkInDate && kept.checkOutDate) {
    const answer = async (inquiryId: string) => {
      const flags = await prisma.duplicateDetectionFlag.findMany({ where: { inquiryId, status: "OPEN" }, select: { id: true } });
      for (const f of flags) {
        await resolveDuplicateFlag(prisma, f.id, actor.actorId, {
          resolutionType: "MERGE",
          resolutionReason: `Combined: ${other.id} went into ${kept.id} — ${reason}`,
          mergedIntoInquiryId: kept.inquiryId,
        });
        flagsResolved.push(f.id);
      }
    };
    const stillOverlapping = await prisma.entry.count({
      where: {
        guestProfileId: kept.guestProfileId,
        id: { notIn: [kept.id, other.id] },
        inquiryId: { not: kept.inquiryId },
        status: { in: [EntryStatus.ACTIVE, EntryStatus.PARKED] },
        checkInDate: { lt: kept.checkOutDate },
        checkOutDate: { gt: kept.checkInDate },
      },
    });
    if (stillOverlapping === 0) await answer(kept.inquiryId);
    if (other.inquiryId !== kept.inquiryId) {
      const liveOnOther = await prisma.entry.count({ where: { inquiryId: other.inquiryId, status: { in: [EntryStatus.ACTIVE, EntryStatus.PARKED] } } });
      if (liveOnOther === 0) await answer(other.inquiryId);
    }
  }

  await prisma.traceEvent.create({
    data: {
      eventType: "ENTRY.BOOKINGS_COMBINED",
      actorId: actor.actorId,
      actorLevel: actor.actorLevel,
      entityType: "Entry",
      entityId: kept.id,
      operation: "UPDATE",
      timestamp: new Date(),
      stageContext: kept.currentStage as Stage,
      inquiryId: kept.inquiryId,
      entryId: kept.id,
      payload: {
        entryId: kept.id,
        combinedFrom: other.id,
        reason,
        before: { adults: kept.adultCount, children: kept.childCount, rooms: preview.kept.rooms },
        took: { adults: other.adultCount, children: other.childCount, rooms: preview.other.rooms },
        after: { adults: plan.adults, children: plan.children, numberOfRooms: plan.numberOfRooms, nights: preview.after.nights },
        otherEnded,
        otherEndRefused,
        flagsResolved,
      },
      createdBy: actor.actorId,
    },
  });

  const now = await prisma.entry.findUniqueOrThrow({ where: { id: kept.id }, select: { currentStage: true } });
  return {
    entryId: kept.id,
    combinedFrom: other.id,
    stage: String(now.currentStage),
    rooms: [...new Set(preview.after.nights.flatMap((n) => n.rooms))],
    adults: plan.adults,
    children: plan.children,
    otherEnded,
    otherEndRefused,
    flagsResolved,
    notes,
  };
}

