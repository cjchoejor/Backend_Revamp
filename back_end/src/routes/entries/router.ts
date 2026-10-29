import { Router } from "express";
import { prisma } from "../../db.js";
import {
  addReturnStayRequestSchema,
  closeEntryRequestSchema,
  createEntryRequestSchema,
  listEntriesQuerySchema,
  parkEntryRequestSchema,
  switchStayRequestSchema,
  patchApartmentContextRequestSchema,
  reassignEntryCustodianRequestSchema,
  recordKeyReturnRequestSchema,
  recordRoomInspectionRequestSchema,
  recordRoomInspectionsBulkRequestSchema,
  answerDamageRequestSchema,
  previewDamageChargeRequestSchema,
  setExpectedArrivalRequestSchema,
  checkInPaymentDeferralRequestSchema,
  checkInPaymentDecisionRequestSchema,
  checkInPaymentWithdrawRequestSchema,
  decideNegotiationAmendmentRequestSchema,
  negotiationAmendmentRequestSchema,
  changeStayInPlaceRequestSchema,
  updateEntryRequestSchema,
  withdrawNegotiationAmendmentRequestSchema,
} from "../../dtos/03-entries/request-schemas.js";
import { requireActorLevel } from "../../middleware/auth.js";
import { validateBody } from "../../middleware/validate-body.js";
import { NotFoundError, ValidationError } from "../../lib/errors.js";
import * as s1EntryService from "../../services/domain/s1-entry-service.js";
import { switchStay } from "../../services/domain/trip-switch-service.js";
import { changeBookingInPlace } from "../../services/domain/booking-change-service.js";
import * as s8CheckoutService from "../../services/domain/s8-checkout-service.js";
import * as damageAssessmentService from "../../services/domain/damage-assessment-service.js";
import * as s9Service from "../../services/domain/s9-service.js";
import { setGroupBillingModeManually } from "../../services/admin/group-billing-mode-admin-service.js";
import {
  amendNegotiationConfiguration,
  decideNegotiationAmendmentRequest,
  withdrawNegotiationAmendmentRequest,
} from "../../services/domain/negotiation-amendment-service.js";
import { z } from "zod";
import { entryDetailInclude } from "../../lib/entry-detail-include.js";
import { addReturnStay } from "../../services/domain/return-stay-service.js";
import { setEntryGuest, updateEntryCaller, updateEntrySource } from "../../services/domain/inquiry-caller-service.js";
import { CAME_IN_AS_VALUES } from "../../lib/inquiry-came-in-as.js";
import { callerRequestSchema } from "../../dtos/02-inquiries/request-schemas.js";
import { runPostCheckoutInspectionWorker } from "../../workers/w9-post-checkout-inspection-worker.js";
import { describeBookingInspections, roomListWords } from "../../lib/room-inspection-standing.js";
import { getEntryTrace } from "../../services/infrastructure/trace-query-service.js";
import { buildBookingJourneySummary } from "../../services/domain/booking-journey-summary-service.js";
import { buildEntryBillingSummary } from "../../services/domain/entry-billing-summary-service.js";
import { buildSegmentHistory } from "../../services/domain/segment-history-service.js";
import { recallSegmentConfiguration, duplicateSegmentIntoNew } from "../../services/domain/segment-recall-service.js";
import { listEntryCommunications } from "../../services/domain/communication-acknowledgement-service.js";
import { buildEntryRateReference } from "../../services/domain/rate-reference-service.js";
import { previewEarlyDeparture, recordEarlyDeparture } from "../../services/domain/early-departure-service.js";
import { buildQuotationPreview } from "../../services/domain/quotation-preview-service.js";
import { buildCompetingClaims } from "../../services/domain/competing-claims-service.js";
import { changeRoomToNewSegment, listRoomChangeCandidates, buildRoomPlanHistory } from "../../services/domain/room-change-service.js";
import { makeWayForRoom } from "../../services/domain/quiet-rooms-service.js";
import { issueRoomKey, issueRoomKeysBulk, returnRoomKey } from "../../services/domain/room-key-service.js";
import {
  partySeatingRepairRequestSchema,
  roomChangeRequestSchema,
  stayExtensionCommitRequestSchema,
  stayExtensionPreviewRequestSchema,
  stayExtensionRequestSchema,
  earlyDeparturePreviewRequestSchema,
  earlyDepartureRequestSchema,
} from "../../dtos/06-reservations/request-schemas.js";
import {
  commitStayExtension,
  listStayExtensions,
  previewStayExtension,
  requestStayExtension,
  withdrawStayExtension,
} from "../../services/domain/stay-extension-service.js";
import { buildPartySeatingStatus, repairPartySeatingForEntry } from "../../services/domain/party-seating-service.js";
import { getExpectedArrival, setExpectedArrival } from "../../services/domain/expected-arrival-service.js";
import { resolveNoShowGraceMinutes, timerShowsFrom } from "../../lib/expected-arrival.js";
import { buildEntryBedPlan, setEntryBedPlanRoom } from "../../services/domain/entry-bed-plan-service.js";

export const entriesRouter = Router();

/**
 * The bed setup each of the booking's rooms is to be made up as (2026-10-06).
 *
 * A read says, per room, what this stay wants, where that came from — the desk said so, it was
 * shared out from the guest's ask at intake, or it is the room's usual setup — what the room is
 * made up as right now, and whether a choice takes effect immediately (from Arrival, once the
 * room is assigned) or is only recorded for later.
 */
/**
 * The caller and the guest staying (2026-10-12). L1 — the desk on the phone. The caller's details
 * can be filled in or corrected while the booking is live; the guest staying is named at Inquiry.
 */
entriesRouter.post("/:id/caller", requireActorLevel("L1"), validateBody(callerRequestSchema), async (req, res, next) => {
  try {
    res.json(await updateEntryCaller(prisma, { actorId: req.actor!.actorId, level: req.actor!.level }, req.params.id, req.body));
  } catch (e) {
    next(e);
  }
});

/** Who is asking, changed at Inquiry (2026-10-12) — channel, party, package, a company's reference. */
const sourceSchema = z
  .object({
    cameInAs: z.enum(CAME_IN_AS_VALUES).nullable().optional(),
    sourceChannel: z.string().min(1).nullable().optional(),
    travelAgentId: z.string().min(1).nullable().optional(),
    corporateAccountId: z.string().min(1).nullable().optional(),
    ratePackageId: z.string().min(1).nullable().optional(),
    corporateClientRef: z.string().trim().max(200).nullable().optional(),
    corporateCoordinator: z.string().trim().max(200).nullable().optional(),
  })
  .refine((v) => !!(v.cameInAs || v.sourceChannel), { message: "Say how the booking came in", path: ["cameInAs"] })
  .refine((v) => !(v.travelAgentId && v.corporateAccountId), { message: "A travel agent OR a company, not both", path: ["travelAgentId"] });

entriesRouter.post("/:id/source", requireActorLevel("L1"), validateBody(sourceSchema), async (req, res, next) => {
  try {
    res.json(await updateEntrySource(prisma, { actorId: req.actor!.actorId, level: req.actor!.level }, req.params.id, req.body));
  } catch (e) {
    next(e);
  }
});

const guestNamingOptions = { keepNewName: z.boolean().optional(), arrivingIsGuest: z.boolean().optional() };
const setGuestSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("CALLER"), nationality: z.string().trim().max(80).nullable().optional(), ...guestNamingOptions }),
  z.object({
    mode: z.literal("EXISTING"),
    guestProfileId: z.string().min(1),
    phone: z.string().trim().max(40).nullable().optional(),
    email: z.string().trim().max(200).nullable().optional(),
    ...guestNamingOptions,
  }),
  z.object({
    mode: z.literal("NEW"),
    ...guestNamingOptions,
    title: z.string().trim().max(20).nullable().optional(),
    firstName: z.string().trim().min(1).max(80),
    lastName: z.string().trim().min(1).max(80),
    nationality: z.string().trim().max(80).nullable().optional(),
    phone: z.string().trim().max(40).nullable().optional(),
    email: z.string().trim().max(200).nullable().optional(),
  }),
]);

entriesRouter.post("/:id/guest", requireActorLevel("L1"), validateBody(setGuestSchema), async (req, res, next) => {
  try {
    res.json(await setEntryGuest(prisma, { actorId: req.actor!.actorId, level: req.actor!.level }, req.params.id, req.body));
  } catch (e) {
    next(e);
  }
});

entriesRouter.get("/:id/bed-plan", requireActorLevel("L1"), async (req, res, next) => {
  try {
    res.json(await buildEntryBedPlan(prisma, req.params.id));
  } catch (e) {
    next(e);
  }
});

/**
 * Say what one room is to be made up as. L1: a bed setup is desk work, priced nowhere — the
 * EXTRA bed is the charged one and lives on the composition. `bedType: null` hands the room back
 * to the guest's ask, or to its usual setup when there was none.
 */
entriesRouter.post("/:id/bed-plan", requireActorLevel("L1"), async (req, res, next) => {
  try {
    const bedType = req.body?.bedType;
    res.json(
      await setEntryBedPlanRoom(
        prisma,
        req.params.id,
        { roomId: String(req.body?.roomId ?? ""), bedType: bedType == null || bedType === "" ? null : String(bedType) },
        { actorId: req.actor!.actorId, actorLevel: req.actor!.level as "L1" | "L2" | "L3" | "L4" },
      ),
    );
  } catch (e) {
    next(e);
  }
});

/**
 * In-place room change (2026-08-12, operator ruling) — candidates lookup. EVERY registered
 * room outside the booking, each with its S1-style standing over the claimed nights (free /
 * reserved / held / blocked / maintenance — 2026-08-13); only FREE rooms are selectable. L1+
 * to look; the change itself enforces authority by kind (same-type L1+, cross-type L2+).
 */
entriesRouter.get("/:id/room-change/candidates", requireActorLevel("L1"), async (req, res, next) => {
  try {
    const fromRoomId = typeof req.query.fromRoomId === "string" ? req.query.fromRoomId : "";
    if (!fromRoomId) throw new ValidationError("fromRoomId query parameter is required");
    res.json(await listRoomChangeCandidates(prisma, req.params.id, fromRoomId));
  } catch (e) {
    next(e);
  }
});

/**
 * The room types one of the booking's rooms could change to (2026-10-29) — "double-click a room to
 * change its room type": how many of each are free over the room's nights, the room the system would
 * give, the rate per night. Read-only; the change itself is the room change below.
 */
entriesRouter.get("/:id/room-type-options", requireActorLevel("L1"), async (req, res, next) => {
  try {
    res.setHeader("Cache-Control", "no-store");
    const fromRoomId = typeof req.query.fromRoomId === "string" ? req.query.fromRoomId : "";
    if (!fromRoomId) throw new ValidationError("fromRoomId query parameter is required");
    const { listRoomTypeOptions } = await import("../../services/domain/room-type-options-service.js");
    res.json(await listRoomTypeOptions(prisma, req.params.id, fromRoomId));
  } catch (e) {
    next(e);
  }
});

/**
 * In-place room change — the composite. One call: governed ROOM_CHANGE re-entry (new segment),
 * substituted basis revalidated against live availability, silent re-quote (nothing sent to the
 * guest; PI not re-issued; the advance already received stands), then the walk back to the
 * origin stage server-side. Partial-outcome contract: if a later step blocks, the response's
 * `walk.blocked` names the step — the new segment is real and the desk finishes normally.
 */
entriesRouter.post("/:id/room-change", requireActorLevel("L1"), validateBody(roomChangeRequestSchema), async (req, res, next) => {
  try {
    const actor = { actorId: req.actor!.actorId, actorLevel: req.actor!.level as "L1" | "L2" | "L3" | "L4" };
    // Arrival takes the room (2026-10-29): another booking holding it only as the system's choice is
    // moved to another room of its type first — a quiet move, the same type and rate — so the room
    // change finds it free. Refused in words when that booking chose it by number.
    let madeWay: Awaited<ReturnType<typeof makeWayForRoom>> | null = null;
    if (req.body.makeWay === true && req.body.toRoomId) {
      madeWay = await makeWayForRoom(prisma, actor, { entryId: req.params.id, fromRoomId: req.body.fromRoomId, toRoomId: req.body.toRoomId });
    } else if (req.body.makeWay === true && req.body.perNight?.length) {
      // A room for some nights only: each new room makes way over its own nights.
      const byRoom = new Map<string, string[]>();
      for (const n of req.body.perNight as Array<{ date: string; roomId: string }>) {
        if (n.roomId === req.body.fromRoomId) continue;
        byRoom.set(n.roomId, [...(byRoom.get(n.roomId) ?? []), n.date.slice(0, 10)]);
      }
      let othersMoved = 0;
      const moves: Awaited<ReturnType<typeof makeWayForRoom>>["moves"] = [];
      for (const [toRoomId, nights] of byRoom) {
        const one = await makeWayForRoom(prisma, actor, { entryId: req.params.id, fromRoomId: req.body.fromRoomId, toRoomId, nights });
        othersMoved += one.othersMoved;
        moves.push(...one.moves);
      }
      madeWay = { othersMoved, moves };
    }
    const outcome = await changeRoomToNewSegment(prisma, actor, {
      entryId: req.params.id,
      fromRoomId: req.body.fromRoomId,
      toRoomId: req.body.toRoomId,
      perNight: req.body.perNight,
      reason: req.body.reason,
      systemChosen: req.body.systemChosen === true,
      adjustments: req.body.adjustments,
      roomSetups: req.body.roomSetups,
      roomCompositions: req.body.roomCompositions,
      ...("requestedDiscount" in (req.body ?? {}) ? { requestedDiscount: req.body.requestedDiscount } : {}),
    });
    res.json(madeWay ? { ...outcome, madeWay } : outcome);
  } catch (e) {
    next(e);
  }
});

/**
 * Stay extension (2026-08-21, operator ruling). Preview (no writes): the current rooms'
 * standing over the extra nights, alternatives, the projected price, the interim figures.
 * Request (FOM): claims the extra nights, mints the interim invoice, arms the hold clock.
 * Commit (FOM, only once the interim payment is in): the governed journey — new segment,
 * silent re-quote over the extended stay, re-freeze with the new checkout, back at S7.
 */
/**
 * Early departure (2026-08-22, SIG-S8 section 1.2 / Policy 36): a guest leaving before the booked
 * checkout. Preview (L1): the figures against the commitment snapshot, the fee the configured rule
 * yields, the slept nights still needing their audit, and every blocker - nothing written. Record
 * (L3, GM): shortens the stay, posts or waives the fee, releases the unstayed nights and compresses
 * into S8; the outcome says honestly whether the move happened.
 */
entriesRouter.post("/:id/early-departure/preview", requireActorLevel("L1"), validateBody(earlyDeparturePreviewRequestSchema), async (req, res, next) => {
  try {
    res.setHeader("Cache-Control", "no-store");
    res.json(await previewEarlyDeparture(prisma, req.params.id, { departureDate: req.body.departureDate ?? null }));
  } catch (e) {
    next(e);
  }
});

entriesRouter.post("/:id/early-departure", requireActorLevel("L3"), validateBody(earlyDepartureRequestSchema), async (req, res, next) => {
  try {
    const actor = { actorId: req.actor!.actorId, actorLevel: req.actor!.level as "L1" | "L2" | "L3" | "L4" };
    res.json(
      await recordEarlyDeparture(prisma, actor, req.params.id, {
        departureDate: req.body.departureDate ?? null,
        reason: req.body.reason,
        waiveFee: req.body.waiveFee === true,
        waiveReason: req.body.waiveReason ?? null,
      }),
    );
  } catch (e) {
    next(e);
  }
});

entriesRouter.post("/:id/stay-extension/preview", requireActorLevel("L1"), validateBody(stayExtensionPreviewRequestSchema), async (req, res, next) => {
  try {
    res.setHeader("Cache-Control", "no-store");
    const ask = req.body.askMode && req.body.askValue != null ? { mode: req.body.askMode, value: Number(req.body.askValue) } : null;
    res.json(
      await previewStayExtension(prisma, req.params.id, {
        newCheckOutDate: req.body.newCheckOutDate,
        perNight: req.body.perNight,
        replaceRoomId: req.body.replaceRoomId,
        roomCompositions: req.body.roomCompositions,
        ...("requestedDiscount" in (req.body ?? {}) ? { requestedDiscount: req.body.requestedDiscount } : {}),
        ask,
      }),
    );
  } catch (e) {
    next(e);
  }
});

entriesRouter.post("/:id/stay-extension", requireActorLevel("L2"), validateBody(stayExtensionRequestSchema), async (req, res, next) => {
  try {
    const actor = { actorId: req.actor!.actorId, actorLevel: req.actor!.level as "L1" | "L2" | "L3" | "L4" };
    res.json(
      await requestStayExtension(prisma, actor, req.params.id, {
        newCheckOutDate: req.body.newCheckOutDate,
        perNight: req.body.perNight,
        replaceRoomId: req.body.replaceRoomId,
        roomCompositions: req.body.roomCompositions,
        ...("requestedDiscount" in (req.body ?? {}) ? { requestedDiscount: req.body.requestedDiscount } : {}),
        reason: req.body.reason,
        ask: { mode: req.body.askMode, value: Number(req.body.askValue) },
        dueBy: req.body.dueBy ?? null,
        note: req.body.note,
      }),
    );
  } catch (e) {
    next(e);
  }
});

entriesRouter.get("/:id/stay-extensions", requireActorLevel("L1"), async (req, res, next) => {
  try {
    res.setHeader("Cache-Control", "no-store");
    res.json({ entryId: req.params.id, requests: await listStayExtensions(prisma, req.params.id) });
  } catch (e) {
    next(e);
  }
});

entriesRouter.post("/:id/stay-extensions/:requestId/commit", requireActorLevel("L2"), validateBody(stayExtensionCommitRequestSchema), async (req, res, next) => {
  try {
    const actor = { actorId: req.actor!.actorId, actorLevel: req.actor!.level as "L1" | "L2" | "L3" | "L4" };
    res.json(await commitStayExtension(prisma, actor, req.params.requestId, req.body?.reason ?? null));
  } catch (e) {
    next(e);
  }
});

entriesRouter.post("/:id/stay-extensions/:requestId/withdraw", requireActorLevel("L2"), validateBody(stayExtensionCommitRequestSchema), async (req, res, next) => {
  try {
    const actor = { actorId: req.actor!.actorId, actorLevel: req.actor!.level as "L1" | "L2" | "L3" | "L4" };
    res.json(await withdrawStayExtension(prisma, actor, req.params.requestId, req.body?.reason ?? null));
  } catch (e) {
    next(e);
  }
});

/**
 * Party seating (2026-08-21, operator ruling — "make sure no room is empty and everyone has a
 * room"): who sleeps where on the booking's current composition, who has NO room, which plan
 * rooms are empty, and whether a repair can run from here. Server-computed so both frontends
 * show the same truth. Pure read.
 */
entriesRouter.get("/:id/party-seating", requireActorLevel("L1"), async (req, res, next) => {
  try {
    res.setHeader("Cache-Control", "no-store");
    res.json(await buildPartySeatingStatus(prisma, req.params.id));
  } catch (e) {
    next(e);
  }
});

/**
 * Seat every guest and fill every empty room — the governed room-change journey in its
 * setup-only form (nobody moves; new segment, silent re-quote with everyone seated, re-freeze,
 * back to this stage). Refused, entry untouched, when there is nothing to repair. L1: seating
 * is desk logistics, not a commercial change.
 */
entriesRouter.post(
  "/:id/party-seating/repair",
  requireActorLevel("L1"),
  validateBody(partySeatingRepairRequestSchema),
  async (req, res, next) => {
    try {
      const actor = { actorId: req.actor!.actorId, actorLevel: req.actor!.level as "L1" | "L2" | "L3" | "L4" };
      res.json(await repairPartySeatingForEntry(prisma, actor, req.params.id, req.body?.reason ?? null));
    } catch (e) {
      next(e);
    }
  },
);

/**
 * Room-plan history (2026-08-13, operator request) — what was INITIALLY selected, per room of
 * the current plan: the first sealed selection followed through the room-change chain, plus
 * each initial room's bed setup as it stood at selection time. Pure read; drives the
 * "Initially" column on the S5–S7 room tables.
 */
entriesRouter.get("/:id/room-plan-history", requireActorLevel("L1"), async (req, res, next) => {
  try {
    res.json(await buildRoomPlanHistory(prisma, req.params.id));
  } catch (e) {
    next(e);
  }
});

/**
 * Per-room key lifecycle (2026-08-14, operator ruling): a key is issued on the day the guest
 * enters the room, and a sequential room change is a key SWAP — the new room's key is HARD
 * blocked (PRIOR_ROOM_KEY_OUTSTANDING) while the vacated room's key is still out. L1 desk acts.
 */
entriesRouter.post("/:id/rooms/:roomId/key-issued", requireActorLevel("L1"), async (req, res, next) => {
  try {
    res.json(await issueRoomKey(prisma, req.params.id, req.params.roomId, req.actor!.actorId));
  } catch (e) {
    next(e);
  }
});

/**
 * Hand over every key the guest can hold right now, in one act (2026-08-19, operator request).
 * Body `{ roomIds? }` — omitted means "the rooms in use today", which the service decides (S6:
 * arrival-night rooms; S7: rooms whose first night has arrived). Deliberately partial: the
 * response's `skipped[]` names each room left out and why (already out / sequential key still
 * with the guest / not occupied yet), so a six-room party is one click and an honest answer.
 */
entriesRouter.post(
  "/:id/rooms/keys/issue-all",
  requireActorLevel("L1"),
  validateBody(z.object({ roomIds: z.array(z.string().min(1)).max(60).optional() })),
  async (req, res, next) => {
    try {
      res.json(await issueRoomKeysBulk(prisma, req.params.id, req.actor!.actorId, { roomIds: req.body?.roomIds }));
    } catch (e) {
      next(e);
    }
  },
);

entriesRouter.post("/:id/rooms/:roomId/key-returned", requireActorLevel("L1"), async (req, res, next) => {
  try {
    res.json(await returnRoomKey(prisma, req.params.id, req.params.roomId, req.actor!.actorId));
  } catch (e) {
    next(e);
  }
});

/** Read-only trace/event feed for a single entry — visible to the staff working it (L1+). */
entriesRouter.get("/:id/trace", requireActorLevel("L1"), async (req, res, next) => {
  try {
    const limit = typeof req.query.limit === "string" ? Number(req.query.limit) : undefined;
    const result = await getEntryTrace(prisma, req.params.id, limit);
    res.json(result);
  } catch (e) {
    next(e);
  }
});

/**
 * Governed outbound communications for one entry, newest first (L1+) — the quotation (S2),
 * proforma invoice (S3), confirmation voucher (S4) and pre-arrival reminder (S5), each with its
 * acknowledgement state. Drives the "sent / accepted" blocks on the desk's stage steps.
 * `canAcknowledge` and `isOverdue` are computed server-side so every frontend agrees.
 */
entriesRouter.get("/:id/communications", requireActorLevel("L1"), async (req, res, next) => {
  try {
    res.json(await listEntryCommunications(prisma, req.params.id));
  } catch (e) {
    next(e);
  }
});

/**
 * Active timers for one entry — drives the right-side countdown panel in the booking flow.
 * Returns SCHEDULED timers only (already-fired or cancelled ones are noise for the operator).
 * Sorted by firesAt asc so the soonest expiry is first.
 */
entriesRouter.get("/:id/timers", requireActorLevel("L1"), async (req, res, next) => {
  try {
    const items = await prisma.timerRecord.findMany({
      where: { entryId: req.params.id, status: "SCHEDULED" },
      orderBy: { firesAt: "asc" },
      select: {
        id: true,
        timerType: true,
        timerCode: true,
        // What the clock is on (a handoff, a communication, a hold…) — the desk names the
        // housekeeping and kitchen handoff clocks apart by it; they share one code.
        entityType: true,
        entityId: true,
        stageContext: true,
        firesAt: true,
        warningAt: true,
        criticalAt: true,
        status: true,
        createdAt: true,
      },
    });
    // A clock the desk shows only from a moment of its own — the no-show cut-off, from the start
    // of its grace (2026-10-29).
    const grace = items.some((t) => t.timerCode === "NO_SHOW_CUTOFF_W5") ? await resolveNoShowGraceMinutes(prisma).catch(() => null) : null;
    res.json({ items: items.map((t) => ({ ...t, showsFrom: timerShowsFrom(t, grace)?.toISOString() ?? null })), count: items.length });
  } catch (e) {
    next(e);
  }
});

/**
 * Booking journey summary — the "S1–S4 handoff summary". A read-only, staff-facing recap of
 * everything the customer chose or did from Inquiry through Confirmation, aggregated from the
 * records that already back each stage (no new business outcome, nothing persisted). Drives the
 * review panel on the desk Confirm step; the S4 confirmation voucher (guest-facing) reads the
 * same underlying records. L1+.
 */
entriesRouter.get("/:id/journey-summary", requireActorLevel("L1"), async (req, res, next) => {
  try {
    const summary = await buildBookingJourneySummary(prisma, req.params.id);
    res.json(summary);
  } catch (e) {
    next(e);
  }
});

/**
 * Billing summary — the booking's money position in one read (2026-08-13). Drives the
 * workspace header's live total + click-through breakdown: stay total on the CURRENT
 * commercial basis (operative quotation of the current segment — re-priced by room changes
 * and re-entries), plus the folio ledger (billed so far / payments / refunds / write-offs /
 * outstanding). Pure aggregation, Decimal-safe server-side; nothing persisted. L1+.
 */
entriesRouter.get("/:id/billing-summary", requireActorLevel("L1"), async (req, res, next) => {
  try {
    res.setHeader("Cache-Control", "no-store");
    res.json(await buildEntryBillingSummary(prisma, req.params.id));
  } catch (e) {
    next(e);
  }
});

/**
 * Rate reference for the S2 composition editors (L1+). Per sealed room type: the room rate the
 * pricing will default to (agent/corporate card incl. overrides, else standard rate plan), the
 * card's extra-bed/meal add-on rates, the standard-plan rate + MSR as the negotiation floor, and
 * the config GST/service-charge rates. Pure read — mirrors `prepareQuotationDraft`'s defaults so
 * the reference the desk shows is exactly what an un-negotiated draft will charge.
 */
entriesRouter.get("/:id/rate-reference", requireActorLevel("L1"), async (req, res, next) => {
  try {
    // `?rooms=a,b` adds rooms the booking does not hold yet, so their own types' rates are named
    // (2026-10-19: the room-change panel's table listed only the booking's current type).
    const rooms = typeof req.query.rooms === "string" ? req.query.rooms.split(",").map((s) => s.trim()).filter(Boolean).slice(0, 50) : [];
    res.json(await buildEntryRateReference(prisma, req.params.id, rooms.length ? { planRoomIds: rooms } : undefined));
  } catch (e) {
    next(e);
  }
});

/**
 * Competing claims on this booking's rooms & dates (2026-08-06): other live bookings holding a
 * quotation / proforma / hold / reservation over the same (room, night) pairs. Advisory — the
 * desk shows it at the S2→S3 boundary and on Set up; the hard race gate stays Policy 26.
 */
entriesRouter.get("/:id/competing-claims", requireActorLevel("L1"), async (req, res, next) => {
  try {
    res.setHeader("Cache-Control", "no-store");
    res.json(await buildCompetingClaims(prisma, req.params.id));
  } catch (e) {
    next(e);
  }
});

/**
 * Live pricing for the composition table — the quote's own arithmetic with nothing persisted.
 *
 * The desk may not compute money, so without this the operator negotiates blind and only learns
 * the total once the quote is generated. POST because the compositions being priced are the
 * unsaved state of the editor, not anything addressable by URL. Writes nothing: no Quotation, no
 * lines, no trace, no PDF.
 */
entriesRouter.post("/:id/quotation-preview", requireActorLevel("L1"), async (req, res, next) => {
  try {
    const body = req.body as { roomCompositions?: unknown; discount?: unknown; roomNights?: unknown; roomNightDates?: unknown; stay?: unknown };
    res.setHeader("Cache-Control", "no-store");
    const roomCompositions = Array.isArray(body?.roomCompositions) ? (body.roomCompositions as Array<{ roomId?: unknown }>) : [];
    // Each room prices at its own type's rate even when the booking does not hold it yet (the
    // room-change panel), and for the nights the desk says it takes — a count from 1 to 366.
    const roomNights = new Map<string, number>();
    if (body?.roomNights && typeof body.roomNights === "object" && !Array.isArray(body.roomNights)) {
      for (const [rid, n] of Object.entries(body.roomNights as Record<string, unknown>)) {
        if (typeof n === "number" && Number.isInteger(n) && n >= 1 && n <= 366) roomNights.set(rid, n);
      }
    }
    // And which nights, as YYYY-MM-DD, so a room's per-night meals and beds price on them (2026-10-22).
    const roomNightDates = new Map<string, string[]>();
    if (body?.roomNightDates && typeof body.roomNightDates === "object" && !Array.isArray(body.roomNightDates)) {
      for (const [rid, ds] of Object.entries(body.roomNightDates as Record<string, unknown>)) {
        if (!Array.isArray(ds) || ds.length < 1 || ds.length > 366) continue;
        if (!ds.every((d) => typeof d === "string" && /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(d))) continue;
        roomNightDates.set(rid, ds as string[]);
      }
    }
    // Priced for a stay the booking does not hold yet (2026-10-29, a change of dates on the step):
    // the rates resolve for those nights.
    const stayIn = (body?.stay as { checkInDate?: unknown } | undefined)?.checkInDate;
    const stayOut = (body?.stay as { checkOutDate?: unknown } | undefined)?.checkOutDate;
    const stayOverride =
      typeof stayIn === "string" && typeof stayOut === "string" && /^\d{4}-\d{2}-\d{2}$/.test(stayIn) && /^\d{4}-\d{2}-\d{2}$/.test(stayOut) && stayOut > stayIn
        ? {
            checkIn: new Date(`${stayIn}T00:00:00.000Z`),
            checkOut: new Date(`${stayOut}T00:00:00.000Z`),
            perRoomNightCounts: new Map(
              roomCompositions
                .map((c) => c.roomId)
                .filter((id): id is string => typeof id === "string")
                .map((id) => [id, roomNights.get(id) ?? Math.round((Date.parse(stayOut) - Date.parse(stayIn)) / 86_400_000)] as [string, number]),
            ),
          }
        : null;
    res.json(
      await buildQuotationPreview(
        prisma,
        req.params.id,
        { roomCompositions: roomCompositions as never[], discount: (body?.discount ?? null) as never },
        {
          planRoomIds: roomCompositions.map((c) => c.roomId).filter((id): id is string => typeof id === "string"),
          ...(roomNights.size ? { roomNights } : {}),
          ...(roomNightDates.size ? { roomNightDates } : {}),
          ...(stayOverride ? { stayOverride } : {}),
        },
      ),
    );
  } catch (e) {
    next(e);
  }
});

/**
 * Segment history — the entry's per-pass record (Implementation Reference §1.2 / §6.2). One item
 * per Segment: the stage path walked, why the pass opened (backflow mode + operator reason),
 * what sealed it, and the per-segment commercial records (reservation, quotations, amendments,
 * billing-model transitions). Read-only aggregation, nothing persisted. L1+.
 */
entriesRouter.get("/:id/segments", requireActorLevel("L1"), async (req, res, next) => {
  try {
    const history = await buildSegmentHistory(prisma, req.params.id);
    res.json(history);
  } catch (e) {
    next(e);
  }
});

/**
 * Reuse a prior segment's room configuration as the current segment's basis — Canon Block 10 §59
 * "Availability Configuration and Recall". This is a recall-plus-revalidate, not a copy: the
 * prior (sealed) configuration is never modified; the engine re-runs against present state, and
 * a NEW configuration derived from it is written on the current segment.
 *
 * `apply: false` (default) previews — it runs every viability check and records the evidence but
 * writes no configuration. `apply: true` commits. Any material change (room no longer available,
 * DEFICIENT flag moved, indicative rate moved) requires L2/FOM authority per §59 M.4 and comes
 * back as PolicyGateBlockedError `AUTH_REQUIRED_L2` for L1 actors. L1+ to preview.
 */
entriesRouter.post("/:id/segments/:segmentNumber/recall", requireActorLevel("L1"), async (req, res, next) => {
  try {
    const fromSegmentNumber = Number(req.params.segmentNumber);
    if (!Number.isInteger(fromSegmentNumber) || fromSegmentNumber < 1) {
      throw new ValidationError("segmentNumber must be a positive integer");
    }
    const body = z
      .object({ apply: z.boolean().optional(), reason: z.string().max(500).optional() })
      .parse(req.body ?? {});
    const outcome = await recallSegmentConfiguration(prisma, {
      entryId: req.params.id,
      fromSegmentNumber,
      actor: { actorId: req.actor!.actorId, actorLevel: req.actor!.level },
      apply: body.apply,
      reason: body.reason,
    });
    res.json(outcome);
  } catch (e) {
    next(e);
  }
});

/**
 * Duplicate a segment — open a NEW segment and carry a prior segment's basis into it. One
 * operator action composed of two governed operations: a re-entry (which is what actually creates
 * the segment, with its own authority gate + consequence engine) followed by a
 * recall-plus-revalidate of the source segment's configuration (Canon Block 10 §59).
 *
 * `toStage` is the stage the new segment opens at, and must be a legal re-entry target from the
 * entry's current stage. Authority is enforced by the underlying backflow (e.g. S4→S1 needs FOM).
 * If the re-entry succeeds but the recall is blocked by the FOM gate, the response carries
 * `prefilled: false` + `recallBlocked` — the new segment is real, the basis just needs approval.
 */
entriesRouter.post("/:id/segments/:segmentNumber/duplicate", requireActorLevel("L1"), async (req, res, next) => {
  try {
    const fromSegmentNumber = Number(req.params.segmentNumber);
    if (!Number.isInteger(fromSegmentNumber) || fromSegmentNumber < 1) {
      throw new ValidationError("segmentNumber must be a positive integer");
    }
    const body = z
      .object({ toStage: z.enum(["S1", "S2", "S3"]), reason: z.string().trim().min(1).max(500) })
      .parse(req.body ?? {});
    const outcome = await duplicateSegmentIntoNew(prisma, {
      entryId: req.params.id,
      fromSegmentNumber,
      toStage: body.toStage,
      actor: { actorId: req.actor!.actorId, actorLevel: req.actor!.level },
      reason: body.reason,
    });
    res.json(outcome);
  } catch (e) {
    next(e);
  }
});

entriesRouter.get("/", requireActorLevel("L1"), async (req, res, next) => {
  try {
    const parsed = listEntriesQuerySchema.safeParse(req.query);
    if (!parsed.success) throw new ValidationError("Invalid query parameters", parsed.error.flatten());
    const items = await s1EntryService.listEntries(prisma, parsed.data);
    res.json({ items, count: items.length });
  } catch (e) {
    next(e);
  }
});

entriesRouter.post("/", requireActorLevel("L1"), validateBody(createEntryRequestSchema), async (req, res, next) => {
  try {
    const created = await s1EntryService.createEntry(prisma, req.actor!.actorId, req.actor!.level, req.body);
    res.status(201).json(created);
  } catch (e) {
    next(e);
  }
});

/**
 * The guest's return stay — a second booking under the SAME enquiry (2026-09-25). The desk adds
 * it from the first booking, so the guest is never searched for twice and the trip keeps one
 * enquiry number. Each stay still carries its own folio and bill (operator's ruling).
 */
entriesRouter.post(
  "/:id/return-stay",
  requireActorLevel("L1"),
  validateBody(addReturnStayRequestSchema),
  async (req, res, next) => {
    try {
      const created = await addReturnStay(
        prisma,
        req.params.id,
        { actorId: req.actor!.actorId, actorLevel: req.actor!.level },
        req.body,
      );
      res.status(201).json(created);
    } catch (e) {
      next(e);
    }
  },
);

/**
 * L3+ manual override of the group billing mode. Used when Policy 64's auto-classification
 * disagrees with the operator's on-the-ground judgement. Body: { mode: "GROUP_MASTER" | null,
 * reason: string, clearManualOverride?: boolean }. Setting clearManualOverride to true
 * re-enables Policy 64 auto-reclassification on subsequent intake edits.
 */
const setGroupBillingModeSchema = z.object({
  mode: z.enum(["GROUP_MASTER", "INDIVIDUAL_FOLIO"]).nullable(),
  reason: z.string().trim().min(1).max(500),
  clearManualOverride: z.boolean().optional(),
});
entriesRouter.patch("/:id/group-billing-mode", requireActorLevel("L3"), validateBody(setGroupBillingModeSchema), async (req, res, next) => {
  try {
    const updated = await setGroupBillingModeManually(
      prisma,
      req.params.id,
      req.actor!.actorId,
      req.actor!.level as "L1" | "L2" | "L3" | "L4",
      req.body,
    );
    res.json(updated);
  } catch (e) {
    next(e);
  }
});

/**
 * Change the rooms and the party without leaving Negotiation (2026-09-30). L1 opens the door;
 * the service raises the bar to the FOM once a quotation has gone to the guest or been accepted,
 * reading the level from the verified session and never from the body.
 */
entriesRouter.post(
  "/:id/negotiation-amendment",
  requireActorLevel("L1"),
  validateBody(negotiationAmendmentRequestSchema),
  async (req, res, next) => {
    try {
      const outcome = await amendNegotiationConfiguration(
        prisma,
        req.params.id,
        { actorId: req.actor!.actorId, actorLevel: req.actor!.level },
        req.body,
      );
      res.json(outcome);
    } catch (e) {
      next(e);
    }
  },
);

/**
 * Change the dates, rooms or guests on the step the booking is at (2026-10-29) — Set up, Reserve,
 * Arrival. **L2**: moving a reserved booking's dates is the FOM's (Policy 58). The booking walks
 * back through Negotiation and forward again; the desk stays on its step.
 */
entriesRouter.post("/:id/change-stay", requireActorLevel("L2"), validateBody(changeStayInPlaceRequestSchema), async (req, res, next) => {
  try {
    res.json(await changeBookingInPlace(prisma, req.params.id, { actorId: req.actor!.actorId, actorLevel: req.actor!.level }, req.body));
  } catch (e) {
    next(e);
  }
});

/**
 * Approve or turn down a waiting configuration change (2026-09-30). **L2** — approving IS
 * applying, and the whole governed act runs again as the approver, so its own gates get the last
 * word on whether the proposal still holds.
 */
entriesRouter.post(
  "/:id/negotiation-amendment-requests/:requestId/decide",
  requireActorLevel("L2"),
  validateBody(decideNegotiationAmendmentRequestSchema),
  async (req, res, next) => {
    try {
      const result = await decideNegotiationAmendmentRequest(
        prisma,
        req.params.id,
        req.params.requestId,
        { actorId: req.actor!.actorId, actorLevel: req.actor!.level as "L1" | "L2" | "L3" | "L4" },
        req.body,
      );
      res.json(result);
    } catch (e) {
      next(e);
    }
  },
);

/** Taken back by the desk before anyone decided — L1, since the desk raised it. */
entriesRouter.post(
  "/:id/negotiation-amendment-requests/:requestId/withdraw",
  requireActorLevel("L1"),
  validateBody(withdrawNegotiationAmendmentRequestSchema),
  async (req, res, next) => {
    try {
      const result = await withdrawNegotiationAmendmentRequest(
        prisma,
        req.params.id,
        req.params.requestId,
        { actorId: req.actor!.actorId, actorLevel: req.actor!.level as "L1" | "L2" | "L3" | "L4" },
        req.body,
      );
      res.json(result);
    } catch (e) {
      next(e);
    }
  },
);

/** Booking flow's step-1 Edit — narrow update for intake fields only, S1-gated server-side. */
entriesRouter.patch("/:id", requireActorLevel("L1"), validateBody(updateEntryRequestSchema), async (req, res, next) => {
  try {
    const updated = await s1EntryService.updateEntryIntakeFields(
      prisma,
      req.params.id,
      req.actor!.actorId,
      req.actor!.level,
      req.body,
    );
    res.json(updated);
  } catch (e) {
    next(e);
  }
});

entriesRouter.get("/:id", requireActorLevel("L1"), async (req, res, next) => {
  try {
    const entry = await prisma.entry.findUnique({
      where: { id: req.params.id },
      include: entryDetailInclude,
    });
    if (!entry) {
      next(new NotFoundError("Entry"));
      return;
    }
    res.json(entry);
  } catch (e) {
    next(e);
  }
});

entriesRouter.post(
  "/:id/key-return",
  requireActorLevel("L1"),
  validateBody(recordKeyReturnRequestSchema),
  async (req, res, next) => {
    try {
      const rec = await s8CheckoutService.recordKeyReturn(prisma, req.params.id, req.actor!.actorId, req.body);
      res.status(201).json(rec);
    } catch (e) {
      next(e);
    }
  },
);

entriesRouter.post(
  "/:id/room-inspection",
  requireActorLevel("L1"),
  validateBody(recordRoomInspectionRequestSchema),
  async (req, res, next) => {
    try {
      const rec = await s8CheckoutService.recordInspection(prisma, req.params.id, req.actor!.actorId, req.body, {
        actorLevel: req.actor!.level,
      });
      res.status(201).json(rec);
    } catch (e) {
      next(e);
    }
  },
);

/** Every room still to inspect, in one act — nothing found, or put off (2026-10-26). */
entriesRouter.post(
  "/:id/room-inspections/bulk",
  requireActorLevel("L1"),
  validateBody(recordRoomInspectionsBulkRequestSchema),
  async (req, res, next) => {
    try {
      res.status(201).json(
        await s8CheckoutService.recordInspectionsInBulk(prisma, req.params.id, req.actor!.actorId, req.body, {
          actorLevel: req.actor!.level,
        }),
      );
    } catch (e) {
      next(e);
    }
  },
);

/** The damage the inspections found and how each was answered (2026-10-26). */
entriesRouter.get("/:id/damages", requireActorLevel("L1"), async (req, res, next) => {
  try {
    res.setHeader("Cache-Control", "no-store");
    res.json(await damageAssessmentService.listBookingDamages(prisma, req.params.id));
  } catch (e) {
    next(e);
  }
});

/** What a damage charge comes to with the taxes chosen — server figures, nothing written. */
entriesRouter.post("/:id/damages/preview", requireActorLevel("L1"), validateBody(previewDamageChargeRequestSchema), async (req, res, next) => {
  try {
    res.setHeader("Cache-Control", "no-store");
    res.json(await damageAssessmentService.previewDamageCharge(prisma, req.body));
  } catch (e) {
    next(e);
  }
});

/** Answer one room's damage: charge · waive (the FOM's) · decide after departure. The service
 *  holds the levels (a charge after departure and a waiver are the FOM's). */
entriesRouter.post("/:id/damages/:inspectionId/answer", requireActorLevel("L1"), validateBody(answerDamageRequestSchema), async (req, res, next) => {
  try {
    res.json(
      await damageAssessmentService.answerDamage(prisma, req.params.id, req.params.inspectionId, {
        actorId: req.actor!.actorId,
        actorLevel: req.actor!.level,
      }, req.body),
    );
  } catch (e) {
    next(e);
  }
});

/** Each room's inspection, as the desk reads it (2026-10-26 — one inspection per room). */
entriesRouter.get("/:id/room-inspections", requireActorLevel("L1"), async (req, res, next) => {
  try {
    res.setHeader("Cache-Control", "no-store");
    res.json(await describeBookingInspections(prisma, req.params.id));
  } catch (e) {
    next(e);
  }
});

/** FOM: mark deferred inspection window lapsed (runs W9 worker — same as timer expiry). One room's
 *  window (body `roomId`); may be left out when only one room's inspection is put off. */
entriesRouter.post("/:id/post-checkout-inspection/expire-window", requireActorLevel("L2"), async (req, res, next) => {
  try {
    let roomId: string | undefined = typeof req.body?.roomId === "string" && req.body.roomId ? req.body.roomId : undefined;
    if (!roomId) {
      const open = (await describeBookingInspections(prisma, req.params.id)).rooms.filter((r) => r.windowCanBeClosed);
      if (open.length > 1) {
        next(new ValidationError(`${roomListWords(open.map((r) => r.roomNumber))} each have an inspection window open — name the room`));
        return;
      }
      roomId = open[0]?.roomId;
    }
    const result = await runPostCheckoutInspectionWorker(prisma, { entryId: req.params.id, roomId });
    if (result.skipped) {
      const words: Record<string, string> = {
        NO_W9_TIMER: "no inspection window is open for that room",
        NO_DEFERRED_INSPECTION: "that room's inspection is not put off",
        TIMER_ALREADY_CLAIMED_OR_CANCELLED: "the window has just closed",
        ENTRY_NOT_FOUND: "the booking was not found",
      };
      res.status(409).json({
        error: "StateTransitionError",
        message: `Cannot close the window: ${words[result.reason] ?? result.reason ?? "skipped"}`,
      });
      return;
    }
    const entry = await prisma.entry.findUnique({
      where: { id: req.params.id },
      include: entryDetailInclude,
    });
    if (!entry) {
      next(new NotFoundError("Entry"));
      return;
    }
    res.json(entry);
  } catch (e) {
    next(e);
  }
});

/** When the guest is expected, and when the no-show cut-off falls (2026-09-18). */
entriesRouter.get("/:id/expected-arrival", requireActorLevel("L1"), async (req, res, next) => {
  try {
    res.setHeader("Cache-Control", "no-store");
    res.json(await getExpectedArrival(prisma, req.params.id));
  } catch (e) {
    next(e);
  }
});

/** Record the guest's own expected arrival time (null clears it); at Arrival it re-arms the cut-off. */
entriesRouter.post(
  "/:id/expected-arrival",
  requireActorLevel("L1"),
  validateBody(setExpectedArrivalRequestSchema),
  async (req, res, next) => {
    try {
      res.json(await setExpectedArrival(prisma, req.params.id, req.actor!.actorId, req.actor!.level, req.body.time, req.body.dayAfter === true));
    } catch (e) {
      next(e);
    }
  },
);

/**
 * The rest of the bill at check-in (2026-10-29, operator ruling "wait for the FOM"): the guest's
 * promise, the figures (stay total − money received, server-side), the open request and the
 * FOM's decision, and whether check-in may go on. Read-only.
 */
entriesRouter.get("/:id/checkin-payment", requireActorLevel("L1"), async (req, res, next) => {
  try {
    res.setHeader("Cache-Control", "no-store");
    const { readCheckInPayment } = await import("../../services/domain/checkin-payment-service.js");
    res.json(await readCheckInPayment(prisma, req.params.id));
  } catch (e) {
    next(e);
  }
});

/** The desk asks the FOM to let the guest pay the rest later (L1). */
entriesRouter.post("/:id/checkin-payment/deferral", requireActorLevel("L1"), validateBody(checkInPaymentDeferralRequestSchema), async (req, res, next) => {
  try {
    const { requestCheckInPaymentDeferral } = await import("../../services/domain/checkin-payment-service.js");
    const actor = { actorId: req.actor!.actorId, actorLevel: req.actor!.level as "L1" | "L2" | "L3" | "L4" };
    res.status(201).json(await requestCheckInPaymentDeferral(prisma, actor, { entryId: req.params.id, reason: req.body.reason }));
  } catch (e) {
    next(e);
  }
});

/** The FOM decides — let them pay later, or turn it down (L2+). */
entriesRouter.post("/:id/checkin-payment/decide", requireActorLevel("L2"), validateBody(checkInPaymentDecisionRequestSchema), async (req, res, next) => {
  try {
    const { decideCheckInPaymentDeferral } = await import("../../services/domain/checkin-payment-service.js");
    const actor = { actorId: req.actor!.actorId, actorLevel: req.actor!.level as "L1" | "L2" | "L3" | "L4" };
    res.json(await decideCheckInPaymentDeferral(prisma, actor, { entryId: req.params.id, ...req.body }));
  } catch (e) {
    next(e);
  }
});

/** The desk takes its request back before the FOM answers (L1). */
entriesRouter.post("/:id/checkin-payment/deferral/:requestId/withdraw", requireActorLevel("L1"), validateBody(checkInPaymentWithdrawRequestSchema), async (req, res, next) => {
  try {
    const { withdrawCheckInPaymentDeferral } = await import("../../services/domain/checkin-payment-service.js");
    const actor = { actorId: req.actor!.actorId, actorLevel: req.actor!.level as "L1" | "L2" | "L3" | "L4" };
    res.json(await withdrawCheckInPaymentDeferral(prisma, actor, { entryId: req.params.id, requestId: req.params.requestId, note: req.body.note }));
  } catch (e) {
    next(e);
  }
});

/** What still stands between the booking and "Close & seal" — the close's own checks, read not run (2026-09-18). */
entriesRouter.get("/:id/closure-readiness", requireActorLevel("L1"), async (req, res, next) => {
  try {
    const readiness = await s9Service.buildS9ClosureReadiness(prisma, req.params.id);
    res.setHeader("Cache-Control", "no-store");
    res.json(readiness);
  } catch (e) {
    next(e);
  }
});

entriesRouter.post("/:id/close", requireActorLevel("L2"), validateBody(closeEntryRequestSchema), async (req, res, next) => {
  try {
    const updated = await s9Service.closeEntryAtS9(prisma, req.params.id, req.actor!.actorId);
    res.json(updated);
  } catch (e) {
    next(e);
  }
});

entriesRouter.post(
  "/:id/reassign-custodian",
  requireActorLevel("L1"),
  validateBody(reassignEntryCustodianRequestSchema),
  async (req, res, next) => {
    try {
      const updated = await s1EntryService.reassignCustodianByEntryId(
        prisma,
        req.params.id,
        req.actor!.actorId,
        req.actor!.level,
        req.body.newCustodianId,
        req.body.reason,
      );
      res.json(updated);
    } catch (e) {
      next(e);
    }
  },
);

// Routed through the service so stage gates + version bump + audit trace apply — was previously
// a raw prisma.entry.update that let any L1 mutate apartment terms on any-stage entries.
entriesRouter.patch("/:id/apartment-context", requireActorLevel("L1"), validateBody(patchApartmentContextRequestSchema), async (req, res, next) => {
  try {
    const updated = await s1EntryService.updateApartmentContext(
      prisma,
      req.params.id,
      req.actor!.actorId,
      req.actor!.level,
      req.body,
    );
    res.json(updated);
  } catch (e) {
    next(e);
  }
});

entriesRouter.post("/:id/park", requireActorLevel("L1"), validateBody(parkEntryRequestSchema), async (req, res, next) => {
  try {
    const out = await s1EntryService.parkEntry(prisma, req.params.id, req.actor!.actorId, req.body.reason);
    res.json(out);
  } catch (e) {
    next(e);
  }
});

entriesRouter.post("/:id/switch-stay", requireActorLevel("L1"), validateBody(switchStayRequestSchema), async (req, res, next) => {
  try {
    res.json(await switchStay(prisma, req.params.id, req.body.toEntryId, req.actor!.actorId));
  } catch (e) {
    next(e);
  }
});

entriesRouter.post("/:id/unpark", requireActorLevel("L1"), async (req, res, next) => {
  try {
    const out = await s1EntryService.unparkEntry(prisma, req.params.id, req.actor!.actorId);
    res.json(out);
  } catch (e) {
    next(e);
  }
});
