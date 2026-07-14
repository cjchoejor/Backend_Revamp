import type { PrismaClient } from "@prisma/client";
import { ModeLifecycleState } from "@prisma/client";
import { assertS9Readiness } from "../../lib/s9-readiness.js";
import { getActiveConfigEntry } from "../../lib/config-store.js";

/**
 * Known-good feature dependency names that any active ModeConfiguration may declare.
 * Adding a new value here means "this subsystem is expected to be running when a mode
 * that declares it fires". Missing declarations become MODE_DEPENDENCY_UNKNOWN warnings so
 * an admin can catch typos and stale seed data.
 */
const KNOWN_FEATURE_DEPENDENCIES = new Set<string>([
  "AvailabilityEngine",
  "PricingPipelineEngine",
  "RatePlanRegistry",
  "SeasonCalendar",
  "CommunicationConfigService",
  "CancellationPolicyRegistry",
  "RoomAssignmentService",
  "DiscountAuthorityPolicy",
  "GroupDetectionPolicy",
  "GuestProfileService",
  "DisputeService",
  "FolioService",
  "BillingModelPolicy",
  "FolioSettlementService",
]);

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

  // Mode dependencies — every ACTIVE ModeConfiguration declares a `featureDependencies` list.
  // Warn on any entry not in `KNOWN_FEATURE_DEPENDENCIES` so typos in seeds / admin edits surface.
  const activeModes = await prisma.modeConfiguration.findMany({
    where: { isActive: true, lifecycleState: ModeLifecycleState.ACTIVE },
    select: { modeKey: true, featureDependencies: true },
  });
  const unknownDeps: Array<{ mode: string; dependency: string }> = [];
  for (const m of activeModes) {
    const deps = Array.isArray(m.featureDependencies) ? (m.featureDependencies as unknown[]) : [];
    for (const d of deps) {
      if (typeof d !== "string") {
        unknownDeps.push({ mode: m.modeKey, dependency: String(d) });
        continue;
      }
      if (!KNOWN_FEATURE_DEPENDENCIES.has(d)) unknownDeps.push({ mode: m.modeKey, dependency: d });
    }
  }
  checks.push({
    id: "MODE_FEATURE_DEPENDENCIES",
    label: "Active mode feature dependencies",
    status: unknownDeps.length === 0 ? "OK" : "WARN",
    detail:
      unknownDeps.length === 0
        ? `${activeModes.length} active mode(s); all declared dependencies recognised.`
        : `${unknownDeps.length} unknown dependency reference(s): ${unknownDeps.map((u) => `${u.mode}→${u.dependency}`).join(", ")}. Update KNOWN_FEATURE_DEPENDENCIES if these are real subsystems, or edit the mode to remove typos.`,
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
