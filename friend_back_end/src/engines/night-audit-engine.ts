/**
 * Atlas Cat 05 §4.9 — NightAuditEngine (`runAudit(input): NightAuditResult`).
 * Nightly orchestration for in-stay folios is implemented in `services/application/s7-night-audit-service.ts`
 * and triggered by W6 (`workers/w6-night-audit-worker.ts`). This module is the named engine shell for
 * future extraction of pure planning logic without Prisma side effects.
 */
export type NightAuditPlanInput = {
  operatingDateIso: string;
};

export type NightAuditPlanResult = {
  /** Placeholder until plan structure is lifted from the service. */
  plannedEntryIds: string[];
};

/** Pure planner stub — returns empty plan; real behaviour remains in `runNightAudit`. */
export function planNightAudit(_input: NightAuditPlanInput): NightAuditPlanResult {
  return { plannedEntryIds: [] };
}
