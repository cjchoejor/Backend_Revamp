import type { PrismaClient } from "@prisma/client";
import { PolicyGateBlockedError, ValidationError } from "../../lib/errors.js";
import { requireActiveConfigValue } from "../../lib/config-store.js";

export async function enforceDiscountApprovalAuthority(
  prisma: PrismaClient,
  input: { actorLevel: "L1" | "L2" | "L3" | "L4"; discountPercent: number },
) {
  const pct = Number(input.discountPercent);
  if (!Number.isFinite(pct) || pct <= 0) throw new ValidationError("Invalid requestedDiscount.discountPercent");

  const maxFom = await requireActiveConfigValue<number>(prisma, "discount.fom.maxPercentage");
  const maxGm = await requireActiveConfigValue<number>(prisma, "discount.gm.maxPercentage");
  const needsL3 = pct > maxGm;
  const needsL2 = pct > maxFom;

  if (needsL3 && input.actorLevel !== "L3") throw new PolicyGateBlockedError("DISCOUNT_REQUIRES_GM", "Discount exceeds GM authority band");
  if (!needsL3 && needsL2 && input.actorLevel === "L1") throw new PolicyGateBlockedError("DISCOUNT_REQUIRES_FOM", "Discount exceeds front desk authority band");
}

