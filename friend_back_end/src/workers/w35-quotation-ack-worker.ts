import type { PrismaClient } from "@prisma/client";
import { runQuotationAckTrackerWorker } from "./w22-quotation-ack-tracker-worker.js";

/**
 * Docs reserve W35 for QuotationAckWorker. In this codebase, the concrete job type is `QUOTATION_ACK_TRACKER`.
 * This wrapper exists so "W35 is present in the workers folder" and can be referenced directly.
 */
export async function runQuotationAckWorkerW35(prisma: PrismaClient, input: { quotationId?: string; timerRecordId?: string }) {
  return runQuotationAckTrackerWorker(prisma, input);
}

