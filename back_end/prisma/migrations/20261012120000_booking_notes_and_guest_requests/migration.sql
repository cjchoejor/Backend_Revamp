-- The Notes and Guest requests tabs (2026-10-12).

-- CreateEnum
CREATE TYPE "BookingNoteKind" AS ENUM ('NOTE', 'TODO');

-- CreateEnum
CREATE TYPE "GuestRequestState" AS ENUM ('ASKED', 'ARRANGED', 'WITHDRAWN');

-- CreateTable
CREATE TABLE "booking_notes" (
    "id" TEXT NOT NULL,
    "entryId" TEXT NOT NULL,
    "kind" "BookingNoteKind" NOT NULL DEFAULT 'NOTE',
    "text" TEXT NOT NULL,
    "assignee" TEXT,
    "dueAt" TIMESTAMP(3),
    "doneAt" TIMESTAMP(3),
    "doneBy" TEXT,
    "stageContext" TEXT,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "editedBy" TEXT,
    "editedAt" TIMESTAMP(3),
    "priorTexts" JSONB,

    CONSTRAINT "booking_notes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "guest_requests" (
    "id" TEXT NOT NULL,
    "entryId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "what" TEXT NOT NULL,
    "forDate" TIMESTAMP(3),
    "forTime" TEXT,
    "state" "GuestRequestState" NOT NULL DEFAULT 'ASKED',
    "stageContext" TEXT,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "arrangedBy" TEXT,
    "arrangedAt" TIMESTAMP(3),
    "arrangedNote" TEXT,
    "withdrawnBy" TEXT,
    "withdrawnAt" TIMESTAMP(3),
    "withdrawnReason" TEXT,

    CONSTRAINT "guest_requests_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "booking_notes_entryId_createdAt_idx" ON "booking_notes"("entryId", "createdAt");

-- CreateIndex
CREATE INDEX "guest_requests_entryId_state_idx" ON "guest_requests"("entryId", "state");

-- AddForeignKey
ALTER TABLE "booking_notes" ADD CONSTRAINT "booking_notes_entryId_fkey" FOREIGN KEY ("entryId") REFERENCES "entries"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "guest_requests" ADD CONSTRAINT "guest_requests_entryId_fkey" FOREIGN KEY ("entryId") REFERENCES "entries"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
