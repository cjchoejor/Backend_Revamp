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
