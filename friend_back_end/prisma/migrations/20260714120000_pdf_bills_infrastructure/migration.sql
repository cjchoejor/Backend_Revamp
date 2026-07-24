-- Migration: 20260714120000_pdf_bills_infrastructure
-- Purpose: PDF artifact + line-item snapshot infrastructure for guest-facing bills.
--
-- Adds:
--   * Six write-once artifact columns on Invoice + Quotation + Reservation.
--   * InvoiceLine / QuotationLine tables — immutable bill-line snapshots.
--   * HotelProfile: accountNumber, tpnNumber, gstTpnNumber, logoStorageKey (Bhutanese
--     invoice legal fields).
--   * RateCard.rateIsTaxInclusive — friend's #6 concern; back-solves base rate when true.
--   * InvoiceIntegrityCheck — append-only audit log of SHA-256 verifications.
-- All artifact columns are nullable; existing rows survive with NULLs and stay valid.

-- AlterTable
ALTER TABLE "hotel_profile" ADD COLUMN     "accountNumber" TEXT,
ADD COLUMN     "gstTpnNumber" TEXT,
ADD COLUMN     "logoStorageKey" TEXT,
ADD COLUMN     "tpnNumber" TEXT;

-- AlterTable
ALTER TABLE "invoices" ADD COLUMN     "pdfChecksum" TEXT,
ADD COLUMN     "pdfChecksumAlgo" TEXT NOT NULL DEFAULT 'SHA-256',
ADD COLUMN     "pdfRenderedAt" TIMESTAMP(3),
ADD COLUMN     "pdfRenderedBy" TEXT,
ADD COLUMN     "pdfStorageKey" TEXT,
ADD COLUMN     "renderInputSnapshot" JSONB;

-- AlterTable
ALTER TABLE "quotations" ADD COLUMN     "pdfChecksum" TEXT,
ADD COLUMN     "pdfChecksumAlgo" TEXT NOT NULL DEFAULT 'SHA-256',
ADD COLUMN     "pdfRenderedAt" TIMESTAMP(3),
ADD COLUMN     "pdfRenderedBy" TEXT,
ADD COLUMN     "pdfStorageKey" TEXT,
ADD COLUMN     "renderInputSnapshot" JSONB;

-- AlterTable
ALTER TABLE "rate_cards" ADD COLUMN     "rateIsTaxInclusive" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "reservations" ADD COLUMN     "confirmationVoucherChecksum" TEXT,
ADD COLUMN     "confirmationVoucherChecksumAlgo" TEXT NOT NULL DEFAULT 'SHA-256',
ADD COLUMN     "confirmationVoucherInputSnapshot" JSONB,
ADD COLUMN     "confirmationVoucherRenderedAt" TIMESTAMP(3),
ADD COLUMN     "confirmationVoucherRenderedBy" TEXT,
ADD COLUMN     "confirmationVoucherStorageKey" TEXT;

-- CreateTable
CREATE TABLE "invoice_lines" (
    "id" TEXT NOT NULL,
    "invoiceId" TEXT NOT NULL,
    "lineNumber" INTEGER NOT NULL,
    "particular" TEXT NOT NULL,
    "roomNo" TEXT,
    "nights" INTEGER,
    "rate" DECIMAL(15,2) NOT NULL,
    "amount" DECIMAL(15,2) NOT NULL,
    "discountAmount" DECIMAL(15,2) NOT NULL DEFAULT 0,
    "serviceChargeAmount" DECIMAL(15,2) NOT NULL DEFAULT 0,
    "gstAmount" DECIMAL(15,2) NOT NULL DEFAULT 0,
    "currency" TEXT NOT NULL DEFAULT 'BTN',
    "folioLineId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "invoice_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "quotation_lines" (
    "id" TEXT NOT NULL,
    "quotationId" TEXT NOT NULL,
    "lineNumber" INTEGER NOT NULL,
    "date" TIMESTAMP(3) NOT NULL,
    "occupants" TEXT NOT NULL,
    "mealPlan" TEXT,
    "extraBeds" TEXT,
    "amount" DECIMAL(15,2) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'BTN',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "quotation_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invoice_integrity_checks" (
    "id" TEXT NOT NULL,
    "invoiceId" TEXT NOT NULL,
    "checkedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expectedHash" TEXT NOT NULL,
    "actualHash" TEXT NOT NULL,
    "matched" BOOLEAN NOT NULL,
    "diagnostic" JSONB,

    CONSTRAINT "invoice_integrity_checks_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "invoice_lines_invoiceId_lineNumber_key" ON "invoice_lines"("invoiceId", "lineNumber");

-- CreateIndex
CREATE UNIQUE INDEX "quotation_lines_quotationId_lineNumber_key" ON "quotation_lines"("quotationId", "lineNumber");

-- CreateIndex
CREATE INDEX "invoice_integrity_checks_invoiceId_checkedAt_idx" ON "invoice_integrity_checks"("invoiceId", "checkedAt");

-- CreateIndex
CREATE INDEX "invoice_integrity_checks_matched_checkedAt_idx" ON "invoice_integrity_checks"("matched", "checkedAt");

-- AddForeignKey
ALTER TABLE "invoice_lines" ADD CONSTRAINT "invoice_lines_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "invoices"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quotation_lines" ADD CONSTRAINT "quotation_lines_quotationId_fkey" FOREIGN KEY ("quotationId") REFERENCES "quotations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

