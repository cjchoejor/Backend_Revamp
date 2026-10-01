-- How a booking ended, and what was said (2026-10-01).
-- Until now the desk could only print the bare status word, so a lead the guest turned down,
-- an enquiry nobody ever answered and a negotiation that stalled all read the same.
ALTER TABLE "entries" ADD COLUMN "closedAs" TEXT;
ALTER TABLE "entries" ADD COLUMN "closedReason" TEXT;
