import { Router } from "express";
import { prisma } from "../../db.js";
import {
  createGuestProfileRequestSchema,
  searchGuestProfilesQuerySchema,
  verifyGuestIdentityRequestSchema,
} from "../../dtos/14-guest-profiles/request-schemas.js";
import { requireActorLevel } from "../../middleware/auth.js";
import { validateBody } from "../../middleware/validate-body.js";
import { ValidationError } from "../../lib/errors.js";
import * as guestProfileService from "../../services/domain/guest-profile-service.js";

export const guestProfilesRouter = Router();

guestProfilesRouter.get("/guest-profiles", requireActorLevel("L1"), async (req, res, next) => {
  try {
    const parsed = searchGuestProfilesQuerySchema.safeParse(req.query);
    if (!parsed.success) throw new ValidationError("Invalid query parameters", parsed.error.flatten());
    const result = await guestProfileService.searchGuestProfiles(prisma, parsed.data);
    res.json(result);
  } catch (e) {
    next(e);
  }
});

guestProfilesRouter.get("/guest-profiles/:id", requireActorLevel("L1"), async (req, res, next) => {
  try {
    const profile = await guestProfileService.getGuestProfileById(prisma, req.params.id);
    res.json(profile);
  } catch (e) {
    next(e);
  }
});

guestProfilesRouter.post(
  "/guest-profiles",
  requireActorLevel("L1"),
  validateBody(createGuestProfileRequestSchema),
  async (req, res, next) => {
    try {
      const created = await guestProfileService.createGuestProfile(
        prisma,
        req.actor!.actorId,
        req.actor!.level,
        req.body,
      );
      res.status(201).json(created);
    } catch (e) {
      next(e);
    }
  },
);

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
