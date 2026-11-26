-- A room removed from a stay by the hotel's mistake, and the desk's ask to the FOM to remove one (2026-11-26).
ALTER TABLE "room_departure_records" ADD COLUMN "kind" TEXT NOT NULL DEFAULT 'LEAVING';
ALTER TABLE "room_departure_records" ADD CONSTRAINT "room_departure_kind_check" CHECK ("kind" IN ('LEAVING', 'REMOVED'));

CREATE TABLE "room_removal_requests" (
    "id" TEXT NOT NULL,
    "entryId" TEXT NOT NULL,
    "roomIds" TEXT[],
    "roomNumbers" TEXT[],
    "departureDate" TIMESTAMP(3) NOT NULL,
    "reason" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'REQUESTED',
    "requestedBy" TEXT NOT NULL,
    "requestedLevel" TEXT,
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decidedBy" TEXT,
    "decidedLevel" TEXT,
    "decidedAt" TIMESTAMP(3),
    "decisionNote" TEXT,
    "recordIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "room_removal_requests_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "room_removal_status_check" CHECK ("status" IN ('REQUESTED', 'APPROVED', 'REJECTED', 'WITHDRAWN'))
);
CREATE INDEX "room_removal_requests_entryId_status_idx" ON "room_removal_requests"("entryId", "status");
ALTER TABLE "room_removal_requests" ADD CONSTRAINT "room_removal_requests_entryId_fkey" FOREIGN KEY ("entryId") REFERENCES "entries"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
