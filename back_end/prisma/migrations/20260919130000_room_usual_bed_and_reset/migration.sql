-- A room's own usual bed setup (null = its type's), and which booking a desk bed change was for.
ALTER TABLE "rooms" ADD COLUMN "defaultBedType" TEXT;
ALTER TABLE "rooms" ADD COLUMN "bedTypeSetForEntryId" TEXT;
