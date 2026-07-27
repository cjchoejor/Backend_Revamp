import type { PrismaClient } from "@prisma/client";
import * as auditService from "./audit-service.js";
import { requireActiveConfigValue } from "../../lib/config-store.js";

type DispatchTier = "OPERATOR" | "FOM" | "GM";

function severityToTier(severity: "WARNING" | "CRITICAL" | "ESCALATION"): DispatchTier {
  if (severity === "ESCALATION") return "FOM";
  if (severity === "CRITICAL") return "FOM";
  return "OPERATOR";
}

export async function dispatchOperatorExpiry(
  prisma: PrismaClient,
  input: { entityType: "Entry" | "ProcessingLockRecord"; entityId: string; entryId?: string | null; inventoryReference?: string; reason: string },
) {
  const routing = await requireActiveConfigValue<Record<string, DispatchTier[]>>(prisma, "notification.routing.operatorExpiry").catch(
    () => ({ DEFAULT: ["OPERATOR"] }),
  );
  const targets = routing.DEFAULT ?? ["OPERATOR"];
  const now = new Date();
  await auditService.emit(prisma, auditService.systemActor(), {
    eventType: "NOTIFICATION.OPERATOR_EXPIRY_DISPATCHED",
    entityType: input.entityType,
    entityId: input.entityId,
    operation: "NOTIFY",
    timestamp: now,
    payload: { ...input, targets, dispatchedAt: now.toISOString() },
    entryId: input.entryId ?? null,
    createdBy: "SYSTEM",
  });
  return { ok: true } as const;
}

export async function dispatchStageDwell(
  prisma: PrismaClient,
  input: { entryId: string; stage: string; severity: "WARNING" | "CRITICAL" | "ESCALATION"; secondsInStage: number; mode: string },
) {
  const tier = severityToTier(input.severity);
  const routing = await requireActiveConfigValue<Record<string, DispatchTier[]>>(prisma, "notification.routing.stageDwell").catch(
    () => ({ WARNING: ["OPERATOR"], CRITICAL: ["FOM"], ESCALATION: ["FOM"] }),
  );
  const targets = routing[input.severity] ?? [tier];
  const now = new Date();
  await auditService.emit(prisma, auditService.systemActor(), {
    eventType: "NOTIFICATION.STAGE_DWELL_DISPATCHED",
    entityType: "Entry",
    entityId: input.entryId,
    operation: "NOTIFY",
    timestamp: now,
    stageContext: input.stage,
    entryId: input.entryId,
    payload: { ...input, tier, targets, dispatchedAt: now.toISOString() },
    createdBy: "SYSTEM",
  });
  return { ok: true, tier } as const;
}

