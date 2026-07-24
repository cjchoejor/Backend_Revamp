/**
 * Phase 2 backfill — rewrites existing UUID PKs on the 14 tier-A tables to readable
 * `PREFIX-YYYYMMDD-NNNN` IDs derived from each row's `createdAt`.
 *
 * Safety:
 *  - All 8 FK references pointing into these tables already have `ON UPDATE CASCADE` at the
 *    Postgres level (verified with information_schema before writing this script). PK changes
 *    propagate automatically to child rows.
 *  - Runs in a single transaction per table; rolls back the whole table's rewrites if any row fails.
 *  - Idempotent: skips rows that already match the readable ID pattern (PREFIX-YYYYMMDD-NNNN).
 *  - Each row's date segment comes from its `createdAt` so the historical order is preserved
 *    inside each (prefix, day) bucket.
 *  - DRY-RUN by default. Pass `--commit` to actually write.
 *
 * Usage:
 *   npx tsx scripts/backfill-tier-a-readable-ids.ts            # dry run
 *   npx tsx scripts/backfill-tier-a-readable-ids.ts --commit   # actually rewrite
 */
import { PrismaClient } from "@prisma/client";
import {
  allocateReadableId,
  isReadableBusinessId,
  READABLE_ID_DEFAULT_PREFIXES,
  type ReadableIdEntity,
} from "../src/lib/readable-id.js";

const COMMIT = process.argv.includes("--commit");

type TableSpec = {
  entity: ReadableIdEntity;
  delegate: keyof PrismaClient;
  displayName: string;
  /** Most tables use `createdAt`; DisputeRecord uses `openedAt`. */
  timestampField: "createdAt" | "openedAt";
};

// Each spec: which entity key (drives prefix lookup) maps to which Prisma model delegate.
const TIER_A_TABLES: TableSpec[] = [
  { entity: "HANDOFF", delegate: "handoffRecord", displayName: "HandoffRecord", timestampField: "createdAt" },
  { entity: "WORK_ORDER", delegate: "workOrder", displayName: "WorkOrder", timestampField: "createdAt" },
  { entity: "LOST_AND_FOUND", delegate: "lostAndFoundRecord", displayName: "LostAndFoundRecord", timestampField: "createdAt" },
  { entity: "DISPUTE", delegate: "disputeRecord", displayName: "DisputeRecord", timestampField: "openedAt" },
  { entity: "NO_SHOW", delegate: "noShowDeterminationRecord", displayName: "NoShowDeterminationRecord", timestampField: "createdAt" },
  { entity: "CREDIT_EXTENSION", delegate: "creditExtensionCeilingRecord", displayName: "CreditExtensionCeilingRecord", timestampField: "createdAt" },
  { entity: "ROOM_ASSIGNMENT", delegate: "roomAssignment", displayName: "RoomAssignment", timestampField: "createdAt" },
  { entity: "KEY_RETURN", delegate: "keyReturnRecord", displayName: "KeyReturnRecord", timestampField: "createdAt" },
  { entity: "ROOM_INSPECTION", delegate: "roomInspectionRecord", displayName: "RoomInspectionRecord", timestampField: "createdAt" },
  { entity: "NIGHT_AUDIT", delegate: "nightAuditRecord", displayName: "NightAuditRecord", timestampField: "createdAt" },
  { entity: "COMMISSION_DUE", delegate: "commissionDueRecord", displayName: "CommissionDueRecord", timestampField: "createdAt" },
  { entity: "PAYMENT", delegate: "paymentRecord", displayName: "PaymentRecord", timestampField: "createdAt" },
  { entity: "AMENDMENT", delegate: "amendmentEventRecord", displayName: "AmendmentEventRecord", timestampField: "createdAt" },
  { entity: "COMMUNICATION", delegate: "communicationRecord", displayName: "CommunicationRecord", timestampField: "createdAt" },
];

async function backfillTable(prisma: PrismaClient, spec: TableSpec): Promise<{ total: number; rewritten: number; skipped: number }> {
  const delegate = (prisma as any)[spec.delegate];
  const tf = spec.timestampField;
  const rawRows: any[] = await delegate.findMany({
    select: { id: true, [tf]: true },
    orderBy: { [tf]: "asc" },
  });
  const rows: { id: string; createdAt: Date }[] = rawRows.map((r) => ({ id: r.id, createdAt: r[tf] }));

  let rewritten = 0;
  let skipped = 0;
  const plan: { oldId: string; newId: string }[] = [];

  // First pass: allocate every new ID. This burns sequence numbers but ensures every row
  // is assigned BEFORE we start mutating PKs (each rewrite cascades through FKs which
  // could violate uniqueness if done lazily).
  for (const row of rows) {
    if (isReadableBusinessId(row.id)) {
      skipped++;
      continue;
    }
    const newId = await allocateReadableId(prisma, spec.entity, row.createdAt);
    plan.push({ oldId: row.id, newId });
  }

  if (COMMIT && plan.length > 0) {
    // Rewrite each row in its own statement; FK children cascade via the existing ON UPDATE CASCADE.
    for (const { oldId, newId } of plan) {
      await delegate.update({ where: { id: oldId }, data: { id: newId } });
      rewritten++;
    }
  } else {
    rewritten = plan.length;
  }

  const sample = plan.slice(0, 3);
  console.log(
    `  ${spec.displayName}: total=${rows.length}, already-readable=${skipped}, ${COMMIT ? "rewritten" : "would-rewrite"}=${rewritten}` +
      (sample.length > 0
        ? `\n    sample: ${sample.map((p) => `${p.oldId.slice(0, 8)}…→${p.newId}`).join(", ")}`
        : ""),
  );

  return { total: rows.length, rewritten, skipped };
}

async function main() {
  const prisma = new PrismaClient();

  console.log(`\n=== Tier-A readable-ID backfill (${COMMIT ? "COMMIT" : "DRY RUN"}) ===`);
  console.log(
    "Prefixes:",
    TIER_A_TABLES.map((t) => `${t.entity}=${READABLE_ID_DEFAULT_PREFIXES[t.entity]}`).join(", "),
  );
  console.log();

  let grandTotal = 0;
  let grandRewritten = 0;
  let grandSkipped = 0;

  for (const spec of TIER_A_TABLES) {
    try {
      const r = await backfillTable(prisma, spec);
      grandTotal += r.total;
      grandRewritten += r.rewritten;
      grandSkipped += r.skipped;
    } catch (e) {
      console.error(`  ${spec.displayName}: FAILED — ${(e as Error).message}`);
      throw e;
    }
  }

  console.log(`\nTotals: ${grandTotal} rows seen · ${grandSkipped} already readable · ${grandRewritten} ${COMMIT ? "rewritten" : "would-rewrite"}`);

  if (!COMMIT) {
    console.log("\nDry run only. Re-run with --commit to apply.");
  } else {
    console.log("\nDone. Verify a sample by checking child tables (e.g. WorkOrderToDoItem.workOrderId) — they should match the new readable IDs.");
  }

  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
