-- Photo/scan capture on guest identity documents (2026-08-10).
-- The table previously held only TYPED document data (type/number/country/expiry, written at
-- S6 identity verification). It now also carries file rows: a photo or scan taken at the desk
-- (S5 Arrival), whose bytes live in the write-once document store (STORAGE_ROOT_DIR) — the row
-- stores only the pointer + integrity data. documentNumber relaxes to nullable because a
-- photo-first capture stores the image before anyone types the number.

ALTER TABLE "guest_identity_documents" ALTER COLUMN "documentNumber" DROP NOT NULL;

ALTER TABLE "guest_identity_documents" ADD COLUMN "entryId" TEXT;
ALTER TABLE "guest_identity_documents" ADD COLUMN "fileName" TEXT;
ALTER TABLE "guest_identity_documents" ADD COLUMN "mimeType" TEXT;
ALTER TABLE "guest_identity_documents" ADD COLUMN "sizeBytes" INTEGER;
ALTER TABLE "guest_identity_documents" ADD COLUMN "storageKey" TEXT;
ALTER TABLE "guest_identity_documents" ADD COLUMN "checksum" TEXT;
ALTER TABLE "guest_identity_documents" ADD COLUMN "checksumAlgo" TEXT NOT NULL DEFAULT 'SHA-256';
ALTER TABLE "guest_identity_documents" ADD COLUMN "note" TEXT;

CREATE UNIQUE INDEX "guest_identity_documents_storageKey_key" ON "guest_identity_documents"("storageKey");
CREATE INDEX "guest_identity_documents_entryId_idx" ON "guest_identity_documents"("entryId");

-- ON UPDATE CASCADE matches the readable-ID convention for FKs into entries.
ALTER TABLE "guest_identity_documents" ADD CONSTRAINT "guest_identity_documents_entryId_fkey"
  FOREIGN KEY ("entryId") REFERENCES "entries"("id") ON DELETE SET NULL ON UPDATE CASCADE;
