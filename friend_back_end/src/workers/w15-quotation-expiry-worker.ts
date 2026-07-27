import type { PrismaClient } from "@prisma/client";
import { expireQuotation } from "../services/domain/s2-quotation-service.js";

export async function runQuotationExpiryWorker(prisma: PrismaClient, input: { quotationId?: string; timerRecordId?: string }) {
  return expireQuotation(prisma, input);
}
