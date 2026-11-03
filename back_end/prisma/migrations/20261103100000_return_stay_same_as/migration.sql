-- A return stay set up "the same as" another stay of its enquiry (2026-11-03): the stay it copies,
-- and what was last copied. A soft link, like splitFromEntryId.
ALTER TABLE "entries" ADD COLUMN "followsEntryId" TEXT;
ALTER TABLE "entries" ADD COLUMN "followState" JSONB;
CREATE INDEX "entries_followsEntryId_idx" ON "entries"("followsEntryId");
