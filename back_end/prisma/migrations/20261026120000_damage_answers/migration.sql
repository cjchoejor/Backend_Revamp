-- Damage found at a room inspection is answered (2026-10-26): charged, waived, or decided after
-- departure. Settlement waits for an answer; the seal waits for charged or waived.
ALTER TABLE "room_inspection_records"
  ADD COLUMN "damageAnswer" TEXT,
  ADD COLUMN "damageAnswerNote" TEXT,
  ADD COLUMN "damageAnsweredBy" TEXT,
  ADD COLUMN "damageAnsweredAt" TIMESTAMP(3),
  ADD COLUMN "damageFolioLineId" TEXT,
  ADD COLUMN "damageFaultId" TEXT;

ALTER TABLE "room_inspection_records"
  ADD CONSTRAINT "room_inspection_damage_answer_values"
  CHECK ("damageAnswer" IS NULL OR "damageAnswer" IN ('CHARGED', 'WAIVED', 'LATER'));

-- The desk's own tax choice on a charge (a damage charge may go on with or without service charge
-- and GST). NULL on every other line.
ALTER TABLE "folio_lines"
  ADD COLUMN "withServiceCharge" BOOLEAN,
  ADD COLUMN "withGst" BOOLEAN;
