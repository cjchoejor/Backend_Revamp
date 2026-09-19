-- Bed setups (2026-09-19): each room type has a usual setup and the setups its rooms can take;
-- a room can narrow that list. Empty lists mean "every setup".
ALTER TABLE "room_types" ADD COLUMN "defaultBedType" TEXT;
ALTER TABLE "room_types" ADD COLUMN "allowedBedTypes" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "rooms" ADD COLUMN "allowedBedTypes" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

-- A type's usual setup is the one most of its rooms are made up in today (ties: alphabetical).
UPDATE "room_types" rt
SET "defaultBedType" = sub."bedType"
FROM (
  SELECT DISTINCT ON ("roomTypeId") "roomTypeId", "bedType"
  FROM "rooms"
  WHERE "bedType" IS NOT NULL
  GROUP BY "roomTypeId", "bedType"
  ORDER BY "roomTypeId", COUNT(*) DESC, "bedType"
) sub
WHERE sub."roomTypeId" = rt."id";
