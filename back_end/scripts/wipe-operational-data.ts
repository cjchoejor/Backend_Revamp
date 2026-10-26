/**
 * Wipe all operational / transactional data while preserving seeded reference data,
 * inventory, staff, configuration, parties and registries.
 *
 * Usage:
 *   npx tsx scripts/wipe-operational-data.ts            # dry-run (counts only, no deletes)
 *   npx tsx scripts/wipe-operational-data.ts --confirm  # actually delete
 *
 * EVERY TABLE IS CLASSIFIED (2026-10-26). The earlier version named the tables it wiped and
 * silently kept everything else, so each table added since (booking notes, guest requests, held
 * papers, room moves, interim payments, stay extensions, OCR readings, …) survived a wipe as rows
 * pointing at bookings that no longer exist. Now a model must be in WIPE, KEEP or PARTIAL, and the
 * script refuses to run — naming it — when the schema holds one that is in none of them. A new
 * table forces a decision instead of being left behind.
 *
 * ONE TRANSACTION. Foreign-key triggers are switched off with `SET LOCAL
 * session_replication_role = replica` inside a single interactive transaction, so every DELETE
 * runs on the connection that has them off (the earlier version set it on Prisma's pool and could
 * run later deletes on a different connection, failing part-way) and a failure leaves nothing
 * deleted.
 *
 * KEPT: hotel profile, departments, roles, staff and their sessions; room types, rooms, spaces and
 * their open faults (a fault is a fact about the room, not a booking); configuration, policies,
 * modes, templates; rate plans, seasons, packages, cancellation policies, the house tariff; travel
 * agencies, companies, their rate packages and cards; admin version snapshots.
 * PARTIAL: trace events (operational ones go, admin-only ones stay); readable-ID counters (reset,
 * except the prefixes kept tables use, so a new agency cannot be given an id one already has).
 * The queued pg-boss job of every scheduled timer is deleted with it, as delete-booking.ts does.
 */

import { Prisma, PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const CONFIRM = process.argv.includes("--confirm");

/** Bookings and everything hanging off them — deleted in this order (children first, for readability). */
const WIPE = [
  "HumanDecisionRecord", "AiDraftRecord", "CommunicationRecord", "HeldDocument", "FollowUpTaskRecord",
  "ProcessingLockRecord", "RevalidationDeltaRecord",
  "WorkOrderAmendmentEvent", "WorkOrderConsumptionRecord", "WorkOrderToDoItem", "WorkOrder",
  "DisputeGateOverrideRecord", "DisputeRecord", "AmendmentEventRecord", "NegotiationAmendmentRequest",
  "VIPArrivalNotificationEvent", "LostAndFoundRecord", "EquipmentAllocation", "CommissionDueRecord", "AgentProfile",
  "BookingNote", "GuestRequest",
  "RoomMoveLeg", "RoomMove",
  "NightAuditAnomaly", "NightAuditRecord",
  "WriteOffRecord", "InvoiceIntegrityCheck", "InvoiceLine", "Invoice",
  "AdvanceApplication", "InterimPaymentRequest", "StayExtensionRequest", "EarlyDepartureRecord",
  "FolioLine", "PaymentRecord", "BillingModelTransitionRecord", "CreditExtensionCeilingRecord",
  "CreditCeilingThresholdEvent", "Folio",
  "RoomInspectionRecord", "KeyReturnRecord", "NoShowDeterminationRecord",
  "RoomNightMealPlan", "RoomAssignment", "PreArrivalTask", "HandoffRecord",
  "Reservation", "CancellationDisclosureRecord", "CommittedHold", "SpeculativeHold",
  "QuotationLine", "Quotation", "TimerRecord", "StageDwellRecord", "RoomClaimStateEvent",
  "AvailabilityConfiguration", "SpaceAllocation", "Segment", "Entry",
  "DuplicateDetectionFlag", "Inquiry",
  "IdentityOcrSuggestion", "GuestIdentityDocument", "GuestProfile", "OtaConflictOverbookingRecord",
];

/** Reference data, configuration, inventory, people and parties — never touched. */
const KEEP = [
  "HotelProfile", "Department", "Role", "RolePermissionMapping", "RoleSessionConfig",
  "StaffUser", "SessionRecord", "SessionEventRecord",
  "RoomType", "Room", "Space", "DeficientConditionRecord",
  "ConfigurationEntry", "AiActorIdentity", "PolicyRegistry", "ModeConfiguration",
  "RatePlanRegistry", "SeasonCalendar", "PackageRegistry", "CancellationPolicyRegistry", "HouseTariff",
  "CommunicationTemplate", "HandoffChecklistTemplate", "InvoiceTemplate", "WorkOrderTemplate",
  "FeedbackSurveyTemplate", "VipNotificationRoutingConfig",
  "TravelAgent", "CorporateAccount", "RatePackage", "RoomTypePackageOverride", "RateCard", "RoomTypeRateOverride",
  "EntityVersionSnapshot",
];

/** Wiped in part — handled below. */
const PARTIAL = ["TraceEvent", "ReadableIdSequence"];

const models = new Map(Prisma.dmmf.datamodel.models.map((m) => [m.name, m.dbName ?? m.name]));
const table = (model: string) => `"${models.get(model)}"`;

function classify() {
  const listed = new Set([...WIPE, ...KEEP, ...PARTIAL]);
  const unknownListed = [...listed].filter((m) => !models.has(m));
  const unclassified = [...models.keys()].filter((m) => !listed.has(m));
  const twice = WIPE.filter((m) => KEEP.includes(m) || PARTIAL.includes(m));
  if (unknownListed.length || unclassified.length || twice.length) {
    if (unclassified.length) console.error(`Tables in the schema that this script does not classify: ${unclassified.join(", ")}`);
    if (unknownListed.length) console.error(`Listed here but not in the schema: ${unknownListed.join(", ")}`);
    if (twice.length) console.error(`Listed as both wiped and kept: ${twice.join(", ")}`);
    console.error("Add each to WIPE, KEEP or PARTIAL in scripts/wipe-operational-data.ts first. Nothing was deleted.");
    process.exit(1);
  }
}

/** Readable-id prefixes the KEPT tables use (e.g. TA- agencies, CORP- companies) — their counters stay. */
async function keptPrefixes(db: Prisma.TransactionClient | PrismaClient): Promise<string[]> {
  const prefixes = new Set<string>();
  for (const model of KEEP) {
    const m = Prisma.dmmf.datamodel.models.find((x) => x.name === model)!;
    const idField = m.fields.find((f) => f.isId);
    if (!idField || idField.type !== "String") continue;
    const rows = await db.$queryRawUnsafe<{ p: string }[]>(
      `SELECT DISTINCT substring("${idField.dbName ?? idField.name}" from '^([A-Z]{2,4})-[0-9]{8}-[0-9]{4}') AS p FROM ${table(model)}`,
    );
    for (const r of rows) if (r.p) prefixes.add(r.p);
  }
  return [...prefixes].sort();
}

const OPERATIONAL_TRACE = `WHERE "inquiryId" IS NOT NULL OR "entryId" IS NOT NULL`;

async function count(db: Prisma.TransactionClient | PrismaClient, sql: string): Promise<number> {
  return Number((await db.$queryRawUnsafe<{ n: bigint }[]>(`SELECT count(*)::bigint AS n FROM ${sql}`))[0].n);
}

async function dryRun() {
  console.log("DRY RUN — counting rows that would be deleted (nothing persisted).\n");
  let total = 0;
  for (const m of WIPE) {
    const n = await count(prisma, table(m));
    if (n > 0) console.log(`  ${String(n).padStart(7)}  ${m}`);
    total += n;
  }
  const traces = await count(prisma, `${table("TraceEvent")} ${OPERATIONAL_TRACE}`);
  if (traces) console.log(`  ${String(traces).padStart(7)}  TraceEvent (operational)`);
  const kept = await keptPrefixes(prisma);
  const seqs = await count(prisma, `${table("ReadableIdSequence")} WHERE prefix <> ALL(ARRAY[${kept.map((p) => `'${p}'`).join(",") || "''"}]::text[])`);
  if (seqs) console.log(`  ${String(seqs).padStart(7)}  ReadableIdSequence (counters reset; kept: ${kept.join(", ") || "none"})`);
  const jobs = await count(prisma, `${table("TimerRecord")} WHERE status = 'SCHEDULED' AND "pgBossJobId" IS NOT NULL`);
  if (jobs) console.log(`  ${String(jobs).padStart(7)}  queued pg-boss jobs of scheduled timers`);
  total += traces + seqs;
  console.log(`\nTotal rows that would be deleted: ${total}`);
  console.log(`\nTo actually wipe, re-run with --confirm`);
}

async function wipe() {
  console.log("DELETING operational data in one transaction (FK triggers off inside it)...\n");
  await prisma.$transaction(
    async (tx) => {
      await tx.$executeRawUnsafe(`SET LOCAL session_replication_role = 'replica'`);
      // pg-boss creates its schema at the first worker start, so a database never run with workers has none.
      const hasBoss = (await tx.$queryRawUnsafe<{ t: string | null }[]>(`SELECT to_regclass('pgboss.job')::text AS t`))[0].t;
      const jobs = hasBoss
        ? await tx.$executeRawUnsafe(
            `DELETE FROM pgboss.job WHERE id::text IN (SELECT "pgBossJobId" FROM ${table("TimerRecord")} WHERE status = 'SCHEDULED' AND "pgBossJobId" IS NOT NULL)`,
          )
        : 0;
      if (jobs) console.log(`  -${String(jobs).padStart(7)}  queued pg-boss jobs of scheduled timers`);
      let total = 0;
      for (const m of WIPE) {
        const n = await tx.$executeRawUnsafe(`DELETE FROM ${table(m)}`);
        if (n > 0) console.log(`  -${String(n).padStart(7)}  ${m}`);
        total += n;
      }
      const traces = await tx.$executeRawUnsafe(`DELETE FROM ${table("TraceEvent")} ${OPERATIONAL_TRACE}`);
      if (traces) console.log(`  -${String(traces).padStart(7)}  TraceEvent (operational)`);
      const kept = await keptPrefixes(tx);
      const seqs = await tx.$executeRawUnsafe(
        `DELETE FROM ${table("ReadableIdSequence")} WHERE prefix <> ALL($1::text[])`,
        kept,
      );
      if (seqs) console.log(`  -${String(seqs).padStart(7)}  ReadableIdSequence (counters reset; kept: ${kept.join(", ") || "none"})`);
      // A room's bed setup may have been made up for a booking that is gone; it is how the room
      // is made up now, so it stays — only the link to the erased booking goes.
      await tx.$executeRawUnsafe(`UPDATE ${table("Room")} SET "bedTypeSetForEntryId" = NULL WHERE "bedTypeSetForEntryId" IS NOT NULL`);
      total += traces + seqs;
      console.log(`\nDone. Deleted ${total} rows.`);
    },
    { timeout: 30 * 60_000, maxWait: 60_000 },
  );
  console.log("\nRoom claim flags still describe the bookings that were wiped: run scripts/repair-stuck-room-states.ts --commit once the new data is in.");
}

classify();
await (CONFIRM ? wipe() : dryRun());
await prisma.$disconnect();
