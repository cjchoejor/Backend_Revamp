-- Each confirmation voucher gets its own number, VOU-YYYYMMDD-NNNN (2026-10-13).
ALTER TABLE "reservations" ADD COLUMN "confirmationVoucherNumber" TEXT;

-- Number the vouchers already issued, by the day each was confirmed (UTC, as every readable id).
WITH numbered AS (
  SELECT "id",
         to_char("confirmedAt", 'YYYYMMDD') AS d,
         row_number() OVER (PARTITION BY to_char("confirmedAt", 'YYYYMMDD') ORDER BY "confirmedAt", "id") AS n
  FROM "reservations"
)
UPDATE "reservations" r
SET "confirmationVoucherNumber" = 'VOU-' || numbered.d || '-' || lpad(numbered.n::text, 4, '0')
FROM numbered
WHERE r."id" = numbered."id";

-- Carry the day counters on, so the next voucher of a day takes the number after the last one.
INSERT INTO "readable_id_sequences" ("prefix", "sequence_date", "last_value")
SELECT 'VOU', to_char("confirmedAt", 'YYYYMMDD'), count(*)
FROM "reservations"
GROUP BY to_char("confirmedAt", 'YYYYMMDD')
ON CONFLICT ("prefix", "sequence_date") DO UPDATE
SET "last_value" = GREATEST("readable_id_sequences"."last_value", EXCLUDED."last_value");

CREATE UNIQUE INDEX "reservations_confirmationVoucherNumber_key" ON "reservations"("confirmationVoucherNumber");
