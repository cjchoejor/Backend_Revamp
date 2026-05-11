import { Router } from "express";
import { prisma } from "../../db.js";
import { AppError } from "../../lib/errors.js";
import { requireActorLevel } from "../../middleware/auth.js";
import * as guestProfileService from "../../services/domain/guest-profile-service.js";

export const guestProfilesRouter = Router();

guestProfilesRouter.post("/guest-profiles/:id/verify-identity", requireActorLevel("L1"), async (req, res, next) => {
  try {
    const { entryId, verificationPath, documentType, documentNumber, issuingCountry, expiryDate } = req.body ?? {};
    if (!entryId || typeof entryId !== "string") {
      next(new AppError(400, { error: "ValidationError", message: "entryId is required" }));
      return;
    }
    if (!verificationPath || typeof verificationPath !== "string") {
      next(new AppError(400, { error: "ValidationError", message: "verificationPath is required" }));
      return;
    }
    const allowed = ["FIRST_TIME", "RETURNING_VALID", "RETURNING_EXPIRED", "VIP"];
    if (!allowed.includes(verificationPath)) {
      next(
        new AppError(400, {
          error: "ValidationError",
          message: "verificationPath must be one of FIRST_TIME, RETURNING_VALID, RETURNING_EXPIRED, VIP",
        }),
      );
      return;
    }
    const updated = await guestProfileService.recordVerification(prisma, req.params.id, req.actor!.actorId, {
      entryId,
      verificationPath: verificationPath as "FIRST_TIME" | "RETURNING_VALID" | "RETURNING_EXPIRED" | "VIP",
      documentType: typeof documentType === "string" ? documentType : undefined,
      documentNumber: typeof documentNumber === "string" ? documentNumber : undefined,
      issuingCountry: typeof issuingCountry === "string" ? issuingCountry : undefined,
      expiryDate: typeof expiryDate === "string" ? expiryDate : undefined,
    });
    res.json(updated);
  } catch (e) {
    next(e);
  }
});

