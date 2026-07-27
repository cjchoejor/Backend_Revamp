import type { PrismaClient } from "@prisma/client";

export declare function runQuotationAckTrackerWorker(
  prisma: PrismaClient,
  input: { quotationId?: string; timerRecordId?: string },
): Promise<{ skipped: boolean; reason?: string; quotationId?: string }>;

