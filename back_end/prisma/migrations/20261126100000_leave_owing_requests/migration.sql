-- The desk asks the FOM to let a guest leave owing at Check-out (2026-11-26).
CREATE TABLE "leave_owing_requests" (
    "id" TEXT NOT NULL,
    "entryId" TEXT NOT NULL,
    "folioId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'REQUESTED',
    "amountOwed" DECIMAL(15,2) NOT NULL,
    "guestWords" TEXT NOT NULL,
    "requestedBy" TEXT NOT NULL,
    "requestedLevel" TEXT,
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decisionNote" TEXT,
    "decidedBy" TEXT,
    "decidedLevel" TEXT,
    "decidedAt" TIMESTAMP(3),
    "payBy" TIMESTAMP(3),
    "creditExtensionId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "leave_owing_requests_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "leave_owing_request_status" CHECK ("status" IN ('REQUESTED','APPROVED','REJECTED','WITHDRAWN')),
    CONSTRAINT "leave_owing_request_amount" CHECK ("amountOwed" > 0)
);
CREATE INDEX "leave_owing_requests_entryId_status_idx" ON "leave_owing_requests"("entryId", "status");
ALTER TABLE "leave_owing_requests" ADD CONSTRAINT "leave_owing_requests_entryId_fkey" FOREIGN KEY ("entryId") REFERENCES "entries"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "leave_owing_requests" ADD CONSTRAINT "leave_owing_requests_folioId_fkey" FOREIGN KEY ("folioId") REFERENCES "folios"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
