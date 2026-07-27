-- AlterTable
ALTER TABLE "invoices" ADD COLUMN     "billingModel" TEXT;

-- AlterTable
ALTER TABLE "payment_records" ADD COLUMN     "billingModel" TEXT;
