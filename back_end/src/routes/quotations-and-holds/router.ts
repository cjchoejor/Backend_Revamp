import { Router } from "express";
import { prisma } from "../../db.js";
import { requireActorLevel } from "../../middleware/auth.js";
import * as s1EntryService from "../../services/domain/s1-entry-service.js";
import * as s2HoldService from "../../services/domain/s2-hold-service.js";
import * as s2QuotationService from "../../services/domain/s2-quotation-service.js";

export const quotationsAndHoldsRouter = Router();

quotationsAndHoldsRouter.post("/entries/:id/quotations", requireActorLevel("L1"), async (req, res, next) => {
  try {
    const created = await s2QuotationService.createQuotation(prisma, req.params.id, req.actor!.actorId, req.body ?? {});
    res.status(201).json(created);
  } catch (e) {
    next(e);
  }
});

quotationsAndHoldsRouter.post("/quotations/:id/supersede", requireActorLevel("L1"), async (req, res, next) => {
  try {
    const created = await s2QuotationService.supersedeQuotationWithNewDraft(prisma, req.params.id, req.actor!.actorId, req.body ?? {});
    res.status(201).json(created);
  } catch (e) {
    next(e);
  }
});

quotationsAndHoldsRouter.post("/quotations/:id/discount/approve", requireActorLevel("L2"), async (req, res, next) => {
  try {
    const out = await s2QuotationService.approveDiscount(prisma, req.params.id, { actorId: req.actor!.actorId, actorLevel: req.actor!.level });
    res.json(out);
  } catch (e) {
    next(e);
  }
});

quotationsAndHoldsRouter.post("/quotations/:id/send", requireActorLevel("L1"), async (req, res, next) => {
  try {
    const updated = await s2QuotationService.sendQuotation(prisma, req.params.id, req.actor!.actorId, req.body ?? {});
    res.json(updated);
  } catch (e) {
    next(e);
  }
});

quotationsAndHoldsRouter.post("/quotations/:id/accept", requireActorLevel("L1"), async (req, res, next) => {
  try {
    const updated = await s2QuotationService.acceptQuotation(prisma, req.params.id, req.actor!.actorId, req.body ?? {});
    res.json(updated);
  } catch (e) {
    next(e);
  }
});

quotationsAndHoldsRouter.post("/quotations/:id/ack-open-loop/resolve", requireActorLevel("L2"), async (req, res, next) => {
  try {
    const out = await s2QuotationService.resolveAckOpenLoop(prisma, req.params.id, { actorId: req.actor!.actorId, actorLevel: req.actor!.level }, req.body ?? {});
    res.json(out);
  } catch (e) {
    next(e);
  }
});

quotationsAndHoldsRouter.post("/entries/:id/s2/auto-fulfil-to-s3", requireActorLevel("L1"), async (req, res, next) => {
  try {
    const { version } = req.body ?? {};
    const updated = await s1EntryService.autoFulfilS2ToS3(prisma, req.params.id, req.actor!.actorId, typeof version === "number" ? version : undefined);
    res.json(updated);
  } catch (e) {
    next(e);
  }
});

quotationsAndHoldsRouter.post("/entries/:id/holds/speculative", requireActorLevel("L1"), async (req, res, next) => {
  try {
    const created = await s2HoldService.placeSpeculativeHold(
      prisma,
      req.params.id,
      { actorId: req.actor!.actorId, actorLevel: req.actor!.level },
      req.body ?? {},
    );
    res.status(201).json(created);
  } catch (e) {
    next(e);
  }
});

quotationsAndHoldsRouter.post("/entries/:id/holds/speculative/:holdId/release", requireActorLevel("L2"), async (req, res, next) => {
  try {
    const updated = await s2HoldService.releaseSpeculativeHold(
      prisma,
      req.params.id,
      req.params.holdId,
      { actorId: req.actor!.actorId, actorLevel: req.actor!.level },
      req.body ?? {},
    );
    res.json(updated);
  } catch (e) {
    next(e);
  }
});

