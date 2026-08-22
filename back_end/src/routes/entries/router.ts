import { Router } from "express";
import { prisma } from "../../db.js";
import {
  createEntryRequestSchema,
  listEntriesQuerySchema,
  parkEntryRequestSchema,
  patchApartmentContextRequestSchema,
  reassignEntryCustodianRequestSchema,
  closeEntryRequestSchema,
  recordKeyReturnRequestSchema,
  recordRoomInspectionRequestSchema,
  updateEntryRequestSchema,
} from "../../dtos/03-entries/request-schemas.js";
import { requireActorLevel } from "../../middleware/auth.js";
import { validateBody } from "../../middleware/validate-body.js";
import { NotFoundError, ValidationError } from "../../lib/errors.js";
import * as s1EntryService from "../../services/domain/s1-entry-service.js";
import * as s8CheckoutService from "../../services/domain/s8-checkout-service.js";
import * as s9Service from "../../services/domain/s9-service.js";
import { setGroupBillingModeManually } from "../../services/admin/group-billing-mode-admin-service.js";
import { z } from "zod";
import { entryDetailInclude } from "../../lib/entry-detail-include.js";
import { runPostCheckoutInspectionWorker } from "../../workers/w9-post-checkout-inspection-worker.js";
import { getEntryTrace } from "../../services/infrastructure/trace-query-service.js";
import { buildBookingJourneySummary } from "../../services/domain/booking-journey-summary-service.js";
import { buildEntryBillingSummary } from "../../services/domain/entry-billing-summary-service.js";
import { buildSegmentHistory } from "../../services/domain/segment-history-service.js";
import { recallSegmentConfiguration, duplicateSegmentIntoNew } from "../../services/domain/segment-recall-service.js";
import { listEntryCommunications } from "../../services/domain/communication-acknowledgement-service.js";
import { buildEntryRateReference } from "../../services/domain/rate-reference-service.js";
import { buildQuotationPreview } from "../../services/domain/quotation-preview-service.js";
import { buildCompetingClaims } from "../../services/domain/competing-claims-service.js";
import { changeRoomToNewSegment, listRoomChangeCandidates, buildRoomPlanHistory } from "../../services/domain/room-change-service.js";
import { issueRoomKey, issueRoomKeysBulk, returnRoomKey } from "../../services/domain/room-key-service.js";
import {
  partySeatingRepairRequestSchema,
  roomChangeRequestSchema,
  stayExtensionCommitRequestSchema,
  stayExtensionPreviewRequestSchema,
  stayExtensionRequestSchema,
} from "../../dtos/06-reservations/request-schemas.js";
import {
  commitStayExtension,
  listStayExtensions,
  previewStayExtension,
  requestStayExtension,
  withdrawStayExtension,
} from "../../services/domain/stay-extension-service.js";
import { buildPartySeatingStatus, repairPartySeatingForEntry } from "../../services/domain/party-seating-service.js";

export const entriesRouter = Router();

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
 * In-place room change — the composite. One call: governed ROOM_CHANGE re-entry (new segment),
 * substituted basis revalidated against live availability, silent re-quote (nothing sent to the
 * guest; PI not re-issued; the advance already received stands), then the walk back to the
 * origin stage server-side. Partial-outcome contract: if a later step blocks, the response's
 * `walk.blocked` names the step — the new segment is real and the desk finishes normally.
 */
entriesRouter.post("/:id/room-change", requireActorLevel("L1"), validateBody(roomChangeRequestSchema), async (req, res, next) => {
  try {
    const actor = { actorId: req.actor!.actorId, actorLevel: req.actor!.level as "L1" | "L2" | "L3" | "L4" };
    const outcome = await changeRoomToNewSegment(prisma, actor, {
      entryId: req.params.id,
      fromRoomId: req.body.fromRoomId,
      toRoomId: req.body.toRoomId,
      perNight: req.body.perNight,
      reason: req.body.reason,
      adjustments: req.body.adjustments,
      roomSetups: req.body.roomSetups,
      roomCompositions: req.body.roomCompositions,
      ...("requestedDiscount" in (req.body ?? {}) ? { requestedDiscount: req.body.requestedDiscount } : {}),
    });
    res.json(outcome);
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
        stageContext: true,
        firesAt: true,
        warningAt: true,
        criticalAt: true,
        status: true,
        createdAt: true,
      },
    });
    res.json({ items, count: items.length });
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
    res.json(await buildEntryRateReference(prisma, req.params.id));
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
    const body = req.body as { roomCompositions?: unknown; discount?: unknown };
    res.setHeader("Cache-Control", "no-store");
    res.json(
      await buildQuotationPreview(prisma, req.params.id, {
        roomCompositions: Array.isArray(body?.roomCompositions) ? (body.roomCompositions as never[]) : [],
        discount: (body?.discount ?? null) as never,
      }),
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
      const rec = await s8CheckoutService.recordInspection(prisma, req.params.id, req.actor!.actorId, req.body);
      res.status(201).json(rec);
    } catch (e) {
      next(e);
    }
  },
);

/** FOM: mark deferred inspection window lapsed (runs W9 worker — same as timer expiry). */
entriesRouter.post("/:id/post-checkout-inspection/expire-window", requireActorLevel("L2"), async (req, res, next) => {
  try {
    const result = await runPostCheckoutInspectionWorker(prisma, { entryId: req.params.id });
    if (result.skipped) {
      res.status(409).json({
        error: "StateTransitionError",
        message: `Cannot expire window: ${result.reason ?? "skipped"}`,
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

entriesRouter.post("/:id/unpark", requireActorLevel("L1"), async (req, res, next) => {
  try {
    const out = await s1EntryService.unparkEntry(prisma, req.params.id, req.actor!.actorId);
    res.json(out);
  } catch (e) {
    next(e);
  }
});
