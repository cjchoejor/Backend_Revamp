-- Guest-detail confirmation (2026-08-21): a confirmed detail row is read-only on the desk
-- and refuses writes until explicitly unlocked. NULL = never confirmed (every existing row).
ALTER TABLE "guest_identity_documents" ADD COLUMN "detailsConfirmedAt" TIMESTAMP(3);
ALTER TABLE "guest_identity_documents" ADD COLUMN "detailsConfirmedBy" TEXT;
