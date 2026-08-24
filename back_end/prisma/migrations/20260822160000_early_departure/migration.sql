-- Early departure (2026-08-22, SIG-S8 §1.2 / Policy 36): the actual end of a shortened stay on the
-- entry, and the one record of what was booked, what was slept, what the unstayed nights forgo and
-- the fee (or waiver).
ALTER TABLE "entries" ADD COLUMN "actualCheckOutDate" TIMESTAMP(3);

CREATE TABLE "early_departure_records" (
    "id" TEXT NOT NULL,
    "entryId" TEXT NOT NULL,
    "segmentId" TEXT,
    "reservationId" TEXT,
    "originalCheckOutDate" TIMESTAMP(3) NOT NULL,
    "departureDate" TIMESTAMP(3) NOT NULL,
    "bookedNights" INTEGER NOT NULL,
    "sleptNights" INTEGER NOT NULL,
    "unstayedNights" INTEGER NOT NULL,
    "forgoneRoomSubtotal" DECIMAL(15,2) NOT NULL,
    "forgoneRoomTotal" DECIMAL(15,2) NOT NULL,
    "rooms" JSONB NOT NULL,
    "feeBasis" JSONB NOT NULL,
    "feeAmount" DECIMAL(15,2) NOT NULL,
    "feeWaived" BOOLEAN NOT NULL DEFAULT false,
    "feeFolioLineId" TEXT,
    "reason" TEXT NOT NULL,
    "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "recordedBy" TEXT NOT NULL,
    "recordedByLevel" TEXT NOT NULL,

    CONSTRAINT "early_departure_records_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "early_departure_records_entryId_key" ON "early_departure_records"("entryId");

ALTER TABLE "early_departure_records" ADD CONSTRAINT "early_departure_records_entryId_fkey" FOREIGN KEY ("entryId") REFERENCES "entries"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
