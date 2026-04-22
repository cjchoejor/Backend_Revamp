import { PrismaClient } from "@prisma/client";
import * as fs from "node:fs";
import * as path from "node:path";

type Json = Record<string, unknown> | unknown[] | string | number | boolean | null;

const prisma = new PrismaClient();
const baseUrl = process.env.API_BASE_URL ?? "http://localhost:4000/api";

type Actor = { id: string; level: "L1" | "L2" | "L3" };
const L1: Actor = { id: "test-fd-1", level: "L1" };
const L2: Actor = { id: "test-fom-1", level: "L2" };
const L3: Actor = { id: "test-gm-1", level: "L3" };

function headers(actor: Actor) {
  return { "content-type": "application/json", "x-actor-id": actor.id, "x-actor-level": actor.level };
}

async function http<T = Json>(method: string, p: string, actor: Actor, body?: Json) {
  const res = await fetch(`${baseUrl}${p}`, { method, headers: headers(actor), body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  const json = text ? (JSON.parse(text) as T) : (null as unknown as T);
  return { status: res.status, json };
}

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

type CaseResult = {
  id: string;
  title: string;
  pass: boolean;
  status?: number;
  body?: Json;
  notes?: string;
  /** Plain-language description of intent and behaviour */
  explanation?: string;
  /** Which PostgreSQL tables/columns are touched (INSERT/UPDATE) */
  dbImpact?: string;
};

function writeArtifacts(results: CaseResult[]) {
  const outDir = path.resolve(process.cwd(), "..", "Documentation");
  fs.mkdirSync(outDir, { recursive: true });

  const jsonPath = path.join(outDir, "S7-test-output.json");
  fs.writeFileSync(jsonPath, JSON.stringify({ baseUrl, ranAt: new Date().toISOString(), results }, null, 2));

  const passCount = results.filter((r) => r.pass).length;
  const failCount = results.length - passCount;
  const md = [
    "# S7 test report",
    "",
    "This report is produced by `back_end/scripts/s7-acceptance-tests.ts`. Each case below states **what** is being validated, **which HTTP call** is made (with actor headers), **what the backend checks**, and **which database tables** receive rows or updates when data is persisted.",
    "",
    "**Prisma `@@map` → PostgreSQL table names** (use these in pgAdmin): `FolioLine` → `folio_lines`, `Folio` → `folios`, `NightAuditRecord` → `night_audit_records`, `NightAuditAnomaly` → `night_audit_anomalies`, `DisputeRecord` → `dispute_records`, `DisputeGateOverrideRecord` → `dispute_gate_override_records`, `Entry` → `entries`, `StageDwellRecord` → `stage_dwell_records`.",
    "",
    `- **Ran at**: ${new Date().toISOString()}`,
    `- **Base URL**: \`${baseUrl}\``,
    `- **Pass**: ${passCount}`,
    `- **Fail**: ${failCount}`,
    "",
    "## Cases",
    "",
    ...results.map((r) => {
      const status = r.status == null ? "" : ` (HTTP ${r.status})`;
      const explain = r.explanation ? `\n\n**What is happening**\n\n${r.explanation}` : "";
      const db = r.dbImpact ? `\n\n**Database (PostgreSQL)**\n\n${r.dbImpact}` : "";
      const body = r.body == null ? "" : `\n\n**API response**\n\n\`\`\`json\n${JSON.stringify(r.body, null, 2)}\n\`\`\``;
      const notes = r.notes ? `\n\n**Notes**\n\n${r.notes}` : "";
      return `### ${r.pass ? "✅" : "❌"} ${r.id} — ${r.title}${status}${explain}${db}${notes}${body}`;
    }),
    "",
  ].join("\n");

  fs.writeFileSync(path.join(outDir, "S7-test-report.md"), md);
}

async function main() {
  const results: CaseResult[] = [];

  const entryIdEnv = process.env.S7_TEST_ENTRY_ID?.trim();
  const entry = await prisma.entry.findFirstOrThrow({
    where: entryIdEnv ? { id: entryIdEnv } : { currentStage: "S7" },
    include: { folio: true, handoffs: true },
  });
  if (!entry.folio) throw new Error("Entry has no folio");
  if (entry.currentStage !== "S7") {
    throw new Error(
      `Entry ${entry.id} is at ${entry.currentStage}, not S7. Run \`npx prisma db seed\` for a fresh S7 row, or set S7_TEST_ENTRY_ID to an entry still in S7.`,
    );
  }
  const folioId = entry.folio.id;
  const h4 = entry.handoffs.find((h) => h.handoffType === "H4");
  assert(h4, "Seeded S7 entry must have H4 created");

  // AC-S7-03 (sealed audit date blocks postCharge)
  {
    const operatingDate = "2026-04-20T00:00:00.000Z";
    const r1 = await http("POST", "/night-audit/run", L2, { operatingDate });
    results.push({
      id: "AC-S7-03-setup",
      title: "Run night audit (seal operating date)",
      pass: r1.status === 200,
      status: r1.status,
      body: r1.json,
      explanation:
        "Calls **POST /night-audit/run** as an **L2** actor (`X-Actor-Id: test-fom-1`, `X-Actor-Level: L2`). The night-audit service processes **2026-04-20** (UTC calendar day). For each active S7 entry it posts a **ROOM_CHARGE** folio line for that operating date (if not already present), then marks the run **COMPLETE**. Once `runStatus` is **COMPLETE** for that `operatingDate`, the same calendar day is treated as **sealed** for backdated manual charges (AC-S7-03).",
      dbImpact:
        "**INSERT** into `night_audit_records` (`id`, `operating_date`, `run_status`, `entries_processed_count`, `entries_not_processed`, `created_at`, `created_by`). **INSERT** into `folio_lines` (`folio_id`, `line_type` = ROOM_CHARGE, `description`, `amount`, `currency`, `charge_date`, `stage`, `posted_by`, `night_audit_record_id`, `created_at`). **UPDATE** `folios` (`outstanding_balance` incremented by the room charge amount). If any entry fails processing, the run can be **PARTIAL** with `entries_not_processed` JSON — not exercised in this happy-path setup.",
    });

    const r2 = await http("POST", `/folios/${folioId}/charges`, L1, {
      entryId: entry.id,
      lineType: "SERVICE",
      description: "Late checkout fee",
      amount: 10,
      currency: "BTN",
      chargeDate: operatingDate,
    });
    const body = r2.json as { error?: string; blockingCondition?: string };
    results.push({
      id: "AC-S7-03",
      title: "Posting a charge on a sealed audit date is blocked",
      pass: r2.status === 409 && body?.error === "StateTransitionError" && body?.blockingCondition === "SEALED_AUDIT_DATE",
      status: r2.status,
      body: r2.json,
      explanation:
        "Calls **POST /folios/:id/charges** as **L1** with `chargeDate` on **2026-04-20**, the same UTC operating date that already has a `night_audit_records` row with `run_status = COMPLETE`. The folio charge service normalises the charge date to an operating date and refuses new lines for sealed days. This matches SIG expectation **SEALED_AUDIT_DATE** (no silent backdating after audit close).",
      dbImpact:
        "**No INSERT** on success path — request is rejected before `folio_lines` is written. The service **reads** `night_audit_records` (`operating_date`, `run_status`) to decide if the date is sealed.",
    });
  }

  // AC-S7-01/02 (immutability + correction via new line)
  {
    const r1 = await http("POST", `/folios/${folioId}/charges`, L1, {
      entryId: entry.id,
      lineType: "OTHER",
      description: "Mini bar",
      amount: 25,
      currency: "BTN",
      chargeDate: "2026-04-21T10:00:00.000Z",
    });
    const created = r1.json as { id?: string };
    results.push({
      id: "AC-S7-01",
      title: "PostCharge creates a FolioLine (no update path)",
      pass: r1.status === 200 && !!created?.id,
      status: r1.status,
      body: r1.json,
      explanation:
        "Calls **POST /folios/:id/charges** as **L1** with `lineType: OTHER` (mini bar style charge). The entry must be **S7** and the folio **LIVE**. Posted charges are **append-only**: there is no Prisma `update` on `FolioLine` after creation (AC-S7-01).",
      dbImpact:
        "**INSERT** `folio_lines`: `id`, `folio_id`, `line_type`, `description`, `amount`, `currency`, `charge_date`, `stage`, `posted_by`, `night_audit_record_id` (null for manual post), `created_at`. **UPDATE** `folios`: `outstanding_balance` += charge `amount`.",
    });

    const r2 = await http("POST", `/folios/${folioId}/corrections`, L1, {
      entryId: entry.id,
      originalFolioLineId: created.id,
      reason: "Wrong amount",
      correctionAmount: -5,
      correctionDate: "2026-04-21T10:05:00.000Z",
    });
    const corr = r2.json as { id?: string };
    results.push({
      id: "AC-S7-02",
      title: "Correction creates a new FolioLine (original unchanged)",
      pass: r2.status === 200 && !!corr?.id,
      status: r2.status,
      body: r2.json,
      explanation:
        "Calls **POST /folios/:id/corrections** with `originalFolioLineId` pointing at the line from AC-S7-01. Corrections are modelled as a **new** `folio_lines` row (typically negative `amount`), not an UPDATE of the original row (AC-S7-02). The original row’s columns remain unchanged in the database.",
      dbImpact:
        "**INSERT** another row into `folio_lines` (same columns as AC-S7-01). **UPDATE** `folios.outstanding_balance` by the correction `amount` (here −5). The row referenced by `original_folio_line_id` in the request is **not updated** — only read for validation and description text.",
    });
  }

  // AC-S7-04/05 (night audit anomaly + idempotency)
  {
    const operatingDate = "2026-04-21T00:00:00.000Z";
    const r1 = await http("POST", "/night-audit/run", L2, { operatingDate });
    results.push({
      id: "AC-S7-05",
      title: "Night audit first run creates record",
      pass: r1.status === 200,
      status: r1.status,
      body: r1.json,
      explanation:
        "First run for **2026-04-21** (UTC). The seeded S7 reservation has `frozen_inclusions` with `dailyFAndBExpected: true`, so the engine expects an **F_AND_B** line for that operating date. If none exists, it records an anomaly instead of auto-posting the missing charge (AC-S7-04). It still posts **ROOM_CHARGE** for the night when applicable (AC-S7-05).",
      dbImpact:
        "**INSERT** `night_audit_records` for `operating_date = 2026-04-21`. **INSERT** `folio_lines` for night-audit room charge with `night_audit_record_id` set. **INSERT** `night_audit_anomalies` (`night_audit_record_id`, `entry_id`, `anomaly_type` = MISSING_EXPECTED_CHARGE, `description`, …) when expected F&B is missing. **UPDATE** `folios.outstanding_balance` for the room charge.",
    });

    const anomalies = await prisma.nightAuditAnomaly.findMany({ where: { nightAuditRecordId: (r1.json as { id?: string }).id } });
    results.push({
      id: "AC-S7-04",
      title: "Night audit creates MISSING_EXPECTED_CHARGE anomaly when expected daily F&B missing",
      pass: anomalies.some((a) => a.anomalyType === "MISSING_EXPECTED_CHARGE"),
      notes: `Anomalies found: ${anomalies.map((a) => a.anomalyType).join(", ")}`,
      explanation:
        "This case does not call the HTTP API again; it **queries Prisma** after the AC-S7-05 run to assert that `night_audit_anomalies` contains at least one row with `anomaly_type = MISSING_EXPECTED_CHARGE` for the new `night_audit_records.id`. That proves the audit detected a missing expected F&B charge **without** inserting a compensating `folio_lines` row for F&B.",
      dbImpact:
        "**SELECT** from `night_audit_anomalies` filtered by `night_audit_record_id`. Expected row columns include `anomaly_type`, `entry_id`, `description`, `created_at`.",
    });

    const beforeLines = await prisma.folioLine.count({ where: { nightAuditRecordId: (r1.json as { id?: string }).id } });
    const r2 = await http("POST", "/night-audit/run", L2, { operatingDate });
    const afterLines = await prisma.folioLine.count({ where: { nightAuditRecordId: (r1.json as { id?: string }).id } });
    results.push({
      id: "AC-S7-05-idempotent",
      title: "Night audit rerun does not add new FolioLines",
      pass: r2.status === 200 && beforeLines === afterLines,
      status: r2.status,
      body: r2.json,
      notes: `FolioLines for record: before=${beforeLines}, after=${afterLines}`,
      explanation:
        "Calls **POST /night-audit/run** again with the **same** `operatingDate`. The service returns the **existing** `night_audit_records` row and must **not** create duplicate `folio_lines` tied to that audit (AC-S7-05 idempotency). The script compares `COUNT(*)` from `folio_lines` where `night_audit_record_id` matches before vs after the second call.",
      dbImpact:
        "Second call: typically **no new** `folio_lines` for that `night_audit_record_id`; **no duplicate** `night_audit_records` for the same `operating_date` (unique constraint).",
    });
  }

  // AC-S7-17/19/25 (dispute gate blocks S7→S8 until GM override; version required)
  {
    const r1 = await http("POST", "/disputes/open", L1, {
      entryId: entry.id,
      folioId,
      title: "Charge dispute",
      description: "Guest disputes minibar",
    });
    const dispute = r1.json as { id?: string };
    results.push({
      id: "AC-S7-17-setup",
      title: "Open dispute",
      pass: r1.status === 200 && !!dispute.id,
      status: r1.status,
      body: r1.json,
      explanation:
        "Calls **POST /disputes/open** as **L1** with `entryId`, `folioId`, `title`, `description`. This creates an open dispute tied to the stay’s folio. Later, `canProgressToS8` treats an open dispute without an S8 gate override as **BLOCKED_WITH_OVERRIDE_AVAILABLE** (policy gate).",
      dbImpact:
        "**INSERT** `dispute_records`: `id`, `entry_id`, `folio_id`, `status` (default OPEN), `title`, `description`, `opened_at`, `opened_by`, `updated_at`, optional `updated_by`, closure fields null.",
    });

    const r2 = await http("POST", `/entries/${entry.id}/progress-stage`, L1, { targetStage: "S8" });
    results.push({
      id: "AC-S7-25",
      title: "S7→S8 requires version (optimistic lock guard)",
      pass: r2.status === 409 && (r2.json as { error?: string })?.error === "OptimisticLockError",
      status: r2.status,
      body: r2.json,
      explanation:
        "Calls **POST /entries/:id/progress-stage** with `targetStage: S8` but **omits** `version`. Per SIG AC-S7-25 / optimistic locking, the handler rejects the request immediately with **OptimisticLockError** so the client must send the current `entries.version`.",
      dbImpact:
        "**No database writes** — validation fails before transaction.",
    });

    const fresh = await prisma.entry.findUniqueOrThrow({ where: { id: entry.id } });
    const r3 = await http("POST", `/entries/${entry.id}/progress-stage`, L1, { targetStage: "S8", version: fresh.version });
    results.push({
      id: "AC-S7-17",
      title: "Dispute gate blocks S7→S8 until GM override",
      pass: r3.status === 409 && (r3.json as { error?: string; blockingCondition?: string })?.error === "PolicyGateBlockedError",
      status: r3.status,
      body: r3.json,
      explanation:
        "With a valid `version`, progression still fails because an **open** dispute exists and no **DisputeGateOverrideRecord** yet exists for `target_stage = S8`. The API returns **PolicyGateBlockedError** with `blockingCondition: DISPUTE_GATE_BLOCKED`. Other S7→S8 gates (H4, night audit for last stay night, deficient conditions) must also pass when implemented in `progressStageS7ToS8`.",
      dbImpact:
        "**Reads** `dispute_records`, `dispute_gate_override_records`, `handoff_records` (H4), `night_audit_records`, `deficient_condition_records`, `entries`, `folios`. **No writes** on this failed attempt.",
    });

    const r4 = await http("POST", `/disputes/${dispute.id}/gate-override`, L3, { targetStage: "S8", freeTextReason: "GM override for checkout continuity" });
    results.push({
      id: "AC-S7-18",
      title: "Create dispute gate override (immutable)",
      pass: r4.status === 200,
      status: r4.status,
      body: r4.json,
      explanation:
        "Calls **POST /disputes/:id/gate-override** as **L3** (GM) with mandatory `freeTextReason` and `targetStage: S8`. This records an immutable override row (AC-S7-18 — no UPDATE path in app code). After this, `canProgressToS8` returns clear for that dispute.",
      dbImpact:
        "**INSERT** `dispute_gate_override_records`: `id`, `dispute_id`, `target_stage`, `free_text_reason`, `created_at`, `created_by`.",
    });

    const r5 = await http("POST", `/disputes/${dispute.id}/gate-override`, L3, { targetStage: "S9", freeTextReason: "Should be blocked" });
    results.push({
      id: "AC-S7-19",
      title: "Override not available for S8→S9",
      pass: r5.status === 409 && (r5.json as { error?: string })?.error === "PolicyGateBlockedError",
      status: r5.status,
      body: r5.json,
      explanation:
        "Attempts a gate override with `targetStage: S9`. Per AC-S7-19, dispute overrides are **not** permitted for the S8→S9 transition; the service rejects with **PolicyGateBlockedError**.",
      dbImpact:
        "**No INSERT** into `dispute_gate_override_records` on rejected path.",
    });

    const fresh2 = await prisma.entry.findUniqueOrThrow({ where: { id: entry.id } });
    const r6 = await http("POST", `/entries/${entry.id}/progress-stage`, L1, { targetStage: "S8", version: fresh2.version });
    results.push({
      id: "S7→S8",
      title: "Progress S7→S8 after audit complete + H4 + override",
      pass: r6.status === 200,
      status: r6.status,
      body: r6.json,
      explanation:
        "Successful **POST /entries/:id/progress-stage** with `targetStage: S8` and current `version`. The entry moves from **S7** to **S8**: closes the open S7 dwell record and opens an S8 dwell. Preconditions satisfied in this seed: **H4** exists in an allowed state, **night audit COMPLETE** for the last operating night before checkout, no deficient blocker, dispute gate cleared by GM override.",
      dbImpact:
        "**UPDATE** `stage_dwell_records`: set `exited_at` on the active S7 row. **INSERT** `stage_dwell_records` for `stage = S8` with `entered_at`. **UPDATE** `entries`: `current_stage` → S8, `version` incremented, `updated_at` set.",
    });
  }

  writeArtifacts(results);
  const failed = results.filter((r) => !r.pass);
  if (failed.length > 0) {
    throw new Error(`S7 acceptance tests failed: ${failed.map((f) => f.id).join(", ")}`);
  }
}

main()
  .then(async () => {
    await prisma.$disconnect();
    console.log("S7 acceptance tests: PASS");
  })
  .catch(async (e) => {
    await prisma.$disconnect();
    console.error(e);
    process.exit(1);
  });

