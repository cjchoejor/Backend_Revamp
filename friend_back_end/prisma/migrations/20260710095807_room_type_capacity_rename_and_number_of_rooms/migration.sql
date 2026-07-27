-- AlterTable
ALTER TABLE "entries" ADD COLUMN     "numberOfRooms" INTEGER;

-- AlterTable
ALTER TABLE "room_types" ADD COLUMN     "maxCapacity" INTEGER NOT NULL DEFAULT 3;
