-- The hotel's service apartments, let by the week or the month (2026-11-25).

CREATE TABLE "apartment_packages" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "carpetAreaSqft" INTEGER,
    "amenities" TEXT,
    "weeklyRate" DECIMAL(12,2) NOT NULL,
    "monthlyRate" DECIMAL(12,2) NOT NULL,
    "ratesTypedWithTax" BOOLEAN NOT NULL DEFAULT false,
    "weeklyRateTyped" DECIMAL(12,2),
    "monthlyRateTyped" DECIMAL(12,2),
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedBy" TEXT,
    CONSTRAINT "apartment_packages_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "apartment_packages_rates_positive" CHECK ("weeklyRate" > 0 AND "monthlyRate" > 0)
);

CREATE TABLE "apartment_units" (
    "id" TEXT NOT NULL,
    "packageId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "maxOccupants" INTEGER NOT NULL,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "apartment_units_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "apartment_units_max_occupants" CHECK ("maxOccupants" BETWEEN 1 AND 20)
);

CREATE TABLE "apartment_unit_rooms" (
    "id" TEXT NOT NULL,
    "unitId" TEXT NOT NULL,
    "roomId" TEXT NOT NULL,
    CONSTRAINT "apartment_unit_rooms_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "apartment_packages_name_key" ON "apartment_packages"("name");
CREATE UNIQUE INDEX "apartment_units_label_key" ON "apartment_units"("label");
CREATE INDEX "apartment_units_packageId_idx" ON "apartment_units"("packageId");
CREATE UNIQUE INDEX "apartment_unit_rooms_roomId_key" ON "apartment_unit_rooms"("roomId");
CREATE INDEX "apartment_unit_rooms_unitId_idx" ON "apartment_unit_rooms"("unitId");

ALTER TABLE "apartment_units" ADD CONSTRAINT "apartment_units_packageId_fkey" FOREIGN KEY ("packageId") REFERENCES "apartment_packages"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "apartment_unit_rooms" ADD CONSTRAINT "apartment_unit_rooms_unitId_fkey" FOREIGN KEY ("unitId") REFERENCES "apartment_units"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "apartment_unit_rooms" ADD CONSTRAINT "apartment_unit_rooms_roomId_fkey" FOREIGN KEY ("roomId") REFERENCES "rooms"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
