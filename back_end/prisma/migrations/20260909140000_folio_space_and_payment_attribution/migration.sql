-- PMS-237, groundwork: a charge and a payment can each say WHERE they belong.
--
-- Charges have carried `roomId` since 2026-08-14, but a conference hall is a Space, not a
-- Room — so conference charges fell into the same unattributed bucket as booking-wide fees
-- and "settle the conference, leave the rooms" could not be expressed. Payments carried no
-- place at all, so "room 202 is paid, 203 still owes" was unanswerable: a per-room balance is
-- that room's charges MINUS its payments, and only the charges half was attributed.

ALTER TABLE "folio_lines"    ADD COLUMN "spaceId" TEXT;
ALTER TABLE "payment_records" ADD COLUMN "roomId" TEXT;
ALTER TABLE "payment_records" ADD COLUMN "spaceId" TEXT;

CREATE INDEX "folio_lines_spaceId_idx"    ON "folio_lines"("spaceId");
CREATE INDEX "payment_records_roomId_idx"  ON "payment_records"("roomId");
CREATE INDEX "payment_records_spaceId_idx" ON "payment_records"("spaceId");

-- ON UPDATE CASCADE throughout: room and space ids are uuids today, but folio-line ids proved
-- readable ids get rewritten, so never assume a key is frozen.
ALTER TABLE "folio_lines" ADD CONSTRAINT "folio_lines_spaceId_fkey"
  FOREIGN KEY ("spaceId") REFERENCES "spaces"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "payment_records" ADD CONSTRAINT "payment_records_roomId_fkey"
  FOREIGN KEY ("roomId") REFERENCES "rooms"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "payment_records" ADD CONSTRAINT "payment_records_spaceId_fkey"
  FOREIGN KEY ("spaceId") REFERENCES "spaces"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- A charge belongs to ONE place, or to the booking as a whole — never both. Enforced in the
-- database rather than trusted from callers, same device as `deficient_target_xor`.
ALTER TABLE "folio_lines" ADD CONSTRAINT "folio_line_target_xor"
  CHECK (NOT ("roomId" IS NOT NULL AND "spaceId" IS NOT NULL));
ALTER TABLE "payment_records" ADD CONSTRAINT "payment_record_target_xor"
  CHECK (NOT ("roomId" IS NOT NULL AND "spaceId" IS NOT NULL));
