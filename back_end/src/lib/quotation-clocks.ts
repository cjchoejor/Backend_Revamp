/**
 * Stop every clock a retired quotation still runs (2026-10-07).
 *
 * A quotation runs clocks in two places: on itself (its validity, W15; the acknowledgement
 * tracker) and on the email it went out in — the CommunicationRecord's answer window, W22. When a
 * quotation is retired the offer no longer exists, so none of them mean anything. Accepting one and
 * superseding one already cancelled both; a configuration change at Negotiation and the validity
 * running out stopped only the first, so the old quote's "waiting for the guest's answer" clock
 * kept counting beside the new one's — the desk and the second screen showed it, and the second
 * screen asked the operator to record an answer that had already been recorded on the new quote
 * (operator report, 2026-10-07). Every path that retires a quotation calls this.
 */
import type { Prisma } from "@prisma/client";

type Engine = { cancel(jobId: string): Promise<unknown> };

export async function cancelQuotationClocksTx(
  tx: Prisma.TransactionClient,
  engine: Engine,
  quotationIds: string[],
  opts: { actorId: string; reason: string; now?: Date },
): Promise<number> {
  if (quotationIds.length === 0) return 0;
  const quotes = await tx.quotation.findMany({
    where: { id: { in: quotationIds } },
    select: { communicationRecordId: true },
  });
  const commIds = quotes.map((q) => q.communicationRecordId).filter((x): x is string => !!x);
  const timers = await tx.timerRecord.findMany({
    where: {
      status: "SCHEDULED",
      OR: [
        { entityType: "Quotation", entityId: { in: quotationIds } },
        ...(commIds.length ? [{ entityType: "CommunicationRecord", entityId: { in: commIds } }] : []),
      ],
    },
    select: { id: true, pgBossJobId: true },
  });
  for (const t of timers) if (t.pgBossJobId) await engine.cancel(t.pgBossJobId).catch(() => undefined);
  if (timers.length) {
    await tx.timerRecord.updateMany({
      where: { id: { in: timers.map((t) => t.id) } },
      data: { status: "CANCELLED", cancelledAt: opts.now ?? new Date(), cancelledBy: opts.actorId, cancelledReason: opts.reason },
    });
  }
  return timers.length;
}
