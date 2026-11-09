-- A proforma keeps its number across versions (2026-11-07): the printed number, shared by every version.
ALTER TABLE "invoices" ADD COLUMN "documentNumber" TEXT;
CREATE INDEX "invoices_documentNumber_idx" ON "invoices"("documentNumber");
