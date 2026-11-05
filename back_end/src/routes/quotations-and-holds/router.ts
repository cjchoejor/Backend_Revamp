import { cleanPhone } from "../../lib/phone-numbers.js";
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
import { quoteValidityWindow } from "../../services/domain/s2-quotation-service.js";
import { afterStayChanged } from "../../services/domain/trip-follow-service.js";

export const quotationsAndHoldsRouter = Router();

quotationsAndHoldsRouter.post("/entries/:id/quotations", requireActorLevel("L1"), validateBody(createQuotationRequestSchema), async (req, res, next) => {
  try {
    const entry = await prisma.entry.findUnique({ where: { id: req.params.id }, select: { useType: true } });
    if (!entry) {
      res.status(404).json({ error: "NotFoundError", message: "Entry not found" });
      return;
    }
    // actorLevel comes from the VERIFIED session (never the body): with it present, the
    // discount's authority band is enforced at generation and the quote is born approved
    // (2026-08-07, operator ruling — approving after generation made no sense). The group
    // path keeps its own percent-only handling.
    // A group goes down the flat group path only when no per-room table is sent (API callers);
    // the desk always sends the table, which carries the meals, children and taxes (2026-09-18).
    const hasTable = Array.isArray(req.body.roomCompositions) && req.body.roomCompositions.length > 0;
    const created =
      entry.useType === "GROUP" && !hasTable
        ? await quotationService.createGroupQuotation(prisma, req.params.id, req.actor!.actorId, req.body)
        : await quotationService.createQuotation(prisma, req.params.id, req.actor!.actorId, {
            ...req.body,
            actorLevel: req.actor!.level,
          });
    await afterStayChanged(prisma, { actorId: req.actor!.actorId, actorLevel: req.actor!.level }, req.params.id, "PRICED");
    res.status(201).json(created);
  } catch (e) {
    next(e);
  }
});

/** How long a quotation on this booking may stand: the hotel's rule, for the desk's box. Read-only. */
quotationsAndHoldsRouter.get("/entries/:id/quote-validity", requireActorLevel("L1"), async (req, res, next) => {
  try {
    res.setHeader("Cache-Control", "no-store");
    res.json(await quoteValidityWindow(prisma, req.params.id));
  } catch (e) {
    next(e);
  }
});

quotationsAndHoldsRouter.post("/quotations/:id/supersede", requireActorLevel("L1"), validateBody(supersedeQuotationRequestSchema), async (req, res, next) => {
  try {
    const created = await quotationService.supersedeQuotationWithNewDraft(prisma, req.params.id, req.actor!.actorId, {
      ...req.body,
      actorLevel: req.actor!.level,
    });
    await afterStayChanged(prisma, { actorId: req.actor!.actorId, actorLevel: req.actor!.level }, created.entryId, "PRICED");
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
    // A send recorded on WhatsApp names a number; it is kept the one way (2026-11-05).
    if (String(req.body.channel ?? "").toUpperCase() === "WHATSAPP") {
      const number = cleanPhone(req.body.recipientAddress ?? req.body.sentTo, "The WhatsApp number");
      req.body.recipientAddress = number ?? undefined;
      req.body.sentTo = number ?? undefined;
    }
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

/**
 * Releasing a hold is a GM decision (2026-08-04, operator ruling; was L2).
 *
 * A held room is inventory promised to a guest. Letting it go is the moment an overbooking or a
 * lost booking becomes possible — two operators racing for the same room at S2/S3 is exactly the
 * case this guards — so the call belongs with someone who can weigh both guests, not with the
 * operator who wants the room. Placing a hold stays L1: taking inventory off the shelf is
 * ordinary front-desk work, giving it away is not.
 */
quotationsAndHoldsRouter.post(
  "/entries/:id/holds/speculative/:holdId/release",
  requireActorLevel("L3"),
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
