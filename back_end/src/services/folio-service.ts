import type { Prisma, PrismaClient } from "@prisma/client";
import { FolioState } from "@prisma/client";
import { MissingConfigurationError, NotFoundError, StateTransitionError, ValidationError } from "../lib/errors.js";

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

  const billingCfg = await db.configurationEntry.findUnique({ where: { configKey: "billingModel.availablePerSource" } });
  if (!billingCfg) {
    throw new MissingConfigurationError("billingModel.availablePerSource");
  }
  const cfg = (billingCfg.value as Record<string, string[]> | undefined) ?? {};
  const allowed = Object.values(cfg).flat();
  if (allowed.length > 0 && !allowed.includes(folio.billingModel)) {
    throw new MissingConfigurationError("billingModel.availablePerSource");
  }

  const now = new Date();
  return db.folio.update({
    where: { id: folioId },
    data: {
      state: FolioState.LIVE,
      convertedToLiveAt: now,
      convertedBy: actorId,
    },
  });
}
