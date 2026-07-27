-- AlterTable
ALTER TABLE "rate_plan_registry" ADD COLUMN     "msr" DECIMAL(15,2),
ADD COLUMN     "type" TEXT NOT NULL DEFAULT 'INDIVIDUAL';
