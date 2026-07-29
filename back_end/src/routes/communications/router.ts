import { Router } from "express";
import { prisma } from "../../db.js";
import { requireActorLevel } from "../../middleware/auth.js";
import { validateBody } from "../../middleware/validate-body.js";
import { acknowledgeCommunicationRequestSchema } from "../../dtos/17-communications/request-schemas.js";
import { recordCommunicationAcknowledgement } from "../../services/domain/communication-acknowledgement-service.js";

export const communicationsRouter = Router();

/**
 * Record that the guest acknowledged / accepted a governed outbound communication — the
 * proforma invoice (S3), confirmation voucher (S4) or pre-arrival reminder (S5), alongside the
 * S2 quotation that already had its own acceptance route.
 *
 * L1+: capturing what the guest said is front-desk work, matching the quotation-acceptance
 * authority in SIG-S2 §1.5 ("records guest acceptance" is an L1 action).
 */
communicationsRouter.post(
  "/:id/acknowledge",
  requireActorLevel("L1"),
  validateBody(acknowledgeCommunicationRequestSchema),
  async (req, res, next) => {
    try {
      const out = await recordCommunicationAcknowledgement(
        prisma,
        req.params.id,
        { actorId: req.actor!.actorId, actorLevel: req.actor!.level },
        req.body,
      );
      res.json(out);
    } catch (e) {
      next(e);
    }
  },
);
