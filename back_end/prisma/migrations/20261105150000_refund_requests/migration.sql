-- Money that has to go back to a guest, and what the desk answered about an earlier pass's advance.
ALTER TABLE "folios" ADD COLUMN "earlierAdvanceAnswer" JSONB;

CREATE TABLE "refund_requests" (
    "id" TEXT NOT NULL,
    "entryId" TEXT NOT NULL,
    "folioId" TEXT NOT NULL,
    "cause" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'WAITING',
    "amountAsked" DECIMAL(15,2) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'BTN',
    "note" TEXT,
    "stage" "Stage",
    "raisedBy" TEXT NOT NULL,
    "raisedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "paidOnInvoiceId" TEXT,
    "refundedAmount" DECIMAL(15,2),
    "refundMethod" TEXT,
    "bankName" TEXT,
    "accountNumber" TEXT,
    "journalNumber" TEXT,
    "paymentRecordId" TEXT,
    "closeNote" TEXT,
    "closedBy" TEXT,
    "closedAt" TIMESTAMP(3),

    CONSTRAINT "refund_requests_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "refund_request_cause" CHECK ("cause" IN ('RENEGOTIATED', 'LAPSED')),
    CONSTRAINT "refund_request_status" CHECK ("status" IN ('WAITING', 'REFUNDED', 'KEPT', 'CANCELLED')),
    CONSTRAINT "refund_request_amount_positive" CHECK ("amountAsked" > 0),
    CONSTRAINT "refund_request_refunded_positive" CHECK ("refundedAmount" IS NULL OR "refundedAmount" > 0),
    CONSTRAINT "refund_request_refunded_not_above_asked" CHECK ("refundedAmount" IS NULL OR "refundedAmount" <= "amountAsked")
);

CREATE UNIQUE INDEX "refund_requests_paymentRecordId_key" ON "refund_requests"("paymentRecordId");
CREATE INDEX "refund_requests_status_raisedAt_idx" ON "refund_requests"("status", "raisedAt");
CREATE INDEX "refund_requests_entryId_idx" ON "refund_requests"("entryId");
CREATE INDEX "refund_requests_folioId_idx" ON "refund_requests"("folioId");
-- One waiting refund per bill: a second would count the same money twice.
CREATE UNIQUE INDEX "refund_requests_one_waiting_per_folio" ON "refund_requests"("folioId") WHERE "status" = 'WAITING';

ALTER TABLE "refund_requests" ADD CONSTRAINT "refund_requests_entryId_fkey" FOREIGN KEY ("entryId") REFERENCES "entries"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "refund_requests" ADD CONSTRAINT "refund_requests_folioId_fkey" FOREIGN KEY ("folioId") REFERENCES "folios"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
