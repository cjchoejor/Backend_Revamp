-- How the guest came in, in its own column (2026-09-18). Filled for existing rows by
-- scripts/backfill-inquiry-came-in-as.ts, which reads the old channel + note-marker encoding.
CREATE TYPE "InquiryCameInAs" AS ENUM ('WALK_IN', 'DIRECT_VOICE', 'DIRECT_ONLINE', 'OTA', 'TRAVEL_AGENT', 'CORPORATE', 'GROUP_MICE');

ALTER TABLE "inquiries" ADD COLUMN "cameInAs" "InquiryCameInAs";
