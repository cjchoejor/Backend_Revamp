-- AlterTable
ALTER TABLE "committed_holds" ADD COLUMN     "perNightBreakdown" JSONB;

-- AlterTable
ALTER TABLE "room_assignments" ADD COLUMN     "endDate" TIMESTAMP(3),
ADD COLUMN     "startDate" TIMESTAMP(3);
