-- Part of the advance, put against ONE room or space (2026-09-11, operator request:
-- "if there is advance paid, the guest can choose to use all or a percentage or some of the
-- advance paid amount, and note how much was deducted from the advance and what is left").
--
-- The advance is money the hotel ALREADY holds. It reduced the folio's balance at S3 and names
-- no room, because nobody knew then which room would run up a bill. So "take it out of what I
-- already paid" moves ATTRIBUTION, not money: the slice's paid rises, unappliedPayments falls,
-- the folio's balance does not move at all.
--
-- Hence a table of its own rather than a second PaymentRecord: an IN row would be summed again
-- by recomputeFolioOutstandingBalance and the hotel would believe it had been paid twice.

CREATE TABLE "advance_applications" (
  "id"           TEXT NOT NULL,
  "folioId"      TEXT NOT NULL,
  "entryId"      TEXT NOT NULL,
  "roomId"       TEXT,
  "spaceId"      TEXT,
  "amount"       DECIMAL(12,2) NOT NULL,
  "basis"        JSONB,
  "reason"       TEXT,
  "reversalOfId" TEXT,
  "stage"        "Stage",
  "appliedAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "appliedBy"    TEXT NOT NULL,
  CONSTRAINT "advance_applications_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "advance_applications_folioId_idx" ON "advance_applications"("folioId");
CREATE INDEX "advance_applications_entryId_idx" ON "advance_applications"("entryId");
CREATE INDEX "advance_applications_roomId_idx"  ON "advance_applications"("roomId");
CREATE INDEX "advance_applications_spaceId_idx" ON "advance_applications"("spaceId");

-- ON UPDATE CASCADE throughout, per the folio-line-id lesson: never assume a key is frozen.
ALTER TABLE "advance_applications" ADD CONSTRAINT "advance_applications_folioId_fkey"
  FOREIGN KEY ("folioId") REFERENCES "folios"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "advance_applications" ADD CONSTRAINT "advance_applications_roomId_fkey"
  FOREIGN KEY ("roomId") REFERENCES "rooms"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "advance_applications" ADD CONSTRAINT "advance_applications_spaceId_fkey"
  FOREIGN KEY ("spaceId") REFERENCES "spaces"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "advance_applications" ADD CONSTRAINT "advance_applications_reversalOfId_fkey"
  FOREIGN KEY ("reversalOfId") REFERENCES "advance_applications"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- EXACTLY one target, unlike a charge. An application to "the booking as a whole" is
-- meaningless — that is where the money already sits.
ALTER TABLE "advance_applications" ADD CONSTRAINT "advance_application_target_xor"
  CHECK (("roomId" IS NOT NULL) <> ("spaceId" IS NOT NULL));

-- Applying a negative amount would be a refund wearing an attribution's clothes.
ALTER TABLE "advance_applications" ADD CONSTRAINT "advance_application_amount_positive"
  CHECK ("amount" > 0);
