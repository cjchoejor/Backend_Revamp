-- AlterTable
ALTER TABLE "entries" ADD COLUMN     "adultCount" INTEGER,
ADD COLUMN     "childAges" INTEGER[] DEFAULT ARRAY[]::INTEGER[],
ADD COLUMN     "childCount" INTEGER;
