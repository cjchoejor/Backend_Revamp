-- Interim payments + stay extensions (2026-08-21, operator ruling): a long stay can be asked
-- for a part payment partway through (manual, or the night audit's schedule rule), and a stay
-- extension holds the extra nights, bills an interim invoice, takes the payment, THEN commits
-- through the governed room-change journey. The INTERIM invoice type carries the proforma's
-- dispatch → answer → money order at S7.
ALTER TYPE "InvoiceType" ADD VALUE 'INTERIM';
ALTER TYPE "CommunicationType" ADD VALUE 'INTERIM_INVOICE';

CREATE TYPE "InterimPaymentKind" AS ENUM ('LONG_STAY', 'EXTENSION');
CREATE TYPE "InterimPaymentState" AS ENUM ('SUGGESTED', 'REQUESTED', 'BILLED', 'PAID', 'WITHDRAWN', 'LAPSED');
CREATE TYPE "InterimPaymentPrompt" AS ENUM ('MANUAL', 'NIGHT_AUDIT');
CREATE TYPE "StayExtensionState" AS ENUM ('REQUESTED', 'BILLED', 'PAID', 'COMMITTED', 'LAPSED', 'WITHDRAWN');

CREATE TABLE "stay_extension_requests" (
  "id"                TEXT NOT NULL,
  "entryId"           TEXT NOT NULL,
  "segmentId"         TEXT,
  "state"             "StayExtensionState" NOT NULL DEFAULT 'REQUESTED',
  "priorCheckOutDate" TIMESTAMP(3) NOT NULL,
  "newCheckOutDate"   TIMESTAMP(3) NOT NULL,
  "extraNights"       JSONB NOT NULL,
  "roomCompositions"  JSONB,
  "requestedDiscount" JSONB,
  "pricingPreview"    JSONB,
  "reason"            TEXT NOT NULL,
  "holdExpiresAt"     TIMESTAMP(3) NOT NULL,
  "timerRecordId"     TEXT,
  "requestedBy"       TEXT NOT NULL,
  "requestedAt"       TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "committedAt"       TIMESTAMP(3),
  "committedBy"       TEXT,
  "outcome"           JSONB,
  "closedAt"          TIMESTAMP(3),
  "closedReason"      TEXT,
  "createdAt"         TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"         TIMESTAMP(3) NOT NULL,
  CONSTRAINT "stay_extension_requests_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "interim_payment_requests" (
  "id"                     TEXT NOT NULL,
  "entryId"                TEXT NOT NULL,
  "folioId"                TEXT NOT NULL,
  "segmentId"              TEXT,
  "kind"                   "InterimPaymentKind" NOT NULL,
  "state"                  "InterimPaymentState" NOT NULL DEFAULT 'REQUESTED',
  "promptedBy"             "InterimPaymentPrompt" NOT NULL DEFAULT 'MANUAL',
  "askMode"                TEXT,
  "askValue"               DECIMAL(15,2),
  "projectedTotal"         DECIMAL(15,2),
  "receivedAtRequest"      DECIMAL(15,2),
  "dueNow"                 DECIMAL(15,2),
  "figures"                JSONB,
  "invoiceId"              TEXT,
  "stayExtensionRequestId" TEXT,
  "nightsSleptAtPrompt"    INTEGER,
  "note"                   TEXT,
  "requestedBy"            TEXT,
  "requestedAt"            TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "billedAt"               TIMESTAMP(3),
  "paidAt"                 TIMESTAMP(3),
  "closedAt"               TIMESTAMP(3),
  "closedReason"           TEXT,
  "createdAt"              TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt"              TIMESTAMP(3) NOT NULL,
  CONSTRAINT "interim_payment_requests_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "interim_payment_requests_invoiceId_key" ON "interim_payment_requests"("invoiceId");
CREATE UNIQUE INDEX "interim_payment_requests_stayExtensionRequestId_key" ON "interim_payment_requests"("stayExtensionRequestId");
CREATE INDEX "interim_payment_requests_entryId_state_idx" ON "interim_payment_requests"("entryId", "state");
CREATE INDEX "stay_extension_requests_entryId_state_idx" ON "stay_extension_requests"("entryId", "state");
CREATE INDEX "stay_extension_requests_state_holdExpiresAt_idx" ON "stay_extension_requests"("state", "holdExpiresAt");

ALTER TABLE "stay_extension_requests"
  ADD CONSTRAINT "stay_extension_requests_entryId_fkey" FOREIGN KEY ("entryId")
  REFERENCES "entries"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "interim_payment_requests"
  ADD CONSTRAINT "interim_payment_requests_entryId_fkey" FOREIGN KEY ("entryId")
  REFERENCES "entries"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "interim_payment_requests"
  ADD CONSTRAINT "interim_payment_requests_folioId_fkey" FOREIGN KEY ("folioId")
  REFERENCES "folios"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "interim_payment_requests"
  ADD CONSTRAINT "interim_payment_requests_invoiceId_fkey" FOREIGN KEY ("invoiceId")
  REFERENCES "invoices"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "interim_payment_requests"
  ADD CONSTRAINT "interim_payment_requests_stayExtensionRequestId_fkey" FOREIGN KEY ("stayExtensionRequestId")
  REFERENCES "stay_extension_requests"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "payment_records" ADD COLUMN "interimPaymentRequestId" TEXT;
ALTER TABLE "payment_records"
  ADD CONSTRAINT "payment_records_interimPaymentRequestId_fkey" FOREIGN KEY ("interimPaymentRequestId")
  REFERENCES "interim_payment_requests"("id") ON DELETE SET NULL ON UPDATE CASCADE;
