-- Several rate packages on a booking, and a package per room type (2026-11-13).
ALTER TABLE "inquiries" ADD COLUMN "ratePackageIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "entries" ADD COLUMN "ratePackageByRoomType" JSONB;

-- Every booking with a package keeps it, as its one chosen package.
UPDATE "inquiries" SET "ratePackageIds" = ARRAY["ratePackageId"] WHERE "ratePackageId" IS NOT NULL;
