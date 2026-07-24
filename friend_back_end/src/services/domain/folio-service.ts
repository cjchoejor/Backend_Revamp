import type { Prisma } from "@prisma/client";
import { FolioState, Stage } from "@prisma/client";

/**
 * S6 check-in completion — provisional folio becomes LIVE (single governed write path).
 */
export async function convertToLive(tx: Prisma.TransactionClient, entryId: string, folioId: string, actorId: string) {
  const now = new Date();
  await tx.folio.update({
    where: { id: folioId },
    data: { state: FolioState.LIVE, convertedToLiveAt: now, convertedBy: actorId },
  });
  await tx.traceEvent.create({
    data: {
      eventType: "FOLIO_CONVERTED_TO_LIVE",
      actorId,
      actorLevel: "L1",
      entityType: "Folio",
      entityId: folioId,
      operation: "UPDATE",
      timestamp: now,
      stageContext: Stage.S6,
      entryId,
      payload: { folioId, entryId },
      createdBy: actorId,
    },
  });
}

/**
 * SIG-S3 FolioService façade — provisional folio lifecycle at S3.
 * Implementations: `s3-folio-service.ts` (get/create), `s3-reservation-setup-service.ts` (billing + PI seed).
 */
export { getOrCreateProvisionalFolio, recordPayment, issueInvoice, supersedePendingInvoices } from "./s3-folio-service.js";
export { ensureProvisionalFolioAndBillingModel } from "./s3-reservation-setup-service.js";
export { getFolio } from "./s8-settlement-service.js";
export { listInvoices } from "./s9-service.js";
