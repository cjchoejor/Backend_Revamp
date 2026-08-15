-- Per-room key lifecycle (2026-08-14): a key is issued per room on the day the guest
-- actually enters it, and a sequential room change is a key SWAP — the vacated room's
-- key comes back before the new room's key goes out. Stamps live on the assignment row
-- because that row IS the (room, date-range) claim the key covers.
ALTER TABLE "room_assignments"
  ADD COLUMN "keyIssuedAt" TIMESTAMP(3),
  ADD COLUMN "keyIssuedBy" TEXT,
  ADD COLUMN "keyReturnedAt" TIMESTAMP(3),
  ADD COLUMN "keyReturnedBy" TEXT;
