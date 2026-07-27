import type { Prisma, PrismaClient } from "@prisma/client";

export type TraceQueryFilters = {
  actorId?: string;
  entityType?: string;
  entityId?: string;
  eventType?: string; // substring match (case-insensitive)
  from?: Date;
  to?: Date;
  limit?: number;
  offset?: number;
};

type TraceRow = {
  id: string;
  eventType: string;
  actorId: string;
  actorLevel: string;
  entityType: string;
  entityId: string;
  operation: string;
  payload: Prisma.JsonValue;
  timestamp: Date;
  stageContext: string | null;
  segmentContext: string | null;
  correlationId: string | null;
  inquiryId: string | null;
  entryId: string | null;
};

/** Resolve actorId -> staff full name (best effort; non-staff actors fall back to the id). */
async function enrichActorNames<T extends { actorId: string }>(prisma: PrismaClient, rows: T[]) {
  const ids = [...new Set(rows.map((r) => r.actorId).filter(Boolean))];
  if (ids.length === 0) return rows.map((r) => ({ ...r, actorName: r.actorId }));
  const staff = await prisma.staffUser.findMany({
    where: { id: { in: ids } },
    select: { id: true, fullName: true },
  });
  const byId = new Map(staff.map((s) => [s.id, s.fullName]));
  return rows.map((r) => ({ ...r, actorName: byId.get(r.actorId) ?? r.actorId }));
}

const clampLimit = (n: number | undefined, fallback: number, max: number) =>
  Math.min(Math.max(Math.trunc(n ?? fallback), 1), max);

/** Filtered, paginated trace-event query for the admin audit-trail surface. */
export async function queryTraceEvents(prisma: PrismaClient, filters: TraceQueryFilters) {
  const limit = clampLimit(filters.limit, 50, 200);
  const offset = Math.max(filters.offset ?? 0, 0);

  const where: Prisma.TraceEventWhereInput = {
    ...(filters.entityType ? { entityType: { contains: filters.entityType, mode: "insensitive" } } : {}),
    ...(filters.entityId ? { entityId: filters.entityId } : {}),
    ...(filters.eventType ? { eventType: { contains: filters.eventType, mode: "insensitive" } } : {}),
    ...(filters.from || filters.to
      ? {
          timestamp: {
            ...(filters.from ? { gte: filters.from } : {}),
            ...(filters.to ? { lte: filters.to } : {}),
          },
        }
      : {}),
  };

  // "Who" filter: match a partial actor id (e.g. "admin-1" → "staff-admin-1") OR a staff name
  // (e.g. "Admin 1"). Resolve matching staff ids, then match by id substring or id-in-set.
  if (filters.actorId) {
    const term = filters.actorId.trim();
    const staff = await prisma.staffUser.findMany({
      where: { fullName: { contains: term, mode: "insensitive" } },
      select: { id: true },
      take: 50,
    });
    const ids = staff.map((s) => s.id);
    where.OR = [
      { actorId: { contains: term, mode: "insensitive" } },
      ...(ids.length ? [{ actorId: { in: ids } }] : []),
    ];
  }

  const [rows, total] = await Promise.all([
    prisma.traceEvent.findMany({ where, orderBy: { timestamp: "desc" }, take: limit, skip: offset }),
    prisma.traceEvent.count({ where }),
  ]);

  const items = await enrichActorNames(prisma, rows as TraceRow[]);
  return { items, total, limit, offset };
}

/** All trace events for a single entry (by entryId or by entityId pointing at the entry). */
export async function getEntryTrace(prisma: PrismaClient, entryId: string, limit = 100) {
  const take = clampLimit(limit, 100, 300);
  const rows = await prisma.traceEvent.findMany({
    where: { OR: [{ entryId }, { entityId: entryId }] },
    orderBy: { timestamp: "desc" },
    take,
  });
  const items = await enrichActorNames(prisma, rows as TraceRow[]);
  return { items, count: items.length };
}
