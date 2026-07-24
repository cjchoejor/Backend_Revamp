import type { PrismaClient } from "@prisma/client";

export declare function runAdvancePaymentFollowUpWorker(
  prisma: PrismaClient,
  input: { entryId?: string; invoiceId?: string; tier?: 1 | 2; timerRecordId?: string },
): Promise<{ skipped: boolean; reason?: string; entryId?: string; tier?: 1 | 2 }>;

