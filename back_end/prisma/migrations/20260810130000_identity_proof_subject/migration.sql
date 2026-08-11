-- "Store ID proof of every guest" (2026-08-10): a proof row now records WHICH PERSON in the
-- booking's party it belongs to. Companions have no GuestProfile rows (the party is counts +
-- ages on the Entry), so the subject lives on the proof itself: subjectKey is the party slot
-- (guest-board keys — A0..An adults, K0..Km children; NULL = unassigned/legacy) and
-- subjectLabel is the operator-recorded name/label.

ALTER TABLE "guest_identity_documents" ADD COLUMN "subjectKey" TEXT;
ALTER TABLE "guest_identity_documents" ADD COLUMN "subjectLabel" TEXT;
