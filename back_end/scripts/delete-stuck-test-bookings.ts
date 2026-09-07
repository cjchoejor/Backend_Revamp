/**
 * Delete the two stuck S8 test bookings on `legphel_pms_dev`.
 *
 * Both were left un-checkoutable by PMS-236: a later booking's committed hold rewrote room
 * 201's live claim flag, and the S8 gate refuses anything but OCCUPIED. The code fix stops it
 * recurring; it does not repair rows already in that state, and the operator's ruling is that
 * these two are test entries and should simply go.
 *
 * Room 201's flag is deliberately NOT reset. A third booking — ENT-20260819-0002, a confirmed
 * reservation still at S6 — also holds room 201, so CONFIRMED is the correct reading once these
 * two are gone. Forcing FREE would strip a live claim and re-create the same class of bug from
 * the other direction.
 *
 * Deletes every row that references the entries, then the entries. FK triggers are disabled for
 * the transaction (the same device `wipe-operational-data.ts` uses) so the order of the child
 * tables does not matter; it is all one transaction, so a failure leaves the database untouched.
 *
 * Dry run by default; --commit to delete.
 */
import { readFileSync } from "node:fs";
import pg from "pg";

const COMMIT = process.argv.includes("--commit");
const TARGET_DB = "legphel_pms_dev";
const ENTRY_IDS = ["ENT-20260612-0001", "ENT-20260819-0001"];

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
  const c = new pg.Client({ connectionString: connectionString() });
  await c.connect();
  console.log(`${COMMIT ? "COMMIT" : "DRY RUN"} — database ${TARGET_DB}\n`);

  try {
    // The owned rows whose children reference them by their own id, not by entryId.
    const owned = async (table: string, col = "entryId") =>
      (await c.query(`SELECT id FROM "${table}" WHERE "${col}" = ANY($1::text[])`, [ENTRY_IDS])).rows.map((r) => r.id as string);
    const folioIds = await owned("folios");
    const invoiceIds = await owned("invoices");
    const quotationIds = await owned("quotations");
    const segmentIds = await owned("segments");
    const assignmentIds = await owned("room_assignments");

    // Every table carrying one of these foreign keys, discovered rather than hardcoded so a
    // schema addition cannot silently leave orphans behind.
    const cols = await c.query(`
      SELECT table_name, column_name FROM information_schema.columns
      WHERE table_schema = 'public'
        AND column_name IN ('entryId','folioId','invoiceId','quotationId','segmentId','roomAssignmentId')
      ORDER BY table_name, column_name`);

    const values: Record<string, string[]> = {
      entryId: ENTRY_IDS, folioId: folioIds, invoiceId: invoiceIds,
      quotationId: quotationIds, segmentId: segmentIds, roomAssignmentId: assignmentIds,
    };

    const plan: Array<{ table: string; column: string; count: number }> = [];
    for (const { table_name, column_name } of cols.rows) {
      if (table_name === "entries") continue;
      const ids = values[column_name];
      if (!ids?.length) continue;
      const n = Number((await c.query(`SELECT count(*)::int n FROM "${table_name}" WHERE "${column_name}" = ANY($1::text[])`, [ids])).rows[0].n);
      if (n > 0) plan.push({ table: table_name, column: column_name, count: n });
    }

    console.log(`entries to delete: ${ENTRY_IDS.join(", ")}`);
    console.log(`owned folios=${folioIds.length} invoices=${invoiceIds.length} quotations=${quotationIds.length} segments=${segmentIds.length} assignments=${assignmentIds.length}\n`);
    console.log(`dependent rows (${plan.reduce((t, p) => t + p.count, 0)} across ${plan.length} tables):`);
    for (const p of plan) console.log(`   ${String(p.count).padStart(4)}  ${p.table} (${p.column})`);

    const room = (await c.query(`SELECT "roomNumber","currentClaimState" FROM rooms WHERE "roomNumber"='201'`)).rows[0];
    console.log(`\nroom 201 is ${room.currentClaimState} — left untouched (ENT-20260819-0002 still holds it)`);

    if (!COMMIT) {
      console.log(`\nDry run — nothing deleted. Re-run with --commit to apply.`);
      return;
    }

    await c.query("BEGIN");
    await c.query("SET CONSTRAINTS ALL DEFERRED");
    await c.query("SET session_replication_role = 'replica'");
    let removed = 0;
    for (const p of plan) {
      const r = await c.query(`DELETE FROM "${p.table}" WHERE "${p.column}" = ANY($1::text[])`, [values[p.column]]);
      removed += r.rowCount ?? 0;
    }
    const e = await c.query(`DELETE FROM entries WHERE id = ANY($1::text[])`, [ENTRY_IDS]);
    await c.query("SET session_replication_role = 'origin'");
    await c.query("COMMIT");
    console.log(`\nDeleted ${e.rowCount} entries and ${removed} dependent rows.`);
  } catch (err) {
    await c.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    await c.end();
  }
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
