import type { PrismaClient } from "@prisma/client";
import { Prisma, Stage } from "@prisma/client";
import { AppError, NotFoundError, ValidationError } from "../../lib/errors.js";
import { requireActiveConfigValue } from "../../lib/config-store.js";
import { readOptionSelected } from "../../lib/option-selected-reader.js";
import { foldIsoNightsToRanges } from "../../lib/entry-inventory-claim.js";
import { findRoomBookingConflicts } from "../../lib/room-booking-conflicts.js";
import { hotelTodayUtc } from "../../lib/stay-dates.js";
import { resolveOperativeQuotation } from "../../lib/operative-quotation.js";
import {
  enforceCommittedHoldRoomPhysicallyUsable,
  enforceNoOverlappingBookingForCommittedHold,
} from "../../policies/11-committed-hold/p26-committed-hold-inventory-availability.js";
import { changeRoomToNewSegment, shiftIsoDate, type RoomChangeOutcome } from "./room-change-service.js";
import { buildQuotationPreview } from "./quotation-preview-service.js";
import { queryAvailability } from "./s1-availability-service.js";
import { amendNegotiationConfiguration, type NegotiationAmendmentOutcome } from "./negotiation-amendment-service.js";

/**
 * MOVING A BOOKING TO OTHER DATES FROM THE HOUSE CHART (2026-10-13, operator: "right now we can
 * switch the rooms for the same date — can it also switch to different dates").
 *
 * Rulings the same day: any booking before check-in (Negotiation to Arrival); the guest keeps the
 * price they agreed unless the desk prices the stay at the new dates with the guest's agreement
 * typed in; the drag shifts the whole stay (same number of nights); the FOM from Set up on.
 *
 * Two routes, each the governed act its step already has:
 *
 *   - **Negotiation** — the change of configuration (negotiation-amendment-service), dates and
 *     rooms together, inside the pass. Its own rule decides who may do it: the desk while nothing
 *     has been sent, the FOM's approval once a quotation went out (the change then waits). The
 *     quotation on file is retired, so the price is made again at the table.
 *   - **Set up, Reserve, Arrival** — the room-change walk in its date-shift form
 *     (`changeRoomToNewSegment({ dateShift })`): a new pass, the rooms re-held on the new nights,
 *     the quotation made again silently, re-reserved with a new voucher held for the desk, and back
 *     to the step it came from (from Arrival to a day beyond the arrival window, it stays at
 *     Reserve until Arrival opens on its own).
 *
 * The preview writes nothing: every room is checked on its new nights the way the hold will check
 * it, and the figures are the server's.
 */

type Actor = { actorId: string; actorLevel: "L1" | "L2" | "L3" | "L4" };
const RANK: Record<string, number> = { L1: 1, L2: 2, L3: 3, L4: 4 };
const DAY = 86_400_000;

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

export type DateMoveRequest = {
  entryId: string;
  /** The room whose bar was dragged. */
  fromRoomId: string;
  /** Where that room lands, when the drag also changed its row. */
  toRoomId?: string | null;
  /** The new first night, "YYYY-MM-DD". */
  newCheckInDate: string;
  priceMode?: "KEEP" | "NEW_DATES";
  guestAgreedNote?: string | null;
  reason?: string | null;
};

export type DateMovePreview = {
  ok: boolean;
  entryId: string;
  bookingLabel: string;
  guestName: string | null;
  stage: string;
  stageWord: string;
  route: "NEGOTIATION" | "WALK";
  from: { checkInDate: string; checkOutDate: string; nights: number };
  to: { checkInDate: string; checkOutDate: string; nights: number };
  shiftDays: number;
  rooms: Array<{ roomId: string; roomNumber: string; toRoomNumber: string | null; nightsLabel: string }>;
  authority: { needed: "L1" | "L2"; actorLevel: string; ok: boolean; waitsForApproval: boolean; why: string };
  price: { before: number | null; after: number | null; delta: number | null; currency: string | null; note: string | null };
  path: string[];
  papers: string[];
  notes: string[];
  refusals: string[];
};

export type DateMoveResult =
  | { route: "WALK"; entryId: string; outcome: RoomChangeOutcome }
  | { route: "NEGOTIATION"; entryId: string; outcome: NegotiationAmendmentOutcome };

const iso = (d: Date) => d.toISOString().slice(0, 10);
const fmtDay = (d: string) =>
  new Date(`${d}T00:00:00.000Z`).toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });
function nightsLabel(nights: string[]): string {
  return foldIsoNightsToRanges([...new Set(nights)].sort())
    .map((r) => `${fmtDay(iso(r.startDate))} – ${fmtDay(iso(r.endDate))}`)
    .join(" · ");
}
function nightsBetween(a: Date, b: Date): string[] {
  const out: string[] = [];
  for (let t = a.getTime(); t < b.getTime(); t += DAY) out.push(new Date(t).toISOString().slice(0, 10));
  return out;
}
function errorMessage(e: unknown): string {
  if (e instanceof AppError) return e.body.message;
  return e instanceof Error ? e.message : String(e);
}

async function loadEntry(prisma: PrismaClient, entryId: string) {
  const entry = await prisma.entry.findUnique({
    where: { id: entryId },
    include: {
      guestProfile: { select: { firstName: true, lastName: true } },
      inquiry: { select: { callerFirstName: true, callerLastName: true } },
      segments: { orderBy: { segmentNumber: "desc" }, take: 1 },
      quotations: { orderBy: { createdAt: "desc" } },
      availabilityConfigs: {
        where: { sealedAt: { not: null }, optionSelected: { not: Prisma.DbNull } },
        orderBy: { sealedAt: "desc" },
        take: 1,
      },
      speculativeHolds: { where: { state: "PLACED" }, orderBy: { placedAt: "desc" }, take: 1 },
      guestRequests: { where: { state: "ASKED" }, select: { kind: true, what: true, forDate: true } },
      reservation: { select: { frozenCheckInDate: true, frozenCheckOutDate: true, segmentId: true } },
    },
  });
  if (!entry) throw new NotFoundError("Entry");
  return entry;
}

/** The step refusals, in words — the same for the preview and the run. */
function stageRefusal(entry: { currentStage: Stage; status: string }): string | null {
  if (entry.status === "PARKED") return "This booking is parked — resume it first";
  if (entry.status !== "ACTIVE") return "This booking has ended — its dates are a record now";
  switch (entry.currentStage) {
    case Stage.S1:
      return "At Inquiry the stay's dates are changed on the booking's Inquiry step";
    case Stage.S6:
    case Stage.S7:
      return "The guest is checking in or in house — the stay changes length through Extend the stay or Leaving early";
    case Stage.S8:
    case Stage.S9:
      return "The guest has left or is leaving — a stay that has happened does not move";
    default:
      return null;
  }
}

/** Negotiation: the sealed pick, night by night, moved to the new nights with the dragged room swapped in. */
function negotiationPicture(
  sealedOption: unknown,
  priorNights: string[],
  shiftDays: number,
  fromRoomId: string,
  toRoomId: string | null,
): Array<{ date: string; roomIds: string[] }> {
  const sel = readOptionSelected(sealedOption ?? null);
  const base =
    sel.perNight && sel.perNight.length > 0
      ? sel.perNight.map((n) => ({ date: String(n.date).slice(0, 10), roomIds: [...n.roomIds] }))
      : priorNights.map((date) => ({ date, roomIds: [...sel.distinctRoomIds] }));
  return base.map((n) => ({
    date: shiftIsoDate(n.date, shiftDays),
    roomIds: n.roomIds.map((id) => (id === fromRoomId && toRoomId ? toRoomId : id)),
  }));
}

export async function previewDateMove(prisma: PrismaClient, actor: Actor, input: DateMoveRequest): Promise<DateMovePreview> {
  const entry = await loadEntry(prisma, input.entryId);
  const guest = [entry.guestProfile?.firstName, entry.guestProfile?.lastName].filter(Boolean).join(" ").trim() ||
    [entry.inquiry?.callerFirstName, entry.inquiry?.callerLastName].filter(Boolean).join(" ").trim() || null;
  const stage = String(entry.currentStage);
  const refusals: string[] = [];
  const notes: string[] = [];

  const reservationOfPass = entry.reservation && entry.reservation.segmentId === entry.segments[0]?.id ? entry.reservation : null;
  const priorIn = reservationOfPass?.frozenCheckInDate ?? entry.checkInDate;
  const priorOut = reservationOfPass?.frozenCheckOutDate ?? entry.checkOutDate;
  if (!priorIn || !priorOut) throw new ValidationError("This booking has no stay dates to move");
  const newIn = new Date(`${input.newCheckInDate.slice(0, 10)}T00:00:00.000Z`);
  if (Number.isNaN(newIn.getTime())) throw new ValidationError("newCheckInDate must be a date (YYYY-MM-DD)");
  const shiftDays = Math.round((newIn.getTime() - priorIn.getTime()) / DAY);
  const newOut = new Date(priorOut.getTime() + shiftDays * DAY);
  const nights = Math.round((priorOut.getTime() - priorIn.getTime()) / DAY);

  const stepRefusal = stageRefusal(entry);
  if (stepRefusal) refusals.push(stepRefusal);
  if (shiftDays === 0) refusals.push("The new check-in is the day the booking already starts — nothing moves");
  if (newIn.getTime() < hotelTodayUtc().getTime()) refusals.push("The new check-in is before today at the hotel");

  const route: DateMovePreview["route"] = entry.currentStage === Stage.S2 ? "NEGOTIATION" : "WALK";
  const toRoomId = input.toRoomId && input.toRoomId !== input.fromRoomId ? input.toRoomId : null;
  const roomIdsOfNote = [input.fromRoomId, ...(toRoomId ? [toRoomId] : [])];
  const roomNumbers = new Map(
    (await prisma.room.findMany({ where: { id: { in: roomIdsOfNote } }, select: { id: true, roomNumber: true } })).map((r) => [r.id, r.roomNumber]),
  );

  // Requests asked for a day the new stay no longer covers — named, never withdrawn on the desk's behalf.
  const newInIso = iso(newIn);
  const newOutIso = iso(newOut);
  for (const r of entry.guestRequests ?? []) {
    const d = r.forDate ? iso(r.forDate) : null;
    if (d && (d < newInIso || d >= newOutIso)) notes.push(`A guest request (${r.kind.toLowerCase()}: ${r.what}) is dated ${fmtDay(d)}, outside the new stay — change it on the booking`);
  }

  // ── The rooms on their new nights ───────────────────────────────────────────────────────────
  let rooms: DateMovePreview["rooms"] = [];
  let price: DateMovePreview["price"] = { before: null, after: null, delta: null, currency: null, note: null };
  let authority: DateMovePreview["authority"];
  const path: string[] = [];
  const papers: string[] = [];

  if (route === "NEGOTIATION") {
    const sealed = entry.availabilityConfigs[0] ?? null;
    if (!sealed) refusals.push("No rooms are picked for this booking yet — pick them at Negotiation first");
    const picture = sealed
      ? negotiationPicture(sealed.optionSelected, nightsBetween(priorIn, priorOut), shiftDays, input.fromRoomId, toRoomId)
      : [];
    const byRoom = new Map<string, string[]>();
    for (const n of picture) for (const id of n.roomIds) byRoom.set(id, [...(byRoom.get(id) ?? []), n.date]);
    const roomRows = await prisma.room.findMany({ where: { id: { in: [...byRoom.keys()] } } });
    for (const room of roomRows) {
      const roomNights = byRoom.get(room.id) ?? [];
      for (const range of foldIsoNightsToRanges([...new Set(roomNights)].sort())) {
        try {
          enforceCommittedHoldRoomPhysicallyUsable({
            roomNumber: room.roomNumber,
            isBlocked: room.isBlocked,
            blockedReason: room.blockedReason,
            isUnderMaintenance: room.isUnderMaintenance,
            maintenanceDeadline: room.maintenanceDeadline,
            checkIn: range.startDate,
            checkOut: range.endDate,
          });
          const conflicts = await findRoomBookingConflicts(prisma, {
            roomIds: [room.id],
            checkIn: range.startDate,
            checkOut: range.endDate,
            excludeEntryId: entry.id,
          });
          enforceNoOverlappingBookingForCommittedHold({ conflicts: conflicts.map((c) => ({ ...c, roomNumber: room.roomNumber })) });
        } catch (e) {
          refusals.push(errorMessage(e));
        }
      }
      rooms.push({
        roomId: room.id,
        roomNumber: room.roomNumber,
        toRoomNumber: null,
        nightsLabel: nightsLabel(roomNights),
      });
    }
    rooms = rooms.sort((a, b) => a.roomNumber.localeCompare(b.roomNumber, "en", { numeric: true }));
    if (toRoomId) notes.push(`Room ${roomNumbers.get(input.fromRoomId) ?? ""} is replaced by Room ${roomNumbers.get(toRoomId) ?? ""} on the new nights`);
    const segmentId = entry.segments[0]?.id ?? null;
    const sent = entry.quotations.some((q) => q.segmentId === segmentId && (q.state === "SENT" || q.state === "ACCEPTED"));
    const isFom = (RANK[actor.actorLevel] ?? 0) >= 2;
    authority = {
      needed: sent ? "L2" : "L1",
      actorLevel: actor.actorLevel,
      ok: true,
      waitsForApproval: sent && !isFom,
      why: sent
        ? isFom
          ? "A quotation has gone out, so the change is the FOM's — you can make it"
          : "A quotation has gone out — the change is sent to the FOM, and waits for their approval"
        : "Nothing has been sent yet — the desk changes the configuration itself",
    };
    const operative = resolveOperativeQuotation(entry.quotations, segmentId);
    price = {
      before: operative?.totalAmount != null ? Number(operative.totalAmount) : null,
      after: null,
      delta: null,
      currency: operative?.currency ?? null,
      note: "At Negotiation the price is made again at the table — the quotation on file is retired",
    };
    path.push("The configuration changes inside this pass — no new pass at Negotiation");
    path.push("The rooms are picked for the new nights (the house is asked for exactly those dates)");
    path.push("The quotation on file is retired — price it again at the table");
    if (entry.speculativeHolds.length) path.push("The provisional block moves to the new nights, keeping its deadline");
  } else {
    // Set up, Reserve, Arrival: the walk validates everything with nothing written.
    const isFom = (RANK[actor.actorLevel] ?? 0) >= 2;
    authority = {
      needed: "L2",
      actorLevel: actor.actorLevel,
      ok: isFom,
      waitsForApproval: false,
      why: isFom ? "From Set up on a date move is the FOM's — you can make it" : "From Set up on, moving a booking's dates needs the FOM",
    };
    if (!stepRefusal && shiftDays !== 0) {
      try {
        // The preview runs with the FOM's hand so the figures show to the desk too; the authority
        // line above says who may actually move it.
        const dryActor: Actor = isFom ? actor : { ...actor, actorLevel: "L2" };
        const dry = await changeRoomToNewSegment(prisma, dryActor, {
          entryId: entry.id,
          fromRoomId: input.fromRoomId,
          ...(toRoomId ? { toRoomId } : {}),
          reason: input.reason?.trim() || "Preview",
          dateShift: {
            newCheckInDate: newIn,
            priceMode: input.priceMode ?? "KEEP",
            guestAgreedNote: input.guestAgreedNote ?? (input.priceMode === "NEW_DATES" ? "(preview)" : null),
          },
          dryRun: true,
        });
        const plan = dry.plan;
        const byRoom = new Map<string, number>(Object.entries(plan?.perRoomNightCounts ?? {}));
        const planRooms = await prisma.room.findMany({ where: { id: { in: [...byRoom.keys()] } }, select: { id: true, roomNumber: true } });
        // Each room's new nights: the old pattern, moved.
        const sealed = entry.availabilityConfigs[0] ?? null;
        const picture = negotiationPicture(sealed?.optionSelected ?? null, nightsBetween(priorIn, priorOut), shiftDays, input.fromRoomId, toRoomId);
        const nightsOf = new Map<string, string[]>();
        for (const n of picture) for (const id of n.roomIds) nightsOf.set(id, [...(nightsOf.get(id) ?? []), n.date]);
        rooms = planRooms
          .map((r) => ({ roomId: r.id, roomNumber: r.roomNumber, toRoomNumber: null, nightsLabel: nightsLabel(nightsOf.get(r.id) ?? []) }))
          .sort((a, b) => a.roomNumber.localeCompare(b.roomNumber, "en", { numeric: true }));
        price = { before: dry.pricing.priorTotal, after: null, delta: null, currency: dry.pricing.currency, note: null };
        if (plan?.compositions) {
          try {
            const preview = await buildQuotationPreview(
              prisma,
              entry.id,
              {
                roomCompositions: plan.compositions as never,
                discount: plan.discount ? { percent: plan.discount.discountPercent ?? null, amount: plan.discount.discountAmount ?? null } : null,
              },
              {
                planRoomIds: plan.planRoomIds,
                stayOverride: { checkIn: new Date(plan.checkIn), checkOut: new Date(plan.checkOut), perRoomNightCounts: byRoom },
              },
            );
            price = {
              before: dry.pricing.priorTotal,
              after: preview.payable,
              delta: dry.pricing.priorTotal != null ? Number((preview.payable - dry.pricing.priorTotal).toFixed(2)) : null,
              currency: preview.currency ?? dry.pricing.currency,
              note: (input.priceMode ?? "KEEP") === "KEEP" ? "The guest keeps the rates they agreed" : "Priced at the rates for the new nights",
            };
          } catch (e) {
            price.note = `The price could not be worked out ahead: ${errorMessage(e)} — the new quotation states it`;
          }
        } else {
          price.note = "Priced the way the booking is priced today (a flat rate) — the new quotation states the figure";
        }
      } catch (e) {
        refusals.push(errorMessage(e));
      }
    }
    path.push("Back to Negotiation — a new pass opens, the old one is kept as it was");
    path.push("The quotation is made again on the new dates (nothing goes to the guest)");
    path.push("Set up — the rooms held on the new nights; the advance stays as it is");
    if (entry.currentStage === Stage.S3) {
      path.push("Back at Set up");
      papers.push("A new proforma invoice — held for you to send or not");
    } else {
      path.push("Reserved again on the new dates");
      papers.push("A new confirmation voucher with its own number — held for you to send or not");
      if (entry.currentStage === Stage.S5) {
        const windowDays = Number(await requireActiveConfigValue<number>(prisma, "preArrival.windowDays").catch(() => 1)) || 1;
        const opensAt = new Date(newIn.getTime() - windowDays * DAY);
        path.push(
          opensAt.getTime() > Date.now()
            ? `It stays at Reserve — Arrival opens on ${fmtDay(iso(opensAt))}, ${windowDays === 1 ? "the day" : `${windowDays} days`} before the new check-in`
            : "Back at Arrival — its checklist opens again for checking",
        );
      } else {
        path.push("Back at Reserve");
      }
    }
  }

  const ok = refusals.length === 0 && authority.ok;
  return {
    ok,
    entryId: entry.id,
    bookingLabel: `${entry.id}${guest ? ` (${guest})` : ""}`,
    guestName: guest,
    stage,
    stageWord: STAGE_WORD[stage] ?? stage,
    route,
    from: { checkInDate: iso(priorIn), checkOutDate: iso(priorOut), nights },
    to: { checkInDate: newInIso, checkOutDate: newOutIso, nights },
    shiftDays,
    rooms,
    authority,
    price,
    path,
    papers,
    notes,
    refusals: [...new Set(refusals)],
  };
}

export async function executeDateMove(
  prisma: PrismaClient,
  actor: Actor,
  input: DateMoveRequest & { reason: string },
): Promise<DateMoveResult> {
  const reason = input.reason?.trim();
  if (!reason) throw new ValidationError("A reason is required to move a booking's dates");
  const entry = await loadEntry(prisma, input.entryId);
  const refusal = stageRefusal(entry);
  if (refusal) throw new ValidationError(refusal);
  const newIn = new Date(`${input.newCheckInDate.slice(0, 10)}T00:00:00.000Z`);
  if (Number.isNaN(newIn.getTime())) throw new ValidationError("newCheckInDate must be a date (YYYY-MM-DD)");
  const toRoomId = input.toRoomId && input.toRoomId !== input.fromRoomId ? input.toRoomId : null;

  if (entry.currentStage === Stage.S2) {
    const priorIn = entry.checkInDate;
    const priorOut = entry.checkOutDate;
    if (!priorIn || !priorOut) throw new ValidationError("This booking has no stay dates to move");
    const shiftDays = Math.round((newIn.getTime() - priorIn.getTime()) / DAY);
    if (shiftDays === 0) throw new ValidationError("The new check-in is the day the booking already starts — nothing moves");
    const newOut = new Date(priorOut.getTime() + shiftDays * DAY);
    const sealed = entry.availabilityConfigs[0] ?? null;
    if (!sealed) throw new ValidationError("No rooms are picked for this booking yet — pick them at Negotiation first");
    const picture = negotiationPicture(sealed.optionSelected, nightsBetween(priorIn, priorOut), shiftDays, input.fromRoomId, toRoomId);
    // The house is asked for exactly the new stay — the change of configuration accepts rooms only
    // from a search for the dates it moves to.
    const search = (await queryAvailability(prisma, entry.id, actor.actorId, actor.actorLevel, {
      checkInDate: iso(newIn),
      checkOutDate: iso(newOut),
      guestCount: entry.guestCount ?? undefined,
    })) as { configuration: { id: string } };
    const outcome = await amendNegotiationConfiguration(prisma, entry.id, actor, {
      dates: { checkInDate: iso(newIn), checkOutDate: iso(newOut) },
      rooms: { configurationId: search.configuration.id, perNight: picture },
      reason: `Moved on the house chart: ${reason}`,
      expectedVersion: entry.version,
    });
    return { route: "NEGOTIATION", entryId: entry.id, outcome };
  }

  const outcome = await changeRoomToNewSegment(prisma, actor, {
    entryId: entry.id,
    fromRoomId: input.fromRoomId,
    ...(toRoomId ? { toRoomId } : {}),
    reason,
    dateShift: {
      newCheckInDate: newIn,
      priceMode: input.priceMode ?? "KEEP",
      guestAgreedNote: input.guestAgreedNote ?? null,
    },
  });
  return { route: "WALK", entryId: entry.id, outcome };
}
