-- A charge on the agency's share corrected after the bill was settled, before the agency paid
-- (2026-11-26): a money-out row of method VOUCHER that makes the voucher cover less.
ALTER TABLE "payment_records" ADD COLUMN "voucherReducedId" TEXT;
CREATE INDEX "payment_records_voucherReducedId_idx" ON "payment_records"("voucherReducedId");
ALTER TABLE "payment_records" ADD CONSTRAINT "payment_records_voucher_reduced_is_out"
  CHECK ("voucherReducedId" IS NULL OR ("paymentDirection" = 'OUT' AND "paymentMethod" = 'VOUCHER'));
