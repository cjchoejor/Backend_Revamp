import type { PrismaClient } from "@prisma/client";
import { Prisma, Stage } from "@prisma/client";
import { NotFoundError, PolicyGateBlockedError, ValidationError } from "../../lib/errors.js";
import { requireActiveConfigValue } from "../../lib/config-store.js";
import { cancelEntryTimersByCode } from "../../lib/cancel-entry-timers-by-code.js";
import { currentPerNightPicture, resolveCompositionBasis } from "../../lib/party-seating.js";
import { enforceExtensionPaidBeforeCommit } from "../../policies/35-interim-payment/p80-interim-payment-gates.js";
import { getTimerEngine } from "../infrastructure/timer-management-service.js";
import { buildQuotationPreview } from "./quotation-preview-service.js";
import { registerNightAuditTimers } from "./pre-arrival-service.js";
import {
  armInterimPaymentReminder,
  cancelInterimReminderForExtension,
  closeInterimForExtensionTx,
  computeInterimFigures,
  createInterimPaymentRequestTx,
  loadInterimReminderPolicy,
  resolveInterimDueBy,
  type InterimAsk,
  type InterimFigures,
  type InterimReminderPolicy,
} from "./interim-payment-service.js";
import {
  changeRoomToNewSegment,
  listRoomStandingForNights,
  type RoomChangeOutcome,
  type RoomStanding,
} from "./room-change-service.js";
import type { RoomCompositionServiceInput } from "./s2-quotation-service.js";

type Actor = { actorId: string; actorLevel: "L1" | "L2" | "L3" | "L4" };
const RANK: Record<string, number> = { L1: 1, L2: 2, L3: 3, L4: 4 };
const DAY_MS = 86_400_000;

/**
 * Stay extension (2026-08-21, operator ruling): "the guest can extend the stay, saying they
 * need to stay for more N nights". NOT a walk back to S1 — the spec's path is S7→S4
 * (DATE_EXTENSION, SIG-S7 §3.3: new segment, inventory claim extended, checkout timer
 * re-registered; §86: availability verified for the extended dates). Built on the in-place
 * room-change composite, which already runs that governed journey with a compressed S4→S7
 * return. S1 contributes only its predicates (availability over the extra nights).
 *
 * The order is the S3 doctrine applied mid-stay, and the operator's ruling:
 *   preview → REQUEST (the extra nights are CLAIMED for the guest, TTL `stayExtension.holdTtlSeconds`;
 *   the INTERIM invoice is minted) → dispatch → guest's answer → interim PAYMENT → COMMIT.
 * Nothing about the booking moves until the commit; a request that lapses unpaid releases
 * the nights. FOM (L2+) throughout. Rates: the current room carries its negotiated rate; a
 * different room type starts at its published rate, negotiable in the extension table.
 */

export type StayExtensionPreview = {
  entryId: string;
  currentStage: string;
  currency: string;
  currentCheckOut: string;
  newCheckOut: string;
  extraNights: string[];
  /** The rooms the guest is in on the last current night, each with its standing over the extra nights. */
  currentRooms: Array<RoomStanding & { extendableInPlace: boolean }>;
  /** Every room's standing over the extra nights (for a move from the old checkout date). */
  candidates: RoomStanding[];
  /** The resolved plan for the extra nights: [{ date, roomId }] (one per room per night). */
  plan: Array<{ date: string; roomId: string; roomNumber: string | null }>;
  /** Rooms in the plan that differ from the current rooms — a scheduled move on the old checkout day. */
  moves: Array<{ fromRoomId: string; fromRoomNumber: string | null; toRoomId: string; toRoomNumber: string | null; crossType: boolean }>;
  /** The composition rows the projection priced — the seed for the desk's negotiation table. */
  compositions: RoomCompositionServiceInput[];
  pricing: {
    priorStayTotal: number | null;
    projectedStayTotal: number;
    delta: number | null;
    discount: { effectivePercent: number; amountOffTotal: number } | null;
  };
  figures: InterimFigures;
  holdTtlSeconds: number;
  /** Mid-stay payment reminder (2026-08-22): the policy + the due-by the request would default to. */
  reminder: { policy: InterimReminderPolicy; defaultDueBy: string | null };
  /** Why the extension cannot be requested as previewed (null = fine). */
  blockedReason: string | null;
};

function isoDay(d: Date): string {
  return d.toISOString().slice(0, 10);
}
function utcMidnight(iso: string): Date {
  const d = new Date(`${iso.slice(0, 10)}T00:00:00.000Z`);
  if (Number.isNaN(d.getTime())) throw new ValidationError(`Invalid date: ${iso}`);
  return d;
}
function nightsBetween(from: Date, to: Date): string[] {
  const out: string[] = [];
  for (let t = from.getTime(); t < to.getTime(); t += DAY_MS) out.push(new Date(t).toISOString().slice(0, 10));
  return out;
}

async function holdTtlSeconds(prisma: PrismaClient): Promise<number> {
  try {
    const v = Number(await requireActiveConfigValue<number>(prisma, "stayExtension.holdTtlSeconds"));
    if (Number.isFinite(v) && v > 0) return v;
  } catch {
    /* unseeded */
  }
  return 86_400;
}

async function loadExtensionEntry(prisma: PrismaClient, entryId: string) {
  const entry = await prisma.entry.findUnique({
    where: { id: entryId },
    include: {
      segments: { orderBy: { segmentNumber: "desc" } },
      quotations: { orderBy: { createdAt: "desc" } },
      reservation: true,
      reservations: { orderBy: { confirmedAt: "desc" }, select: { confirmedAt: true, frozenCommercialTerms: true } },
      committedHold: true,
      roomAssignments: { orderBy: { createdAt: "desc" } },
      availabilityConfigs: {
        where: { sealedAt: { not: null }, optionSelected: { not: Prisma.DbNull } },
        orderBy: { sealedAt: "desc" },
        take: 1,
      },
      stayExtensionRequests: { orderBy: { createdAt: "desc" } },
    },
  });
  if (!entry) throw new NotFoundError("Entry");
  return entry;
}

/**
 * Preview — no writes. Availability of the current rooms over the extra nights (own claims
 * excluded), alternatives when taken, the projected price of the extended stay, and the
 * interim figures for the ask. Also the validation the request runs, so a refusal is named
 * here before anything is held.
 */
export async function previewStayExtension(
  prisma: PrismaClient,
  entryId: string,
  input: {
    newCheckOutDate: string;
    perNight?: Array<{ date: string; roomId: string }>;
    /** The current room `perNight` replaces (multi-room bookings); defaults to the taken one. */
    replaceRoomId?: string | null;
    roomCompositions?: RoomCompositionServiceInput[];
    requestedDiscount?: { discountPercent?: number; discountAmount?: number; discountBasis: string } | null;
    ask?: InterimAsk | null;
  },
): Promise<StayExtensionPreview> {
  const entry = await loadExtensionEntry(prisma, entryId);
  if (entry.currentStage !== Stage.S7) throw new ValidationError(`A stay is extended from the Stay step (S7) — this booking is at ${entry.currentStage}`);
  if (entry.status !== "ACTIVE") throw new ValidationError(`The booking is ${entry.status.toLowerCase()} — its record is read-only`);
  const checkIn = entry.reservation?.frozenCheckInDate ?? entry.checkInDate;
  const currentCheckOut = entry.reservation?.frozenCheckOutDate ?? entry.checkOutDate;
  if (!checkIn || !currentCheckOut) throw new ValidationError("This booking has no stay dates");
  const newCheckOut = utcMidnight(input.newCheckOutDate);
  if (newCheckOut.getTime() <= currentCheckOut.getTime()) {
    throw new ValidationError(
      `The new checkout must be later than the current one (${isoDay(currentCheckOut)}) — a shorter stay is an early departure`,
    );
  }
  const extraNights = nightsBetween(currentCheckOut, newCheckOut);
  if (extraNights.length > 120) throw new ValidationError("An extension is at most 120 nights at a time");

  // The current plan and the rooms in use on the last night — those are what extend.
  const currentNights = nightsBetween(checkIn, currentCheckOut);
  const picture = currentPerNightPicture({
    sealedOption: entry.availabilityConfigs[0]?.optionSelected ?? null,
    fallbackRoomIds: Array.from(new Set(entry.roomAssignments.map((a) => a.roomId))),
    nightsIso: currentNights,
  });
  const lastNight = picture[picture.length - 1];
  const lastNightRoomIds = lastNight?.roomIds ?? [];
  if (lastNightRoomIds.length === 0) throw new ValidationError("This booking has no room on its last night to extend");
  const currentPlanRoomIds = Array.from(new Set(picture.flatMap((n) => n.roomIds)));

  // Every room's standing over the extra nights — the current rooms included (their own
  // claims excluded, so "is the room free after my checkout" is answered honestly).
  const standing = await listRoomStandingForNights(prisma, { entryId, nights: extraNights, referenceRoomTypeIdFrom: lastNightRoomIds[0] });
  const byRoom = new Map(standing.map((s) => [s.roomId, s]));

  // The plan: default = every last-night room continues; `perNight` overrides ONE room's
  // extra nights with another room (a scheduled move on the old checkout day).
  const plan: Array<{ date: string; roomId: string; roomNumber: string | null }> = [];
  const overrides = new Map<string, string>();
  for (const p of input.perNight ?? []) overrides.set(p.date.slice(0, 10), p.roomId);
  const overrideRooms = new Set(overrides.values());
  // Which current room is being replaced by the override rooms: the one the caller names
  // (`replaceRoomId`), else the current room that is NOT free over the extra nights, else the
  // first one not named in the overrides (single-room bookings: the only room). Found live
  // 2026-08-22 on a four-room booking: "the first current room not in the overrides" paired a
  // pick meant for the taken Room 302 with Room 206, so 302 stayed blocked and the desk's
  // move-to select could never unblock the extension.
  if (input.replaceRoomId && !lastNightRoomIds.includes(input.replaceRoomId)) {
    throw new ValidationError(`replaceRoomId must be one of the rooms the guest is in on the last night (${lastNightRoomIds.map((id) => byRoom.get(id)?.roomNumber ?? id.slice(0, 6)).join(", ")})`);
  }
  const takenCurrent = lastNightRoomIds.filter((id) => (byRoom.get(id)?.perNight ?? []).some((n) => n.status !== "FREE"));
  const replacedRoomId =
    overrides.size > 0
      ? (input.replaceRoomId ?? takenCurrent.find((id) => !overrideRooms.has(id)) ?? lastNightRoomIds.find((id) => !overrideRooms.has(id)) ?? lastNightRoomIds[0])
      : null;
  for (const date of extraNights) {
    for (const roomId of lastNightRoomIds) {
      const target = roomId === replacedRoomId ? overrides.get(date) ?? roomId : roomId;
      plan.push({ date, roomId: target, roomNumber: byRoom.get(target)?.roomNumber ?? null });
    }
  }
  for (const p of plan) {
    if (!byRoom.has(p.roomId)) throw new ValidationError(`Unknown room in the extension plan (${p.roomId.slice(0, 8)}…)`);
  }
  const moves: StayExtensionPreview["moves"] = [];
  if (replacedRoomId) {
    for (const toRoomId of new Set(plan.filter((p) => p.roomId !== replacedRoomId && !lastNightRoomIds.includes(p.roomId)).map((p) => p.roomId))) {
      const from = byRoom.get(replacedRoomId);
      const to = byRoom.get(toRoomId);
      moves.push({
        fromRoomId: replacedRoomId,
        fromRoomNumber: from?.roomNumber ?? null,
        toRoomId,
        toRoomNumber: to?.roomNumber ?? null,
        crossType: (from?.roomTypeId ?? null) !== (to?.roomTypeId ?? null),
      });
    }
  }

  // The candidates' `sameType` / `requiredLevel` are judged against the room being REPLACED
  // (the caller's `replaceRoomId`, else the taken room), not the booking's first room — on a
  // multi-room booking those differ, and the desk's "same type — rate carries" label has to
  // agree with how the move is priced (`crossType`). The standing helper was told the first
  // room's type because the replaced room is only known after the standing comes back.
  const refRoomId = input.replaceRoomId ?? takenCurrent[0] ?? replacedRoomId ?? lastNightRoomIds[0];
  const refTypeId = byRoom.get(refRoomId)?.roomTypeId ?? null;
  const candidates: RoomStanding[] = standing
    .map((s) => {
      const sameType = refTypeId == null || s.roomTypeId === refTypeId;
      return { ...s, sameType, requiredLevel: (sameType ? "L1" : "L2") as "L1" | "L2" };
    })
    .sort((a, b) => Number(b.sameType) - Number(a.sameType) || Number(b.selectable) - Number(a.selectable) || String(a.roomNumber).localeCompare(String(b.roomNumber), undefined, { numeric: true }));

  // Availability of the plan, night by night.
  let blockedReason: string | null = null;
  for (const p of plan) {
    const st = byRoom.get(p.roomId)!;
    const night = st.perNight.find((n) => n.date === p.date);
    if (night && night.status !== "FREE") {
      const who = night.claimedBy?.guestName ?? night.claimedBy?.bookingRef ?? null;
      blockedReason = `Room ${st.roomNumber} is ${night.status.toLowerCase()} on ${p.date}${who ? ` (${who})` : ""} — pick another room for the nights after ${isoDay(currentCheckOut)}`;
      break;
    }
  }

  // Pricing projection: the carried compositions + a row for each new room (the moving party's
  // row, at the new type's published rate when cross-type), nights counted over the EXTENDED
  // plan. The desk's extension table, when sent, replaces the rows of the extension's rooms.
  const basis = resolveCompositionBasis<RoomCompositionServiceInput>(entry);
  const carried = (basis.compositions ?? []).map((c) => ({ ...c }));
  const extensionRoomIds = Array.from(new Set(plan.map((p) => p.roomId)));
  const rows: RoomCompositionServiceInput[] = carried.filter((c) => currentPlanRoomIds.includes(c.roomId));
  for (const roomId of extensionRoomIds) {
    if (rows.some((r) => r.roomId === roomId)) continue;
    const move = moves.find((m) => m.toRoomId === roomId);
    const source = carried.find((c) => c.roomId === (move?.fromRoomId ?? lastNightRoomIds[0])) ?? carried[0];
    if (!source) continue;
    const { negotiatedRoomRate, nightMealOverrides, ...rest } = source;
    rows.push({ ...rest, roomId, ...(move?.crossType ? {} : negotiatedRoomRate != null ? { negotiatedRoomRate } : {}) });
  }
  if (input.roomCompositions?.length) {
    for (const supplied of input.roomCompositions) {
      if (!extensionRoomIds.includes(supplied.roomId)) {
        throw new ValidationError(`The extension table may only describe the rooms carrying the extension — Room ${byRoom.get(supplied.roomId)?.roomNumber ?? supplied.roomId.slice(0, 6)} is not one of them`);
      }
      const i = rows.findIndex((r) => r.roomId === supplied.roomId);
      if (i >= 0) rows[i] = { ...supplied };
      else rows.push({ ...supplied });
    }
  }
  const perRoomNightCounts = new Map<string, number>();
  for (const n of picture) for (const id of n.roomIds) perRoomNightCounts.set(id, (perRoomNightCounts.get(id) ?? 0) + 1);
  for (const p of plan) perRoomNightCounts.set(p.roomId, (perRoomNightCounts.get(p.roomId) ?? 0) + 1);

  const discountIn = input.requestedDiscount === undefined ? ((basis.terms?.requestedDiscount ?? null) as { discountPercent?: number; discountAmount?: number } | null) : input.requestedDiscount;
  let projected: { payable: number; effectivePercent: number; amountOffTotal: number } | null = null;
  if (rows.length > 0) {
    const preview = await buildQuotationPreview(
      prisma,
      entryId,
      {
        roomCompositions: rows.map((c) => ({ ...c, nightMealOverrides: c.nightMealOverrides ?? [] })),
        discount: discountIn ? { percent: discountIn.discountPercent ?? null, amount: discountIn.discountAmount ?? null } : null,
      },
      { stayOverride: { checkIn, checkOut: newCheckOut, perRoomNightCounts } },
    );
    projected = {
      payable: preview.payable,
      effectivePercent: preview.discount?.effectivePercent ?? 0,
      amountOffTotal: preview.discount?.amountOffTotal ?? 0,
    };
  }
  const baseFigures = await computeInterimFigures(prisma, entryId);
  const priorStayTotal = baseFigures.projectionSource === "QUOTE" ? baseFigures.projectedRoomTotal : null;
  // Legacy booking with no priced composition: run the posted rate forward over the new nights.
  const projectedStayTotal =
    projected?.payable ??
    Number((baseFigures.projectedRoomTotal + (baseFigures.nightsSlept > 0 ? (baseFigures.roomChargesPostedSoFar / baseFigures.nightsSlept) * extraNights.length : 0)).toFixed(2));
  const figures = await computeInterimFigures(prisma, entryId, {
    projection: { checkOut: newCheckOut, roomTotal: projectedStayTotal },
    ask: input.ask ?? null,
  });

  const ttlForPreview = await holdTtlSeconds(prisma);
  const reminderPolicy = await loadInterimReminderPolicy(prisma);
  const previewNow = new Date();
  const defaultDueBy = resolveInterimDueBy(reminderPolicy, {
    kind: "EXTENSION",
    now: previewNow,
    holdExpiresAt: new Date(previewNow.getTime() + ttlForPreview * 1000),
  });
  return {
    entryId,
    currentStage: String(entry.currentStage),
    currency: figures.currency,
    currentCheckOut: isoDay(currentCheckOut),
    newCheckOut: isoDay(newCheckOut),
    extraNights,
    currentRooms: lastNightRoomIds
      .map((id) => byRoom.get(id))
      .filter((s): s is RoomStanding => !!s)
      .map((s) => ({ ...s, extendableInPlace: s.perNight.every((n) => n.status === "FREE") })),
    candidates,
    plan,
    moves,
    compositions: rows,
    pricing: {
      priorStayTotal,
      projectedStayTotal,
      delta: priorStayTotal != null ? Number((projectedStayTotal - priorStayTotal).toFixed(2)) : null,
      discount: projected && projected.amountOffTotal > 0 ? { effectivePercent: projected.effectivePercent, amountOffTotal: projected.amountOffTotal } : null,
    },
    figures,
    holdTtlSeconds: ttlForPreview,
    reminder: { policy: reminderPolicy, defaultDueBy: defaultDueBy?.toISOString() ?? null },
    blockedReason,
  };
}

function requireFom(actor: Actor, what: string) {
  if ((RANK[actor.actorLevel] ?? 0) < 2) {
    throw new PolicyGateBlockedError("AUTH_REQUIRED_L2", `FOM authority required to ${what}`);
  }
}

/** REQUEST: claim the extra nights, mint the interim invoice, arm the hold clock. */
export async function requestStayExtension(
  prisma: PrismaClient,
  actor: Actor,
  entryId: string,
  input: {
    newCheckOutDate: string;
    perNight?: Array<{ date: string; roomId: string }>;
    /** The current room `perNight` replaces (multi-room bookings); defaults to the taken one. */
    replaceRoomId?: string | null;
    roomCompositions?: RoomCompositionServiceInput[];
    requestedDiscount?: { discountPercent?: number; discountAmount?: number; discountBasis: string } | null;
    reason: string;
    ask: InterimAsk;
    note?: string | null;
    /** When the extension's payment is expected (ISO). Omitted = before the held nights lapse (policy). */
    dueBy?: string | null;
  },
) {
  requireFom(actor, "extend a stay");
  const reason = input.reason?.trim();
  if (!reason) throw new ValidationError("A reason for the extension is required");
  const open = await prisma.stayExtensionRequest.findFirst({
    where: { entryId, state: { in: ["REQUESTED", "BILLED", "PAID"] } },
    select: { id: true, state: true, newCheckOutDate: true },
  });
  if (open) {
    throw new ValidationError(
      `An extension to ${isoDay(open.newCheckOutDate)} is already ${open.state.toLowerCase()} — commit or withdraw it before requesting another`,
    );
  }
  const preview = await previewStayExtension(prisma, entryId, { ...input, ask: input.ask });
  if (preview.blockedReason) throw new ValidationError(preview.blockedReason);
  if (preview.figures.dueNow == null || preview.figures.dueNow <= 0) {
    throw new ValidationError("The interim ask comes to nothing after what the guest has already paid — raise it, or commit the extension without a payment is not allowed");
  }
  const ttl = preview.holdTtlSeconds;
  const now = new Date();
  const holdExpiresAt = new Date(now.getTime() + ttl * 1000);
  // Mid-stay payment reminder: the extension's bill is due before its held nights lapse.
  const reminderPolicy = await loadInterimReminderPolicy(prisma);
  const dueBy = resolveInterimDueBy(reminderPolicy, { kind: "EXTENSION", now, holdExpiresAt, requested: input.dueBy ?? null });
  const entryRow = await prisma.entry.findUniqueOrThrow({
    where: { id: entryId },
    select: { inquiryId: true, segments: { orderBy: { segmentNumber: "desc" }, take: 1, select: { id: true } } },
  });

  const created = await prisma.$transaction(async (tx) => {
    const request = await tx.stayExtensionRequest.create({
      data: {
        entryId,
        segmentId: entryRow.segments[0]?.id ?? null,
        state: "REQUESTED",
        priorCheckOutDate: utcMidnight(preview.currentCheckOut),
        newCheckOutDate: utcMidnight(preview.newCheckOut),
        extraNights: preview.plan.map((p) => ({ date: p.date, roomId: p.roomId })) as Prisma.InputJsonValue,
        roomCompositions: preview.compositions as unknown as Prisma.InputJsonValue,
        requestedDiscount: (input.requestedDiscount ?? null) as Prisma.InputJsonValue,
        pricingPreview: { pricing: preview.pricing, figures: preview.figures, moves: preview.moves } as Prisma.InputJsonValue,
        reason,
        holdExpiresAt,
        requestedBy: actor.actorId,
        requestedAt: now,
      },
    });
    const interim = await createInterimPaymentRequestTx(tx, actor, {
      entryId,
      kind: "EXTENSION",
      ask: input.ask,
      figures: preview.figures,
      note: input.note ?? `Stay extension to ${preview.newCheckOut}: ${reason}`,
      stayExtensionRequestId: request.id,
      dueBy,
    });
    await tx.traceEvent.create({
      data: {
        eventType: "STAY_EXTENSION.REQUESTED",
        actorId: actor.actorId,
        actorLevel: actor.actorLevel,
        entityType: "StayExtensionRequest",
        entityId: request.id,
        operation: "CREATE",
        timestamp: now,
        stageContext: Stage.S7,
        inquiryId: entryRow.inquiryId,
        entryId,
        payload: {
          entryId,
          priorCheckOutDate: preview.currentCheckOut,
          newCheckOutDate: preview.newCheckOut,
          extraNights: preview.plan,
          moves: preview.moves,
          projectedStayTotal: preview.pricing.projectedStayTotal,
          dueNow: preview.figures.dueNow,
          holdExpiresAt: holdExpiresAt.toISOString(),
          interimPaymentRequestId: interim.request.id,
          invoiceId: interim.invoice.id,
          reason,
        } as Prisma.InputJsonValue,
        createdBy: actor.actorId,
      },
    });
    return { request, interim };
  });

  // Hold clock (W40) — post-tx so a pg-boss hiccup can't roll the request back.
  try {
    const engine = await getTimerEngine();
    const timer = await prisma.timerRecord.create({
      data: {
        entryId,
        entityType: "StayExtensionRequest",
        entityId: created.request.id,
        timerType: "STAY_EXTENSION_HOLD_EXPIRY_W40",
        timerCode: "STAY_EXTENSION_HOLD_EXPIRY_W40",
        stageContext: Stage.S7,
        dueAt: holdExpiresAt,
        firesAt: holdExpiresAt,
        status: "SCHEDULED",
        createdBy: actor.actorId,
        payload: { stayExtensionRequestId: created.request.id },
      },
    });
    const jobId = await engine.schedule(
      "STAY_EXTENSION_HOLD_EXPIRY_W40",
      { stayExtensionRequestId: created.request.id, timerRecordId: timer.id },
      { startAfter: holdExpiresAt },
    );
    await prisma.timerRecord.update({ where: { id: timer.id }, data: { pgBossJobId: jobId } });
    await prisma.stayExtensionRequest.update({ where: { id: created.request.id }, data: { timerRecordId: timer.id } });
  } catch {
    /* the claim still expires by `holdExpiresAt` (the claim predicate reads it) — only the lapse bookkeeping waits */
  }
  // Reminder clock (W41): chase the extension's payment before the held nights lapse.
  if (dueBy) await armInterimPaymentReminder(prisma, { requestId: created.interim.request.id, actorId: actor.actorId }).catch(() => {});

  return { request: created.request, interim: created.interim.request, invoice: created.interim.invoice, preview };
}

async function cancelHoldTimer(prisma: PrismaClient, entryId: string, actorId: string, reason: string) {
  await cancelEntryTimersByCode(prisma, {
    entryId,
    timerCodes: ["STAY_EXTENSION_HOLD_EXPIRY_W40"],
    cancelledBy: actorId,
    cancelledReason: reason,
  }).catch(() => {});
}

export async function withdrawStayExtension(prisma: PrismaClient, actor: Actor, requestId: string, reason?: string | null) {
  requireFom(actor, "withdraw a stay extension");
  const req = await prisma.stayExtensionRequest.findUnique({ where: { id: requestId }, include: { entry: { select: { inquiryId: true } } } });
  if (!req) throw new NotFoundError("StayExtensionRequest");
  if (req.state === "COMMITTED") throw new ValidationError("This extension has already been committed — a shorter stay is an early departure");
  if (req.state === "LAPSED" || req.state === "WITHDRAWN") return req;
  const now = new Date();
  const updated = await prisma.$transaction(async (tx) => {
    const u = await tx.stayExtensionRequest.update({
      where: { id: req.id },
      data: { state: "WITHDRAWN", closedAt: now, closedReason: reason?.trim() || "WITHDRAWN_BY_DESK" },
    });
    await closeInterimForExtensionTx(tx, req.id, "WITHDRAWN", reason?.trim() || "EXTENSION_WITHDRAWN");
    await tx.traceEvent.create({
      data: {
        eventType: "STAY_EXTENSION.WITHDRAWN",
        actorId: actor.actorId,
        actorLevel: actor.actorLevel,
        entityType: "StayExtensionRequest",
        entityId: req.id,
        operation: "UPDATE",
        timestamp: now,
        stageContext: Stage.S7,
        inquiryId: req.entry.inquiryId,
        entryId: req.entryId,
        payload: { entryId: req.entryId, priorState: req.state, reason: reason ?? null, moneyStaysOnFolio: req.state === "PAID" } as Prisma.InputJsonValue,
        createdBy: actor.actorId,
      },
    });
    return u;
  });
  await cancelHoldTimer(prisma, req.entryId, actor.actorId, "STAY_EXTENSION_WITHDRAWN");
  await cancelInterimReminderForExtension(prisma, req.id, actor.actorId, "STAY_EXTENSION_WITHDRAWN").catch(() => {});
  return updated;
}

/** W40: the hold ran out unpaid — release the nights, close the bill. */
export async function lapseStayExtensionRequest(prisma: PrismaClient, requestId: string, reason: string) {
  const req = await prisma.stayExtensionRequest.findUnique({ where: { id: requestId }, include: { entry: { select: { inquiryId: true } } } });
  if (!req) return null;
  if (req.state !== "REQUESTED" && req.state !== "BILLED") return req;
  const now = new Date();
  const out = await prisma.$transaction(async (tx) => {
    const u = await tx.stayExtensionRequest.update({
      where: { id: req.id },
      data: { state: "LAPSED", closedAt: now, closedReason: reason },
    });
    await closeInterimForExtensionTx(tx, req.id, "LAPSED", reason);
    await tx.traceEvent.create({
      data: {
        eventType: "STAY_EXTENSION.LAPSED",
        actorId: "SYSTEM",
        actorLevel: "SYSTEM",
        entityType: "StayExtensionRequest",
        entityId: req.id,
        operation: "UPDATE",
        timestamp: now,
        stageContext: Stage.S7,
        inquiryId: req.entry.inquiryId,
        entryId: req.entryId,
        payload: { entryId: req.entryId, reason, newCheckOutDate: req.newCheckOutDate.toISOString() } as Prisma.InputJsonValue,
        createdBy: "SYSTEM",
      },
    });
    return u;
  });
  await cancelInterimReminderForExtension(prisma, req.id, "SYSTEM", reason).catch(() => {});
  return out;
}

/**
 * COMMIT — only once the interim payment is in (Policy 80). Re-validates the extra nights
 * against everyone else (the request's own claim is excluded), then runs the governed
 * room-change composite in extension mode: new segment, sealed config with the extra nights,
 * silent re-quote over the extended stay (slept nights pinned), hold over the full plan,
 * re-freeze with the NEW checkout (a new immutable Reservation row), voucher answer
 * auto-recorded, compressed return to S7; then the extra night-audit clocks. Partial-outcome
 * contract: the outcome names a blocked step; the request stays PAID with the outcome stored.
 */
export async function commitStayExtension(
  prisma: PrismaClient,
  actor: Actor,
  requestId: string,
  reason?: string | null,
): Promise<{ request: unknown; outcome: RoomChangeOutcome }> {
  requireFom(actor, "commit a stay extension");
  const req = await prisma.stayExtensionRequest.findUnique({
    where: { id: requestId },
    include: { interimPayment: true, entry: { select: { id: true, inquiryId: true, currentStage: true, status: true } } },
  });
  if (!req) throw new NotFoundError("StayExtensionRequest");
  enforceExtensionPaidBeforeCommit({ extensionState: req.state, interimState: req.interimPayment?.state ?? null });
  if (req.entry.currentStage !== Stage.S7 || req.entry.status !== "ACTIVE") {
    throw new ValidationError(`The booking is at ${req.entry.currentStage} (${req.entry.status.toLowerCase()}) — an extension commits from the Stay step`);
  }
  const extraNights = (Array.isArray(req.extraNights) ? req.extraNights : []) as Array<{ date: string; roomId: string }>;
  if (extraNights.length === 0) throw new ValidationError("This extension names no nights");

  // Which current room is extended / moved — the request's plan against the last current night.
  const entry = await loadExtensionEntry(prisma, req.entryId);
  const checkIn = entry.reservation?.frozenCheckInDate ?? entry.checkInDate!;
  const currentCheckOut = entry.reservation?.frozenCheckOutDate ?? entry.checkOutDate!;
  if (currentCheckOut.getTime() !== req.priorCheckOutDate.getTime()) {
    throw new ValidationError(
      `The booking's checkout (${isoDay(currentCheckOut)}) no longer matches the one this extension was requested against (${isoDay(req.priorCheckOutDate)}) — request it again`,
    );
  }
  const picture = currentPerNightPicture({
    sealedOption: entry.availabilityConfigs[0]?.optionSelected ?? null,
    fallbackRoomIds: Array.from(new Set(entry.roomAssignments.map((a) => a.roomId))),
    nightsIso: nightsBetween(checkIn, currentCheckOut),
  });
  const lastNightRoomIds = picture[picture.length - 1]?.roomIds ?? [];
  const extraRoomIds = Array.from(new Set(extraNights.map((n) => n.roomId)));
  const newRoomIds = extraRoomIds.filter((id) => !lastNightRoomIds.includes(id));
  const replaced = lastNightRoomIds.find((id) => !extraRoomIds.includes(id)) ?? null;
  const fromRoomId = replaced ?? lastNightRoomIds[0];
  const toRoomId = newRoomIds[0] ?? null;
  if (!fromRoomId) throw new ValidationError("This booking has no room on its last night to extend");

  const outcome = await changeRoomToNewSegment(prisma, actor, {
    entryId: req.entryId,
    fromRoomId,
    ...(toRoomId ? { toRoomId } : {}),
    reason: reason?.trim() || req.reason,
    roomCompositions: Array.isArray(req.roomCompositions) ? (req.roomCompositions as unknown as RoomCompositionServiceInput[]) : undefined,
    ...(req.requestedDiscount !== null && req.requestedDiscount !== undefined
      ? { requestedDiscount: req.requestedDiscount as { discountPercent?: number; discountAmount?: number; discountBasis: string } }
      : {}),
    extension: {
      requestId: req.id,
      priorCheckOutDate: req.priorCheckOutDate,
      newCheckOutDate: req.newCheckOutDate,
      extraNights,
    },
  });

  const now = new Date();
  const committed = !outcome.walk.blocked;
  const updated = await prisma.stayExtensionRequest.update({
    where: { id: req.id },
    data: {
      outcome: outcome as unknown as Prisma.InputJsonValue,
      ...(committed ? { state: "COMMITTED", committedAt: now, committedBy: actor.actorId } : {}),
    },
  });
  await prisma.traceEvent
    .create({
      data: {
        eventType: committed ? "STAY_EXTENSION.COMMITTED" : "STAY_EXTENSION.COMMIT_BLOCKED",
        actorId: actor.actorId,
        actorLevel: actor.actorLevel,
        entityType: "StayExtensionRequest",
        entityId: req.id,
        operation: "UPDATE",
        timestamp: now,
        stageContext: Stage.S7,
        inquiryId: req.entry.inquiryId,
        entryId: req.entryId,
        payload: {
          entryId: req.entryId,
          newCheckOutDate: req.newCheckOutDate.toISOString(),
          newSegmentNumber: outcome.newSegmentNumber,
          quotationId: outcome.quotationId,
          pricing: outcome.pricing,
          walk: outcome.walk,
        } as Prisma.InputJsonValue,
        createdBy: actor.actorId,
      },
    })
    .catch(() => {});
  await cancelHoldTimer(prisma, req.entryId, actor.actorId, "STAY_EXTENSION_COMMITTED");
  if (committed) {
    // SIG-S7 §3.3: the extra nights get their night-audit clocks; the checkout timer re-keys.
    await registerNightAuditTimers(prisma, req.entryId, actor.actorId).catch(() => {});
    await cancelEntryTimersByCode(prisma, {
      entryId: req.entryId,
      timerCodes: ["CHECKOUT_TIME_W26"],
      cancelledBy: actor.actorId,
      cancelledReason: "STAY_EXTENSION_COMMITTED",
    }).catch(() => {});
  }
  return { request: updated, outcome };
}

export async function listStayExtensions(prisma: PrismaClient, entryId: string) {
  const rows = await prisma.stayExtensionRequest.findMany({
    where: { entryId },
    orderBy: { createdAt: "desc" },
    include: { interimPayment: { include: { invoice: { select: { id: true, state: true, dispatchedAt: true, totalAmount: true } }, payments: { select: { amount: true } } } } },
  });
  return rows.map((r) => ({
    ...r,
    interimPayment: r.interimPayment
      ? {
          ...r.interimPayment,
          askValue: r.interimPayment.askValue != null ? Number(r.interimPayment.askValue) : null,
          projectedTotal: r.interimPayment.projectedTotal != null ? Number(r.interimPayment.projectedTotal) : null,
          receivedAtRequest: r.interimPayment.receivedAtRequest != null ? Number(r.interimPayment.receivedAtRequest) : null,
          dueNow: r.interimPayment.dueNow != null ? Number(r.interimPayment.dueNow) : null,
          receivedAgainstAsk: Number(r.interimPayment.payments.reduce((acc, p) => acc + Number(p.amount), 0).toFixed(2)),
          invoice: r.interimPayment.invoice ? { ...r.interimPayment.invoice, totalAmount: r.interimPayment.invoice.totalAmount != null ? Number(r.interimPayment.invoice.totalAmount) : null } : null,
          payments: undefined,
        }
      : null,
  }));
}
