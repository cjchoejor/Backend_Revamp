-- S8 key return: record how many keys were declared LOST, not just how many came back.
--
-- Existing rows default to 0. That is correct and not a guess: every record written before this
-- migration was created by a UI that offered no way to declare a loss, so no historical shortfall
-- was ever asserted to be a loss — it stayed free text in reconciliationNote.
ALTER TABLE "key_return_records"
  ADD COLUMN "keyCountLost" INTEGER NOT NULL DEFAULT 0;

-- A key cannot be both returned and lost, and neither can exceed what was issued.
ALTER TABLE "key_return_records"
  ADD CONSTRAINT "key_return_counts_within_issued"
  CHECK ("keyCountReturned" + "keyCountLost" <= "keyCountIssued");
