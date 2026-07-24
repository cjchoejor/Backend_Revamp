import { ConfigurationViolationError } from "../errors.js";

export interface RequiredControlCheckInput {
  surfaceName: string;
  proposedChange: unknown;
  currentValue?: unknown;
  operationType: "CREATE" | "UPDATE" | "DELETE";
  actorId: string;
}

/** A deterministic check: returns a violation message, or null when the change is acceptable. */
type CheckFn = (proposed: any, current: any, op: RequiredControlCheckInput["operationType"]) => string | null;

const CREDIT_CEILING_TIERS = ["standard", "preferred", "caution", "restricted"];

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function tierKey(obj: Record<string, unknown>, tier: string): unknown {
  // tolerate STANDARD / standard casing
  return obj[tier] ?? obj[tier.toUpperCase()] ?? obj[tier.toLowerCase()];
}

/**
 * ACIG §6.1A.1 RequiredControlCheck registry. Each surface maps to deterministic
 * governance checks invoked before the write transaction opens. Surfaces without a
 * registered check pass by default.
 */
const CHECK_REGISTRY: Record<string, CheckFn[]> = {
  discount_thresholds: [
    (proposed) => {
      const fom = Number((proposed as any)?.fomMaxPercentage ?? (proposed as any)?.["discount.fom.maxPercentage"]);
      const gm = Number((proposed as any)?.gmMaxPercentage ?? (proposed as any)?.["discount.gm.maxPercentage"]);
      if (Number.isFinite(fom) && fom < 0) return "FOM discount percentage cannot be negative";
      if (Number.isFinite(gm) && gm < 0) return "GM discount percentage cannot be negative";
      if (Number.isFinite(fom) && Number.isFinite(gm) && fom > gm) {
        return "FOM discount ceiling must not exceed the GM discount ceiling";
      }
      return null;
    },
  ],
  credit_extension_ceiling_thresholds: [
    (proposed) => {
      if (!isPlainObject(proposed)) return "Credit ceiling thresholds must be an object keyed by tier";
      for (const tier of CREDIT_CEILING_TIERS) {
        const v = tierKey(proposed, tier);
        if (v === undefined || v === null) return `Credit ceiling tier "${tier}" is missing — all four tiers must be saved together`;
        if (typeof v === "number" && v < 0) return `Credit ceiling for tier "${tier}" cannot be negative`;
      }
      return null;
    },
  ],
  CancellationPolicyRegistry: [
    (proposed) => {
      const tiers = (proposed as any)?.penaltyTiers;
      if (!Array.isArray(tiers) || tiers.length === 0) return "A cancellation policy must define at least one penalty tier";
      const sorted = [...tiers].sort((a, b) => Number(b.daysBeforeArrival) - Number(a.daysBeforeArrival));
      let prevPenalty = -1;
      for (const t of sorted) {
        const pct = Number(t.penaltyPercentage);
        const days = Number(t.daysBeforeArrival);
        if (!Number.isFinite(pct) || pct < 0 || pct > 100) return "Penalty percentage must be between 0 and 100";
        if (!Number.isFinite(days) || days < 0) return "daysBeforeArrival must be a non-negative number";
        if (pct < prevPenalty) return "Penalty tiers must be non-decreasing as the arrival date approaches";
        prevPenalty = pct;
      }
      return null;
    },
  ],
  no_show_penalty_structure: [
    (proposed) => {
      if (proposed === undefined || proposed === null) return "No-show penalty structure is required";
      if (isPlainObject(proposed) && Object.keys(proposed).length === 0) {
        return "No-show penalty structure cannot be empty";
      }
      return null;
    },
  ],
  VipNotificationRoutingConfig: [
    (proposed) => {
      const roles = (proposed as any)?.notifyRoles;
      const actors = (proposed as any)?.notifyActorIds;
      const hasRoles = Array.isArray(roles) && roles.length > 0;
      const hasActors = Array.isArray(actors) && actors.length > 0;
      if (!hasRoles && !hasActors) return "A VIP routing entry must notify at least one role or actor";
      return null;
    },
  ],
  advance_payment_thresholds: [
    (proposed) => {
      const follow = Number((proposed as any)?.followUpWindowSeconds);
      const esc = Number((proposed as any)?.escalationWindowSeconds);
      if (Number.isFinite(follow) && Number.isFinite(esc) && follow >= esc) {
        return "followUpWindowSeconds must be less than escalationWindowSeconds";
      }
      return null;
    },
  ],
  RatePlanRegistry: [
    (proposed) => {
      const rate = Number((proposed as any)?.baseRate);
      if (Number.isFinite(rate) && rate < 0) return "Rate plan base rate cannot be negative";
      const margin = (proposed as any)?.overrideMargin;
      if (margin !== undefined && margin !== null && Number(margin) < 0) return "Override margin cannot be negative";
      return null;
    },
  ],
  season_calendar: [
    (proposed) => {
      const start = (proposed as any)?.startDate ? new Date((proposed as any).startDate) : null;
      const end = (proposed as any)?.endDate ? new Date((proposed as any).endDate) : null;
      if (start && end && start.getTime() >= end.getTime()) return "Season startDate must be before endDate";
      return null;
    },
  ],
};

/**
 * ACIG §6.1A.1 — invoked by every admin write method before opening the Prisma `$transaction`.
 * Throws ConfigurationViolationError (HTTP 422) on the first failing check.
 */
export async function requiredControlCheck(input: RequiredControlCheckInput): Promise<void> {
  const checks = CHECK_REGISTRY[input.surfaceName] ?? [];
  for (const check of checks) {
    const violation = check(input.proposedChange, input.currentValue, input.operationType);
    if (violation) {
      throw new ConfigurationViolationError(violation, {
        control: input.surfaceName,
        requirement: violation,
        proposedChange: input.proposedChange,
      });
    }
  }
}
