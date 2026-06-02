import type { PrismaClient } from "@prisma/client";
import { assertS9Readiness } from "../../lib/s9-readiness.js";
import { getActiveConfigEntry } from "../../lib/config-store.js";

const CORE_KEYS = [
  "stageDwell.thresholds",
  "advancePayment.thresholds",
  "billing.salesTaxRate",
  "expiry.s3.committedHoldTtlSeconds",
  "nightAudit.scheduleTime",
  "handoff.H1.checklist",
  "handoff.H2.checklist",
  "handoff.H3.checklist",
  "deficientCondition.categories",
] as const;

export type ReadinessCheck = {
  id: string;
  label: string;
  status: "OK" | "MISSING" | "WARN";
  detail?: string;
};

export async function runReadinessCheck(prisma: PrismaClient) {
  const checks: ReadinessCheck[] = [];

  for (const key of CORE_KEYS) {
    const row = await getActiveConfigEntry(prisma, key);
    checks.push({
      id: key,
      label: key,
      status: row ? "OK" : "MISSING",
      detail: row ? `Active since ${row.effectiveFrom.toISOString()}` : "No active configuration row",
    });
  }

  let s9: ReadinessCheck = { id: "S9_READINESS", label: "S9 closure surfaces", status: "OK" };
  try {
    await assertS9Readiness(prisma);
  } catch (e) {
    s9 = {
      id: "S9_READINESS",
      label: "S9 closure surfaces",
      status: "MISSING",
      detail: (e as Error).message,
    };
  }
  checks.push(s9);

  const ratePlanCount = await prisma.ratePlanRegistry.count({ where: { isActive: true } });
  checks.push({
    id: "RATE_PLAN_REGISTRY",
    label: "Active rate plans (PricingPipelineEngine source)",
    status: ratePlanCount > 0 ? "OK" : "MISSING",
    detail: ratePlanCount > 0 ? `${ratePlanCount} active rate plan(s) in registry` : "No active rate plans — S1 indicative + S2 quotation pricing will fail",
  });

  const staffCount = await prisma.staffUser.count({ where: { isActive: true, actorLevel: "L4" } });
  checks.push({
    id: "L4_STAFF",
    label: "Active L4 administrators",
    status: staffCount > 0 ? "OK" : "WARN",
    detail: staffCount > 0 ? `${staffCount} active L4 user(s)` : "No active L4 staff — admin writes need an L4 actor",
  });

  const roomCount = await prisma.room.count();
  checks.push({
    id: "ROOM_INVENTORY",
    label: "Room inventory",
    status: roomCount > 0 ? "OK" : "WARN",
    detail: `${roomCount} room(s) registered`,
  });

  const failures = checks.filter((c) => c.status === "MISSING");
  const warnings = checks.filter((c) => c.status === "WARN");

  return {
    ranAt: new Date().toISOString(),
    ready: failures.length === 0,
    summary: {
      ok: checks.filter((c) => c.status === "OK").length,
      missing: failures.length,
      warnings: warnings.length,
      total: checks.length,
    },
    checks,
  };
}
