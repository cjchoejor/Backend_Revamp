-- Multi-room speculative holds (2026-08-06): snapshot of the sealed per-night selection at
-- placement, same shape as "committed_holds"."perNightBreakdown". Null on legacy/single-room
-- holds, which keep covering "roomId" across the entry's stay.
ALTER TABLE "speculative_holds" ADD COLUMN "perNightBreakdown" JSONB;
