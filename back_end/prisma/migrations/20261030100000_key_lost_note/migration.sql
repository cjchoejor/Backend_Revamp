-- Each lost key's own reason, on the room it belongs to (2026-10-30).
ALTER TABLE "room_assignments" ADD COLUMN "keyLostNote" TEXT;
