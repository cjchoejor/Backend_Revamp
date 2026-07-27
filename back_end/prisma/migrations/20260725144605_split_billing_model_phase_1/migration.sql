-- AlterTable
ALTER TABLE "billing_model_transition_records" ADD COLUMN     "changeSource" TEXT,
ADD COLUMN     "folioLineId" TEXT,
ADD COLUMN     "reason" TEXT;

-- AlterTable
ALTER TABLE "folio_lines" ADD COLUMN     "billingModel" TEXT;

-- AlterTable
ALTER TABLE "folios" ADD COLUMN     "billingModelDefaults" JSONB;

-- CreateIndex
CREATE INDEX "billing_model_transition_records_folioLineId_idx" ON "billing_model_transition_records"("folioLineId");

-- AddForeignKey
ALTER TABLE "billing_model_transition_records" ADD CONSTRAINT "billing_model_transition_records_folioLineId_fkey" FOREIGN KEY ("folioLineId") REFERENCES "folio_lines"("id") ON DELETE SET NULL ON UPDATE CASCADE;
