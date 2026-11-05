-- How long a proforma stands, by the same rule as a quotation.
ALTER TABLE "invoices" ADD COLUMN "validUntil" TIMESTAMP(3);
ALTER TABLE "invoices" ADD COLUMN "lapsedAt" TIMESTAMP(3);
