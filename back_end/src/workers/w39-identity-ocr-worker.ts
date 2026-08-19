import type { PrismaClient } from "@prisma/client";
import { runServerExtractionForPhoto } from "../services/domain/identity-ocr-service.js";

/**
 * W39 — identity OCR / QR extraction over a stored ID photo (2026-08-18).
 *
 * Enqueued by `storeIdentityProof` after every upload (desk or phone) and by the manual
 * re-run route. Runs the local pipeline (QR decode → MRZ OCR) and stores a SUGGESTION row;
 * the desk operator applies it. Best-effort: a photo the phone already extracted from is
 * skipped, `OCR_DISABLE=true` skips everything, and any failure lands as a FAILED suggestion
 * rather than a retrying job (pg-boss must not hammer a broken image).
 */
export async function runIdentityOcrWorker(
  prisma: PrismaClient,
  input: { photoDocumentId?: string; actorId?: string; force?: boolean },
) {
  const photoDocumentId = typeof input.photoDocumentId === "string" ? input.photoDocumentId : undefined;
  if (!photoDocumentId) return { skipped: true, reason: "MISSING_PHOTO_ID" } as const;
  const actorId = typeof input.actorId === "string" && input.actorId ? input.actorId : "SYSTEM";
  try {
    const r = await runServerExtractionForPhoto(prisma, actorId, photoDocumentId, { force: input.force === true });
    return { skipped: r.skipped, reason: "reason" in r ? r.reason : undefined, status: r.suggestion?.status ?? null } as const;
  } catch (err) {
    console.warn(`[W39] identity OCR failed for ${photoDocumentId}:`, err instanceof Error ? err.message : err);
    return { skipped: true, reason: "ERROR" } as const;
  }
}
