/**
 * Erase a booking and everything hanging off it.
 *
 *   npx tsx scripts/delete-booking.ts ENT-20260908-0001              # dry run — prints the inventory
 *   npx tsx scripts/delete-booking.ts ENT-20260908-0001 --commit     # delete
 *
 *   --db <name>      target database (default legphel_pms_dev2 — this branch's database)
 *   --allow-paid     proceed even though money was recorded against the folio (see below)
 *   --keep-inquiry   leave the Inquiry row behind
 *
 * WHY A SCRIPT. There is no "delete a booking" route and there should not be one: the lifecycle's
 * terminal states are CANCELLED and CLOSED, both of which KEEP the record — that is the point of
 * an audit trail. Erasure is an out-of-band act for test data the operator has finished with, so
 * it lives here, dry-run first, rather than behind a button someone can press by accident.
 *
 * CANCEL IS NOT ERASE. If the booking is real and simply is not happening, cancel it through the
 * stage's own route — that prices the penalty, releases the hold, supersedes the paperwork and
 * leaves the history readable. This script leaves nothing.
 *
 * WHAT IT WILL NOT DO WITHOUT BEING TOLD. A folio carrying PaymentRecords is money that was
 * actually taken and reconciled; deleting those rows makes the hotel's cash position wrong with
 * no trace of why. The script refuses and names the folio unless `--allow-paid` is passed.
 *
 * THE ROOM FLAG. `Room.currentClaimState` is a single NOW snapshot shared by every booking, so
 * deleting a booking must not blindly free its rooms — another live booking may legitimately own
 * that flag (the case `delete-stuck-test-bookings.ts` hit with room 201). Each room is therefore
 * judged on its own: freed only when no OTHER live claim — an ACTIVE booking's assignment still
 * running, or a live hold — covers it. Hold coverage is read loosely (primary room OR anywhere in
 * `perNightBreakdown`), so an over-read leaves the flag alone, which is the safe direction.
 *
 * Dependent tables are DISCOVERED from information_schema rather than listed, so a schema addition
 * cannot silently leave orphans behind. Everything runs in one transaction with FK triggers
 * deferred (the device `wipe-operational-data.ts` uses), so a failure leaves the database untouched.
 */
import { readFileSync } from "node:fs";
import pg from "pg";

const ARGV = process.argv.slice(2);
const COMMIT = ARGV.includes("--commit");
const ALLOW_PAID = ARGV.includes("--allow-paid");
const KEEP_INQUIRY = ARGV.includes("--keep-inquiry");
const TARGET_DB = (() => {
  const i = ARGV.indexOf("--db");
  return i >= 0 ? ARGV[i + 1] : "legphel_pms_dev2";
})();
const ENTRY_IDS = ARGV.filter((a) => /^(ENT|TEST)-/i.test(a)).map((a) => a.toUpperCase());

/** The foreign keys that fan a booking out across the schema. */
const OWNED: Array<{ table: string; column: string; key: string }> = [
  { table: "folios", column: "entryId", key: "folioId" },
  { table: "invoices", column: "entryId", key: "invoiceId" },
  { table: "quotations", column: "entryId", key: "quotationId" },
  { table: "segments", column: "entryId", key: "segmentId" },
  { table: "room_assignments", column: "entryId", key: "roomAssignmentId" },
  { table: "reservations", column: "entryId", key: "reservationId" },
  { table: "committed_holds", column: "entryId", key: "committedHoldId" },
  { table: "speculative_holds", column: "entryId", key: "speculativeHoldId" },
  { table: "availability_configurations", column: "entryId", key: "availabilityConfigurationId" },
  { table: "handoff_records", column: "entryId", key: "handoffRecordId" },
  { table: "dispute_records", column: "entryId", key: "disputeRecordId" },
  { table: "work_orders", column: "entryId", key: "workOrderId" },
  { table: "interim_payment_requests", column: "entryId", key: "interimPaymentRequestId" },
  { table: "stay_extension_requests", column: "entryId", key: "stayExtensionRequestId" },
  { table: "communication_records", column: "entryId", key: "communicationRecordId" },
];
// Deliberately NOT here: `night_audit_records`. A night audit is hotel-wide for an operating
// date — it has no entryId, and every other in-house booking's folio lines point at the same
// row. Sweeping by `nightAuditRecordId` would delete other guests' charges.

function connectionString(): string {
  const env = readFileSync(new URL("../.env", import.meta.url), "utf8");
  const raw = env.match(/^DATABASE_URL\s*=\s*"?([^"\r\n]+)"?/m)?.[1];
  if (!raw) throw new Error("DATABASE_URL not found in .env");
  const u = new URL(raw);
  u.pathname = `/${TARGET_DB}`;
  u.search = "";
  return u.toString();
}

async function main() {
  if (ENTRY_IDS.length === 0) {
    console.error("Name at least one entry, e.g. npx tsx scripts/delete-booking.ts ENT-20260908-0001");
    process.exitCode = 1;
    return;
  }

  const c = new pg.Client({ connectionString: connectionString() });
  await c.connect();
  console.log(`${COMMIT ? "COMMIT" : "DRY RUN"} — database ${TARGET_DB}\n`);

  try {
    const rows = async (sql: string, params: unknown[] = []) => (await c.query(sql, params)).rows;
    const one = async (sql: string, params: unknown[] = []) => (await rows(sql, params))[0];

    const entries = await rows(
      `SELECT id, "inquiryId", "currentStage", status, "checkInDate", "checkOutDate" FROM entries WHERE id = ANY($1::text[])`,
      [ENTRY_IDS],
    );
    const missing = ENTRY_IDS.filter((id) => !entries.some((e) => e.id === id));
    if (missing.length) {
      console.error(`Not on ${TARGET_DB}: ${missing.join(", ")}`);
      process.exitCode = 1;
      return;
    }
    for (const e of entries) {
      console.log(
        `  ${e.id}  ${e.status} @ ${e.currentStage}  ${String(e.checkInDate).slice(0, 10)} -> ` +
          `${String(e.checkOutDate).slice(0, 10)}  (${e.inquiryId})`,
      );
    }

    // --- what this booking owns -------------------------------------------------------------
    // A table that has lost the column (or never had it) is skipped loudly rather than crashing
    // the run half-way through the inventory.
    const hasColumn = async (table: string, column: string) =>
      Number(
        (
          await one(
            `SELECT count(*)::int n FROM information_schema.columns
              WHERE table_schema = 'public' AND table_name = $1 AND column_name = $2`,
            [table, column],
          )
        ).n,
      ) > 0;

    const values: Record<string, string[]> = { entryId: ENTRY_IDS };
    for (const o of OWNED) {
      if (!(await hasColumn(o.table, o.column))) {
        console.log(`  (skipping ${o.table} — no ${o.column} column)`);
        continue;
      }
      const found = await rows(`SELECT id FROM "${o.table}" WHERE "${o.column}" = ANY($1::text[])`, [ENTRY_IDS]);
      if (found.length) values[o.key] = found.map((r) => r.id as string);
    }

    // Inquiries are deleted only when this booking was their only entry — an inquiry that
    // spawned a second booking is still that booking's origin record.
    const inquiryIds: string[] = [];
    if (!KEEP_INQUIRY) {
      const distinct = [...new Set(entries.map((e) => e.inquiryId as string))].filter(Boolean);
      for (const inq of distinct) {
        const n = Number(
          (
            await one(`SELECT count(*)::int n FROM entries WHERE "inquiryId" = $1 AND NOT (id = ANY($2::text[]))`, [
              inq,
              ENTRY_IDS,
            ])
          ).n,
        );
        if (n === 0) inquiryIds.push(inq);
        else console.log(`  keeping ${inq} — ${n} other booking(s) came from it`);
      }
      if (inquiryIds.length) values.inquiryId = inquiryIds;
    }

    // --- the money guard --------------------------------------------------------------------
    const folioIds = values.folioId ?? [];
    if (folioIds.length) {
      const paid = await rows(
        `SELECT "folioId", count(*)::int n, sum(amount)::text total FROM payment_records WHERE "folioId" = ANY($1::text[]) GROUP BY 1`,
        [folioIds],
      );
      if (paid.length) {
        console.log(`\nmoney recorded against the folio:`);
        for (const p of paid) console.log(`   ${p.folioId}  ${p.n} payment(s)  ${p.total}`);
        if (!ALLOW_PAID) {
          console.log(
            `\nRefusing. Real money is recorded here — deleting it leaves the cash position wrong with\n` +
              `nothing to explain it. Cancel the booking through its stage route instead, or pass\n` +
              `--allow-paid if this is test data you are certain about.`,
          );
          return;
        }
        console.log(`   --allow-paid given — these will be deleted too.`);
      }
    }

    // --- every dependent row, discovered ----------------------------------------------------
    const cols = await rows(
      `SELECT table_name, column_name FROM information_schema.columns
        WHERE table_schema = 'public' AND column_name = ANY($1::text[])
        ORDER BY table_name, column_name`,
      [Object.keys(values)],
    );

    const plan: Array<{ table: string; column: string; count: number }> = [];
    for (const col of cols) {
      const table = col.table_name as string;
      const column = col.column_name as string;
      if (table === "entries") continue;
      if (table === "inquiries" && column === "inquiryId") continue;
      const ids = values[column];
      if (!ids?.length) continue;
      const n = Number((await one(`SELECT count(*)::int n FROM "${table}" WHERE "${column}" = ANY($1::text[])`, [ids])).n);
      if (n > 0) plan.push({ table, column, count: n });
    }

    console.log(`\nowned records:`);
    for (const [k, v] of Object.entries(values)) if (k !== "entryId") console.log(`   ${String(v.length).padStart(4)}  ${k}`);
    console.log(`\ndependent rows (${plan.reduce((t, p) => t + p.count, 0)} across ${plan.length} tables):`);
    for (const p of plan) console.log(`   ${String(p.count).padStart(4)}  ${p.table} (${p.column})`);

    // --- rooms ------------------------------------------------------------------------------
    const claimed = await rows(
      `SELECT DISTINCT r.id, r."roomNumber", r."currentClaimState", r."physicalState"
         FROM rooms r WHERE r.id IN (
           SELECT "roomId" FROM room_assignments WHERE "entryId" = ANY($1::text[])
           UNION SELECT "roomId" FROM committed_holds WHERE "entryId" = ANY($1::text[]) AND "roomId" IS NOT NULL
           UNION SELECT "roomId" FROM speculative_holds WHERE "entryId" = ANY($1::text[]) AND "roomId" IS NOT NULL)
         ORDER BY r."roomNumber"`,
      [ENTRY_IDS],
    );
    const toFree: string[] = [];
    console.log(`\nrooms this booking claims:`);
    for (const r of claimed) {
      const liveAssignment = await one(
        `SELECT count(*)::int n FROM room_assignments ra JOIN entries e ON e.id = ra."entryId"
          WHERE ra."roomId" = $1 AND NOT (ra."entryId" = ANY($2::text[])) AND e.status = 'ACTIVE'
            AND COALESCE(ra."endDate", e."checkOutDate") > now()`,
        [r.id, ENTRY_IDS],
      );
      // A hold is judged by its booking's DATES, not by the hold row surviving — the same
      // doctrine the S1 search and Policy 26 follow. A hold belonging to a stay that ended last
      // week claims nothing tonight, so it must not keep a room flagged for ever.
      const liveHold = await one(
        `SELECT (SELECT count(*)::int FROM committed_holds h JOIN entries he ON he.id = h."entryId"
                  WHERE NOT (h."entryId" = ANY($2::text[])) AND h.state IN ('PLACED','CONFIRMED')
                    AND he.status = 'ACTIVE' AND he."checkOutDate" > now()
                    AND (h."roomId" = $1 OR h."perNightBreakdown"::text LIKE '%' || $1 || '%'))
              + (SELECT count(*)::int FROM speculative_holds s JOIN entries se ON se.id = s."entryId"
                  WHERE NOT (s."entryId" = ANY($2::text[])) AND s.state = 'PLACED' AND s."expiresAt" > now()
                    AND se.status = 'ACTIVE' AND se."checkOutDate" > now()
                    AND (s."roomId" = $1 OR s."perNightBreakdown"::text LIKE '%' || $1 || '%')) AS n`,
        [r.id, ENTRY_IDS],
      );
      const others = Number(liveAssignment.n) + Number(liveHold.n);
      if (others === 0 && r.currentClaimState !== "FREE") {
        toFree.push(r.id as string);
        console.log(`   ${r.roomNumber}  ${r.currentClaimState} / ${r.physicalState}  -> FREE (nothing else claims it)`);
      } else {
        console.log(
          `   ${r.roomNumber}  ${r.currentClaimState} / ${r.physicalState}  -> left alone (${others} other live claim(s))`,
        );
      }
    }

    // --- timers still armed -----------------------------------------------------------------
    const armed = await rows(
      `SELECT id, "timerCode", "pgBossJobId" FROM timer_records
        WHERE "entryId" = ANY($1::text[]) AND status = 'SCHEDULED' AND "pgBossJobId" IS NOT NULL`,
      [ENTRY_IDS],
    );
    if (armed.length) {
      console.log(`\nqueued jobs to cancel (${armed.length}):`);
      for (const t of armed) console.log(`   ${t.timerCode}  ${t.pgBossJobId}`);
    }

    if (!COMMIT) {
      console.log(`\nDry run — nothing deleted. Re-run with --commit to apply.`);
      return;
    }

    // --- do it ------------------------------------------------------------------------------
    await c.query("BEGIN");
    await c.query("SET CONSTRAINTS ALL DEFERRED");
    await c.query("SET session_replication_role = 'replica'");

    let jobs = 0;
    for (const t of armed) {
      const r = await c.query(`DELETE FROM pgboss.job WHERE id = $1::uuid`, [t.pgBossJobId]);
      jobs += r.rowCount ?? 0;
    }

    let removed = 0;
    for (const p of plan) {
      const r = await c.query(`DELETE FROM "${p.table}" WHERE "${p.column}" = ANY($1::text[])`, [values[p.column]]);
      removed += r.rowCount ?? 0;
    }
    const deletedEntries = await c.query(`DELETE FROM entries WHERE id = ANY($1::text[])`, [ENTRY_IDS]);
    let deletedInquiries = 0;
    if (inquiryIds.length) {
      const r = await c.query(`DELETE FROM inquiries WHERE id = ANY($1::text[])`, [inquiryIds]);
      deletedInquiries = r.rowCount ?? 0;
    }
    if (toFree.length) {
      await c.query(`UPDATE rooms SET "currentClaimState" = 'FREE' WHERE id = ANY($1::text[])`, [toFree]);
    }

    await c.query("SET session_replication_role = 'origin'");
    await c.query("COMMIT");

    console.log(
      `\nDeleted ${deletedEntries.rowCount} entr${deletedEntries.rowCount === 1 ? "y" : "ies"}, ` +
        `${deletedInquiries} inquir${deletedInquiries === 1 ? "y" : "ies"}, ${removed} dependent rows; ` +
        `${jobs} queued job(s) cancelled; ${toFree.length} room(s) freed.`,
    );
  } catch (err) {
    await c.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    await c.end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
