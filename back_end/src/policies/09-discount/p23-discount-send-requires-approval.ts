import type { PrismaClient } from "@prisma/client";
import { PolicyGateBlockedError } from "../../lib/errors.js";

export async function enforceDiscountApprovalBeforeSend(
  prisma: PrismaClient,
  input: { quotationId: string; hasDiscount: boolean },
) {
  if (!input.hasDiscount) return;

  const approvals = await prisma.traceEvent.findMany({
    where: {
      eventType: "S2.DISCOUNT.APPROVED",
      entityType: "Quotation",
      entityId: input.quotationId,
    },
    orderBy: { timestamp: "desc" },
    take: 5,
  });

  if (!approvals.length) {
    throw new PolicyGateBlockedError("DISCOUNT_UNAPPROVED", "Quotation has a discount without recorded approval");
  }
}

