-- CreateEnum
CREATE TYPE "NegotiationAmendmentState" AS ENUM ('REQUESTED', 'APPROVED', 'REJECTED', 'WITHDRAWN', 'SUPERSEDED');

-- DropForeignKey
ALTER TABLE "deficient_condition_records" DROP CONSTRAINT "deficient_condition_records_roomId_fkey";

-- CreateTable
CREATE TABLE "negotiation_amendment_requests" (
    "id" TEXT NOT NULL,
    "entryId" TEXT NOT NULL,
    "segmentId" TEXT NOT NULL,
    "state" "NegotiationAmendmentState" NOT NULL DEFAULT 'REQUESTED',
    "proposal" JSONB NOT NULL,
    "summary" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "requestedBy" TEXT NOT NULL,
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decidedBy" TEXT,
    "decidedAt" TIMESTAMP(3),
    "decisionNote" TEXT,
    "appliedAmendmentId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "negotiation_amendment_requests_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "negotiation_amendment_requests_entryId_state_idx" ON "negotiation_amendment_requests"("entryId", "state");

-- AddForeignKey
ALTER TABLE "deficient_condition_records" ADD CONSTRAINT "deficient_condition_records_roomId_fkey" FOREIGN KEY ("roomId") REFERENCES "rooms"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "negotiation_amendment_requests" ADD CONSTRAINT "negotiation_amendment_requests_entryId_fkey" FOREIGN KEY ("entryId") REFERENCES "entries"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
