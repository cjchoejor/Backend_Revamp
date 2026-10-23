-- A photo taken off its guest's row (2026-10-23). The file stays in the store; the row stops showing it.
ALTER TABLE "guest_identity_documents" ADD COLUMN "clearedAt" TIMESTAMP(3), ADD COLUMN "clearedBy" TEXT;
