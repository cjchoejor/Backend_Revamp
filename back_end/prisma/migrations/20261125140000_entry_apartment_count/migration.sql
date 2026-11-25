-- How many apartments the guest asked for (2026-11-25, operator: "in the stay it didn't ask how many
-- rooms the guest wants, due to that in the third section of inquiry, i can choose any numbers of rooms").
-- An apartment stay only; a 2 BHK is one apartment. `numberOfRooms` stays the rooms the pick holds.
ALTER TABLE "entries" ADD COLUMN "apartmentCount" INTEGER;
ALTER TABLE "entries" ADD CONSTRAINT "entries_apartment_count_positive" CHECK ("apartmentCount" IS NULL OR "apartmentCount" > 0);
