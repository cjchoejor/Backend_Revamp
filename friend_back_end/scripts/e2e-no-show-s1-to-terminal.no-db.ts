import { prisma } from "../src/db.js";
import * as fs from "node:fs";
import * as path from "node:path";
import { createTimerEngine } from "../src/lib/timer-engine.js";
import { runPreArrivalWindowActivationWorker } from "../src/workers/w4-pre-arrival-window-activation-worker.js";

type Json = Record<string, unknown> | unknown[] | string | number | boolean | null;

const baseUrl = process.env.API_BASE_URL ?? "http://localhost:4000/api";

type Actor = { id: string; level: "L1" | "L2" | "L3" };
const L1: Actor = { id: "e2e-fd-4", level: "L1" };
const L2: Actor = { id: "e2e-fom-4", level: "L2" };

function headers(actor: Actor) {
  return { "content-type": "application/json", "x-actor-id": actor.id, "x-actor-level": actor.level };
}

async function http<T = Json>(method: string, p: string, actor: Actor, body?: Json) {
  const res = await fetch(`${baseUrl}${p}`, {
    method,
    headers: headers(actor),
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  const json = text ? (JSON.parse(text) as T) : (null as unknown as T);
  return { status: res.status, json };
}

function safeJson(v: unknown) {
  return JSON.parse(JSON.stringify(v, (_k, val) => (typeof val === "bigint" ? val.toString() : val)));
}

function isoDay(d: Date) {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 0, 0, 0, 0)).toISOString();
}

type StepReport = {
  step: string;
  request: { method: string; path: string; actor: Actor; body?: Json };
  response: { status: number; body: Json };
};

function expectStatus(step: string, got: { status: number; json: unknown }, expected: number) {
  if (got.status !== expected) {
    throw new Error(`${step} failed: expected HTTP ${expected}, got ${got.status} body=${JSON.stringify(safeJson(got.json), null, 2)}`);
  }
}

async function waitForStage(entryId: string, stage: string, timeoutMs = 30_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const r = await http<any>("GET", `/entries/${entryId}`, L1);
    const current = (r.json as any)?.currentStage;
    if (current === stage) return r.json;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`Timed out waiting for stage=${stage}`);
}

async function main() {
  const ranAt = new Date();
  const steps: StepReport[] = [];

  async function runStep(step: string, req: StepReport["request"]) {
    const resp = await http(req.method, req.path, req.actor, req.body);
    steps.push({ step, request: req, response: { status: resp.status, body: safeJson(resp.json) } });
    return resp;
  }

  async function runWorkerStep(step: string, workerName: string, run: () => Promise<unknown>) {
    const out = await run();
    steps.push({
      step,
      request: { method: "WORKER", path: workerName, actor: { id: "SYSTEM", level: "L1" } as any },
      response: { status: 200, body: safeJson(out) as any },
    });
  }

  const guest = await prisma.guestProfile.findFirstOrThrow({ orderBy: { createdAt: "asc" } });
  const now = new Date();
  const checkInDate = isoDay(now);
  const checkOutDate = isoDay(new Date(now.getTime() + 86400_000));

  // S1 -> create inquiry + entry + availability + select -> S2
  const inq = await runStep("S1 create inquiry", { method: "POST", path: "/inquiries", actor: L1, body: { guestProfileId: guest.id, sourceChannel: "WALK_IN", notes: "e2e no-show flow" } });
  expectStatus("S1 create inquiry", inq, 201);
  const inquiryId = (inq.json as any).id as string;

  const entryCreated = await runStep("S1 create entry", { method: "POST", path: "/entries", actor: L1, body: { inquiryId, useType: "LEISURE", checkInDate, checkOutDate, guestCount: 1, otaSource: false } });
  expectStatus("S1 create entry", entryCreated, 201);
  const entryId = (entryCreated.json as any).id as string;

  const avail = await runStep("S1 availability search", { method: "POST", path: "/availability/search", actor: L1, body: { entryId, checkInDate, checkOutDate, guestCount: 1, useType: "LEISURE" } });
  expectStatus("S1 availability search", avail, 200);
  const cfgId = (avail.json as any).configurationId as string;
  const results = (avail.json as any).results as any;
  const firstRoomId = (results?.availableRooms?.[0]?.roomId ?? results?.deficientRooms?.[0]?.roomId) as string | undefined;
  if (!firstRoomId) throw new Error("No roomId found in availability results");

  expectStatus("S1 select availability option", await runStep("S1 select availability option", { method: "PATCH", path: `/availability/configurations/${cfgId}/select`, actor: L1, body: { roomId: firstRoomId } }), 200);

  const entryFreshS1 = await http<any>("GET", `/entries/${entryId}`, L1);
  expectStatus("S1->S2 progress-stage", await runStep("S1->S2 progress-stage", { method: "POST", path: `/entries/${entryId}/progress-stage`, actor: L1, body: { targetStage: "S2", version: (entryFreshS1.json as any).version } }), 200);

  // S2 quotation -> S3
  const q1 = await runStep("S2 create quotation", { method: "POST", path: `/entries/${entryId}/quotations`, actor: L1, body: { nightlyRate: 100, currency: "BTN", notes: "e2e quotation" } as any });
  expectStatus("S2 create quotation", q1, 201);
  const quotationId = (q1.json as any).id as string;
  expectStatus("S2 send quotation", await runStep("S2 send quotation", { method: "POST", path: `/quotations/${quotationId}/send`, actor: L1, body: {} }), 200);
  expectStatus("S2 accept quotation", await runStep("S2 accept quotation", { method: "POST", path: `/quotations/${quotationId}/accept`, actor: L1, body: {} }), 200);

  const entryFreshS2 = await http<any>("GET", `/entries/${entryId}`, L1);
  expectStatus("S2->S3 progress-stage", await runStep("S2->S3 progress-stage", { method: "POST", path: `/entries/${entryId}/progress-stage`, actor: L1, body: { targetStage: "S3", version: (entryFreshS2.json as any).version } }), 200);

  // S3 setup enough to confirm S4 and then reach S5
  expectStatus("S3 ensure provisional folio + billing model", await runStep("S3 ensure provisional folio + billing model", { method: "POST", path: `/entries/${entryId}/folio/provisional`, actor: L1, body: { billingModel: "GUEST_PAY" } }), 201);

  const entryWithFolioApi = await http<any>("GET", `/entries/${entryId}`, L1);
  const folioId = (entryWithFolioApi.json as any)?.folio?.id as string | undefined;
  if (!folioId) throw new Error("Expected folio after S3 setup");

  // Record an advance payment so same-day penalty can be computed (and S3 hold policy can pass).
  expectStatus("S3 record advance payment", await runStep("S3 record advance payment", { method: "POST", path: `/folios/${folioId}/payments`, actor: L1, body: { entryId, amount: 500, notes: "advance for no-show scenario" } }), 201);
  expectStatus("S3 reconcile advance payment", await runStep("S3 reconcile advance payment", { method: "POST", path: `/folios/${folioId}/advance-payment/reconcile`, actor: L1, body: { entryId, note: "reconcile for no-show scenario" } }), 200);

  expectStatus("S3 cancellation disclosure", await runStep("S3 cancellation disclosure", { method: "POST", path: `/entries/${entryId}/disclosures/cancellation`, actor: L1, body: { noShowTreatmentStatement: "Standard no-show policy", disclosedTerms: { sameDayPenaltyAmount: 200 } } as any }), 201);
  expectStatus("S3 committed hold", await runStep("S3 committed hold", { method: "POST", path: `/entries/${entryId}/holds/committed`, actor: L1, body: { roomId: firstRoomId, commercialJustification: "No-show scenario hold" } }), 201);

  const entryFreshS3 = await http<any>("GET", `/entries/${entryId}`, L1);
  expectStatus("S3->S4 confirm reservation", await runStep("S3->S4 confirm reservation", { method: "POST", path: `/entries/${entryId}/confirm`, actor: L1, body: { version: (entryFreshS3.json as any).version } }), 200);

  // Activate to S5 (W4)
  try {
    await waitForStage(entryId, "S5", 10_000);
  } catch {
    const timer = await prisma.timerRecord.findFirst({
      where: { entryId, status: "SCHEDULED", OR: [{ timerCode: "PRE_ARRIVAL_COUNTDOWN_W4" }, { timerType: "PRE_ARRIVAL_COUNTDOWN_W4" }] },
      orderBy: { createdAt: "desc" },
    });
    if (!timer) throw new Error("Expected PRE_ARRIVAL_COUNTDOWN_W4 TimerRecord after confirmation");
    const connectionString = process.env.DATABASE_URL;
    if (!connectionString) throw new Error("DATABASE_URL is required to trigger W4 manually");
    const engine = createTimerEngine(connectionString);
    await engine.start();
    await runWorkerStep("W4 pre-arrival activation (manual trigger)", "PRE_ARRIVAL_COUNTDOWN_W4", async () =>
      runPreArrivalWindowActivationWorker(prisma, engine, { entryId, timerRecordId: timer.id }),
    );
    await engine.stop();
    await waitForStage(entryId, "S5", 10_000);
  }

  // No-show service requires cutoff reached timestamp.
  await prisma.entry.update({ where: { id: entryId }, data: { noShowCutoffReachedAt: new Date(), awaitingWrittenConfirmationActive: false } as any });
  steps.push({
    step: "TEST SETUP (DB): mark noShowCutoffReachedAt",
    request: { method: "DB", path: "Entry.noShowCutoffReachedAt", actor: { id: "SYSTEM", level: "L2" } as any },
    response: { status: 200, body: { ok: true } },
  });

  // Determine no-show SUB_PATH_1 -> entry goes TERMINAL and folio becomes NO_SHOW_CLOSED.
  const noShow = await runStep("S5 determine no-show (SUB_PATH_1)", {
    method: "POST",
    path: `/entries/${entryId}/no-show`,
    actor: L2,
    body: {
      determinationPath: "SUB_PATH_1",
      contactAttemptLog: [{ channel: "PHONE", attemptedAt: new Date().toISOString(), outcome: "NO_ANSWER" }],
      decisionReason: "Guest did not arrive within cutoff window",
    },
  });
  expectStatus("S5 determine no-show (SUB_PATH_1)", noShow, 200);

  const outDir = path.resolve(process.cwd(), "..", "Documentation_V2");
  fs.mkdirSync(outDir, { recursive: true });
  const outMd = path.join(outDir, "E2E-no-show-s1-to-terminal-test-report.no-db.md");

  const md = [
    "# E2E no-show flow report (S1 → TERMINAL) — no DB diffs",
    "",
    `- **Ran at**: ${ranAt.toISOString()}`,
    `- **Base URL**: \`${baseUrl}\``,
    `- **Entry ID**: \`${entryId}\``,
    `- **Inquiry ID**: \`${inquiryId}\``,
    `- **GuestProfile ID (seeded)**: \`${guest.id}\``,
    "",
    "## Steps",
    "",
    ...steps.flatMap((r) => [
      `### ${r.step}`,
      "",
      `- **Request**: \`${r.request.method}\` \`${r.request.path}\` (actor \`${r.request.actor.level}\` / \`${r.request.actor.id}\`)`,
      "",
      "```json",
      JSON.stringify({ body: r.request.body ?? null }, null, 2),
      "```",
      "",
      `- **Response**: HTTP ${r.response.status}`,
      "",
      "```json",
      JSON.stringify(r.response.body ?? null, null, 2),
      "```",
      "",
    ]),
  ].join("\n");
  fs.writeFileSync(outMd, md, "utf8");
  console.log(`Wrote ${outMd}`);
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error("E2E no-show flow: FAILED", e);
    process.exit(1);
  });

