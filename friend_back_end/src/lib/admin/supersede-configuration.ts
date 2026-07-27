import type { Prisma } from "@prisma/client";
import { ValidationError } from "../errors.js";
import { writeAdminAuditEvent } from "./write-admin-audit.js";

type Tx = Prisma.TransactionClient;

const SYSTEM_SEED_MARKER = "actor-seed-system";

export function isSystemSeedSetBy(setBy: string): boolean {
  return setBy === SYSTEM_SEED_MARKER || setBy === "SYSTEM_SEED";
}

export async function supersedeConfigurationEntry(
  tx: Tx,
  input: {
    configKey: string;
    configValue: Prisma.InputJsonValue;
    actorId: string;
    notes?: string | null;
    effectiveFrom?: Date;
  },
) {
  const key = input.configKey.trim();
  if (!key) throw new ValidationError("configKey is required");

  const now = input.effectiveFrom ?? new Date();

  const active = await tx.configurationEntry.findFirst({
    where: {
      configKey: key,
      effectiveTo: null,
    },
    orderBy: { effectiveFrom: "desc" },
  });

  if (active) {
    const closed = await tx.configurationEntry.updateMany({
      where: { id: active.id, effectiveTo: null },
      data: { effectiveTo: now },
    });
    if (closed.count === 0) {
      throw new ValidationError("Configuration was updated concurrently — refresh and retry");
    }
  }

  const created = await tx.configurationEntry.create({
    data: {
      configKey: key,
      configValue: input.configValue,
      effectiveFrom: now,
      effectiveTo: null,
      setBy: input.actorId,
      setAt: now,
      notes: input.notes?.trim() ? input.notes.trim() : null,
    },
  });

  await writeAdminAuditEvent(tx, {
    actorId: input.actorId,
    eventType: "ADMIN.CONFIGURATION_SUPERSEDED",
    entityType: "ConfigurationEntry",
    entityId: created.id,
    operation: active ? "UPDATE" : "CREATE",
    payload: {
      configKey: key,
      priorValue: active?.configValue ?? null,
      newValue: input.configValue,
      notes: input.notes ?? null,
    },
  });

  return {
    entry: created,
    isSystemDefault: false,
    wasSeeded: active ? isSystemSeedSetBy(active.setBy) : false,
  };
}
