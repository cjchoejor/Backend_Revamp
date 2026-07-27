import { Router } from "express";
import { prisma } from "../../db.js";
import {
  cancelEarlyDepartureRequestSchema,
  cancelS3EntryRequestSchema,
  cancelS5EntryRequestSchema,
  recordCancellationDisclosureRequestSchema,
} from "../../dtos/09-cancellations/request-schemas.js";
import { NotFoundError, ValidationError } from "../../lib/errors.js";
import { requireActorLevel } from "../../middleware/auth.js";
import { validateBody } from "../../middleware/validate-body.js";
import * as cancellationService from "../../services/application/cancellation-service.js";
import * as s3DisclosureService from "../../services/domain/s3-cancellation-disclosure-service.js";

export const cancellationsRouter = Router();

cancellationsRouter.post(
  "/entries/:id/cancel-at-s3",
  requireActorLevel("L1"),
  validateBody(cancelS3EntryRequestSchema),
  async (req, res, next) => {
    try {
      const updated = await cancellationService.cancelEntryAtS3(prisma, req.params.id, req.actor!.actorId, {
        reason: req.body.reason,
        penaltyWaiverRequested: req.body.penaltyWaiverRequested === true,
        actorLevel: req.actor!.level,
      });
      res.json(updated);
    } catch (e) {
      next(e);
    }
  },
);

cancellationsRouter.post(
  "/entries/:id/cancel",
  requireActorLevel("L2"),
  validateBody(cancelS5EntryRequestSchema),
  async (req, res, next) => {
    try {
      const updated = await cancellationService.cancelEntryAtS5(prisma, req.params.id, req.actor!.actorId, {
        penaltyWaiverRequested: req.body.penaltyWaiverRequested === true,
        actorLevel: req.actor!.level,
      });
      res.json(updated);
    } catch (e) {
      next(e);
    }
  },
);

cancellationsRouter.post(
  "/entries/:id/cancel-early-departure",
  requireActorLevel("L2"),
  validateBody(cancelEarlyDepartureRequestSchema),
  async (req, res, next) => {
    try {
      const updated = await cancellationService.cancelEntryEarlyDepartureAfterCheckIn(prisma, req.params.id, req.actor!.actorId, {
        penaltyWaiverRequested: req.body.penaltyWaiverRequested === true,
        actorLevel: req.actor!.level,
      });
      res.json(updated);
    } catch (e) {
      next(e);
    }
  },
);

cancellationsRouter.post(
  "/entries/:id/disclosures/cancellation",
  requireActorLevel("L1"),
  validateBody(recordCancellationDisclosureRequestSchema),
  async (req, res, next) => {
    try {
      const entry = await prisma.entry.findUnique({
        where: { id: req.params.id },
        include: { segments: { orderBy: { segmentNumber: "desc" }, take: 1 } },
      });
      if (!entry) {
        next(new NotFoundError("Entry"));
        return;
      }
      const segmentId = entry.segments[0]?.id;
      if (!segmentId) {
        next(new ValidationError("Entry has no segment"));
        return;
      }
      const out = await s3DisclosureService.recordCancellationDisclosure(
        prisma,
        { entryId: req.params.id, segmentId, noShowTreatmentStatement: req.body.noShowTreatmentStatement, disclosedTerms: req.body.disclosedTerms },
        { actorId: req.actor!.actorId, actorLevel: req.actor!.level },
      );
      res.status(201).json(out);
    } catch (e) {
      next(e);
    }
  },
);
