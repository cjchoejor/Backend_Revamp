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
} from "../../dtos/03-entries/request-schemas.js";
import { requireActorLevel } from "../../middleware/auth.js";
import { validateBody } from "../../middleware/validate-body.js";
import { NotFoundError, ValidationError } from "../../lib/errors.js";
import * as s1EntryService from "../../services/domain/s1-entry-service.js";
import * as s8CheckoutService from "../../services/domain/s8-checkout-service.js";
import * as s9Service from "../../services/domain/s9-service.js";
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

entriesRouter.patch("/:id/apartment-context", requireActorLevel("L1"), validateBody(patchApartmentContextRequestSchema), async (req, res, next) => {
  try {
    const { apartmentDurationNights, apartmentRateTierCode } = req.body;
    const updated = await prisma.entry.update({
      where: { id: req.params.id },
      data: { apartmentDurationNights, apartmentRateTierCode, version: { increment: 1 } } as any,
    });
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
