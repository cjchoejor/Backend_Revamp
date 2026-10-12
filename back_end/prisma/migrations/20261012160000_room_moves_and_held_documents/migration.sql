-- Room moves from the house chart (2026-10-12) and the guest papers a walk holds for the desk's decision.

-- CreateEnum
CREATE TYPE "RoomMoveKind" AS ENUM ('MOVE', 'SWAP');

-- CreateEnum
CREATE TYPE "RoomMoveStatus" AS ENUM ('IN_PROGRESS', 'COMPLETED', 'PARTIAL', 'REVERTED', 'FAILED');

-- CreateEnum
CREATE TYPE "RoomMoveLegStatus" AS ENUM ('PLANNED', 'DONE', 'STOPPED', 'REFUSED', 'REVERTED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "RoomMovePriceMode" AS ENUM ('KEEP', 'NEW_TYPE');

-- CreateEnum
CREATE TYPE "HeldDocumentKind" AS ENUM ('CONFIRMATION_VOUCHER', 'PROFORMA');

-- CreateEnum
CREATE TYPE "HeldDocumentDecision" AS ENUM ('SENT_EMAIL', 'SENT_WHATSAPP', 'NOT_SENT', 'SUPERSEDED');

-- CreateTable
CREATE TABLE "room_moves" (
    "id" TEXT NOT NULL,
    "kind" "RoomMoveKind" NOT NULL,
    "status" "RoomMoveStatus" NOT NULL DEFAULT 'IN_PROGRESS',
    "reason" TEXT NOT NULL,
    "requestedBy" TEXT NOT NULL,
    "requestedLevel" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "completedAt" TIMESTAMP(3),
    "notes" JSONB,

    CONSTRAINT "room_moves_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "room_move_legs" (
    "id" TEXT NOT NULL,
    "moveId" TEXT NOT NULL,
    "order" INTEGER NOT NULL,
    "entryId" TEXT NOT NULL,
    "fromRoomId" TEXT NOT NULL,
    "toRoomId" TEXT NOT NULL,
    "nights" JSONB NOT NULL,
    "originStage" "Stage" NOT NULL,
    "priceMode" "RoomMovePriceMode" NOT NULL DEFAULT 'KEEP',
    "guestAgreedNote" TEXT,
    "status" "RoomMoveLegStatus" NOT NULL DEFAULT 'PLANNED',
    "outcome" JSONB,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "room_move_legs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "held_documents" (
    "id" TEXT NOT NULL,
    "entryId" TEXT NOT NULL,
    "kind" "HeldDocumentKind" NOT NULL,
    "documentId" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "roomMoveLegId" TEXT,
    "heldAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "heldBy" TEXT NOT NULL,
    "decision" "HeldDocumentDecision",
    "sentTo" TEXT,
    "note" TEXT,
    "decidedAt" TIMESTAMP(3),
    "decidedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "held_documents_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "room_moves_status_idx" ON "room_moves"("status");

-- CreateIndex
CREATE INDEX "room_move_legs_moveId_idx" ON "room_move_legs"("moveId");

-- CreateIndex
CREATE INDEX "room_move_legs_entryId_idx" ON "room_move_legs"("entryId");

-- CreateIndex
CREATE INDEX "room_move_legs_toRoomId_idx" ON "room_move_legs"("toRoomId");

-- CreateIndex
CREATE INDEX "held_documents_entryId_decision_idx" ON "held_documents"("entryId", "decision");

-- AddForeignKey
ALTER TABLE "room_move_legs" ADD CONSTRAINT "room_move_legs_moveId_fkey" FOREIGN KEY ("moveId") REFERENCES "room_moves"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "room_move_legs" ADD CONSTRAINT "room_move_legs_entryId_fkey" FOREIGN KEY ("entryId") REFERENCES "entries"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "room_move_legs" ADD CONSTRAINT "room_move_legs_fromRoomId_fkey" FOREIGN KEY ("fromRoomId") REFERENCES "rooms"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "room_move_legs" ADD CONSTRAINT "room_move_legs_toRoomId_fkey" FOREIGN KEY ("toRoomId") REFERENCES "rooms"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "held_documents" ADD CONSTRAINT "held_documents_entryId_fkey" FOREIGN KEY ("entryId") REFERENCES "entries"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "held_documents" ADD CONSTRAINT "held_documents_roomMoveLegId_fkey" FOREIGN KEY ("roomMoveLegId") REFERENCES "room_move_legs"("id") ON DELETE SET NULL ON UPDATE CASCADE;
