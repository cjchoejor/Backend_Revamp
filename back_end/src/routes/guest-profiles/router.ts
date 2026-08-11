import express, { Router } from "express";
import { prisma } from "../../db.js";
import {
  createGuestProfileRequestSchema,
  saveGuestIdentityDetailRequestSchema,
  searchGuestProfilesQuerySchema,
  verifyGuestIdentityRequestSchema,
} from "../../dtos/14-guest-profiles/request-schemas.js";
import { requireActorLevel } from "../../middleware/auth.js";
import { validateBody } from "../../middleware/validate-body.js";
import { ValidationError } from "../../lib/errors.js";
import * as guestProfileService from "../../services/domain/guest-profile-service.js";
import * as identityProofService from "../../services/domain/guest-identity-proof-service.js";

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

/**
 * Guest ID proof upload (2026-08-10) — the request BODY is the raw file bytes (photo or PDF
 * scan), NOT JSON: base64-in-JSON would inflate a phone photo ~33% and trip the app-level
 * json body limit, so the route mounts its own raw parser. The app-level `express.json()`
 * skips non-JSON content types, leaving the body untouched for it. Metadata rides in query
 * params; the file's type is the Content-Type header. L1 — the receptionist holding the
 * document is exactly who captures it.
 */
guestProfilesRouter.post(
  "/entries/:id/identity-proofs",
  requireActorLevel("L1"),
  express.raw({ type: ["image/*", "application/pdf", "application/octet-stream"], limit: "12mb" }),
  async (req, res, next) => {
    try {
      if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
        throw new ValidationError(
          "Send the file bytes as the raw request body with Content-Type set to the file's type (e.g. image/jpeg)",
        );
      }
      const q = req.query;
      const created = await identityProofService.storeIdentityProof(prisma, req.params.id, req.actor!.actorId, {
        bytes: req.body,
        mimeType: String(req.headers["content-type"] ?? "").split(";")[0].trim(),
        fileName: typeof q.fileName === "string" && q.fileName.trim() ? q.fileName : null,
        documentType: typeof q.documentType === "string" && q.documentType.trim() ? q.documentType : null,
        note: typeof q.note === "string" && q.note.trim() ? q.note : null,
        subjectKey: typeof q.subjectKey === "string" && q.subjectKey.trim() ? q.subjectKey : null,
        subjectLabel: typeof q.subjectLabel === "string" && q.subjectLabel.trim() ? q.subjectLabel : null,
      });
      res.status(201).json(created);
    } catch (e) {
      next(e);
    }
  },
);

/** Arrival guest-detail table: save one party member's typed details (upsert per slot). */
guestProfilesRouter.put(
  "/entries/:id/identity-details",
  requireActorLevel("L1"),
  validateBody(saveGuestIdentityDetailRequestSchema),
  async (req, res, next) => {
    try {
      const saved = await identityProofService.saveGuestIdentityDetail(prisma, req.params.id, req.actor!.actorId, req.body);
      res.json(saved);
    } catch (e) {
      next(e);
    }
  },
);

guestProfilesRouter.get("/entries/:id/identity-proofs", requireActorLevel("L1"), async (req, res, next) => {
  try {
    res.json(await identityProofService.listIdentityProofsForEntry(prisma, req.params.id));
  } catch (e) {
    next(e);
  }
});

guestProfilesRouter.get("/identity-proofs/:id/file", requireActorLevel("L1"), async (req, res, next) => {
  try {
    const f = await identityProofService.readIdentityProofFile(prisma, req.params.id);
    res.setHeader("Content-Type", f.mimeType);
    res.setHeader("Content-Disposition", `inline; filename="${f.fileName.replace(/"/g, "")}"`);
    // A guest's ID must never land in a shared cache.
    res.setHeader("Cache-Control", "private, no-store");
    res.send(f.bytes);
  } catch (e) {
    next(e);
  }
});

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
