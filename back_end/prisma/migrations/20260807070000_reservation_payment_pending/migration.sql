-- Held-vs-Reserved by payment confidence (2026-08-07): a booking confirmed with the advance
-- still short (remainder promised before/at check-in) keeps its rooms "Held" rather than
-- "Reserved" until the money lands. Same inventory block; different label + escalation.
ALTER TABLE "entries" ADD COLUMN "reservationPaymentPending" BOOLEAN NOT NULL DEFAULT false;
