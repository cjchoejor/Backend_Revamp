import { Router } from "express";
import { prisma } from "../../db.js";
import { AppError } from "../../lib/errors.js";
import { requireActorLevel } from "../../middleware/auth.js";
import * as cancellationService from "../../services/application/cancellation-service.js";
import * as s3DisclosureService from "../../services/domain/s3-cancellation-disclosure-service.js";

export const cancellationsRouter = Router();

cancellationsRouter.post("/entries/:id/cancel", requireActorLevel("L2"), async (req, res, next) => {
  try {
    const updated = await cancellationService.cancelEntryAtS5(prisma, req.params.id, req.actor!.actorId);
    res.json(updated);
  } catch (e) {
    next(e);
  }
});

cancellationsRouter.post("/entries/:id/disclosures/cancellation", requireActorLevel("L1"), async (req, res, next) => {
  try {
    const entry = await prisma.entry.findUnique({
      where: { id: req.params.id },
      include: { segments: { orderBy: { segmentNumber: "desc" }, take: 1 } },
    });
    if (!entry) {
      next(new AppError(404, { error: "NotFoundError", message: "Entry not found" }));
      return;
    }
    const segmentId = entry.segments[0]?.id;
    if (!segmentId) {
      next(new AppError(400, { error: "ValidationError", message: "Entry has no segment" }));
      return;
    }
    const out = await s3DisclosureService.recordCancellationDisclosure(
      prisma,
      { entryId: req.params.id, segmentId, noShowTreatmentStatement: req.body?.noShowTreatmentStatement, disclosedTerms: req.body?.disclosedTerms },
      { actorId: req.actor!.actorId, actorLevel: req.actor!.level },
    );
    res.status(201).json(out);
  } catch (e) {
    next(e);
  }
});

