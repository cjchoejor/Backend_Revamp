import { Router } from "express";
import { prisma } from "../../db.js";
import { verifyGuestIdentityRequestSchema } from "../../dtos/14-guest-profiles/request-schemas.js";
import { requireActorLevel } from "../../middleware/auth.js";
import { validateBody } from "../../middleware/validate-body.js";
import * as guestProfileService from "../../services/domain/guest-profile-service.js";

export const guestProfilesRouter = Router();

guestProfilesRouter.post(
  "/guest-profiles/:id/verify-identity",
  requireActorLevel("L1"),
  validateBody(verifyGuestIdentityRequestSchema),
  async (req, res, next) => {
    try {
      const { entryId, verificationPath, documentType, documentNumber, issuingCountry, expiryDate } = req.body;
      const updated = await guestProfileService.recordVerification(prisma, req.params.id, req.actor!.actorId, {
        entryId,
        verificationPath,
        documentType,
        documentNumber,
        issuingCountry,
        expiryDate,
      });
      res.json(updated);
    } catch (e) {
      next(e);
    }
  },
);
