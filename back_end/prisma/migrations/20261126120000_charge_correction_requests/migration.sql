-- The front desk asks the FOM to correct a charge on a settled bill (2026-11-26).
CREATE TABLE "charge_correction_requests" (
    "id" TEXT NOT NULL,
    "entryId" TEXT NOT NULL,
    "folioId" TEXT NOT NULL,
    "originalLineId" TEXT NOT NULL,
    "mode" TEXT NOT NULL,
    "value" DECIMAL(15,2) NOT NULL,
    "netBefore" DECIMAL(15,2) NOT NULL,
    "reason" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'REQUESTED',
    "requestedBy" TEXT NOT NULL,
    "requestedLevel" TEXT,
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decisionNote" TEXT,
    "decidedBy" TEXT,
    "decidedLevel" TEXT,
    "decidedAt" TIMESTAMP(3),
    "correctionLineId" TEXT,
    "outcome" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "charge_correction_requests_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "charge_correction_request_status" CHECK ("status" IN ('REQUESTED','APPROVED','REJECTED','WITHDRAWN')),
    CONSTRAINT "charge_correction_request_mode" CHECK ("mode" IN ('ADJUST','SET_NET'))
);
CREATE INDEX "charge_correction_requests_entryId_status_idx" ON "charge_correction_requests"("entryId", "status");
ALTER TABLE "charge_correction_requests" ADD CONSTRAINT "charge_correction_requests_entryId_fkey" FOREIGN KEY ("entryId") REFERENCES "entries"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "charge_correction_requests" ADD CONSTRAINT "charge_correction_requests_folioId_fkey" FOREIGN KEY ("folioId") REFERENCES "folios"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
