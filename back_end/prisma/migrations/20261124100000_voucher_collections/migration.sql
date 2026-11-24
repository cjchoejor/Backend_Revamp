-- The agency's money for a voucher taken at check-out (2026-11-24). Not a payment on the guest's
-- bill: the voucher already counted as paid there. One row per voucher.
CREATE TABLE "voucher_collections" (
    "id" TEXT NOT NULL,
    "paymentRecordId" TEXT NOT NULL,
    "folioId" TEXT NOT NULL,
    "entryId" TEXT,
    "amount" DECIMAL(15,2) NOT NULL,
    "receivedOn" DATE NOT NULL,
    "paymentMethod" TEXT NOT NULL,
    "bankName" TEXT,
    "journalNumber" TEXT,
    "reference" TEXT,
    "notes" TEXT,
    "batchId" TEXT NOT NULL,
    "recordedBy" TEXT NOT NULL,
    "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "voucher_collections_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "voucher_collections_amount_positive" CHECK ("amount" > 0)
);

CREATE UNIQUE INDEX "voucher_collections_paymentRecordId_key" ON "voucher_collections"("paymentRecordId");
CREATE INDEX "voucher_collections_batchId_idx" ON "voucher_collections"("batchId");
CREATE INDEX "voucher_collections_folioId_idx" ON "voucher_collections"("folioId");

ALTER TABLE "voucher_collections" ADD CONSTRAINT "voucher_collections_paymentRecordId_fkey"
    FOREIGN KEY ("paymentRecordId") REFERENCES "payment_records"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
