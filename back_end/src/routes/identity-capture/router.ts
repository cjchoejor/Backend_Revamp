import express, { Router } from "express";
import { prisma } from "../../db.js";
import { AuthorizationError, ValidationError } from "../../lib/errors.js";
import { verifyIdentityCaptureToken } from "../../lib/identity-capture-token.js";
import * as identityProofService from "../../services/domain/guest-identity-proof-service.js";

/**
 * Phone identity-capture routes (2026-08-12) — the endpoints behind the QR code the desk
 * shows to hand ID-photo capture to a phone. Mounted BEFORE `parseActorHeaders()` in the API
 * router: the phone has no staff session, so the short-lived scoped capture token (see
 * `lib/identity-capture-token.ts`) is the whole credential — upload-only, one entry, one
 * party slot, attributed to the operator who minted it. Everything else about the upload is
 * identical to the authenticated desk route: same `storeIdentityProof` service, same 10MB
 * cap and mime allowlist, same write-once store, same trace.
 */

export const identityCaptureRouter = Router();

function requireToken(raw: unknown) {
  const payload = verifyIdentityCaptureToken(typeof raw === "string" ? raw : null);
  if (!payload) {
    throw new AuthorizationError(
      "This capture link is invalid or has expired — ask the desk to show a fresh QR code",
    );
  }
  return payload;
}

/** What the phone page shows before the camera opens: whose ID, for which booking — and in
 *  all-guests mode the full party roster, one row per slot with per-slot photo counts. */
identityCaptureRouter.get("/identity-capture/context", async (req, res, next) => {
  try {
    const payload = requireToken(req.query.token);
    const entry = await prisma.entry.findUnique({
      where: { id: payload.entryId },
      select: { id: true, status: true },
    });
    if (!entry) throw new AuthorizationError("This capture link points at a booking that no longer exists");
    const sealed = entry.status === "EXPIRED" || entry.status === "CANCELLED" || entry.status === "CLOSED";
    // The roster carries per-slot labels, photo counts and the seated room; single-slot
    // tokens use it too, just reduced to their one pinned guest.
    const fullRoster = await identityProofService.phoneCaptureRoster(prisma, entry.id).catch(() => null);
    const roster = payload.allSlots ? (fullRoster ?? []) : null;
    const pinned = !payload.allSlots && payload.subjectKey ? fullRoster?.find((s) => s.key === payload.subjectKey) : null;
    const uploadedCount = roster
      ? roster.reduce((n, s) => n + s.photoCount, 0)
      : payload.subjectKey
        ? await prisma.guestIdentityDocument.count({
            where: { entryId: entry.id, subjectKey: payload.subjectKey, storageKey: { not: null } },
          })
        : 0;
    res.json({
      entryId: entry.id,
      subjectKey: payload.subjectKey,
      subjectLabel: payload.subjectLabel,
      sealed,
      uploadedCount,
      roster,
      /** The pinned guest's seated room on single-slot tokens (null in all-guests mode —
       *  each roster row carries its own). */
      room: pinned?.room ?? null,
    });
  } catch (e) {
    next(e);
  }
});

/** The upload itself — raw file bytes as the body, exactly like the desk route. */
identityCaptureRouter.post(
  "/identity-capture/upload",
  express.raw({ type: ["image/*", "application/pdf", "application/octet-stream"], limit: "12mb" }),
  async (req, res, next) => {
    try {
      const payload = requireToken(req.query.token);
      if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
        throw new ValidationError(
          "Send the file bytes as the raw request body with Content-Type set to the file's type (e.g. image/jpeg)",
        );
      }
      const q = req.query;
      // Which guest the photo files under: a single-slot token pins it — the phone can't pick
      // another. An all-guests token names one slot per photo, validated against the entry's
      // derived party so nothing can file outside it; the label is server-resolved (the typed
      // name when the desk has one) rather than trusted from the phone.
      let subjectKey = payload.subjectKey;
      let subjectLabel = payload.subjectLabel;
      if (payload.allSlots) {
        const picked = typeof q.subjectKey === "string" ? q.subjectKey.trim() : "";
        if (!picked) throw new ValidationError("Say which guest this photo belongs to (subjectKey)");
        const roster = await identityProofService.phoneCaptureRoster(prisma, payload.entryId);
        const slot = roster.find((s) => s.key === picked);
        if (!slot) throw new ValidationError("That guest is not part of this booking's party");
        subjectKey = slot.key;
        subjectLabel = slot.label;
      }
      const created = await identityProofService.storeIdentityProof(prisma, payload.entryId, payload.mintedBy, {
        bytes: req.body,
        mimeType: String(req.headers["content-type"] ?? "").split(";")[0].trim(),
        fileName: typeof q.fileName === "string" && q.fileName.trim() ? q.fileName : null,
        note: "Captured on a phone via QR handoff",
        subjectKey,
        subjectLabel,
      });
      // Trimmed response — the phone page needs a receipt, not the row internals.
      res.status(201).json({
        id: created.id,
        subjectKey: created.subjectKey,
        subjectLabel: created.subjectLabel,
        capturedAt: created.capturedAt,
      });
    } catch (e) {
      next(e);
    }
  },
);
