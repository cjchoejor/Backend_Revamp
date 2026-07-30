/**
 * Recover the figures a cancellation actually settled on, from the cancellation's own TraceEvent.
 *
 * WHY READ THE TRACE RATHER THAN RECOMPUTE
 * ---------------------------------------
 * The A5 Cancellation Confirmation must restate the decision the engine made at the moment of
 * cancellation. Re-running the penalty computation later would consult the CURRENT
 * CancellationPolicyRegistry / config, which may have been edited since — producing a document that
 * contradicts the refund the guest was actually paid. The trace is the durable record of that
 * decision, so it is the source here.
 *
 * All three entry points in `cancellation-service` write the same payload shape
 * (`advanceTotal`, `penalty`, `netRefund`, `penaltyWaiverRequested`), which is what makes one reader
 * sufficient for S3 pre-confirmation, S5 pre-arrival and S7 early-departure cancellations.
 */
import type { PrismaClient } from "@prisma/client";
import { NotFoundError } from "../../lib/errors.js";
import type { CancellationFigures } from "./cancellation-confirmation-pdf-service.js";

/** The three cancellation traces, newest-first preference order is by timestamp. */
const CANCELLATION_EVENT_TYPES = [
  "ENTRY.S3.CANCELLED",
  "ENTRY.S5.CANCELLED",
  "ENTRY.S7.EARLY_DEPARTURE_CANCELLED",
];

function num(v: unknown): number {
  if (v == null) return 0;
  const n = typeof v === "number" ? v : Number(String(v));
  return Number.isFinite(n) ? n : 0;
}

export async function readCancellationFiguresFromTrace(
  prisma: PrismaClient,
  entryId: string,
): Promise<CancellationFigures> {
  const trace = await prisma.traceEvent.findFirst({
    where: { entryId, eventType: { in: CANCELLATION_EVENT_TYPES } },
    orderBy: { timestamp: "desc" },
  });
  if (!trace) throw new NotFoundError("Cancellation record for this entry");

  const p = (trace.payload ?? {}) as Record<string, unknown>;
  const advanceHeld = num(p.advanceTotal);
  const retained = num(p.penalty);
  // The engine floors the refund at zero (penalty is capped at the advance), so mirror that rather
  // than printing a negative refund if a payload ever carries odd values.
  const netRefund = p.netRefund != null ? num(p.netRefund) : advanceHeld - retained;

  // The refund PAYMENT the engine raised, if any — matched by direction on this entry's folio.
  const refund = await prisma.paymentRecord.findFirst({
    where: { entryId, paymentDirection: { not: "IN" } },
    orderBy: { createdAt: "desc" },
    select: { id: true },
  });

  return {
    advanceHeld,
    retained,
    refundIssued: Math.max(0, netRefund),
    // The band label isn't in the payload (the engine records the computed penalty, not which tier
    // produced it). Left null so the document prints the neutral "Refundable per terms" rather than
    // asserting a band that might be wrong.
    bandLabel: null,
    refundReceiptNo: refund?.id ?? null,
    advanceReceiptRef: null,
    penaltyWaived: p.penaltyWaiverRequested === true && retained === 0,
    cancelledAt: trace.timestamp,
  };
}
