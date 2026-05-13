import { Router } from "express";
import { prisma } from "../../db.js";
import {
  acceptQuotationRequestSchema,
  applyDiscountRequestSchema,
  autoFulfilS2ToS3RequestSchema,
  createQuotationRequestSchema,
  placeSpeculativeHoldRequestSchema,
  releaseSpeculativeHoldRequestSchema,
  resolveQuotationAckOpenLoopRequestSchema,
  sendQuotationRequestSchema,
  supersedeQuotationRequestSchema,
} from "../../dtos/05-quotations-and-holds/request-schemas.js";
import { requireActorLevel } from "../../middleware/auth.js";
import { validateBody } from "../../middleware/validate-body.js";
import * as s1EntryService from "../../services/domain/s1-entry-service.js";
import * as holdService from "../../services/domain/hold-service.js";
import * as quotationService from "../../services/domain/quotation-service.js";

export const quotationsAndHoldsRouter = Router();

quotationsAndHoldsRouter.post("/entries/:id/quotations", requireActorLevel("L1"), validateBody(createQuotationRequestSchema), async (req, res, next) => {
  try {
    const entry = await prisma.entry.findUnique({ where: { id: req.params.id }, select: { useType: true } });
    if (!entry) {
      res.status(404).json({ error: "NotFoundError", message: "Entry not found" });
      return;
    }
    const created =
      entry.useType === "GROUP"
        ? await quotationService.createGroupQuotation(prisma, req.params.id, req.actor!.actorId, req.body)
        : await quotationService.createQuotation(prisma, req.params.id, req.actor!.actorId, req.body);
    res.status(201).json(created);
  } catch (e) {
    next(e);
  }
});

quotationsAndHoldsRouter.post("/quotations/:id/supersede", requireActorLevel("L1"), validateBody(supersedeQuotationRequestSchema), async (req, res, next) => {
  try {
    const created = await quotationService.supersedeQuotationWithNewDraft(prisma, req.params.id, req.actor!.actorId, req.body);
    res.status(201).json(created);
  } catch (e) {
    next(e);
  }
});

quotationsAndHoldsRouter.post("/quotations/:id/discount/approve", requireActorLevel("L2"), async (req, res, next) => {
  try {
    const out = await quotationService.approveDiscount(prisma, req.params.id, { actorId: req.actor!.actorId, actorLevel: req.actor!.level });
    res.json(out);
  } catch (e) {
    next(e);
  }
});

quotationsAndHoldsRouter.post("/quotations/:id/discount", requireActorLevel("L1"), validateBody(applyDiscountRequestSchema), async (req, res, next) => {
  try {
    const updated = await quotationService.applyDiscount(prisma, req.params.id, { actorId: req.actor!.actorId, actorLevel: req.actor!.level }, req.body);
    res.json(updated);
  } catch (e) {
    next(e);
  }
});

quotationsAndHoldsRouter.post("/quotations/:id/send", requireActorLevel("L1"), validateBody(sendQuotationRequestSchema), async (req, res, next) => {
  try {
    const updated = await quotationService.sendQuotation(prisma, req.params.id, req.actor!.actorId, req.body);
    res.json(updated);
  } catch (e) {
    next(e);
  }
});

quotationsAndHoldsRouter.post("/quotations/:id/accept", requireActorLevel("L1"), validateBody(acceptQuotationRequestSchema), async (req, res, next) => {
  try {
    const updated = await quotationService.acceptQuotation(prisma, req.params.id, req.actor!.actorId, req.body);
    res.json(updated);
  } catch (e) {
    next(e);
  }
});

quotationsAndHoldsRouter.post(
  "/quotations/:id/ack-open-loop/resolve",
  requireActorLevel("L2"),
  validateBody(resolveQuotationAckOpenLoopRequestSchema),
  async (req, res, next) => {
    try {
      const out = await quotationService.resolveAckOpenLoop(prisma, req.params.id, { actorId: req.actor!.actorId, actorLevel: req.actor!.level }, req.body);
      res.json(out);
    } catch (e) {
      next(e);
    }
  },
);

quotationsAndHoldsRouter.post("/entries/:id/s2/auto-fulfil-to-s3", requireActorLevel("L1"), validateBody(autoFulfilS2ToS3RequestSchema), async (req, res, next) => {
  try {
    const { version } = req.body;
    const updated = await s1EntryService.autoFulfilS2ToS3(prisma, req.params.id, req.actor!.actorId, typeof version === "number" ? version : undefined);
    res.json(updated);
  } catch (e) {
    next(e);
  }
});

quotationsAndHoldsRouter.post(
  "/entries/:id/holds/speculative",
  requireActorLevel("L1"),
  validateBody(placeSpeculativeHoldRequestSchema),
  async (req, res, next) => {
    try {
      const created = await holdService.placeSpeculativeHold(prisma, req.params.id, { actorId: req.actor!.actorId, actorLevel: req.actor!.level }, req.body);
      res.status(201).json(created);
    } catch (e) {
      next(e);
    }
  },
);

quotationsAndHoldsRouter.post(
  "/entries/:id/holds/speculative/:holdId/release",
  requireActorLevel("L2"),
  validateBody(releaseSpeculativeHoldRequestSchema),
  async (req, res, next) => {
    try {
      const updated = await holdService.releaseSpeculativeHold(
        prisma,
        req.params.id,
        req.params.holdId,
        { actorId: req.actor!.actorId, actorLevel: req.actor!.level },
        req.body,
      );
      res.json(updated);
    } catch (e) {
      next(e);
    }
  },
);
