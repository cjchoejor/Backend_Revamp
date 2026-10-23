-- A booking split off another (2026-10-14): the soft link to it, and what it carried.
ALTER TABLE "entries" ADD COLUMN "splitFromEntryId" TEXT;
ALTER TABLE "entries" ADD COLUMN "carryOver" JSONB;
CREATE INDEX "entries_splitFromEntryId_idx" ON "entries"("splitFromEntryId");
