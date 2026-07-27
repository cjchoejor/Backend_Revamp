/**
 * EntityVersionSnapshot — append-only version history for in-place CRUD admin tables.
 *
 * Pattern: every admin service whose Update endpoint mutates a tracked entity wraps its
 * write in `withEntityVersionSnapshot(...)`. The wrapper captures the prior row state as
 * JSON, increments the per-entity version counter, then runs the caller's mutator inside
 * the same transaction so snapshot + mutation are atomic.
 *
 * Restoring a snapshot writes its `rowJson` back to the live row — AND inserts a fresh
 * snapshot capturing what was just superseded (so the restore itself is auditable).
 *
 * Only L4 may read or restore (enforced at the route layer).
 */
import type { Prisma, PrismaClient } from "@prisma/client";

type Tx = Prisma.TransactionClient;

/**
 * The 15 admin CRUD tables tracked by EntityVersionSnapshot.
 *
 * Source of truth — keep this in sync with:
 *   - the admin services that wrap their Updates via `withEntityVersionSnapshot`
 *   - the frontend `VersionsTab` consumers
 */
export const TRACKED_ENTITY_TYPES = [
  "HotelProfile",
  "Department",
  "Role",
  "StaffUser",
  "RatePlanRegistry",
  "SeasonCalendar",
  "PackageRegistry",
  "CancellationPolicyRegistry",
  "ModeConfiguration",
  "CommunicationTemplate",
  "InvoiceTemplate",
  "FeedbackSurveyTemplate",
  "HandoffChecklistTemplate",
  "WorkOrderTemplate",
  "VipNotificationRoutingConfig",
  // Phase B additions (Travel agents + Corporate) — added pre-emptively per user request.
  "TravelAgent",
  "CorporateAccount",
] as const;

export type TrackedEntityType = (typeof TRACKED_ENTITY_TYPES)[number];

/** Map entity type → Prisma delegate name (camelCase). */
const ENTITY_DELEGATE: Record<TrackedEntityType, string> = {
  HotelProfile: "hotelProfile",
  Department: "department",
  Role: "role",
  StaffUser: "staffUser",
  RatePlanRegistry: "ratePlanRegistry",
  SeasonCalendar: "seasonCalendar",
  PackageRegistry: "packageRegistry",
  CancellationPolicyRegistry: "cancellationPolicyRegistry",
  ModeConfiguration: "modeConfiguration",
  CommunicationTemplate: "communicationTemplate",
  InvoiceTemplate: "invoiceTemplate",
  FeedbackSurveyTemplate: "feedbackSurveyTemplate",
  HandoffChecklistTemplate: "handoffChecklistTemplate",
  WorkOrderTemplate: "workOrderTemplate",
  VipNotificationRoutingConfig: "vipNotificationRoutingConfig",
  TravelAgent: "travelAgent",
  CorporateAccount: "corporateAccount",
};

export function isTrackedEntityType(s: string): s is TrackedEntityType {
  return (TRACKED_ENTITY_TYPES as readonly string[]).includes(s);
}

/**
 * Snapshot the entity's current state, then run the mutator inside the same transaction.
 * If the entity row doesn't exist yet (Update-before-Create race), no snapshot is written
 * and the mutator runs straight through — the mutator should `update()` which will throw
 * `RecordNotFound` if appropriate.
 */
export async function withEntityVersionSnapshot<T>(
  prisma: PrismaClient,
  args: {
    entityType: TrackedEntityType;
    entityId: string;
    actorId: string;
    changeNote?: string | null;
  },
  mutator: (tx: Tx) => Promise<T>,
): Promise<T> {
  if (!isTrackedEntityType(args.entityType)) {
    throw new Error(`EntityVersionSnapshot: unknown entityType ${args.entityType}`);
  }
  return prisma.$transaction(async (tx) => {
    await captureSnapshotTx(tx, args);
    return mutator(tx);
  });
}

/**
 * Lower-level — capture a snapshot inside an existing transaction. Use this when the
 * surrounding code already runs `prisma.$transaction(...)` and you can't nest.
 */
export async function captureSnapshotTx(
  tx: Tx,
  args: {
    entityType: TrackedEntityType;
    entityId: string;
    actorId: string;
    changeNote?: string | null;
  },
): Promise<void> {
  const delegate = (tx as any)[ENTITY_DELEGATE[args.entityType]];
  const current = await delegate.findUnique({ where: { id: args.entityId } });
  if (!current) return; // Update will fail downstream; nothing to snapshot.

  const lastVersion = await tx.entityVersionSnapshot.findFirst({
    where: { entityType: args.entityType, entityId: args.entityId },
    orderBy: { version: "desc" },
    select: { version: true },
  });

  await tx.entityVersionSnapshot.create({
    data: {
      entityType: args.entityType,
      entityId: args.entityId,
      version: (lastVersion?.version ?? 0) + 1,
      rowJson: current as unknown as Prisma.InputJsonValue,
      changedBy: args.actorId,
      changeNote: args.changeNote ?? null,
    },
  });
}

/** List snapshots for an entity, newest first. */
export async function listSnapshots(
  prisma: PrismaClient,
  entityType: TrackedEntityType,
  entityId: string,
) {
  if (!isTrackedEntityType(entityType)) {
    throw new Error(`Unknown entityType: ${entityType}`);
  }
  const rows = await prisma.entityVersionSnapshot.findMany({
    where: { entityType, entityId },
    orderBy: { version: "desc" },
  });
  return rows.map((r) => ({
    id: r.id,
    version: r.version,
    rowJson: r.rowJson,
    changedAt: r.changedAt,
    changedBy: r.changedBy,
    changeNote: r.changeNote,
  }));
}

/**
 * Restore a snapshot. Captures another snapshot of the current state (so the restore is
 * itself reversible), then overwrites the live row with the snapshot's rowJson.
 *
 * Returns the restored row.
 */
export async function restoreSnapshot(
  prisma: PrismaClient,
  args: { snapshotId: string; actorId: string; changeNote?: string | null },
): Promise<unknown> {
  return prisma.$transaction(async (tx) => {
    const snap = await tx.entityVersionSnapshot.findUnique({ where: { id: args.snapshotId } });
    if (!snap) throw new Error(`Snapshot ${args.snapshotId} not found`);
    if (!isTrackedEntityType(snap.entityType)) {
      throw new Error(`Snapshot has unknown entityType: ${snap.entityType}`);
    }

    await captureSnapshotTx(tx, {
      entityType: snap.entityType,
      entityId: snap.entityId,
      actorId: args.actorId,
      changeNote: args.changeNote ?? `Pre-restore snapshot before reverting to v${snap.version}`,
    });

    const delegate = (tx as any)[ENTITY_DELEGATE[snap.entityType]];
    const restoredFields = { ...(snap.rowJson as Record<string, unknown>) };
    // Don't try to overwrite the immutable PK.
    delete restoredFields.id;
    // Don't overwrite createdAt — it's the row's birth date.
    delete restoredFields.createdAt;
    // Bump updatedAt to now.
    if ("updatedAt" in restoredFields) restoredFields.updatedAt = new Date();
    // Optimistic locking: bump version if the model uses it.
    if ("version" in restoredFields && typeof restoredFields.version === "number") {
      restoredFields.version = (restoredFields.version as number) + 1;
    }

    return delegate.update({ where: { id: snap.entityId }, data: restoredFields });
  });
}
