-- One room of a booking leaving before the booking's check-out (2026-11-26).
CREATE TABLE "room_departure_records" (
    "id" TEXT NOT NULL,
    "entryId" TEXT NOT NULL,
    "roomId" TEXT NOT NULL,
    "roomNumber" TEXT NOT NULL,
    "assignmentId" TEXT NOT NULL,
    "departureDate" TIMESTAMP(3) NOT NULL,
    "originalEndDate" TIMESTAMP(3) NOT NULL,
    "sleptNights" INTEGER NOT NULL,
    "unstayedNights" INTEGER NOT NULL,
    "forgoneSubtotal" DECIMAL(15,2) NOT NULL,
    "forgoneTotal" DECIMAL(15,2) NOT NULL,
    "frozenSubtotalBefore" DECIMAL(15,2),
    "frozenTotalBefore" DECIMAL(15,2),
    "feeBasis" JSONB NOT NULL,
    "feeAmount" DECIMAL(15,2) NOT NULL,
    "feeWaived" BOOLEAN NOT NULL DEFAULT false,
    "feeFolioLineId" TEXT,
    "billing" TEXT NOT NULL,
    "state" TEXT NOT NULL DEFAULT 'SCHEDULED',
    "leftAt" TIMESTAMP(3),
    "leftBy" TEXT,
    "reason" TEXT NOT NULL,
    "recordedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "recordedBy" TEXT NOT NULL,
    "recordedByLevel" TEXT NOT NULL,
    CONSTRAINT "room_departure_records_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "room_departure_billing_check" CHECK ("billing" IN ('TOGETHER', 'OWN')),
    CONSTRAINT "room_departure_state_check" CHECK ("state" IN ('SCHEDULED', 'LEFT')),
    CONSTRAINT "room_departure_fee_check" CHECK ("feeAmount" >= 0)
);
CREATE INDEX "room_departure_records_entryId_state_idx" ON "room_departure_records"("entryId", "state");
ALTER TABLE "room_departure_records" ADD CONSTRAINT "room_departure_records_entryId_fkey" FOREIGN KEY ("entryId") REFERENCES "entries"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
