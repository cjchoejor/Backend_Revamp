import type { Prisma } from "@prisma/client";
import { ValidationError } from "../../lib/errors.js";

function expandedWindowMs(start: Date, end: Date, bufferMs: number) {
  return { lo: start.getTime() - bufferMs, hi: end.getTime() + bufferMs };
}

function rangesOverlap(a: { lo: number; hi: number }, b: { lo: number; hi: number }) {
  return !(a.hi < b.lo || b.hi < a.lo);
}

/**
 * Policy 67 — turnaround buffer before creating a **QUOTED** space allocation (SIG-S1 §6.5).
 * Compares the requested window (expanded by buffer) against other active allocations on the same space.
 */
export async function assertSpaceTurnaroundBufferAllowsQuotedAllocation(
  tx: Prisma.TransactionClient,
  params: { spaceId: string; windowStart: Date; windowEnd: Date; bufferMs: number },
) {
  if (params.bufferMs < 0) throw new ValidationError("turnaround buffer must be non-negative");
  const candidate = expandedWindowMs(params.windowStart, params.windowEnd, params.bufferMs);

  const allocations = await tx.spaceAllocation.findMany({
    where: {
      spaceId: params.spaceId,
      state: { in: ["QUOTED", "HELD", "CONFIRMED"] },
    },
    include: { entry: { select: { checkInDate: true, checkOutDate: true } } },
  });

  for (const a of allocations) {
    const eb = (a.eventBlock ?? {}) as { checkInDate?: string; checkOutDate?: string };
    const start = eb.checkInDate ? new Date(eb.checkInDate) : a.entry.checkInDate;
    const end = eb.checkOutDate ? new Date(eb.checkOutDate) : a.entry.checkOutDate;
    if (!start || !end || Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) continue;
    const other = expandedWindowMs(start, end, params.bufferMs);
    if (rangesOverlap(candidate, other)) {
      throw new ValidationError("Space turnaround buffer conflict with an existing allocation on this space");
    }
  }
}
