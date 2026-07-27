import type { Prisma, PrismaClient } from "@prisma/client";

/** Shared include for entry workspace GET / activation responses. */
export const entryDetailInclude = {
  reservation: true,
  folio: {
    include: {
      lines: { orderBy: { postedAt: "desc" as const }, take: 100 },
      invoices: { orderBy: { createdAt: "desc" as const } },
      payments: { orderBy: { createdAt: "desc" as const } },
      writeOffRecords: { orderBy: { createdAt: "desc" as const } },
      billingModelTransitions: { orderBy: { createdAt: "desc" as const }, take: 10 },
    },
  },
  disputes: { orderBy: { openedAt: "desc" as const }, take: 20 },
  cancellationDisclosure: true,
  guestProfile: true,
  handoffs: { orderBy: { createdAt: "desc" as const } },
  preArrivalTasks: { orderBy: { createdAt: "asc" as const } },
  roomAssignments: {
    include: {
      room: {
        include: {
          deficientConditionRecords: { orderBy: { detectedAt: "desc" as const } },
        },
      },
    },
    orderBy: { createdAt: "desc" as const },
  },
  availabilityConfigs: { orderBy: { createdAt: "desc" as const } },
  segments: { orderBy: { segmentNumber: "desc" as const }, take: 5 },
  quotations: { orderBy: { versionNumber: "desc" as const } },
  speculativeHolds: {
    orderBy: { placedAt: "desc" as const },
    include: { room: { select: { id: true, roomNumber: true } } },
  },
  committedHold: true,
  vipArrivalNotifications: { orderBy: { createdAt: "desc" as const }, take: 3 },
  keyReturnRecords: { orderBy: { createdAt: "desc" as const }, take: 3 },
  roomInspectionRecords: { orderBy: { createdAt: "desc" as const }, take: 3 },
  commissionDueRecords: { orderBy: { createdAt: "desc" as const }, take: 5 },
  followUpTasks: { orderBy: { createdAt: "desc" as const }, take: 5 },
  noShowDetermination: true,
  inquiry: { include: { agentProfile: { select: { id: true, displayName: true, commissionRate: true, commissionBasis: true } } } },
} satisfies Prisma.EntryInclude;

type Db = PrismaClient | Prisma.TransactionClient;

/** Full entry graph for stage workspaces (folio lines, payments, handoffs, …). */
export async function loadEntryDetail(db: Db, entryId: string) {
  return db.entry.findUniqueOrThrow({
    where: { id: entryId },
    include: entryDetailInclude,
  });
}
