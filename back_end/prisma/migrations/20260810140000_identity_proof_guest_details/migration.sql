-- Guest-detail table on Arrival (2026-08-10): per-guest typed details — DOB + gender as read
-- off the document (passport/permit number reuses documentNumber). They live on the
-- per-(entry, subjectKey) DETAIL row (storageKey IS NULL); photo rows stay separate.

ALTER TABLE "guest_identity_documents" ADD COLUMN "dateOfBirth" TIMESTAMP(3);
ALTER TABLE "guest_identity_documents" ADD COLUMN "gender" TEXT;
