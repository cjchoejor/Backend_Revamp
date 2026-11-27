-- What an apartment holds (with counts, never priced), and an extra bed asked for during an apartment stay (2026-11-27).
ALTER TABLE "apartment_packages" ADD COLUMN "amenityKit" JSONB;
ALTER TABLE "entries" ADD COLUMN "apartmentAmenities" JSONB;

CREATE TABLE "apartment_extra_beds" (
    "id" TEXT NOT NULL,
    "entryId" TEXT NOT NULL,
    "unitId" TEXT NOT NULL,
    "unitLabel" TEXT NOT NULL,
    "roomId" TEXT NOT NULL,
    "beds" INTEGER NOT NULL,
    "fromDate" TIMESTAMP(3) NOT NULL,
    "toDate" TIMESTAMP(3) NOT NULL,
    "ratePerBed" DECIMAL(12,2) NOT NULL,
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT NOT NULL,
    "endedAt" TIMESTAMP(3),
    "endedBy" TEXT,
    "endReason" TEXT,
    CONSTRAINT "apartment_extra_beds_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "apartment_extra_beds_beds_check" CHECK ("beds" > 0),
    CONSTRAINT "apartment_extra_beds_dates_check" CHECK ("toDate" > "fromDate"),
    CONSTRAINT "apartment_extra_beds_rate_check" CHECK ("ratePerBed" >= 0)
);
CREATE INDEX "apartment_extra_beds_entryId_idx" ON "apartment_extra_beds"("entryId");
ALTER TABLE "apartment_extra_beds" ADD CONSTRAINT "apartment_extra_beds_entryId_fkey" FOREIGN KEY ("entryId") REFERENCES "entries"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "apartment_extra_beds" ADD CONSTRAINT "apartment_extra_beds_roomId_fkey" FOREIGN KEY ("roomId") REFERENCES "rooms"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
