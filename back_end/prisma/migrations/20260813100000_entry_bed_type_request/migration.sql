-- Bed-setup breakdown of the S1 room request (2026-08-13, operator request:
-- "sometimes the guest asks for 5 King and 2 Twin"). Flat JSON map bedType -> count.
ALTER TABLE "entries" ADD COLUMN "bedTypeRequest" JSONB;
