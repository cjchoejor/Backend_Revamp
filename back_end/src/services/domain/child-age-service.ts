import type { PrismaClient } from "@prisma/client";
import { Prisma, Stage } from "@prisma/client";
import { NotFoundError, ValidationError } from "../../lib/errors.js";
import {
  currentPerNightPicture,
  derivePartySlots,
  nightsByRoomFromPicture,
  planRoomOrder,
  resolveCompositionBasis,
  seatPartyRooms,
  type PartyBand,
} from "../../lib/party-seating.js";
import { loadChildPolicyBundle, type ChildPolicyBundle } from "./child-policy-service.js";
import { enforceEntryNotSealedForWorkingAction } from "../../policies/01-availability/p01-entry-progression-stage-gates.js";
import { changeRoomToNewSegment, type RoomChangeOutcome } from "./room-change-service.js";
import { enforceRoomCompositionsPriceable, type RoomCompositionServiceInput } from "./s2-quotation-service.js";
import { buildQuotationPreview } from "./quotation-preview-service.js";
import { toDecimal } from "../../lib/money.js";

/**
 * A child's age, put right at Arrival or Check-in (2026-11-10, operator: "sometimes the ages are not
 * exactly like how the guest said before … if before guest said it was 7 and later it was 12, it
 * should notify the user about the hotel's policy … if that room already has 2 adults an extra bed is
 * needed … or move the child to that room along with the meal plan … well audited … even the papers
 * would be generated again").
 *
 * The age decides the band (`registry.child.ageBands`): under 6, 6 to 10, or 11 and over — charged as
 * an adult, a bed of their own, meals at the full rate. Within one band nothing is priced differently
 * and only the age is recorded. Across bands the room's counts change, so the booking is priced again
 * through the governed room-change walk in its setup-only form (`roomCompositions`): a new pass, the
 * quotation made again, the voucher and the proforma made again and held for the desk, back to the
 * step it was at. Either the child stays in their room — with an extra bed when they are now a third
 * adult there — or moves to another room of the booking, their meal plan with them.
 *
 * Arrival and Check-in only. Before that the party is changed with Change the dates, rooms or guests;
 * once the guest has slept a night, a night cannot be priced for a different person after the fact.
 */

export type ChildAgeBand = PartyBand;
type MealPlanKey = "CP" | "MAPL" | "MAPD" | "AP" | "EP";
const PLAN_FIELD: Record<Exclude<MealPlanKey, "EP">, keyof RoomCompositionServiceInput> = {
  CP: "mealPlanCpCount",
  MAPL: "mealPlanMaplCount",
  MAPD: "mealPlanMapdCount",
  AP: "mealPlanApCount",
};
const PLAN_WORD: Record<MealPlanKey, string> = { CP: "CP (breakfast)", MAPL: "MAP+L", MAPD: "MAP+D", AP: "AP (all meals)", EP: "room only (EP)" };

export type ChildAgeChoice = {
  kind: "STAY" | "MOVE";
  roomId: string;
  roomNumber: string | null;
  possible: boolean;
  /** Why it cannot be done, in words. */
  why: string | null;
  /** Extra beds the room then has (after any added for a third adult). */
  extraBeds: number;
  /** True when an extra bed is added by this choice. */
  addsExtraBed: boolean;
  /** For a move: the meal plan that goes with the child. */
  mealPlan: MealPlanKey | null;
  /** Server figures: the stay's total after, and the change. */
  totalAfter: number | null;
  change: number | null;
  /** What it does, in a line. */
  summary: string;
};

export type ChildAgePreview = {
  entryId: string;
  childIndex: number;
  oldAge: number;
  newAge: number;
  oldBand: ChildAgeBand;
  newBand: ChildAgeBand;
  /** The hotel's rule for the new age, in words. */
  policy: string;
  /** Only the age changes (same band, or no per-room pricing on the booking). */
  ageOnly: boolean;
  room: { roomId: string; roomNumber: string | null; guests: string } | null;
  totalBefore: number | null;
  choices: ChildAgeChoice[];
  /** Meal plans the child could be on, for a move, when the room's guests are on more than one. */
  mealPlans: MealPlanKey[];
  /** Refused outright, in words. */
  refusal: string | null;
};

function bandOf(age: number, bundle: ChildPolicyBundle): ChildAgeBand {
  return age <= bundle.ageBands.youngChildMaxAge ? "UNDER6" : age <= bundle.ageBands.childMaxAge ? "C6TO10" : "ADULT";
}

export function childAgePolicyWords(age: number, bundle: ChildPolicyBundle): string {
  const band = bandOf(age, bundle);
  const young = bundle.ageBands.youngChildMaxAge;
  const child = bundle.ageBands.childMaxAge;
  const mp = bundle.mealPricing;
  if (band === "ADULT") {
    return `At ${age} the guest is charged as an adult: from ${child + 1} a child takes a full place in the room, a bed of their own, and meals at the full adult rate.`;
  }
  if (band === "C6TO10") {
    return `At ${age} the guest is a child of ${young + 1} to ${child}: they share the bedding, and meals are ${mp.childPercent}% of the adult rate.`;
  }
  return `At ${age} the guest is a child under ${young + 1}: they share the bedding, and meals are ${mp.youngChildPercent === 0 ? "free" : `${mp.youngChildPercent}% of the adult rate`}.`;
}

const n = (v: unknown) => Math.max(0, Math.floor(Number(v ?? 0) || 0));
const bandField = (b: ChildAgeBand): "adultCount" | "cnb6To10Count" | "cnbUnder6Count" =>
  b === "ADULT" ? "adultCount" : b === "C6TO10" ? "cnb6To10Count" : "cnbUnder6Count";

/** A composition row from the basis, as the room-change walk takes it. */
function asServiceRow(r: Record<string, unknown>): RoomCompositionServiceInput {
  const num = (k: string) => (r[k] == null ? undefined : Number(r[k]));
  return {
    roomId: String(r.roomId),
    ...(typeof r.startDate === "string" ? { startDate: r.startDate } : {}),
    ...(typeof r.endDate === "string" ? { endDate: r.endDate } : {}),
    occupantCount: num("occupantCount"),
    adultCount: num("adultCount"),
    cnb6To10Count: num("cnb6To10Count"),
    cnbUnder6Count: num("cnbUnder6Count"),
    extraBedCount: num("extraBedCount"),
    mealPlanCpCount: num("mealPlanCpCount"),
    mealPlanMaplCount: num("mealPlanMaplCount"),
    mealPlanMapdCount: num("mealPlanMapdCount"),
    mealPlanApCount: num("mealPlanApCount"),
    mealPlanOthersCount: num("mealPlanOthersCount"),
    othersBreakfastPax: num("othersBreakfastPax"),
    othersLunchPax: num("othersLunchPax"),
    othersDinnerPax: num("othersDinnerPax"),
    negotiatedRoomRate: num("negotiatedRoomRate"),
    negotiatedExtraBedRate: num("negotiatedExtraBedRate"),
    negotiatedBreakfastRate: num("negotiatedBreakfastRate"),
    negotiatedLunchRate: num("negotiatedLunchRate"),
    negotiatedDinnerRate: num("negotiatedDinnerRate"),
    ...(typeof r.serviceChargeApplies === "boolean" ? { serviceChargeApplies: r.serviceChargeApplies } : {}),
    ...(typeof r.gstApplies === "boolean" ? { gstApplies: r.gstApplies } : {}),
    ...(typeof r.isFoc === "boolean" ? { isFoc: r.isFoc } : {}),
    ...(Array.isArray(r.nightMealOverrides) && r.nightMealOverrides.length
      ? { nightMealOverrides: r.nightMealOverrides as RoomCompositionServiceInput["nightMealOverrides"] }
      : {}),
  };
}

type RoomTypeFacts = { maxCapacity: number; maxExtraBeds: number; maxChildren: number; requiredAccompanyingAdults: number };

/** Extra beds a room needs for its adult-rate guests — the negotiation table's own rule (p78 + capacity). */
function bedsNeeded(adults: number, foc: boolean, rt: RoomTypeFacts): number {
  const capacityBeds = Math.max(0, adults - rt.maxCapacity);
  const p78 = !foc && adults >= 3 ? 1 : 0;
  return Math.max(capacityBeds, p78);
}

/** Whether a room can hold this row, in words when it cannot. */
function roomRefusal(row: RoomCompositionServiceInput, rt: RoomTypeFacts, roomNo: string): string | null {
  const adults = n(row.adultCount);
  const kids = n(row.cnb6To10Count) + n(row.cnbUnder6Count);
  const need = bedsNeeded(adults, row.isFoc === true, rt);
  if (need > rt.maxExtraBeds) {
    return rt.maxExtraBeds === 0
      ? `Room ${roomNo} cannot take an extra bed, so it cannot sleep ${adults} guests charged as adults`
      : `Room ${roomNo} takes at most ${rt.maxExtraBeds} extra bed${rt.maxExtraBeds === 1 ? "" : "s"}, so it cannot sleep ${adults} guests charged as adults`;
  }
  if (kids > rt.maxChildren) return `Room ${roomNo} sleeps at most ${rt.maxChildren} children`;
  if (kids > 0 && adults < rt.requiredAccompanyingAdults) return `Room ${roomNo} would have children with no adult`;
  return null;
}

async function loadEntry(prisma: PrismaClient, entryId: string) {
  const entry = await prisma.entry.findUnique({
    where: { id: entryId },
    select: {
      id: true,
      status: true,
      currentStage: true,
      inquiryId: true,
      adultCount: true,
      childAges: true,
      guestCount: true,
      checkInDate: true,
      checkOutDate: true,
      segments: { orderBy: { segmentNumber: "desc" }, select: { id: true } },
      quotations: {
        orderBy: { createdAt: "desc" },
        select: { id: true, segmentId: true, state: true, versionNumber: true, createdAt: true, commercialTerms: true },
      },
      reservation: { select: { frozenCheckInDate: true, frozenCheckOutDate: true, frozenCommercialTerms: true } },
      reservations: { orderBy: { confirmedAt: "desc" }, select: { confirmedAt: true, frozenCommercialTerms: true } },
      committedHold: { select: { roomId: true, perNightBreakdown: true } },
      roomAssignments: { orderBy: { createdAt: "desc" }, select: { roomId: true } },
      availabilityConfigs: {
        where: { sealedAt: { not: null }, optionSelected: { not: Prisma.DbNull } },
        orderBy: { sealedAt: "asc" },
        select: { optionSelected: true },
      },
    },
  });
  if (!entry) throw new NotFoundError("Entry");
  return entry;
}

const DAY = 86_400_000;
function nightsIso(a: Date, b: Date): string[] {
  const out: string[] = [];
  for (let t = Date.UTC(a.getUTCFullYear(), a.getUTCMonth(), a.getUTCDate()); t < Date.UTC(b.getUTCFullYear(), b.getUTCMonth(), b.getUTCDate()); t += DAY) {
    out.push(new Date(t).toISOString().slice(0, 10));
  }
  return out;
}

type Plan = {
  preview: ChildAgePreview;
  /** The rows to price with, per choice key ("STAY" or "MOVE:<roomId>"). */
  rowsFor: Map<string, RoomCompositionServiceInput[]>;
  anchorRoomId: string | null;
};

async function plan(prisma: PrismaClient, entryId: string, childIndex: number, newAge: number, mealPlanAsked?: MealPlanKey | null): Promise<Plan> {
  const entry = await loadEntry(prisma, entryId);
  const bundle = await loadChildPolicyBundle(prisma);
  const childAges = entry.childAges ?? [];
  if (!Number.isInteger(childIndex) || childIndex < 0 || childIndex >= childAges.length) {
    throw new ValidationError("That child is not on this booking");
  }
  const maxAge = bundle.unaccompaniedMinor.minimumAge - 1;
  if (!Number.isInteger(newAge) || newAge < 0 || newAge > maxAge) {
    throw new ValidationError(`A child's age is a whole number from 0 to ${maxAge} — at ${maxAge + 1} the guest is an adult on the booking`);
  }
  const oldAge = childAges[childIndex];
  const oldBand = bandOf(oldAge, bundle);
  const newBand = bandOf(newAge, bundle);
  const base: ChildAgePreview = {
    entryId,
    childIndex,
    oldAge,
    newAge,
    oldBand,
    newBand,
    policy: childAgePolicyWords(newAge, bundle),
    ageOnly: true,
    room: null,
    totalBefore: null,
    choices: [],
    mealPlans: [],
    refusal: null,
  };
  const refuse = (why: string): Plan => ({ preview: { ...base, refusal: why }, rowsFor: new Map(), anchorRoomId: null });
  if (entry.status !== "ACTIVE") return refuse("The booking is not active — its record cannot be changed");
  if (!([Stage.S5, Stage.S6] as Stage[]).includes(entry.currentStage)) {
    return refuse(
      entry.currentStage === Stage.S7 || entry.currentStage === Stage.S8 || entry.currentStage === Stage.S9
        ? "A child's age is put right at Arrival or Check-in — once the guest has stayed, the nights are already priced"
        : "Before Arrival the guests are changed with Change booking › Change the dates, rooms or guests",
    );
  }
  if (newAge === oldAge) return refuse(`Child ${childIndex + 1} is already ${oldAge}`);

  const basis = resolveCompositionBasis<Record<string, unknown> & { roomId: string }>(entry);
  const rows = (basis.compositions ?? []).map((r) => asServiceRow(r));
  // Same band, or no room-by-room pricing: nothing is priced differently.
  if (oldBand === newBand || rows.length === 0) return { preview: base, rowsFor: new Map(), anchorRoomId: null };

  const checkIn = entry.reservation?.frozenCheckInDate ?? entry.checkInDate;
  const checkOut = entry.reservation?.frozenCheckOutDate ?? entry.checkOutDate;
  const nights = checkIn && checkOut ? nightsIso(checkIn, checkOut) : [];
  const latest = entry.availabilityConfigs[entry.availabilityConfigs.length - 1] ?? null;
  const picture = currentPerNightPicture({
    sealedOption: latest?.optionSelected ?? null,
    fallbackRoomIds: entry.roomAssignments.map((a) => a.roomId),
    nightsIso: nights.length ? nights : ["stay"],
  });
  const order = planRoomOrder(picture);
  const nightsByRoom = nightsByRoomFromPicture(picture);
  const bands = { youngChildMaxAge: bundle.ageBands.youngChildMaxAge, childMaxAge: bundle.ageBands.childMaxAge };
  const slots = derivePartySlots(entry, bands);
  const seating = seatPartyRooms({ slots, rows, order, nightsByRoom });
  const childRooms = seating.get(`K${childIndex}`) ?? [];
  if (childRooms.length === 0) return refuse("This child has no room on the booking yet — seat everyone first");
  if (childRooms.length > 1) {
    return refuse("This child moves rooms during the stay — change their age from Change booking › Change extra beds or meals");
  }
  const fromId = childRooms[0];
  const fromRow = rows.find((r) => r.roomId === fromId);
  if (!fromRow) return refuse("This child's room has no composition — re-price the booking first");

  const roomIds = rows.map((r) => r.roomId);
  const roomFacts = await prisma.room.findMany({
    where: { id: { in: roomIds } },
    select: { id: true, roomNumber: true, roomType: { select: { maxCapacity: true, maxExtraBeds: true, maxChildren: true, requiredAccompanyingAdults: true } } },
  });
  const noOf = new Map(roomFacts.map((r) => [r.id, r.roomNumber]));
  const rtOf = new Map(
    roomFacts.map((r) => [
      r.id,
      {
        maxCapacity: r.roomType?.maxCapacity ?? 3,
        maxExtraBeds: r.roomType?.maxExtraBeds ?? 0,
        maxChildren: r.roomType?.maxChildren ?? 2,
        requiredAccompanyingAdults: r.roomType?.requiredAccompanyingAdults ?? 1,
      } satisfies RoomTypeFacts,
    ]),
  );
  const numberByRoomId = new Map(roomFacts.map((r) => [r.id, r.roomNumber]));
  const roomNo = (id: string) => noOf.get(id) ?? id.slice(0, 6);
  const guestsWord = (r: RoomCompositionServiceInput) => {
    const a = n(r.adultCount);
    const k = n(r.cnb6To10Count) + n(r.cnbUnder6Count);
    return [a ? `${a} adult${a === 1 ? "" : "s"}` : null, k ? `${k} child${k === 1 ? "" : "ren"}` : null].filter(Boolean).join(" and ") || "nobody";
  };

  // The meal plans the child could be on: the plans the room's guests are on, and room only when
  // fewer covers than guests.
  const covers = (r: RoomCompositionServiceInput) =>
    (["CP", "MAPL", "MAPD", "AP"] as const).map((k) => [k, n(r[PLAN_FIELD[k]])] as const).filter(([, c]) => c > 0);
  const fromCovers = covers(fromRow);
  const coverSum = fromCovers.reduce((s, [, c]) => s + c, 0);
  const mealPlans: MealPlanKey[] = [...fromCovers.map(([k]) => k as MealPlanKey), ...(coverSum < n(fromRow.occupantCount) ? (["EP"] as MealPlanKey[]) : [])];
  const mealPlan: MealPlanKey =
    mealPlanAsked && mealPlans.includes(mealPlanAsked)
      ? mealPlanAsked
      : mealPlans.length === 1
        ? mealPlans[0]
        : (fromCovers.slice().sort((a, b) => b[1] - a[1])[0]?.[0] as MealPlanKey | undefined) ?? "EP";

  const rowsFor = new Map<string, RoomCompositionServiceInput[]>();
  const choices: ChildAgeChoice[] = [];
  const nightsOf = new Map<string, string[]>();
  for (const id of roomIds) nightsOf.set(id, nightsByRoom.get(id) ?? []);
  const priceable = (next: RoomCompositionServiceInput[]): string | null => {
    try {
      enforceRoomCompositionsPriceable(next, {
        numberByRoomId,
        stayCheckIn: checkIn ?? null,
        stayCheckOut: checkOut ?? null,
        nights: nights.length || 1,
        nightDatesByRoom: nightsOf,
      });
      return null;
    } catch (e) {
      return e instanceof Error ? e.message : "These counts cannot be priced";
    }
  };

  // Stay: the child's band moves within the room; an extra bed when they are now a third adult.
  {
    const r = { ...fromRow };
    r[bandField(oldBand)] = Math.max(0, n(r[bandField(oldBand)]) - 1);
    r[bandField(newBand)] = n(r[bandField(newBand)]) + 1;
    const need = bedsNeeded(n(r.adultCount), r.isFoc === true, rtOf.get(fromId)!);
    const adds = need > n(r.extraBedCount);
    if (adds) r.extraBedCount = need;
    const next = rows.map((x) => (x.roomId === fromId ? r : x));
    const why = roomRefusal(r, rtOf.get(fromId)!, roomNo(fromId)) ?? priceable(next);
    rowsFor.set("STAY", next);
    choices.push({
      kind: "STAY",
      roomId: fromId,
      roomNumber: noOf.get(fromId) ?? null,
      possible: !why,
      why,
      extraBeds: n(r.extraBedCount),
      addsExtraBed: adds,
      mealPlan: null,
      totalAfter: null,
      change: null,
      summary: adds
        ? `Stays in Room ${roomNo(fromId)} — an extra bed is added there (${guestsWord(r)} then)`
        : `Stays in Room ${roomNo(fromId)} (${guestsWord(r)} then)`,
    });
  }

  // Move: to another room of the booking with the same nights, the meal plan with them.
  const fromNights = (nightsOf.get(fromId) ?? []).join(",");
  for (const to of rows) {
    if (to.roomId === fromId) continue;
    const toNo = roomNo(to.roomId);
    const sameNights = (nightsOf.get(to.roomId) ?? []).join(",") === fromNights;
    const src = { ...fromRow };
    const dst = { ...to };
    src[bandField(oldBand)] = Math.max(0, n(src[bandField(oldBand)]) - 1);
    src.occupantCount = Math.max(0, n(src.occupantCount) - 1);
    dst[bandField(newBand)] = n(dst[bandField(newBand)]) + 1;
    dst.occupantCount = n(dst.occupantCount) + 1;
    if (mealPlan !== "EP") {
      const f = PLAN_FIELD[mealPlan];
      src[f] = Math.max(0, n(src[f]) - 1) as never;
      dst[f] = (n(dst[f]) + 1) as never;
    }
    const need = bedsNeeded(n(dst.adultCount), dst.isFoc === true, rtOf.get(to.roomId)!);
    const adds = need > n(dst.extraBedCount);
    if (adds) dst.extraBedCount = need;
    const next = rows.map((x) => (x.roomId === fromId ? src : x.roomId === to.roomId ? dst : x));
    const why = !sameNights
      ? `Room ${toNo} is not booked for the same nights`
      : n(src.occupantCount) === 0
        ? `Room ${roomNo(fromId)} would be left empty`
        : (fromRow.nightMealOverrides?.length || to.nightMealOverrides?.length)
          ? `The meals in Room ${roomNo(fromId)} or Room ${toNo} differ by night — move the guest from Change booking › Change extra beds or meals`
          : (roomRefusal(dst, rtOf.get(to.roomId)!, toNo) ?? roomRefusal(src, rtOf.get(fromId)!, roomNo(fromId)) ?? priceable(next));
    rowsFor.set(`MOVE:${to.roomId}`, next);
    choices.push({
      kind: "MOVE",
      roomId: to.roomId,
      roomNumber: noOf.get(to.roomId) ?? null,
      possible: !why,
      why,
      extraBeds: n(dst.extraBedCount),
      addsExtraBed: adds,
      mealPlan,
      totalAfter: null,
      change: null,
      summary: `Moves to Room ${toNo}${mealPlan !== "EP" ? `, with their ${PLAN_WORD[mealPlan]}` : ""}${adds ? " — an extra bed is added there" : ""} (Room ${toNo}: ${guestsWord(dst)}; Room ${roomNo(fromId)}: ${guestsWord(src)})`,
    });
  }

  // The figures, the server's: the stay as the table stands now, and after each choice.
  const terms = (basis.terms ?? {}) as { compositionDiscount?: { requestedPercent?: number | null; requestedAmount?: number | null } };
  const discount = terms.compositionDiscount
    ? { percent: terms.compositionDiscount.requestedPercent ?? null, amount: terms.compositionDiscount.requestedAmount ?? null }
    : null;
  const priceOf = async (next: RoomCompositionServiceInput[]) => {
    try {
      const p = await buildQuotationPreview(prisma, entryId, { roomCompositions: next, discount });
      return p.payable;
    } catch {
      return null;
    }
  };
  const before = await priceOf(rows);
  for (const c of choices) {
    if (!c.possible) continue;
    const after = await priceOf(rowsFor.get(c.kind === "STAY" ? "STAY" : `MOVE:${c.roomId}`)!);
    c.totalAfter = after;
    c.change = after != null && before != null ? Number(toDecimal(after).sub(toDecimal(before)).toFixed(2)) : null;
  }

  return {
    preview: {
      ...base,
      ageOnly: false,
      room: { roomId: fromId, roomNumber: noOf.get(fromId) ?? null, guests: guestsWord(fromRow) },
      totalBefore: before,
      choices,
      mealPlans,
    },
    rowsFor,
    anchorRoomId: fromId,
  };
}

export async function previewChildAgeChange(
  prisma: PrismaClient,
  entryId: string,
  input: { childIndex: number; newAge: number; mealPlan?: MealPlanKey | null },
): Promise<ChildAgePreview> {
  return (await plan(prisma, entryId, input.childIndex, input.newAge, input.mealPlan)).preview;
}

export type ChildAgeOutcome = {
  entryId: string;
  childIndex: number;
  oldAge: number;
  newAge: number;
  ageOnly: boolean;
  choice: ChildAgeChoice | null;
  walk: RoomChangeOutcome | null;
};

export async function changeChildAge(
  prisma: PrismaClient,
  actor: { actorId: string; actorLevel: "L1" | "L2" | "L3" | "L4" },
  entryId: string,
  input: { childIndex: number; newAge: number; placement?: "STAY" | "MOVE"; toRoomId?: string | null; mealPlan?: MealPlanKey | null; reason?: string | null },
): Promise<ChildAgeOutcome> {
  const head = await prisma.entry.findUnique({ where: { id: entryId }, select: { status: true, inquiryId: true, childAges: true } });
  if (!head) throw new NotFoundError("Entry");
  enforceEntryNotSealedForWorkingAction({ status: head.status });
  const p = await plan(prisma, entryId, input.childIndex, input.newAge, input.mealPlan);
  if (p.preview.refusal) throw new ValidationError(p.preview.refusal);
  const oldAges = [...(head.childAges ?? [])];
  const newAges = oldAges.map((a, i) => (i === input.childIndex ? input.newAge : a));
  const words = input.reason?.trim() || null;

  const trace = async (choice: ChildAgeChoice | null, walk: RoomChangeOutcome | null) =>
    prisma.traceEvent.create({
      data: {
        eventType: "PARTY.CHILD_AGE_CORRECTED",
        actorId: actor.actorId,
        actorLevel: actor.actorLevel,
        entityType: "Entry",
        entityId: entryId,
        operation: "UPDATE",
        timestamp: new Date(),
        stageContext: null,
        inquiryId: head.inquiryId ?? null,
        entryId,
        payload: {
          childIndex: input.childIndex,
          child: `Child ${input.childIndex + 1}`,
          fromAge: p.preview.oldAge,
          toAge: input.newAge,
          fromBand: p.preview.oldBand,
          toBand: p.preview.newBand,
          policy: p.preview.policy,
          choice: choice ? { kind: choice.kind, roomNumber: choice.roomNumber, mealPlan: choice.mealPlan, addsExtraBed: choice.addsExtraBed, summary: choice.summary } : null,
          totalBefore: p.preview.totalBefore,
          totalAfter: choice?.totalAfter ?? null,
          change: choice?.change ?? null,
          reason: words,
          walk: walk ? { pass: walk.newSegmentNumber, reachedStage: walk.walk.reachedStage, stoppedAt: walk.walk.blocked } : null,
        } as Prisma.InputJsonValue,
        createdBy: actor.actorId,
      },
    });

  if (p.preview.ageOnly) {
    await prisma.entry.update({ where: { id: entryId }, data: { childAges: newAges } });
    await trace(null, null);
    return { entryId, childIndex: input.childIndex, oldAge: p.preview.oldAge, newAge: input.newAge, ageOnly: true, choice: null, walk: null };
  }

  const key = input.placement === "MOVE" ? `MOVE:${input.toRoomId ?? ""}` : "STAY";
  const choice = p.preview.choices.find((c) => (c.kind === "STAY" ? "STAY" : `MOVE:${c.roomId}`) === key) ?? null;
  if (!choice) throw new ValidationError(input.placement === "MOVE" ? "That room is not one of this booking's rooms" : "Say whether the child stays in their room or moves");
  if (!choice.possible) throw new ValidationError(choice.why ?? "That cannot be done");
  const rows = p.rowsFor.get(key)!;

  // The age first — the walk seats the party by it — then the governed walk. A walk refused before
  // it began leaves the booking as it was, so the age goes back too.
  await prisma.entry.update({ where: { id: entryId }, data: { childAges: newAges } });
  let walk: RoomChangeOutcome;
  try {
    walk = await changeRoomToNewSegment(prisma, actor, {
      entryId,
      fromRoomId: p.anchorRoomId!,
      reason: words ?? `Child ${input.childIndex + 1}'s age put right: ${p.preview.oldAge} → ${input.newAge}`,
      roomCompositions: rows,
    });
  } catch (e) {
    await prisma.entry.update({ where: { id: entryId }, data: { childAges: oldAges } });
    throw e;
  }
  await trace(choice, walk);
  return { entryId, childIndex: input.childIndex, oldAge: p.preview.oldAge, newAge: input.newAge, ageOnly: false, choice, walk };
}
