-- A trip's combined paper, one row per version (2026-11-07).
CREATE TABLE "trip_papers" (
    "id" TEXT NOT NULL,
    "inquiryId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "documentNumber" TEXT NOT NULL,
    "versionNumber" INTEGER NOT NULL DEFAULT 1,
    "members" JSONB NOT NULL,
    "totalAmount" DECIMAL(15,2) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'BTN',
    "state" TEXT NOT NULL DEFAULT 'LIVE',
    "validUntil" TIMESTAMP(3),
    "sentAt" TIMESTAMP(3),
    "sentTo" TEXT,
    "sentChannel" TEXT,
    "answeredAt" TIMESTAMP(3),
    "answeredBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT NOT NULL,
    "supersededAt" TIMESTAMP(3),
    CONSTRAINT "trip_papers_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "trip_papers_state_check" CHECK ("state" IN ('LIVE', 'SUPERSEDED')),
    CONSTRAINT "trip_papers_kind_check" CHECK ("kind" IN ('QUOTATION', 'PROFORMA'))
);
CREATE INDEX "trip_papers_inquiryId_kind_idx" ON "trip_papers"("inquiryId", "kind");
