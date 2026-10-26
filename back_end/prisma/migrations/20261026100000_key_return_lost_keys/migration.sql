-- S8 key return records a LOST key as a fact, and which room's it was (2026-10-26).
-- Ported from the user's own branch (4e36b65, 20260810090000_key_return_lost_count) and made
-- room-wise: the desk marks each room's key back or lost.
--
-- Existing rows default to 0 / none lost. That is correct and not a guess: every record written
-- before this was made by a desk that offered no way to declare a loss.
ALTER TABLE "key_return_records"
  ADD COLUMN "keyCountLost" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "lostRoomIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

-- A key cannot be both returned and lost, and neither can exceed what was issued.
ALTER TABLE "key_return_records"
  ADD CONSTRAINT "key_return_counts_within_issued"
  CHECK ("keyCountReturned" + "keyCountLost" <= "keyCountIssued");

-- The room's own key stamp: lost at the S8 key return. A lost key is no longer out with the guest.
ALTER TABLE "room_assignments"
  ADD COLUMN "keyLostAt" TIMESTAMP(3),
  ADD COLUMN "keyLostBy" TEXT;
