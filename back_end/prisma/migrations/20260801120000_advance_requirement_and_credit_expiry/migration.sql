-- Operator-set per-booking advance requirement (overrides advancePayment.thresholds config)
ALTER TABLE "folios" ADD COLUMN "advanceRequiredAmount" DECIMAL(15,2);
ALTER TABLE "folios" ADD COLUMN "advanceRequiredBasis" JSONB;

-- Optional expiry on the FOM credit extension (read-time enforcement)
ALTER TABLE "credit_extension_ceiling_records" ADD COLUMN "expiresAt" TIMESTAMP(3);
