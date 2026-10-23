/**
 * Wipe every booking — and everything hanging off one — while keeping the hotel's setup, so the
 * system can be refilled from the old PMS and handed to the front desk (2026-10-23, go-live).
 *
 * WHY THIS AND NOT `wipe-operational-data.ts`
 * ------------------------------------------
 * That script is from June and has drifted: it lists ~55 tables by hand and misses every table
 * added since (stay extensions, interim payments, early departures, room moves, booking notes,
 * guest requests, OCR suggestions…), so with foreign keys switched off it would leave their rows
 * pointing at bookings that no longer exist. And it is not one transaction: it switches the FK
 * triggers off on ONE pooled Prisma connection and then runs its deletes on whichever connection
 * the pool hands out, so a failure part-way leaves a half-wiped database.
 *
 * This one:
 *   - names EVERY table, either to keep or to wipe, and refuses to run if the database holds a
 *     table on neither list — a table added later must be decided, never silently kept or lost;
 *   - runs on ONE connection, in ONE transaction: either everything below happens or nothing does;
 *   - checks all foreign keys for broken links before committing, and rolls back if any is found;
 *   - refuses `--commit` while the backend is listening, so no worker fires mid-wipe.
 *
 * What it does, in the one transaction:
 *   1. deletes every row of every WIPE table (FK triggers off for this transaction only);
 *   2. deletes the activity-log rows that name a booking or an enquiry — the admin-console audit
 *      rows (which name neither) are kept;
 *   3. sets every room's claim flag back to FREE and clears "bed set for booking", since no
 *      booking exists any more to hold a room. Physical state, blocks, maintenance and a recorded
 *      fault (with its record) are the room's own facts and are left alone;
 *   4. deletes the pg-boss jobs still queued for bookings. The recurring schedules (the nightly
 *      audit) are not jobs and are untouched; pg-boss's own housekeeping jobs are left alone;
 *   5. checks every foreign key; any broken link rolls the whole thing back.
 *
 * Kept on purpose: the readable-id counters, so no booking, folio or voucher number is ever
 * issued twice; staff and their sessions; admin settings and their version history.
 *
 * Files on disk (PDFs, ID photos) are not touched — the store is write-once by design.
 *
 *   npx tsx scripts/wipe-bookings-for-go-live.ts            # dry run — counts only
 *   npx tsx scripts/wipe-bookings-for-go-live.ts --commit   # wipe (backend must be stopped)
 */
import pg from "pg";
import net from "node:net";
import { readFileSync } from "node:fs";
import path from "node:path";

const COMMIT = process.argv.includes("--commit");

/** The hotel's setup — never wiped. */
const KEEP = [
  "ai_actor_identity",
  "cancellation_policy_registry",
  "communication_templates",
  "configuration_entries",
  "corporate_accounts",
  "departments",
  "entity_version_snapshots",
  "feedback_survey_templates",
  "handoff_checklist_templates",
  "hotel_profile",
  "house_tariffs",
  "invoice_templates",
  "mode_configurations",
  "package_registry",
  "policy_registry",
  "rate_cards",
  "rate_packages",
  "rate_plan_registry",
  "readable_id_sequences",
  "role_permission_mappings",
  "role_session_configs",
  "roles",
  "room_type_package_overrides",
  "room_type_rate_overrides",
  "room_types",
  "rooms",
  "season_calendar",
  "session_event_records",
  "session_records",
  "spaces",
  "staff_users",
  "travel_agents",
  "vip_notification_routing_configs",
  "work_order_templates",
  // A recorded fault belongs to the ROOM, not to a booking (it has no booking column), and the
  // room's out-of-service flag stands on it — wiping the record would leave the flag unexplained.
  "deficient_condition_records",
];

/** Kept in part: only the rows that name a booking or an enquiry go. */
const PARTIAL = ["trace_events"];

/** Every booking and everything that hangs off one. */
const WIPE = [
  "advance_applications",
  "agent_profiles",
  "ai_draft_records",
  "amendment_event_records",
  "availability_configurations",
  "billing_model_transition_records",
  "booking_notes",
  "cancellation_disclosure_records",
  "commission_due_records",
  "committed_holds",
  "communication_records",
  "credit_ceiling_threshold_events",
  "credit_extension_ceiling_records",
  "dispute_gate_override_records",
  "dispute_records",
  "duplicate_detection_flags",
  "early_departure_records",
  "entries",
  "equipment_allocations",
  "folio_lines",
  "folios",
  "follow_up_task_records",
  "guest_identity_documents",
  "guest_profiles",
  "guest_requests",
  "handoff_records",
  "held_documents",
  "human_decision_records",
  "identity_ocr_suggestions",
  "inquiries",
  "interim_payment_requests",
  "invoice_integrity_checks",
  "invoice_lines",
  "invoices",
  "key_return_records",
  "lost_and_found_records",
  "negotiation_amendment_requests",
  "night_audit_anomalies",
  "night_audit_records",
  "no_show_determination_records",
  "ota_conflict_overbooking_records",
  "payment_records",
  "pre_arrival_tasks",
  "processing_lock_records",
  "quotation_lines",
  "quotations",
  "reservations",
  "revalidation_delta_records",
  "room_assignments",
  "room_claim_state_events",
  "room_inspection_records",
  "room_move_legs",
  "room_moves",
  "room_night_meal_plans",
  "segments",
  "space_allocations",
  "speculative_holds",
  "stage_dwell_records",
  "stay_extension_requests",
  "timer_records",
  "vip_arrival_notification_events",
  "work_order_amendment_events",
  "work_order_consumption_records",
  "work_order_todo_items",
  "work_orders",
  "write_off_records",
];

const TRACE_BOOKING_ROWS = `"inquiryId" is not null or "entryId" is not null`;
/** pg-boss jobs still waiting to run, other than its own housekeeping. Recurring schedules live
 *  in pgboss.schedule and are not touched; they create a fresh job each time they fire. */
const QUEUED_JOBS = `state in ('created','retry') and name not like '\\_\\_pgboss%'`;

function envFileConnectionString(): string {
  const env = readFileSync(path.resolve(process.cwd(), ".env"), "utf8");
  const line = env.split(/\r?\n/).find((l) => l.trim().startsWith("DATABASE_URL="));
  if (!line) throw new Error("DATABASE_URL not found in back_end/.env");
  return line.slice(line.indexOf("=") + 1).trim().replace(/^["']|["']$/g, "");
}

function connectionString(): string {
  return process.env.DATABASE_URL || envFileConnectionString();
}

const dbNameOf = (conn: string) => conn.replace(/^.*\//, "").replace(/\?.*$/, "");

function backendListening(port = 4000): Promise<boolean> {
  return new Promise((resolve) => {
    const s = net.connect({ host: "127.0.0.1", port });
    s.setTimeout(1500);
    s.once("connect", () => { s.destroy(); resolve(true); });
    s.once("timeout", () => { s.destroy(); resolve(false); });
    s.once("error", () => resolve(false));
  });
}

const q = (id: string) => `"${id.replace(/"/g, '""')}"`;

async function main() {
  const conn = connectionString();
  const dbName = dbNameOf(conn);
  // The backend serves the database named in back_end/.env. Aimed anywhere else (a rehearsal on a
  // copy), a running backend cannot be touching it, so its check would only get in the way.
  const isServedDatabase = dbName === dbNameOf(envFileConnectionString());
  const client = new pg.Client({ connectionString: conn });
  await client.connect();
  console.log(`database: ${dbName}`);
  console.log(COMMIT ? "MODE: COMMIT\n" : "MODE: DRY RUN — nothing will be written\n");

  try {
    /* ---- every table must be decided ---- */
    const tables: string[] = (await client.query(
      `select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relkind in ('r','p') and c.relname <> '_prisma_migrations'
        order by 1`,
    )).rows.map((r) => r.relname);
    const decided = new Set([...KEEP, ...PARTIAL, ...WIPE]);
    const undecided = tables.filter((t) => !decided.has(t));
    const missing = [...decided].filter((t) => !tables.includes(t));
    const both = KEEP.filter((t) => WIPE.includes(t) || PARTIAL.includes(t));
    if (undecided.length || both.length) {
      if (undecided.length) console.error(`Refusing: these tables are on neither list — decide each one: ${undecided.join(", ")}`);
      if (both.length) console.error(`Refusing: these tables are on both lists: ${both.join(", ")}`);
      process.exitCode = 1;
      return;
    }
    if (missing.length) console.log(`(listed but not in this database, skipped: ${missing.join(", ")})\n`);
    const wipeTables = WIPE.filter((t) => tables.includes(t));

    /* ---- what would go ---- */
    let total = 0;
    console.log("Rows to delete:");
    for (const t of wipeTables) {
      const n = Number((await client.query(`select count(*) n from ${q(t)}`)).rows[0].n);
      if (n > 0) console.log(`  ${String(n).padStart(7)}  ${t}`);
      total += n;
    }
    const traceGo = Number((await client.query(`select count(*) n from trace_events where ${TRACE_BOOKING_ROWS}`)).rows[0].n);
    const traceKeep = Number((await client.query(`select count(*) n from trace_events where not (${TRACE_BOOKING_ROWS})`)).rows[0].n);
    console.log(`  ${String(traceGo).padStart(7)}  trace_events (the rows naming a booking; ${traceKeep} admin rows kept)`);
    total += traceGo;
    console.log(`  ${"-".repeat(7)}\n  ${String(total).padStart(7)}  in all\n`);

    const roomsToFree = (await client.query(
      `select "roomNumber", "currentClaimState" from rooms where "currentClaimState" <> 'FREE' or "bedTypeSetForEntryId" is not null order by "roomNumber"`,
    )).rows;
    console.log(`Room flags to set back to FREE: ${roomsToFree.length}${roomsToFree.length ? " — " + roomsToFree.map((r) => `${r.roomNumber} (${r.currentClaimState})`).join(", ") : ""}`);
    const faulty = (await client.query(`select "roomNumber" from rooms where "isDeficient" or "isBlocked" or "isUnderMaintenance" order by 1`)).rows;
    if (faulty.length) console.log(`Left as they are (the room's own fault / block / maintenance): ${faulty.map((r) => r.roomNumber).join(", ")}`);

    const hasBoss = (await client.query(`select 1 from information_schema.tables where table_schema='pgboss' and table_name='job'`)).rowCount;
    if (hasBoss) {
      const jobs = (await client.query(`select name, count(*) n from pgboss.job where ${QUEUED_JOBS} group by 1 order by 1`)).rows;
      console.log(`Queued booking timers to delete: ${jobs.reduce((s, j) => s + Number(j.n), 0)}${jobs.length ? " — " + jobs.map((j) => `${j.name} ×${j.n}`).join(", ") : ""}`);
      const sched = (await client.query(`select name from pgboss.schedule order by 1`)).rows.map((r) => r.name);
      console.log(`Recurring schedules kept: ${sched.join(", ") || "none"}`);
    }
    const kept = (await client.query(
      `select (select count(*) from staff_users) staff, (select count(*) from rooms) rooms, (select count(*) from travel_agents) agents,
              (select count(*) from corporate_accounts) companies, (select count(*) from rate_packages) packages,
              (select count(*) from configuration_entries) settings`,
    )).rows[0];
    console.log(`Kept: ${kept.staff} staff · ${kept.rooms} rooms · ${kept.agents} agencies · ${kept.companies} companies · ${kept.packages} rate packages · ${kept.settings} settings rows\n`);

    if (!COMMIT) {
      console.log("DRY RUN — nothing written. Stop the backend, take a backup, then re-run with --commit.");
      return;
    }

    if (isServedDatabase && (await backendListening())) {
      console.error("Refusing: the backend is running (port 4000). Stop the LegphelPMS Backend service first, so no worker fires mid-wipe.");
      process.exitCode = 1;
      return;
    }

    /* ---- the wipe: one connection, one transaction ---- */
    await client.query("begin");
    try {
      await client.query("set local session_replication_role = replica");
      for (const t of wipeTables) await client.query(`delete from ${q(t)}`);
      await client.query(`delete from trace_events where ${TRACE_BOOKING_ROWS}`);
      await client.query(`update rooms set "currentClaimState" = 'FREE', "bedTypeSetForEntryId" = null, "updatedAt" = now()
                           where "currentClaimState" <> 'FREE' or "bedTypeSetForEntryId" is not null`);
      if (hasBoss) await client.query(`delete from pgboss.job where ${QUEUED_JOBS}`);
      // Back to normal FK enforcement before checking, so nothing below runs with triggers off.
      await client.query("set local session_replication_role = origin");

      /* ---- every foreign key: no row may point at nothing ---- */
      const fks = (await client.query(
        `select tc.table_name t, kcu.column_name c, ccu.table_name rt, ccu.column_name rc
           from information_schema.table_constraints tc
           join information_schema.key_column_usage kcu on kcu.constraint_name = tc.constraint_name and kcu.table_schema = tc.table_schema
           join information_schema.constraint_column_usage ccu on ccu.constraint_name = tc.constraint_name and ccu.table_schema = tc.table_schema
          where tc.constraint_type = 'FOREIGN KEY' and tc.table_schema = 'public'`,
      )).rows;
      const broken: string[] = [];
      for (const fk of fks) {
        const n = Number((await client.query(
          `select count(*) n from ${q(fk.t)} x where x.${q(fk.c)} is not null
             and not exists (select 1 from ${q(fk.rt)} y where y.${q(fk.rc)} = x.${q(fk.c)})`,
        )).rows[0].n);
        if (n > 0) broken.push(`${fk.t}.${fk.c} → ${fk.rt}: ${n}`);
      }
      if (broken.length) throw new Error(`broken links after the wipe — rolled back, nothing changed:\n  ${broken.join("\n  ")}`);
      const left = Number((await client.query(`select count(*) n from entries`)).rows[0].n)
        + Number((await client.query(`select count(*) n from inquiries`)).rows[0].n);
      if (left !== 0) throw new Error(`bookings still present after the wipe (${left}) — rolled back`);

      await client.query("commit");
      console.log(`✓ committed: ${total} rows deleted, ${roomsToFree.length} room flags reset, ${fks.length} foreign keys checked — none broken.`);
    } catch (e) {
      await client.query("rollback");
      throw e;
    }
  } finally {
    await client.end();
  }
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
