import { Router } from "express";
import { prisma } from "../../db.js";
import { requireActorLevel } from "../../middleware/auth.js";
import { validateBody } from "../../middleware/validate-body.js";
import { answerEarlierAdvanceRequestSchema, keepRefundRequestSchema, recordRefundRequestSchema } from "../../dtos/07-folios/request-schemas.js";
import { answerEarlierAdvance, keepRefund, listRefunds, recordRefund } from "../../services/domain/refund-service.js";

export const refundsRouter = Router();

/** The desk's answer about an advance from an earlier pass: on the new proforma, or refunded. */
refundsRouter.post("/entries/:id/earlier-advance/answer", requireActorLevel("L1"), validateBody(answerEarlierAdvanceRequestSchema), async (req, res, next) => {
  try {
    res.json(await answerEarlierAdvance(prisma, req.params.id, req.body, { actorId: req.actor!.actorId, actorLevel: req.actor!.level }));
  } catch (e) {
    next(e);
  }
});

/** The Refunds tab, for the FOM, GM and admin. It carries bank details, so never the front desk. */
refundsRouter.get("/refunds", requireActorLevel("L2"), async (req, res, next) => {
  try {
    res.setHeader("Cache-Control", "no-store");
    const view = req.query.view === "done" ? "done" : "waiting";
    res.json({ items: await listRefunds(prisma, view) });
  } catch (e) {
    next(e);
  }
});

refundsRouter.post("/refunds/:id/record", requireActorLevel("L2"), validateBody(recordRefundRequestSchema), async (req, res, next) => {
  try {
    res.json(await recordRefund(prisma, req.params.id, req.body, { actorId: req.actor!.actorId, actorLevel: req.actor!.level }));
  } catch (e) {
    next(e);
  }
});

refundsRouter.post("/refunds/:id/keep", requireActorLevel("L2"), validateBody(keepRefundRequestSchema), async (req, res, next) => {
  try {
    res.json(await keepRefund(prisma, req.params.id, req.body, { actorId: req.actor!.actorId, actorLevel: req.actor!.level }));
  } catch (e) {
    next(e);
  }
});
