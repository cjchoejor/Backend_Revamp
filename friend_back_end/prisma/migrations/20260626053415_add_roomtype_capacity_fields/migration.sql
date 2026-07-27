-- AlterTable
ALTER TABLE "room_types" ADD COLUMN     "maxChildren" INTEGER NOT NULL DEFAULT 2,
ADD COLUMN     "maxExtraBeds" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "maxOccupancy" INTEGER NOT NULL DEFAULT 2,
ADD COLUMN     "requiredAccompanyingAdults" INTEGER NOT NULL DEFAULT 1;
