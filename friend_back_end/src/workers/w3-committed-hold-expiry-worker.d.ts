import type { PrismaClient } from "@prisma/client";

export declare function runCommittedHoldExpiryWorker(
  prisma: PrismaClient,
  input: { committedHoldId?: string; timerRecordId?: string },
): Promise<{ skipped: boolean; reason?: string; committedHoldId?: string }>;

