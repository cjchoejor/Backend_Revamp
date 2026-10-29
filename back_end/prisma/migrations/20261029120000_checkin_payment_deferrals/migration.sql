-- The rest of the bill promised at check-in, and the FOM's word on paying it later (2026-10-29).
CREATE TABLE "checkin_payment_deferrals" (
    "id" TEXT NOT NULL,
    "entryId" TEXT NOT NULL,
    "folioId" TEXT NOT NULL,
    "segmentId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'REQUESTED',
    "stillToPay" DECIMAL(15,2) NOT NULL,
    "reason" TEXT NOT NULL,
    "requestedBy" TEXT NOT NULL,
    "requestedLevel" TEXT,
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "payBy" TEXT,
    "dueBy" TIMESTAMP(3),
    "decisionNote" TEXT,
    "decidedBy" TEXT,
    "decidedLevel" TEXT,
    "decidedAt" TIMESTAMP(3),
    "creditExtensionId" TEXT,
    "reminderTimerRecordId" TEXT,
    "remindersSent" INTEGER NOT NULL DEFAULT 0,
    "lastReminderAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "checkin_payment_deferrals_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "checkin_payment_deferral_status" CHECK ("status" IN ('REQUESTED','APPROVED','REJECTED','WITHDRAWN')),
    CONSTRAINT "checkin_payment_deferral_pay_by" CHECK ("payBy" IS NULL OR "payBy" IN ('DURING_STAY','AT_CHECKOUT','AFTER_STAY'))
);
CREATE INDEX "checkin_payment_deferrals_entryId_status_idx" ON "checkin_payment_deferrals"("entryId", "status");
ALTER TABLE "checkin_payment_deferrals" ADD CONSTRAINT "checkin_payment_deferrals_entryId_fkey" FOREIGN KEY ("entryId") REFERENCES "entries"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "checkin_payment_deferrals" ADD CONSTRAINT "checkin_payment_deferrals_folioId_fkey" FOREIGN KEY ("folioId") REFERENCES "folios"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
