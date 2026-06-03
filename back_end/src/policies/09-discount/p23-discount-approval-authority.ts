import type { Prisma, PrismaClient } from "@prisma/client";
import { PolicyGateBlockedError, ValidationError } from "../../lib/errors.js";
import { requireActiveConfigValue } from "../../lib/config-store.js";
import { getRegistryPolicy } from "../../lib/policy-registry-runtime.js";

type Db = PrismaClient | Prisma.TransactionClient;

export type ActorDiscountCeilings = {
  /** Max % an L1 (front desk) may apply without escalation. */
  l1MaxPercent: number;
  /** Max % an L2 (FOM) may apply without escalating to GM. */
  l2MaxPercent: number;
  /** Max % an L3 (GM) may apply. Default 100. */
  l3MaxPercent: number;
  source: "policy_registry" | "configuration_entry";
};

/**
 * Resolve per-actor discount ceilings. Registry policy `registry.discount.actorCeiling` takes
 * precedence when enabled and all three numeric fields are present; otherwise falls back to the
 * legacy ConfigurationEntry keys `discount.fom.maxPercentage` (= L1 ceiling) and
 * `discount.gm.maxPercentage` (= L2 ceiling).
 */
export async function resolveActorDiscountCeilings(db: Db): Promise<ActorDiscountCeilings> {
  const policy = await getRegistryPolicy(db, "registry.discount.actorCeiling");
  if (
    policy &&
    policy.enabled !== false &&
    typeof policy.l1MaxPercent === "number" &&
    typeof policy.l2MaxPercent === "number" &&
    typeof policy.l3MaxPercent === "number"
  ) {
    return {
      l1MaxPercent: policy.l1MaxPercent as number,
      l2MaxPercent: policy.l2MaxPercent as number,
      l3MaxPercent: policy.l3MaxPercent as number,
      source: "policy_registry",
    };
  }
  const l1 = await requireActiveConfigValue<number>(db as PrismaClient, "discount.fom.maxPercentage");
  const l2 = await requireActiveConfigValue<number>(db as PrismaClient, "discount.gm.maxPercentage");
  return { l1MaxPercent: l1, l2MaxPercent: l2, l3MaxPercent: 100, source: "configuration_entry" };
}

export async function enforceDiscountApprovalAuthority(
  prisma: PrismaClient,
  input: { actorLevel: "L1" | "L2" | "L3" | "L4"; discountPercent: number },
) {
  const pct = Number(input.discountPercent);
  if (!Number.isFinite(pct) || pct <= 0) throw new ValidationError("Invalid requestedDiscount.discountPercent");

  const ceilings = await resolveActorDiscountCeilings(prisma);
  const needsL3 = pct > ceilings.l2MaxPercent;
  const needsL2 = pct > ceilings.l1MaxPercent;

  if (needsL3 && input.actorLevel !== "L3") throw new PolicyGateBlockedError("DISCOUNT_REQUIRES_GM", "Discount exceeds GM authority band");
  if (!needsL3 && needsL2 && input.actorLevel === "L1") throw new PolicyGateBlockedError("DISCOUNT_REQUIRES_FOM", "Discount exceeds front desk authority band");
}
