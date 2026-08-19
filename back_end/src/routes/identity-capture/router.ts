import express, { Router } from "express";
import { prisma } from "../../db.js";
import { AuthorizationError, ValidationError } from "../../lib/errors.js";
import { verifyIdentityCaptureToken } from "../../lib/identity-capture-token.js";
import * as identityProofService from "../../services/domain/guest-identity-proof-service.js";
import * as identityOcrService from "../../services/domain/identity-ocr-service.js";
import { phoneIdentityExtractionRequestSchema } from "../../dtos/14-guest-profiles/request-schemas.js";

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
      // Document-type vocabulary for the phone's detected-fields form (2026-08-18) — the same
      // config-driven list the desk table offers, so the phone can never suggest a code the
      // hotel does not accept.
      documentTypes: await identityProofService.listIdentityDocumentTypeOptions(prisma).catch(() => []),
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
      // Server-side extraction fallback (2026-08-18): the phone normally follows the upload with
      // its own reading (`?extractionFollows=1`), so give it a head start — the W39 pass skips a
      // photo that already carries a phone suggestion. A phone that can't extract (old browser,
      // no model) says nothing and the server reads the bytes right away.
      const extractionFollows = q.extractionFollows === "1" || q.extractionFollows === "true";
      void (async () => {
        if (identityOcrService.serverOcrDisabled()) return;
        try {
          const engine = await (await import("../../services/infrastructure/timer-management-service.js")).getTimerEngine();
          await engine.schedule(
            "IDENTITY_OCR_W39",
            { photoDocumentId: created.id, actorId: payload.mintedBy },
            { startAfter: new Date(Date.now() + (extractionFollows ? 45_000 : 0)) },
          );
        } catch (err) {
          console.warn("[identity-capture] could not enqueue W39:", err instanceof Error ? err.message : err);
        }
      })();
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

/**
 * Phone-side extraction (2026-08-18): what the phone read off the document — the RAW MRZ
 * lines / QR text it decoded (the server re-parses them; the phone's interpretation is never
 * trusted) plus the fields the person confirmed or corrected on the phone. Lands as a
 * SUGGESTION on the desk's guest-detail table, never as a write. Same token as the upload;
 * the photo must belong to the token's booking (and, on a single-slot token, its slot).
 */
identityCaptureRouter.post("/identity-capture/extraction", express.json({ limit: "64kb" }), async (req, res, next) => {
  try {
    const payload = requireToken(req.query.token);
    const parsed = phoneIdentityExtractionRequestSchema.safeParse(req.body);
    if (!parsed.success) throw new ValidationError(parsed.error.issues.map((i) => i.message).join("; "));
    const body = parsed.data;
    const photo = await prisma.guestIdentityDocument.findUnique({
      where: { id: body.photoDocumentId },
      select: { id: true, entryId: true, subjectKey: true, storageKey: true },
    });
    if (!photo?.storageKey || photo.entryId !== payload.entryId) throw new AuthorizationError("That photo is not part of this capture");
    if (!payload.allSlots && payload.subjectKey && photo.subjectKey !== payload.subjectKey) {
      throw new AuthorizationError("That photo belongs to a different guest than this code");
    }
    const suggestion = await identityOcrService.ingestPhoneExtraction(prisma, payload.mintedBy, {
      photoDocumentId: photo.id,
      mrzLines: body.mrzLines ?? null,
      qrText: body.qrText ?? null,
      fields: (body.fields ?? null) as Record<string, string | null | undefined> | null,
    });
    res.status(201).json({
      id: suggestion.id,
      status: suggestion.status,
      engine: suggestion.engine,
      fields: suggestion.fields,
      fieldConfidence: suggestion.fieldConfidence,
    });
  } catch (e) {
    next(e);
  }
});

/**
 * Full-image analysis of the photo the phone is PREVIEWING (no storage) — the phone's own
 * pass only covers QR + MRZ; this runs the whole server pipeline (QR → MRZ → Florence-2
 * layout) so label documents auto-fill the phone's form BEFORE sending. Slow is expected
 * (the layout engine takes ~10–20 s); the phone shows its analysing spinner throughout.
 */
identityCaptureRouter.post(
  "/identity-capture/analyze",
  express.raw({ type: ["image/*", "application/pdf", "application/octet-stream"], limit: "12mb" }),
  async (req, res, next) => {
    try {
      const payload = requireToken(req.query.token);
      if (!Buffer.isBuffer(req.body) || req.body.length === 0) {
        throw new ValidationError("Send the image bytes as the raw request body with the file's Content-Type");
      }
      // subjectKey is only a kind HINT here (which layout to anchor first) — the upload
      // route is where slot claims are validated.
      const subjectKey = payload.subjectKey ?? (typeof req.query.subjectKey === "string" ? req.query.subjectKey : null);
      const result = await identityOcrService.analyzeIdentityImage(prisma, req.body, {
        entryId: payload.entryId,
        subjectKey,
      });
      res.json(result);
    } catch (e) {
      next(e);
    }
  },
);

/** Parse-only preview of what the phone read (no storage) — see `previewPhoneExtraction`. */
identityCaptureRouter.post("/identity-capture/parse", express.json({ limit: "64kb" }), async (req, res, next) => {
  try {
    requireToken(req.query.token);
    const b = (req.body ?? {}) as { ocrText?: unknown; mrzLines?: unknown; qrText?: unknown };
    const ocrText = typeof b.ocrText === "string" ? b.ocrText.slice(0, 20_000) : null;
    const qrText = typeof b.qrText === "string" ? b.qrText.slice(0, 20_000) : null;
    const mrzLines = Array.isArray(b.mrzLines) ? b.mrzLines.filter((l): l is string => typeof l === "string").slice(0, 3) : null;
    res.json(await identityOcrService.previewPhoneExtraction(prisma, { ocrText, mrzLines, qrText }));
  } catch (e) {
    next(e);
  }
});
