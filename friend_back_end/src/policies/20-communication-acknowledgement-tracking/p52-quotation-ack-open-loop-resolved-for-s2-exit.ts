import type { PrismaClient } from "@prisma/client";
import { PolicyGateBlockedError } from "../../lib/errors.js";

/**
 * Policy 52 — Communication Acknowledgement Tracking (SIG-S2).
 * If quotation ack window was exceeded, FOM-resolved open loop must be recorded before S2→S3.
 */
export async function enforceQuotationAckOpenLoopResolvedForS2Exit(
  prisma: PrismaClient,
  input: { quotationId: string },
) {
  const exceeded = await prisma.traceEvent.findFirst({
    where: { eventType: "S2.QUOTATION_ACK_WINDOW_EXCEEDED", entityType: "Quotation", entityId: input.quotationId },
    orderBy: { timestamp: "desc" },
  });
  if (!exceeded) return;

  const resolved = await prisma.traceEvent.findFirst({
    where: { eventType: "S2.QUOTATION_ACK_OPEN_LOOP_RESOLVED", entityType: "Quotation", entityId: input.quotationId },
    orderBy: { timestamp: "desc" },
  });
  if (resolved) return;

  throw new PolicyGateBlockedError(
    "ACK_OPEN_LOOP_UNRESOLVED",
    "Acknowledgement window exceeded; open loop must be resolved before exit",
  );
}
