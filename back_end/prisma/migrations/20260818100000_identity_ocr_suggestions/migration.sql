-- OCR / QR extraction suggestions for stored ID photos (2026-08-18). One row per photo,
-- suggestion-only (the desk applies it through the normal guest-detail save); cascades with
-- the photo row so the retention purge disposes of both.
CREATE TABLE "identity_ocr_suggestions" (
  "id" TEXT NOT NULL,
  "photoDocumentId" TEXT NOT NULL,
  "entryId" TEXT NOT NULL,
  "subjectKey" TEXT,
  "engine" TEXT NOT NULL,
  "status" TEXT NOT NULL,
  "fields" JSONB,
  "fieldConfidence" JSONB,
  "raw" JSONB,
  "error" TEXT,
  "extractedAt" TIMESTAMP(3),
  "appliedAt" TIMESTAMP(3),
  "appliedBy" TEXT,
  "dismissedAt" TIMESTAMP(3),
  "dismissedBy" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "identity_ocr_suggestions_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "identity_ocr_suggestions_photoDocumentId_key" ON "identity_ocr_suggestions"("photoDocumentId");
CREATE INDEX "identity_ocr_suggestions_entryId_status_idx" ON "identity_ocr_suggestions"("entryId", "status");
ALTER TABLE "identity_ocr_suggestions"
  ADD CONSTRAINT "identity_ocr_suggestions_photoDocumentId_fkey" FOREIGN KEY ("photoDocumentId")
  REFERENCES "guest_identity_documents"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "identity_ocr_suggestions"
  ADD CONSTRAINT "identity_ocr_suggestions_entryId_fkey" FOREIGN KEY ("entryId")
  REFERENCES "entries"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
