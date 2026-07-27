import type { PrismaClient } from "@prisma/client";
import { MissingConfigurationError, PolicyGateBlockedError, ValidationError } from "../../lib/errors.js";
import { requireActiveConfigValue } from "../../lib/config-store.js";

export async function validateDiscountRequestAgainstAuthorityBands(
  prisma: PrismaClient,
  input: { discountPercent: number; discountBasis: string },
) {
  if (!Number.isFinite(input.discountPercent) || input.discountPercent <= 0 || input.discountPercent > 100) {
    throw new ValidationError("requestedDiscount.discountPercent must be in (0, 100]");
  }
  if (!input.discountBasis?.trim()) throw new ValidationError("requestedDiscount.discountBasis is required");

  const maxGm = await requireActiveConfigValue<number>(prisma, "discount.gm.maxPercentage").catch(() => {
    throw new MissingConfigurationError("discount.gm.maxPercentage");
  });
  if (input.discountPercent > maxGm) {
    throw new PolicyGateBlockedError("DISCOUNT_REQUIRES_GM", "Discount exceeds GM authority band");
  }
}

