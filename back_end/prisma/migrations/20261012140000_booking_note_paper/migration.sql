-- A note can belong to a paper (2026-10-12): the internal note typed when a quotation is sent.
ALTER TABLE "booking_notes" ADD COLUMN "paperKind" TEXT;
ALTER TABLE "booking_notes" ADD COLUMN "paperId" TEXT;
CREATE INDEX "booking_notes_entryId_paperId_idx" ON "booking_notes"("entryId", "paperId");
