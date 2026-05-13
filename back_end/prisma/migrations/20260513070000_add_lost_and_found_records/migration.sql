-- CreateEnum
CREATE TYPE "LostFoundReturnStatus" AS ENUM ('HELD', 'RETURNED', 'DISPOSED');

-- CreateTable
CREATE TABLE "lost_and_found_records" (
  "id" TEXT NOT NULL,
  "entryId" TEXT,
  "guestProfileId" TEXT,
  "description" TEXT NOT NULL,
  "returnStatus" "LostFoundReturnStatus" NOT NULL DEFAULT 'HELD',
  "retentionExpiresAt" TIMESTAMP(3) NOT NULL,
  "returnedAt" TIMESTAMP(3),
  "disposedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdBy" TEXT NOT NULL,

  CONSTRAINT "lost_and_found_records_pkey" PRIMARY KEY ("id")
);

