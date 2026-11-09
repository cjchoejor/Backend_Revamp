-- Money the desk recorded as one payment for a whole trip (2026-11-09). What it pays beyond one
-- stay's advance counts towards the other stays' advances; money paid on a stay's own page does not.
ALTER TABLE "payment_records" ADD COLUMN "paidForTrip" BOOLEAN NOT NULL DEFAULT false;

-- Every trip payment so far was written with these words by the system.
UPDATE "payment_records" SET "paidForTrip" = true
WHERE "paymentDirection" = 'IN' AND "notes" LIKE 'Part of Nu % paid for the trip (%';
