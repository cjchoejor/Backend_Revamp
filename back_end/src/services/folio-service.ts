import type { Prisma, PrismaClient } from "@prisma/client";
import { FolioState } from "@prisma/client";
import { MissingConfigurationError, NotFoundError, StateTransitionError, ValidationError } from "../lib/errors.js";
import { requireActiveConfigValue } from "../lib/config-store.js";

type DbClient = PrismaClient | Prisma.TransactionClient;

export async function convertToLive(db: DbClient, entryId: string, folioId: string, actorId: string) {
  const folio = await db.folio.findUnique({ where: { id: folioId } });
  if (!folio) throw new NotFoundError("Folio");
  if (folio.entryId !== entryId) {
    throw new ValidationError("Folio does not belong to this entry");
  }
  if (folio.state !== FolioState.PROVISIONAL) {
    throw new StateTransitionError(`Folio must be PROVISIONAL to convert (current: ${folio.state})`);
  }
  if (!folio.billingModel?.trim()) {
    throw new MissingConfigurationError("Folio.billingModel");
  }

  const cfg = (await requireActiveConfigValue<Record<string, string[]> | undefined>(db as any, "billingModel.availablePerSource")) ?? {};
  const allowed = Object.values(cfg).flat();
  if (allowed.length > 0 && !allowed.includes(folio.billingModel)) {
    throw new MissingConfigurationError("billingModel.availablePerSource");
  }

  const now = new Date();
  const updated = await db.folio.update({
    where: { id: folioId },
    data: {
      state: FolioState.LIVE,
      convertedToLiveAt: now,
      convertedBy: actorId,
    },
  });

  // SIG-S6 AC-S6-005: audited conversion event (must be atomic with conversion in transaction context).
  await (db as any).traceEvent.create({
    data: {
      eventType: "FOLIO_CONVERTED_TO_LIVE",
      actorId,
      actorLevel: actorId === "SYSTEM" ? "SYSTEM" : "L1",
      entityType: "Folio",
      entityId: folioId,
      operation: "TRANSITION",
      timestamp: now,
      stageContext: null,
      inquiryId: null,
      entryId,
      payload: { entryId, folioId, convertedAt: now.toISOString(), billingModel: updated.billingModel },
      createdBy: actorId,
    },
  });

  return updated;
}
