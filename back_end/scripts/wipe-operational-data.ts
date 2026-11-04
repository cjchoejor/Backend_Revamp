/**
 * Wipe all operational / transactional data while preserving seeded reference data,
 * inventory, staff, configuration, parties and registries.
 *
 * Usage:
 *   npx tsx scripts/wipe-operational-data.ts            # dry-run (counts only, no deletes)
 *   npx tsx scripts/wipe-operational-data.ts --confirm  # actually delete
 *   add --parties to wipe travel agents and companies too (the house's common package stays)
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
 * PARTIAL: trace events (operational ones go, admin-only ones stay).
 * The queued pg-boss job of every scheduled timer is deleted with it, as delete-booking.ts does, and
 * any other waiting job that names a booking: moving a booking on by hand closes its countdown's
 * timer but leaves the job waiting, and with the booking gone it can only ever skip.
 *
 * READABLE-ID COUNTERS ARE KEPT (2026-11-04). Papers are stored write-once under their number, and
 * the voucher adopts a file already stored under its number, so a counter reset could hand a new
 * booking a wiped booking's paper. Numbers simply carry on.
 *
 * A ROOM LEFT DIRTY by a wiped guest is put back clean: with every booking gone nothing explains
 * it, and it would refuse the next check-in.
 */

import { Prisma, PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const CONFIRM = process.argv.includes("--confirm");
const PARTIES = process.argv.includes("--parties");

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
  "CheckInPaymentDeferral",
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
  "EntityVersionSnapshot", "ReadableIdSequence",
];

/** Wiped only with --parties, in this order. The COMMON package belongs to the house, not a party. */
const PARTY_DELETES: [string, string][] = [
  ["RoomTypePackageOverride", `WHERE "ratePackageId" IN (SELECT id FROM "rate_packages" WHERE scope <> 'COMMON')`],
  ["RatePackage", `WHERE scope <> 'COMMON'`],
  ["RoomTypeRateOverride", ""],
  ["RateCard", ""],
  ["TravelAgent", ""],
  ["CorporateAccount", ""],
];

/** Wiped in part — handled below. */
const PARTIAL = ["TraceEvent"];

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

const OPERATIONAL_TRACE = `WHERE "inquiryId" IS NOT NULL OR "entryId" IS NOT NULL`;
const WAITING_BOOKING_JOB = `pgboss.job WHERE state IN ('created', 'retry') AND data->>'entryId' IS NOT NULL`;

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
  if (PARTIES) {
    for (const [m, where] of PARTY_DELETES) {
      const n = await count(prisma, `${table(m)} ${where}`);
      if (n > 0) console.log(`  ${String(n).padStart(7)}  ${m}`);
      total += n;
    }
  }
  const dirty = await prisma.$queryRawUnsafe<{ roomNumber: string }[]>(`SELECT "roomNumber" FROM ${table("Room")} WHERE "physicalState" = 'DIRTY' ORDER BY 1`);
  if (dirty.length) console.log(`  rooms put back clean: ${dirty.map((r) => r.roomNumber).join(", ")}`);
  const jobs = await count(prisma, `${table("TimerRecord")} WHERE status = 'SCHEDULED' AND "pgBossJobId" IS NOT NULL`);
  if (jobs) console.log(`  ${String(jobs).padStart(7)}  queued pg-boss jobs of scheduled timers`);
  const hasBoss = (await prisma.$queryRawUnsafe<{ t: string | null }[]>(`SELECT to_regclass('pgboss.job')::text AS t`))[0].t;
  const waiting = hasBoss ? await count(prisma, WAITING_BOOKING_JOB) : 0;
  if (waiting) console.log(`  ${String(waiting).padStart(7)}  waiting pg-boss jobs that name a booking (some of the above)`);
  total += traces;
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
      const waiting = hasBoss ? await tx.$executeRawUnsafe(`DELETE FROM ${WAITING_BOOKING_JOB}`) : 0;
      if (waiting) console.log(`  -${String(waiting).padStart(7)}  other waiting pg-boss jobs that name a booking`);
      let total = 0;
      for (const m of WIPE) {
        const n = await tx.$executeRawUnsafe(`DELETE FROM ${table(m)}`);
        if (n > 0) console.log(`  -${String(n).padStart(7)}  ${m}`);
        total += n;
      }
      const traces = await tx.$executeRawUnsafe(`DELETE FROM ${table("TraceEvent")} ${OPERATIONAL_TRACE}`);
      if (traces) console.log(`  -${String(traces).padStart(7)}  TraceEvent (operational)`);
      if (PARTIES) {
        for (const [m, where] of PARTY_DELETES) {
          const n = await tx.$executeRawUnsafe(`DELETE FROM ${table(m)} ${where}`);
          if (n > 0) console.log(`  -${String(n).padStart(7)}  ${m}`);
          total += n;
        }
      }
      const cleaned = await tx.$queryRawUnsafe<{ roomNumber: string }[]>(
        `UPDATE ${table("Room")} SET "physicalState" = 'AVAILABLE_CLEAN' WHERE "physicalState" = 'DIRTY' RETURNING "roomNumber"`,
      );
      if (cleaned.length) console.log(`  rooms put back clean: ${cleaned.map((r) => r.roomNumber).join(", ")}`);
      // A room's bed setup may have been made up for a booking that is gone; it is how the room
      // is made up now, so it stays — only the link to the erased booking goes.
      await tx.$executeRawUnsafe(`UPDATE ${table("Room")} SET "bedTypeSetForEntryId" = NULL WHERE "bedTypeSetForEntryId" IS NOT NULL`);
      total += traces;
      console.log(`\nDone. Deleted ${total} rows.`);
    },
    { timeout: 30 * 60_000, maxWait: 60_000 },
  );
  console.log("\nRoom claim flags still describe the bookings that were wiped: run scripts/repair-stuck-room-states.ts --commit once the new data is in.");
}

classify();
await (CONFIRM ? wipe() : dryRun());
await prisma.$disconnect();
