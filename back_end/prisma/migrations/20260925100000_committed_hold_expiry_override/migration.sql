-- The desk's own hold time for one booking (2026-09-25, operator request).
--
-- The committed hold has always run for the house window (`registry.holdExpiry.minutes`, else
-- `expiry.s3.committedHoldTtlSeconds`) counted from the moment it was placed. The guest who says
-- "I'll confirm by six" had nowhere to be recorded, so the desk could only watch the hour lapse
-- and place the hold again. These columns remember that moment ON THE BOOKING, so a hold placed
-- again later — after a re-entry, or after the first one ran out — runs to the same time instead
-- of falling back to the house window.
ALTER TABLE "entries" ADD COLUMN "holdExpiresAtOverride" TIMESTAMP(3);
ALTER TABLE "entries" ADD COLUMN "holdExpiryOverrideSetBy" TEXT;
ALTER TABLE "entries" ADD COLUMN "holdExpiryOverrideSetAt" TIMESTAMP(3);
