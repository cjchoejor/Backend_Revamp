-- AlterTable
ALTER TABLE "amendment_event_records" ADD COLUMN     "affectsGroup" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "entries" ADD COLUMN     "contactPersonName" TEXT,
ADD COLUMN     "contactPersonPhone" TEXT,
ADD COLUMN     "groupBillingModeManualOverride" BOOLEAN NOT NULL DEFAULT false;

-- AlterTable
ALTER TABLE "handoff_records" ADD COLUMN     "roomAssignmentId" TEXT;

-- AddForeignKey
ALTER TABLE "handoff_records" ADD CONSTRAINT "handoff_records_roomAssignmentId_fkey" FOREIGN KEY ("roomAssignmentId") REFERENCES "room_assignments"("id") ON DELETE SET NULL ON UPDATE CASCADE;
