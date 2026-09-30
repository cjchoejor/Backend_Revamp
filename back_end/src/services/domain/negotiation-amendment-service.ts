/**
 * Change the rooms and the party WITHOUT leaving Negotiation (2026-09-30, operator ruling).
 *
 * The problem it answers: a guest who drops two rooms and two people after the quote was
 * priced. The intake — adults, children and their ages, the room count, the bed-setup ask —
 * is written by `updateEntryIntakeFields`, which refuses anything past S1 ("use the
 * stage-specific amendment flow"); that flow was never built. So the only route was a
 * re-entry to Inquiry, which reads to the desk like starting the enquiry again.
 *
 * WHY THIS STAYS INSIDE THE PASS. A change after Reserve needs a new segment because
 * something permanent was stamped — the Reservation row, the confirmed hold, the frozen
 * terms — and those cannot be edited. At Negotiation NOTHING is stamped: no reservation, no
 * committed hold, no folio, no bill. What exists is availability configurations (already one
 * row per search, sealed individually) and quotation versions (already append-only, superseded
 * rather than rewritten). So this is an amendment INSIDE the current pass, not a re-entry, and
 * it deliberately does not seal a segment that holds nothing worth sealing.
 *
 * From Set up or Reserve the operator comes back through the existing re-entry — which seals
 * the pass and supersedes the standing paperwork — and then amends here. That is why there is
 * no S3 or S4 form of this act (operator, 2026-09-30: "even if they were in s3 or s4 they'll
 * have to come back to s2 to do the changes, that way the quotation and proforma invoice and
 * all can be superseded with new ones as they have to move from s2 to s3 to s4").
 *
 * IT IS NOT A NEW SPEC ITEM. `GUEST_COMPOSITION_CHANGE` has been a seeded ModeConfiguration
 * since the mode registry landed — "adds or removes guests from an entry ... routes through S2
 * (re-validate group threshold)", `stageRoute: ["S2", "S6"]`, with an auto-fulfilment condition
 * whose evaluator is already written. It had no consumer. This is that consumer, so
 * deactivating the mode on /admin/modes disables the feature exactly as it does every backflow.
 *
 * WHAT IT REFUSES TO DO. Dates. A date change moves the availability question, the quote's
 * validity anchor, the no-show cut-off and the hold window at once, so it stays on the
 * re-entry to Inquiry (operator ruling: "dates can't be changed, if dates needs to be changed
 * then going back to s1 is mandatory or a new inquiry").
 */
import type { PrismaClient, Prisma as PrismaNS } from "@prisma/client";
import { QuotationState, Stage } from "@prisma/client";
import { NotFoundError, ValidationError } from "../../lib/errors.js";
import { readOptionSelected } from "../../lib/option-selected-reader.js";
import { requireActiveMode } from "../../lib/mode-registry-runtime.js";
import { getTimerEngine } from "../infrastructure/timer-management-service.js";
import * as auditService from "../infrastructure/audit-service.js";
import {
  enforceEntryAtS2ForNegotiationAmendment,
  enforceNegotiationAmendmentAuthority,
} from "../../policies/01-availability/p01-entry-progression-stage-gates.js";
import { createAmendmentEvent } from "../application/s7-amendment-service.js";
import { updateEntryIntakeFields } from "./s1-entry-service.js";
import { selectOption } from "./s1-availability-service.js";
import { releaseSpeculativeHold, placeSpeculativeHold } from "./s2-hold-service.js";

/** A person at a terminal — `ActorLevel` also carries SYSTEM, which never takes this act. */
export type NegotiationAmendmentActor = { actorId: string; actorLevel: "L1" | "L2" | "L3" | "L4" };

export type NegotiationAmendmentInput = {
  /** The stay's party — the fields the intake screen owns. Dates are deliberately absent. */
  party?: {
    adultCount?: number;
    childCount?: number;
    childAges?: number[];
    numberOfRooms?: number;
    bedTypeRequest?: Record<string, number> | null;
  };
  /**
   * The new room plan, expressed exactly as the S1 save expresses it — the configuration the
   * fresh search produced, plus the picks. Absent = the rooms are unchanged.
   */
  rooms?: {
    configurationId: string;
    roomId?: string;
    roomIds?: string[];
    perNight?: Array<{ date: string; roomIds: string[] }>;
    deficientAcknowledgements?: unknown;
  };
  reason: string;
  expectedVersion?: number;
};

/**
 * What the act did. `applied: false` means the operator could not take it themselves and it is
 * now WAITING — the outcome then carries `requestId` and nothing on the booking has moved.
 */
export type NegotiationAmendmentOutcome = {
  applied: boolean;
  requestId?: string;
  entryId: string;
  amendmentId: string | null;
  partyChanged: boolean;
  roomsChanged: boolean;
  priorRoomIds: string[];
  newRoomIds: string[];
  /** Every live quotation of this pass that the change made untrue, and the state it was in. */
  quotationsInvalidated: Array<{ id: string; referenceNumber: string; priorState: QuotationState }>;
  /** What happened to the provisional block, when one was standing. */
  hold:
    | { action: "REPLACED"; priorHoldId: string; holdId: string; expiresAt: string }
    | { action: "RELEASED"; priorHoldId: string; note: string }
    | null;
  summary: string;
};

/** The party fields, as one comparable shape — so "did anything actually change" is honest. */
function partyShape(e: {
  adultCount: number | null;
  childCount: number | null;
  childAges: number[];
  numberOfRooms: number | null;
  bedTypeRequest: PrismaNS.JsonValue | null;
}) {
  return JSON.stringify({
    a: e.adultCount ?? null,
    c: e.childCount ?? null,
    ages: [...(e.childAges ?? [])].sort((x, y) => x - y),
    rooms: e.numberOfRooms ?? null,
    beds: e.bedTypeRequest ?? null,
  });
}

/** "6 adults → 4 · 3 rooms → 1 (204, 305 dropped)" — the line the amendment record carries. */
function describeChange(
  before: { adults: number | null; children: number | null; rooms: number | null; roomIds: string[] },
  after: { adults: number | null; children: number | null; rooms: number | null; roomIds: string[] },
  roomNo: (id: string) => string,
): string {
  const parts: string[] = [];
  if (before.adults !== after.adults) parts.push(`${before.adults ?? 0} adults → ${after.adults ?? 0}`);
  if (before.children !== after.children) parts.push(`${before.children ?? 0} children → ${after.children ?? 0}`);
  if (before.rooms !== after.rooms) parts.push(`${before.rooms ?? 0} rooms asked → ${after.rooms ?? 0}`);
  const dropped = before.roomIds.filter((id) => !after.roomIds.includes(id));
  const added = after.roomIds.filter((id) => !before.roomIds.includes(id));
  if (dropped.length > 0) parts.push(`dropped ${dropped.map(roomNo).join(", ")}`);
  if (added.length > 0) parts.push(`added ${added.map(roomNo).join(", ")}`);
  return parts.length > 0 ? parts.join(" · ") : "no change";
}

export async function amendNegotiationConfiguration(
  prisma: PrismaClient,
  entryId: string,
  actor: NegotiationAmendmentActor,
  input: NegotiationAmendmentInput,
  /** Set only by `decideNegotiationAmendmentRequest` — an approval never re-queues itself. */
  opts?: { applyingRequestId?: string },
): Promise<NegotiationAmendmentOutcome> {
  if (!input?.reason?.trim()) throw new ValidationError("A reason is required to change the configuration.");
  if (!input.party && !input.rooms) {
    throw new ValidationError("Nothing to change — send the party, the rooms, or both.");
  }

  const entry = await prisma.entry.findUnique({
    where: { id: entryId },
    include: {
      segments: { orderBy: { segmentNumber: "desc" }, take: 1 },
      availabilityConfigs: { orderBy: { createdAt: "desc" }, take: 25 },
      speculativeHolds: { orderBy: { placedAt: "desc" }, take: 25 },
    },
  });
  if (!entry) throw new NotFoundError("Entry");

  // ---- gates, all before anything is written -------------------------------------
  enforceEntryAtS2ForNegotiationAmendment({ currentStage: entry.currentStage, status: entry.status });
  if (input.expectedVersion != null && entry.version !== input.expectedVersion) {
    throw new ValidationError("This booking changed on another screen — reload it and try again.");
  }
  const segmentId = entry.segments[0]?.id ?? null;
  if (!segmentId) throw new ValidationError("Entry has no segment");

  // The seeded mode is load-bearing: deactivating GUEST_COMPOSITION_CHANGE disables this act,
  // exactly as deactivating a mode disables its backflow.
  await requireActiveMode(prisma, "GUEST_COMPOSITION_CHANGE");

  /**
   * Authority follows what MOVED, not the stage (the p58 doctrine). Nothing sent and nothing
   * accepted is the same act as the first pick, one conversation later — L1. Once the guest
   * holds a paper this makes untrue, it is the FOM's call; once they have ACCEPTED it, the
   * terms they agreed to are being changed under them, so the change is flagged up to the FOM
   * or the GM rather than taken silently at the desk (operator, 2026-09-30).
   */
  const passQuotations = await prisma.quotation.findMany({
    where: { entryId, segmentId },
    orderBy: { createdAt: "desc" },
  });
  const live = passQuotations.filter(
    (q) => q.state === QuotationState.DRAFT || q.state === QuotationState.SENT || q.state === QuotationState.ACCEPTED,
  );
  /**
   * May this operator apply the change themselves, or must it wait for the FOM? The gate throws
   * the sentence the desk shows; here it is CAUGHT, because the operator's ruling was that an
   * L1 should be able to PREPARE the change and have it flagged up, not be sent away. Nothing
   * is written on the waiting path — the proposal is stored and the booking is untouched.
   */
  const quotationSent = live.some((q) => q.state === QuotationState.SENT);
  const quotationAccepted = live.some((q) => q.state === QuotationState.ACCEPTED);
  let mayApply = true;
  let whyNot: string | null = null;
  try {
    enforceNegotiationAmendmentAuthority({ actorLevel: actor.actorLevel, quotationSent, quotationAccepted });
  } catch (e) {
    mayApply = false;
    whyNot = (e as Error).message;
  }
  // An approval re-runs this function as the approver, and the approver always may.
  if (!mayApply && !opts?.applyingRequestId) {
    return raiseNegotiationAmendmentRequest(prisma, entry, segmentId, actor, input, {
      priorRoomIds: readOptionSelected(
        (entry.availabilityConfigs.find((c) => c.sealedAt && c.optionSelected) ?? null)?.optionSelected,
      ).distinctRoomIds,
      whyNot: whyNot ?? "This change needs the FOM.",
    });
  }

  const sealedBefore = entry.availabilityConfigs.find((c) => c.sealedAt && c.optionSelected) ?? null;
  const priorRoomIds = readOptionSelected(sealedBefore?.optionSelected).distinctRoomIds;
  const before = {
    adults: entry.adultCount,
    children: entry.childCount,
    rooms: entry.numberOfRooms,
    roomIds: priorRoomIds,
    shape: partyShape(entry),
  };

  // The configuration named must belong to this booking, and to this pass — a sealed config of
  // an earlier segment is commercial history and is never re-sealed (the same rule
  // `recallConfiguration` enforces).
  if (input.rooms) {
    const cfg = await prisma.availabilityConfiguration.findUnique({ where: { id: input.rooms.configurationId } });
    if (!cfg || cfg.entryId !== entryId) throw new NotFoundError("AvailabilityConfiguration");
    if (cfg.segmentId && cfg.segmentId !== segmentId) {
      throw new ValidationError("That search belongs to an earlier pass — ask the house again before saving rooms.");
    }
  }

  // ---- apply -----------------------------------------------------------------------
  // The party first: its validation (capacity, the hotel's ceiling, unaccompanied minors, the
  // adult-to-child ratio, the bed-setup ask against the room count in BOTH directions, and the
  // Policy 64 re-classification) all runs before its own transaction, so a refusal here writes
  // nothing at all.
  let partyChanged = false;
  if (input.party) {
    const updated = await updateEntryIntakeFields(
      prisma,
      entryId,
      actor.actorId,
      actor.actorLevel,
      { ...input.party },
      { allowAtNegotiation: true },
    );
    partyChanged = partyShape(updated) !== before.shape;
  }

  let roomsChanged = false;
  let newRoomIds = priorRoomIds;
  if (input.rooms) {
    const { configurationId, ...picks } = input.rooms;
    const sealed = await selectOption(prisma, configurationId, actor.actorId, picks);
    newRoomIds = readOptionSelected(sealed.optionSelected).distinctRoomIds;
    const sameSet =
      newRoomIds.length === priorRoomIds.length && newRoomIds.every((id) => priorRoomIds.includes(id));
    roomsChanged = !sameSet;
  }

  if (!partyChanged && !roomsChanged) {
    throw new ValidationError("Nothing changed — the party and the rooms are as they were.");
  }

  // ---- consequences ----------------------------------------------------------------
  const rooms = await prisma.room.findMany({
    where: { id: { in: [...new Set([...priorRoomIds, ...newRoomIds])] } },
    select: { id: true, roomNumber: true },
  });
  const roomNo = (id: string) => rooms.find((r) => r.id === id)?.roomNumber ?? id.slice(0, 6);

  /**
   * A quotation priced a party and a room plan that no longer stand, so it is no longer an
   * offer — leaving it live would let the booking reach Set up on a quote for guests who are
   * not coming. Every live version of THIS pass is retired; earlier passes are untouched.
   *
   * A version whose PDF was never rendered is frozen first (the 2026-08-02 ruling: a retired
   * version must keep the figures that were on the table, not recompose today's).
   */
  const quotationsInvalidated: NegotiationAmendmentOutcome["quotationsInvalidated"] = [];
  if (live.length > 0) {
    const { generateOrLoadQuotationPdf } = await import("./quotation-pdf-service.js");
    for (const q of live) {
      if (!q.pdfStorageKey) {
        try {
          await generateOrLoadQuotationPdf(prisma, q.id, actor.actorId);
        } catch {
          /* best effort — a render failure must not block the amendment */
        }
      }
    }
    const engine = await getTimerEngine();
    const now = new Date();
    await prisma.$transaction(async (tx) => {
      for (const q of live) {
        await tx.quotation.update({
          where: { id: q.id },
          data: { state: QuotationState.EXPIRED, expiredAt: now },
        });
        quotationsInvalidated.push({ id: q.id, referenceNumber: q.referenceNumber, priorState: q.state });
        await auditService.emit(tx as any, { actorId: actor.actorId, actorLevel: actor.actorLevel }, {
          eventType: "QUOTATION.RETIRED_BY_CONFIGURATION_CHANGE",
          entityType: "Quotation",
          entityId: q.id,
          operation: "UPDATE",
          timestamp: now,
          stageContext: Stage.S2,
          inquiryId: entry.inquiryId,
          entryId,
          payload: { priorState: q.state, reason: input.reason.trim(), referenceNumber: q.referenceNumber },
          createdBy: actor.actorId,
        });
      }
      // The validity clock belongs to an offer that no longer exists.
      const timers = await tx.timerRecord.findMany({
        where: { entryId, timerType: "QUOTATION_VALIDITY_W15", status: "SCHEDULED" },
      });
      for (const t of timers) {
        if (t.pgBossJobId) await engine.cancel(t.pgBossJobId).catch(() => undefined);
        await tx.timerRecord.update({ where: { id: t.id }, data: { status: "CANCELLED", cancelledAt: now } });
      }
    });
  }

  /**
   * The provisional block snapshots the seal it was placed on, so a changed room set leaves it
   * describing rooms that are no longer the plan — one still marked and unsellable, another in
   * the plan and unmarked. It is therefore re-placed over the NEW set, and deliberately keeps
   * its ORIGINAL expiry: the house granted the marker until that moment, and re-anchoring it
   * would quietly block another guest's rooms for longer than was agreed (operator ruling,
   * 2026-09-30). If the re-placement is refused — someone else took a newly picked room, or the
   * room count now needs a level this operator does not hold — the release still stands and the
   * outcome says so, rather than leaving a marker that names the wrong rooms.
   */
  let hold: NegotiationAmendmentOutcome["hold"] = null;
  const activeHold = entry.speculativeHolds.find(
    (h) => h.segmentId === segmentId && (h.state === "PLACED" || h.state === "UPGRADED"),
  );
  if (roomsChanged && activeHold) {
    // The rooms are already re-sealed by this point, so nothing here may throw: a marker problem
    // must be REPORTED, not turned into a failure that hides a change which has happened.
    try {
      await releaseSpeculativeHold(prisma, entryId, activeHold.id, actor, {
        releaseReason: `Rooms changed at Negotiation — ${input.reason.trim()}`,
        internalReMark: true,
      });
      const anchor = newRoomIds[0] ?? null;
      const secondsLeft = Math.floor((activeHold.expiresAt.getTime() - Date.now()) / 1000);
      if (anchor && secondsLeft > 0) {
        try {
          // `placeSpeculativeHold` returns the hold row itself.
          const placed = await placeSpeculativeHold(prisma, entryId, actor, {
            roomId: anchor,
            ttlSeconds: secondsLeft,
            commercialBasis: activeHold.notes ?? `Re-marked after a configuration change — ${input.reason.trim()}`,
            notes: "Re-placed over the new rooms; the original deadline stands.",
          });
          hold = {
            action: "REPLACED",
            priorHoldId: activeHold.id,
            holdId: placed.id,
            expiresAt: (placed.expiresAt ?? activeHold.expiresAt).toISOString(),
          };
        } catch (e) {
          hold = {
            action: "RELEASED",
            priorHoldId: activeHold.id,
            note: `The rooms could not be marked again — ${(e as Error).message}. Place the provisional block again when you are ready.`,
          };
        }
      } else {
        hold = {
          action: "RELEASED",
          priorHoldId: activeHold.id,
          note: secondsLeft > 0 ? "No room left to mark." : "The marker had already run out.",
        };
      }
    } catch (e) {
      hold = {
        action: "RELEASED",
        priorHoldId: activeHold.id,
        note: `The old marker could not be lifted — ${(e as Error).message}. Release it and mark the new rooms by hand.`,
      };
    }
  }

  // ---- the record ------------------------------------------------------------------
  const after = await prisma.entry.findUnique({ where: { id: entryId } });
  const summary = describeChange(
    { adults: before.adults, children: before.children, rooms: before.rooms, roomIds: priorRoomIds },
    {
      adults: after?.adultCount ?? before.adults,
      children: after?.childCount ?? before.children,
      rooms: after?.numberOfRooms ?? before.rooms,
      roomIds: newRoomIds,
    },
    roomNo,
  );

  /**
   * `AmendmentEventRecord` is stage-agnostic, belongs to the pass, and already shows up in the
   * Segments drill-in — so the change has a home without a new table. PATH_1 is the plain
   * operator-initiated amendment path.
   */
  let amendmentId: string | null = null;
  try {
    const rec = await createAmendmentEvent(prisma, actor.actorId, {
      entryId,
      segmentId,
      amendmentPath: "PATH_1",
      amendmentType: "NEGOTIATION_CONFIGURATION_CHANGE",
      requestedBy: actor.actorId,
      authorisedBy: actor.actorId,
      authorityBasis: `GUEST_COMPOSITION_CHANGE · ${actor.actorLevel}`,
      reason: input.reason.trim(),
      newTermsSummary: summary,
      priorTermsRef: quotationsInvalidated[0]?.referenceNumber,
      stageAtAmendment: Stage.S2,
    });
    amendmentId = rec.id;
  } catch {
    /* the amendment record is evidence, not a gate — never fail the change over it */
  }

  await auditService.emit(prisma as any, { actorId: actor.actorId, actorLevel: actor.actorLevel }, {
    eventType: "ENTRY.NEGOTIATION_CONFIGURATION_AMENDED",
    entityType: "Entry",
    entityId: entryId,
    operation: "UPDATE",
    timestamp: new Date(),
    stageContext: Stage.S2,
    inquiryId: entry.inquiryId,
    entryId,
    payload: {
      reason: input.reason.trim(),
      summary,
      partyChanged,
      roomsChanged,
      before: { adults: before.adults, children: before.children, rooms: before.rooms, roomIds: priorRoomIds },
      after: {
        adults: after?.adultCount ?? null,
        children: after?.childCount ?? null,
        rooms: after?.numberOfRooms ?? null,
        roomIds: newRoomIds,
      },
      quotationsInvalidated: quotationsInvalidated.map((q) => q.referenceNumber),
      hold,
      amendmentId,
    },
    createdBy: actor.actorId,
  });

  if (opts?.applyingRequestId) {
    await prisma.negotiationAmendmentRequest.update({
      where: { id: opts.applyingRequestId },
      data: { appliedAmendmentId: amendmentId },
    });
  }

  return {
    applied: true,
    entryId,
    amendmentId,
    partyChanged,
    roomsChanged,
    priorRoomIds,
    newRoomIds,
    quotationsInvalidated,
    hold,
    summary,
  };
}

/* ==================================================================================
 * The waiting half — a change PREPARED by someone who may not apply it (2026-09-30).
 * ================================================================================== */

/**
 * Store the proposal and stop. Nothing on the booking moves: the rooms are not re-sealed, the
 * party is not written, no quotation is retired. Approval re-runs the whole act with every gate,
 * so a room taken in the meantime is refused THEN, with its real reason — which is exactly why
 * the proposal is stored rather than half-applied.
 */
async function raiseNegotiationAmendmentRequest(
  prisma: PrismaClient,
  entry: { id: string; inquiryId: string; adultCount: number | null; childCount: number | null; numberOfRooms: number | null },
  segmentId: string,
  actor: NegotiationAmendmentActor,
  input: NegotiationAmendmentInput,
  ctx: { priorRoomIds: string[]; whyNot: string },
): Promise<NegotiationAmendmentOutcome> {
  const open = await prisma.negotiationAmendmentRequest.findFirst({
    where: { entryId: entry.id, state: "REQUESTED" },
  });
  if (open) {
    throw new ValidationError(
      "A change is already waiting for the FOM on this booking — it has to be decided before another is raised.",
    );
  }

  /**
   * The summary is written HERE, from the numbers as they stand, because by the time the FOM
   * reads it the booking may have moved on; the approver should see what was asked for, and the
   * re-run is what checks whether it still holds.
   */
  const rooms = input.rooms
    ? await prisma.room.findMany({ where: { id: { in: proposedRoomIds(input.rooms) } }, select: { id: true, roomNumber: true } })
    : [];
  const priorRooms = await prisma.room.findMany({
    where: { id: { in: ctx.priorRoomIds } },
    select: { id: true, roomNumber: true },
  });
  const roomNo = (id: string) =>
    rooms.find((r) => r.id === id)?.roomNumber ?? priorRooms.find((r) => r.id === id)?.roomNumber ?? id.slice(0, 6);
  const summary = describeChange(
    {
      adults: entry.adultCount,
      children: entry.childCount,
      rooms: entry.numberOfRooms,
      roomIds: ctx.priorRoomIds,
    },
    {
      adults: input.party?.adultCount ?? entry.adultCount,
      children: input.party?.childCount ?? entry.childCount,
      rooms: input.party?.numberOfRooms ?? entry.numberOfRooms,
      roomIds: input.rooms ? proposedRoomIds(input.rooms) : ctx.priorRoomIds,
    },
    roomNo,
  );

  const req = await prisma.negotiationAmendmentRequest.create({
    data: {
      entryId: entry.id,
      segmentId,
      proposal: input as unknown as PrismaNS.InputJsonValue,
      summary,
      reason: input.reason.trim(),
      requestedBy: actor.actorId,
    },
  });

  await auditService.emit(prisma as any, { actorId: actor.actorId, actorLevel: actor.actorLevel }, {
    eventType: "ENTRY.NEGOTIATION_AMENDMENT_REQUESTED",
    entityType: "Entry",
    entityId: entry.id,
    operation: "CREATE",
    timestamp: new Date(),
    stageContext: Stage.S2,
    inquiryId: entry.inquiryId,
    entryId: entry.id,
    payload: { requestId: req.id, summary, reason: input.reason.trim(), because: ctx.whyNot },
    createdBy: actor.actorId,
  });

  return {
    applied: false,
    requestId: req.id,
    entryId: entry.id,
    amendmentId: null,
    partyChanged: false,
    roomsChanged: false,
    priorRoomIds: ctx.priorRoomIds,
    newRoomIds: ctx.priorRoomIds,
    quotationsInvalidated: [],
    hold: null,
    summary,
  };
}

/** The rooms a proposal names, in the three shapes the save accepts. */
function proposedRoomIds(rooms: NonNullable<NegotiationAmendmentInput["rooms"]>): string[] {
  if (rooms.perNight?.length) return [...new Set(rooms.perNight.flatMap((n) => n.roomIds))];
  if (rooms.roomIds?.length) return [...new Set(rooms.roomIds)];
  return rooms.roomId ? [rooms.roomId] : [];
}

/**
 * Approve (which APPLIES it), or turn it down. There is no approved-but-unapplied state: an
 * approval that did not take effect would be a promise the booking does not keep, and the whole
 * point of re-running the act is that its gates get the last word.
 */
export async function decideNegotiationAmendmentRequest(
  prisma: PrismaClient,
  entryId: string,
  requestId: string,
  actor: NegotiationAmendmentActor,
  input: { decision: "APPROVE" | "REJECT"; note?: string },
): Promise<{ state: string; outcome?: NegotiationAmendmentOutcome }> {
  const req = await prisma.negotiationAmendmentRequest.findUnique({ where: { id: requestId } });
  if (!req || req.entryId !== entryId) throw new NotFoundError("NegotiationAmendmentRequest");
  if (req.state !== "REQUESTED") {
    throw new ValidationError(`This change was already ${req.state.toLowerCase()} — nothing left to decide.`);
  }
  if (input.decision === "REJECT" && !input.note?.trim()) {
    throw new ValidationError("Say why it is turned down — the desk sees the note.");
  }

  const entry = await prisma.entry.findUnique({ where: { id: entryId }, include: { segments: { orderBy: { segmentNumber: "desc" }, take: 1 } } });
  if (!entry) throw new NotFoundError("Entry");

  /**
   * A proposal describes the pass it was raised in. A re-entry opens a new one and the rooms it
   * names belong to sealed history, so the request is retired rather than applied to a booking
   * it no longer describes.
   */
  if ((entry.segments[0]?.id ?? null) !== req.segmentId) {
    await prisma.negotiationAmendmentRequest.update({
      where: { id: requestId },
      data: { state: "SUPERSEDED", decidedBy: actor.actorId, decidedAt: new Date(), decisionNote: "The booking started a new pass." },
    });
    throw new ValidationError("The booking has started a new pass since this was raised — ask for the change again.");
  }

  if (input.decision === "REJECT") {
    const updated = await prisma.negotiationAmendmentRequest.update({
      where: { id: requestId },
      data: { state: "REJECTED", decidedBy: actor.actorId, decidedAt: new Date(), decisionNote: input.note!.trim() },
    });
    await auditService.emit(prisma as any, { actorId: actor.actorId, actorLevel: actor.actorLevel }, {
      eventType: "ENTRY.NEGOTIATION_AMENDMENT_REJECTED",
      entityType: "Entry",
      entityId: entryId,
      operation: "UPDATE",
      timestamp: new Date(),
      stageContext: Stage.S2,
      inquiryId: entry.inquiryId,
      entryId,
      payload: { requestId, summary: req.summary, note: input.note!.trim() },
      createdBy: actor.actorId,
    });
    return { state: updated.state };
  }

  // Approving IS applying — every gate runs again, as the approver.
  const proposal = req.proposal as unknown as NegotiationAmendmentInput;
  const outcome = await amendNegotiationConfiguration(
    prisma,
    entryId,
    actor,
    { ...proposal, expectedVersion: undefined },
    { applyingRequestId: requestId },
  );
  const updated = await prisma.negotiationAmendmentRequest.update({
    where: { id: requestId },
    data: {
      state: "APPROVED",
      decidedBy: actor.actorId,
      decidedAt: new Date(),
      decisionNote: input.note?.trim() || null,
    },
  });
  await auditService.emit(prisma as any, { actorId: actor.actorId, actorLevel: actor.actorLevel }, {
    eventType: "ENTRY.NEGOTIATION_AMENDMENT_APPROVED",
    entityType: "Entry",
    entityId: entryId,
    operation: "UPDATE",
    timestamp: new Date(),
    stageContext: Stage.S2,
    inquiryId: entry.inquiryId,
    entryId,
    payload: { requestId, summary: outcome.summary, requestedBy: req.requestedBy },
    createdBy: actor.actorId,
  });
  return { state: updated.state, outcome };
}

/** Taken back by the desk before anyone decided — the raiser changed their mind, or the guest did. */
export async function withdrawNegotiationAmendmentRequest(
  prisma: PrismaClient,
  entryId: string,
  requestId: string,
  actor: NegotiationAmendmentActor,
  input: { note?: string },
) {
  const req = await prisma.negotiationAmendmentRequest.findUnique({ where: { id: requestId } });
  if (!req || req.entryId !== entryId) throw new NotFoundError("NegotiationAmendmentRequest");
  if (req.state !== "REQUESTED") {
    throw new ValidationError(`This change was already ${req.state.toLowerCase()} — there is nothing to take back.`);
  }
  const updated = await prisma.negotiationAmendmentRequest.update({
    where: { id: requestId },
    data: { state: "WITHDRAWN", decidedBy: actor.actorId, decidedAt: new Date(), decisionNote: input.note?.trim() || null },
  });
  const entry = await prisma.entry.findUnique({ where: { id: entryId }, select: { inquiryId: true } });
  await auditService.emit(prisma as any, { actorId: actor.actorId, actorLevel: actor.actorLevel }, {
    eventType: "ENTRY.NEGOTIATION_AMENDMENT_WITHDRAWN",
    entityType: "Entry",
    entityId: entryId,
    operation: "UPDATE",
    timestamp: new Date(),
    stageContext: Stage.S2,
    inquiryId: entry?.inquiryId ?? "",
    entryId,
    payload: { requestId, summary: req.summary },
    createdBy: actor.actorId,
  });
  return { state: updated.state };
}
