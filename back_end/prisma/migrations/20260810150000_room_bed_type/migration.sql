-- Bed setup per ROOM (2026-08-10): KING / TWIN / QUEEN / SINGLE + bed count. Per room, not per
-- type — the legacy catalogue splits e.g. Family Apartment into (King) and (Twin) rooms.
-- Backfilled from scripts/import-data/legacy-bookings/room.csv (bed_size + no_of_beds).

ALTER TABLE "rooms" ADD COLUMN "bedType" TEXT;
ALTER TABLE "rooms" ADD COLUMN "bedCount" INTEGER;
