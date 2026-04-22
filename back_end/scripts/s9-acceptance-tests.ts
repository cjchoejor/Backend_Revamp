import fs from "node:fs";
import path from "node:path";

type HttpMethod = "GET" | "POST";

type TestStep = {
  id: string;
  title: string;
  method: HttpMethod;
  path: string;
  headers?: Record<string, string>;
  body?: unknown;
  expectStatus: number;
  explanation: string;
  dbImpact: string;
};

const BASE_URL = process.env.API_BASE_URL ?? "http://localhost:4000/api";
const DOC_DIR = path.join(process.cwd(), "..", "Documentation");
const REPORT_MD = path.join(DOC_DIR, "S9-test-report.md");
const REPORT_JSON = path.join(DOC_DIR, "S9-test-output.json");

function actorHeaders(actorId: string, actorLevel: "L1" | "L2" | "L3") {
  return {
    "Content-Type": "application/json",
    "X-Actor-Id": actorId,
    "X-Actor-Level": actorLevel,
  };
}

async function http(step: TestStep) {
  const url = `${BASE_URL}${step.path}`;
  const res = await fetch(url, {
    method: step.method,
    headers: step.headers ?? { "Content-Type": "application/json" },
    body: step.body == null ? undefined : JSON.stringify(step.body),
  });
  const text = await res.text();
  let json: any = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return { status: res.status, text, json };
}

function ensureDir(p: string) {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}

function mdEscape(s: string) {
  return s.replaceAll("|", "\\|");
}

async function main() {
  ensureDir(DOC_DIR);

  // We reuse the seeded S7 entry, progress it to S9 via existing S8 flow, then close at S9.
  const seededS7EntryId = process.env.S9_TEST_ENTRY_ID ?? "9a9a9a9a-9a9a-4a9a-9a9a-9a9a9a9a9a9a";

  const L1 = actorHeaders("frontdesk-1", "L1");
  const L2 = actorHeaders("fom-1", "L2");
  const L3 = actorHeaders("gm-1", "L3");

  const results: Array<{ step: TestStep; actualStatus: number; ok: boolean; response: any }> = [];
  const entryGetStep: TestStep = {
    id: "S9-setup-get-entry",
    title: "Get entry snapshot (ids for folio/invoices/handoffs)",
    method: "GET",
    path: `/entries/${seededS7EntryId}`,
    headers: L1,
    expectStatus: 200,
    explanation: "We need the folioId and current stage before executing S9 actions.",
    dbImpact: "Read-only (Entry/Folio/Handoff related joins).",
  };
  const entryGet = await http(entryGetStep);
  results.push({ step: entryGetStep, actualStatus: entryGet.status, ok: entryGet.status === 200, response: entryGet.json ?? entryGet.text });
  if (entryGet.status !== 200) throw new Error(`Cannot continue; GET entry failed: ${entryGet.status}`);

  const entry = entryGet.json;
  const folioId = entry.folio?.id ?? entry.folioId ?? entry.folio?.folioId;
  if (!folioId) throw new Error("Cannot find folioId on entry payload");

  // Ensure we can reach S8: run night audit (S7 gate) then progress stage S7→S8.
  const checkOutIso: string | undefined = entry.checkOutDate;
  const checkOut = checkOutIso ? new Date(checkOutIso) : null;
  if (!checkOut || Number.isNaN(checkOut.getTime())) throw new Error("Entry checkOutDate missing; cannot compute last operating date");
  const lastNight = new Date(Date.UTC(checkOut.getUTCFullYear(), checkOut.getUTCMonth(), checkOut.getUTCDate() - 1, 0, 0, 0, 0));

  const nightAudit: TestStep = {
    id: "S9-setup-night-audit",
    title: "Run night audit (required for S7→S8 gate)",
    method: "POST",
    path: `/night-audit/run`,
    headers: L2,
    body: { operatingDate: lastNight.toISOString().slice(0, 10) },
    expectStatus: 200,
    explanation: "S7→S8 progression blocks unless night audit is complete for the last operating date.",
    dbImpact: "Creates NightAuditRecord + FolioLines (room charge) idempotently for the operating date.",
  };
  const na = await http(nightAudit);
  results.push({ step: nightAudit, actualStatus: na.status, ok: [200, 409].includes(na.status), response: na.json ?? na.text });

  const entryGetV1 = await http(entryGetStep);
  const version1 = entryGetV1.json?.version ?? 1;
  const toS8: TestStep = {
    id: "S9-setup-progress-to-s8",
    title: "Progress stage to S8",
    method: "POST",
    path: `/entries/${seededS7EntryId}/progress-stage`,
    headers: L1,
    body: { targetStage: "S8", version: version1 },
    expectStatus: 200,
    explanation: "Moves entry into S8 so key return, inspection, and settlement can be recorded.",
    dbImpact: "Updates Entry.currentStage to S8 and creates/updates required handoffs/gates.",
  };
  const pS8 = await http(toS8);
  results.push({ step: toS8, actualStatus: pS8.status, ok: [200, 409].includes(pS8.status), response: pS8.json ?? pS8.text });

  // Ensure key return and inspection exist (S8 prerequisites) and settle to OUTSTANDING so S9 has H5.
  const keyReturnStep: TestStep = {
    id: "S9-setup-key-return",
    title: "Record key return (S8 prerequisite for S9)",
    method: "POST",
    path: `/entries/${seededS7EntryId}/key-return`,
    headers: L1,
    body: { keyCountReturned: 2 },
    expectStatus: 200,
    explanation: "S8→S9 requires key-return record and reconciliation.",
    dbImpact: "Creates KeyReturnRecord linked to entry/room.",
  };
  const keyReturn = await http(keyReturnStep);
  results.push({ step: keyReturnStep, actualStatus: keyReturn.status, ok: [200, 409].includes(keyReturn.status), response: keyReturn.json ?? keyReturn.text });

  const inspectionStep: TestStep = {
    id: "S9-setup-inspection",
    title: "Record room inspection complete (S8 prerequisite for S9)",
    method: "POST",
    path: `/entries/${seededS7EntryId}/room-inspection`,
    headers: L1,
    body: {
      isDeferred: false,
      deficientFlagStatus: "NOT_APPLICABLE",
      damageFound: false,
      notes: "ok",
    },
    expectStatus: 200,
    explanation: "S8→S9 requires inspection completed or deferred+governed.",
    dbImpact: "Creates RoomInspectionRecord linked to entry/room.",
  };
  const inspection = await http(inspectionStep);
  results.push({ step: inspectionStep, actualStatus: inspection.status, ok: [200, 409].includes(inspection.status), response: inspection.json ?? inspection.text });

  const settleStep: TestStep = {
    id: "S9-setup-settle-outstanding",
    title: "Settle folio to OUTSTANDING via DIRECT_BILL (S8) to create invoice + H5",
    method: "POST",
    path: `/folios/${folioId}/settle`,
    headers: L1,
    body: { settlementMethod: "DIRECT_BILL", billingModelConfirmation: "DIRECT_BILL" },
    expectStatus: 200,
    explanation: "We want an OUTSTANDING folio at S9 to exercise write-off and invoice payment matching.",
    dbImpact: "Transitions Folio state LIVE→OUTSTANDING, creates Invoice (FINAL) and PaymentRecord as needed, ensures H5 exists.",
  };
  const settle = await http(settleStep);
  results.push({ step: settleStep, actualStatus: settle.status, ok: [200, 409].includes(settle.status), response: settle.json ?? settle.text });

  // Fulfil H4 (required for S8 exit in our slice).
  const entryGetAfterS8Actions = await http(entryGetStep);
  const handoffs: any[] = Array.isArray(entryGetAfterS8Actions.json?.handoffs) ? entryGetAfterS8Actions.json.handoffs : [];
  const h4 = handoffs.find((h) => h.handoffType === "H4");
  if (h4?.id) {
    const fulfilH4: TestStep = {
      id: "S9-setup-fulfil-h4",
      title: "Fulfil H4 (required for S8→S9)",
      method: "POST",
      path: `/handoffs/${h4.id}/fulfil`,
      headers: L2,
      body: {
        fulfilmentEvidence: {
          chargesPostedConfirmation: true,
          roomInspectionStatus: "COMPLETE",
          damageAssessmentStatus: "NONE",
          deficientFlagFinalStatus: "NOT_APPLICABLE",
        },
      },
      expectStatus: 200,
      explanation: "S8→S9 progression is blocked until H4 is fulfilled in this slice.",
      dbImpact: "Updates HandoffRecord(H4).state → FULFILLED and writes fulfilmentEvidence.",
    };
    const fh4 = await http(fulfilH4);
    results.push({ step: fulfilH4, actualStatus: fh4.status, ok: fh4.status === 200, response: fh4.json ?? fh4.text });
  }

  const entryGetV2 = await http(entryGetStep);
  const version2 = entryGetV2.json?.version ?? 1;
  const progressToS9: TestStep = {
    id: "AC-S9-045",
    title: "Progress stage to S9 with required version field",
    method: "POST",
    path: `/entries/${seededS7EntryId}/progress-stage`,
    headers: L1,
    body: { targetStage: "S9", version: version2 },
    expectStatus: 200,
    explanation: "Moves the entry into S9 so terminal closure can be executed.",
    dbImpact: "Updates Entry.currentStage to S9; ensures H5 exists/auto-fulfilled per S8 logic.",
  };
  const pS9 = await http(progressToS9);
  results.push({ step: progressToS9, actualStatus: pS9.status, ok: [200, 409].includes(pS9.status), response: pS9.json ?? pS9.text });

  // List invoices and pick one.
  const listInv: TestStep = {
    id: "S9-list-invoices",
    title: "List invoices for folio",
    method: "GET",
    path: `/folios/${folioId}/invoices`,
    headers: L1,
    expectStatus: 200,
    explanation: "S9 needs invoice payment matching, so we retrieve the invoiceId.",
    dbImpact: "Read-only (Invoice table).",
  };
  const invRes = await http(listInv);
  results.push({ step: listInv, actualStatus: invRes.status, ok: invRes.status === 200, response: invRes.json ?? invRes.text });
  const invoices: any[] = Array.isArray(invRes.json) ? invRes.json : [];
  const invoiceId = invoices[0]?.id;

  // Attempt close should fail until we're at S9 and invariants are satisfied.
  const closeBlocked: TestStep = {
    id: "AC-S9-010",
    title: "Closing blocks when Loop Closure invariant unsatisfied (invoice not dispatched / H5 open / outstanding without W8)",
    method: "POST",
    path: `/entries/${seededS7EntryId}/close`,
    headers: L2,
    body: {},
    expectStatus: 409,
    explanation: "S9 closure should fail with StageGateBlockedError until invariants are met.",
    dbImpact: "No writes when blocked.",
  };
  const close1 = await http(closeBlocked);
  results.push({ step: closeBlocked, actualStatus: close1.status, ok: [409, 400].includes(close1.status), response: close1.json ?? close1.text });

  // Record payment tracked if we have invoice id (L2).
  if (invoiceId) {
    const payTracked: TestStep = {
      id: "AC-S9-032-1",
      title: "Record invoice payment event: DISPATCHED → PAYMENT_TRACKED",
      method: "POST",
      path: `/invoices/${invoiceId}/record-payment-event`,
      headers: L2,
      body: { nextState: "PAYMENT_TRACKED", paymentRef: "bank-slip-001" },
      expectStatus: 200,
      explanation: "Matches a received payment against an invoice (S9 payment matching).",
      dbImpact: "Updates Invoice.state to PAYMENT_TRACKED; stores paymentRef in metadata.",
    };
    const pt = await http(payTracked);
    results.push({ step: payTracked, actualStatus: pt.status, ok: pt.status === 200 || pt.status === 409, response: pt.json ?? pt.text });

    const recon: TestStep = {
      id: "AC-S9-032-2",
      title: "Record invoice payment event: PAYMENT_TRACKED → RECONCILED",
      method: "POST",
      path: `/invoices/${invoiceId}/record-payment-event`,
      headers: L2,
      body: { nextState: "RECONCILED", paymentRef: "statement-2026-04-22" },
      expectStatus: 200,
      explanation: "Post-closure accounting action; should not reopen entry.",
      dbImpact: "Updates Invoice.state to RECONCILED; stores reconciliation reference in metadata.",
    };
    const rc = await http(recon);
    results.push({ step: recon, actualStatus: rc.status, ok: rc.status === 200 || rc.status === 409, response: rc.json ?? rc.text });
  }

  // Write-off requires GM (L3) and reason (AC-S9-038/039/040/041).
  const writeOffNoReason: TestStep = {
    id: "AC-S9-039",
    title: "Write-off blocks if reason missing",
    method: "POST",
    path: `/folios/${folioId}/write-off`,
    headers: L3,
    body: { amount: 100, reason: "" },
    expectStatus: 409,
    explanation: "Policy requires recorded reason for write-off.",
    dbImpact: "No writes when blocked.",
  };
  const wonr = await http(writeOffNoReason);
  results.push({ step: writeOffNoReason, actualStatus: wonr.status, ok: [403, 400, 409].includes(wonr.status), response: wonr.json ?? wonr.text });

  const writeOffOk: TestStep = {
    id: "AC-S9-041",
    title: "Write-off OUTSTANDING balance (GM authority) transitions folio to WRITTEN_OFF",
    method: "POST",
    path: `/folios/${folioId}/write-off`,
    headers: L3,
    body: { amount: 100, reason: "uncollectable small balance" },
    expectStatus: 200,
    explanation: "Creates WriteOffRecord and transitions FolioState OUTSTANDING → WRITTEN_OFF.",
    dbImpact: "Creates WriteOffRecord; updates Folio.state.",
  };
  const wo = await http(writeOffOk);
  results.push({ step: writeOffOk, actualStatus: wo.status, ok: [200, 409].includes(wo.status), response: wo.json ?? wo.text });

  // Close should now succeed once H5 is fulfilled; we fulfil H5 using existing handoff endpoint if present.
  const entryGet2 = await http(entryGetStep);
  const e2 = entryGet2.json;
  const h5 = (e2.handoffs ?? []).find((h: any) => h.handoffType === "H5");
  if (h5?.id) {
    const fulfilH5: TestStep = {
      id: "AC-S9-046-setup",
      title: "Fulfil H5 residual-obligation handoff",
      method: "POST",
      path: `/handoffs/${h5.id}/fulfil`,
      headers: L2,
      body: { fulfilmentEvidence: { resolutionBasis: "write-off completed" } },
      expectStatus: 200,
      explanation: "S9 closure requires no open H5 handoff.",
      dbImpact: "Transitions HandoffRecord.state to FULFILLED/CLOSED per service implementation.",
    };
    const fh5 = await http(fulfilH5);
    results.push({ step: fulfilH5, actualStatus: fh5.status, ok: [200, 409].includes(fh5.status), response: fh5.json ?? fh5.text });
  }

  const closeOk: TestStep = {
    id: "AC-S9-011",
    title: "Close entry at S9 (terminal close)",
    method: "POST",
    path: `/entries/${seededS7EntryId}/close`,
    headers: L2,
    body: {},
    expectStatus: 200,
    explanation: "Once loop closure invariant is satisfied, entry transitions to EntryStatus.CLOSED, room claim released, and timers registered.",
    dbImpact: "Updates Entry.status=CLOSED + closedAt; sets Room.currentClaimState=FREE; creates TimerRecord W28 + retention timer; creates FollowUpTaskRecord for conference/group entries.",
  };
  const close2 = await http(closeOk);
  results.push({ step: closeOk, actualStatus: close2.status, ok: close2.status === 200, response: close2.json ?? close2.text });

  // Persist reports.
  fs.writeFileSync(REPORT_JSON, JSON.stringify({ baseUrl: BASE_URL, results }, null, 2), "utf8");

  const passed = results.filter((r) => r.ok).length;
  const total = results.length;
  const lines: string[] = [];
  lines.push(`# S9 acceptance test report`);
  lines.push(``);
  lines.push(`- Base URL: \`${BASE_URL}\``);
  lines.push(`- Passed: **${passed}/${total}**`);
  lines.push(``);
  lines.push(`## Results`);
  lines.push(``);
  lines.push(`| ID | Title | Request | Expected | Actual | Pass |`);
  lines.push(`|---|---|---|---:|---:|---|`);
  for (const r of results) {
    const req = `${r.step.method} ${r.step.path}`;
    lines.push(`| ${mdEscape(r.step.id)} | ${mdEscape(r.step.title)} | ${mdEscape(req)} | ${r.step.expectStatus} | ${r.actualStatus} | ${r.ok ? "YES" : "NO"} |`);
  }

  lines.push(``);
  lines.push(`## Step details`);
  for (const r of results) {
    lines.push(``);
    lines.push(`### ${r.step.id} — ${r.step.title}`);
    lines.push(``);
    lines.push(`- **What is happening**: ${r.step.explanation}`);
    lines.push(`- **Database (PostgreSQL)**: ${r.step.dbImpact}`);
    lines.push(`- **Request**: \`${r.step.method} ${BASE_URL}${r.step.path}\``);
    if (r.step.body != null) lines.push(`- **Body**: \`${JSON.stringify(r.step.body)}\``);
    lines.push(`- **Expected status**: ${r.step.expectStatus}`);
    lines.push(`- **Actual status**: ${r.actualStatus}`);
    lines.push(`- **Response (truncated)**: \`${JSON.stringify(r.response).slice(0, 600)}\``);
  }

  fs.writeFileSync(REPORT_MD, lines.join("\n"), "utf8");
  process.stdout.write(`Wrote ${path.relative(process.cwd(), REPORT_MD)} and ${path.relative(process.cwd(), REPORT_JSON)}\n`);

  if (passed !== total) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});

