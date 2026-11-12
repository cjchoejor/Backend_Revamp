-- The bank and the journal number of money through a bank (2026-11-12).
ALTER TABLE "payment_records" ADD COLUMN "bankName" TEXT;
ALTER TABLE "payment_records" ADD COLUMN "journalNumber" TEXT;
