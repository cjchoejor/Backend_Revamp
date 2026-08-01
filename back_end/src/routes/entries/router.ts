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
import { buildSegmentHistory } from "../../services/domain/segment-history-service.js";
import { recallSegmentConfiguration, duplicateSegmentIntoNew } from "../../services/domain/segment-recall-service.js";
import { listEntryCommunications } from "../../services/domain/communication-acknowledgement-service.js";
import { buildEntryRateReference } from "../../services/domain/rate-reference-service.js";

export const entriesRouter = Router();

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
