-- Money moved from one stay's bill to another's when a stay of a trip is cancelled (2026-11-09).
-- One money-out row and one money-in row share a reference; together they move no money.
ALTER TABLE "payment_records" ADD COLUMN "tripTransferRef" TEXT;
CREATE INDEX "payment_records_tripTransferRef_idx" ON "payment_records"("tripTransferRef");
