import { prisma } from "../src/db.js";
import * as fs from "node:fs";
import * as path from "node:path";
import { createTimerEngine } from "../src/lib/timer-engine.js";
import { runPreArrivalWindowActivationWorker } from "../src/workers/w4-pre-arrival-window-activation-worker.js";

type Json = Record<string, unknown> | unknown[] | string | number | boolean | null;

const baseUrl = process.env.API_BASE_URL ?? "http://localhost:4000/api";

type Actor = { id: string; level: "L1" | "L2" | "L3" };
const L1: Actor = { id: "e2e-fd-3", level: "L1" };
const L2: Actor = { id: "e2e-fom-3", level: "L2" };

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

async function getActiveConfigValue<T = unknown>(key: string, now = new Date()): Promise<T> {
  const rows = await prisma.configurationEntry.findMany({
    where: { configKey: key, effectiveFrom: { lte: now }, OR: [{ effectiveTo: null }, { effectiveTo: { gt: now } }] },
    orderBy: { effectiveFrom: "desc" },
    take: 1,
  });
  const row = rows[0];
  if (!row) throw new Error(`Missing active config: ${key}`);
  return row.configValue as T;
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

  const guest = await prisma.guestProfile.findFirstOrThrow({ orderBy: { createdAt: "asc" } });
  const now = new Date();
  const checkInDate = isoDay(now);
  const checkOutDate = isoDay(new Date(now.getTime() + 86400_000));

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

  // --- S1
  const inq = await runStep("S1 create inquiry", {
    method: "POST",
    path: "/inquiries",
    actor: L1,
    body: { guestProfileId: guest.id, sourceChannel: "WALK_IN", notes: "e2e voucher flow" },
  });
  expectStatus("S1 create inquiry", inq, 201);
  const inquiryId = (inq.json as any).id as string;

  const entryCreated = await runStep("S1 create entry", {
    method: "POST",
    path: "/entries",
    actor: L1,
    body: { inquiryId, useType: "LEISURE", checkInDate, checkOutDate, guestCount: 1, otaSource: false },
  });
  expectStatus("S1 create entry", entryCreated, 201);
  const entryId = (entryCreated.json as any).id as string;

  const avail = await runStep("S1 availability search", {
    method: "POST",
    path: "/availability/search",
    actor: L1,
    body: { entryId, checkInDate, checkOutDate, guestCount: 1, useType: "LEISURE" },
  });
  expectStatus("S1 availability search", avail, 200);
  const cfgId = (avail.json as any).configurationId as string;
  const results = (avail.json as any).results as any;
  const firstRoomId = (results?.availableRooms?.[0]?.roomId ?? results?.deficientRooms?.[0]?.roomId) as string | undefined;
  if (!firstRoomId) throw new Error("No roomId found in availability results");

  expectStatus(
    "S1 select availability option",
    await runStep("S1 select availability option", { method: "PATCH", path: `/availability/configurations/${cfgId}/select`, actor: L1, body: { roomId: firstRoomId } }),
    200,
  );

  const entryFreshS1 = await http<any>("GET", `/entries/${entryId}`, L1);
  expectStatus(
    "S1->S2 progress-stage",
    await runStep("S1->S2 progress-stage", { method: "POST", path: `/entries/${entryId}/progress-stage`, actor: L1, body: { targetStage: "S2", version: (entryFreshS1.json as any).version } }),
    200,
  );

  // --- S2
  const q1 = await runStep("S2 create quotation", { method: "POST", path: `/entries/${entryId}/quotations`, actor: L1, body: { nightlyRate: 100, currency: "BTN", notes: "e2e quotation" } as any });
  expectStatus("S2 create quotation", q1, 201);
  const quotationId = (q1.json as any).id as string;
  expectStatus("S2 send quotation", await runStep("S2 send quotation", { method: "POST", path: `/quotations/${quotationId}/send`, actor: L1, body: {} }), 200);
  expectStatus("S2 accept quotation", await runStep("S2 accept quotation", { method: "POST", path: `/quotations/${quotationId}/accept`, actor: L1, body: {} }), 200);

  const entryFreshS2 = await http<any>("GET", `/entries/${entryId}`, L1);
  expectStatus(
    "S2->S3 progress-stage",
    await runStep("S2->S3 progress-stage", { method: "POST", path: `/entries/${entryId}/progress-stage`, actor: L1, body: { targetStage: "S3", version: (entryFreshS2.json as any).version } }),
    200,
  );

  // --- S3 setup (GUEST_PAY + advance payment + reconcile + disclosure + committed hold + confirm)
  const folioCreated = await runStep("S3 ensure provisional folio + billing model", { method: "POST", path: `/entries/${entryId}/folio/provisional`, actor: L1, body: { billingModel: "GUEST_PAY" } });
  expectStatus("S3 ensure provisional folio + billing model", folioCreated, 201);

  const entryWithFolioApi = await http<any>("GET", `/entries/${entryId}`, L1);
  const folioId = (entryWithFolioApi.json as any)?.folio?.id as string | undefined;
  if (!folioId) throw new Error("Expected folio after S3 setup");

  expectStatus("S3 record advance payment", await runStep("S3 record advance payment", { method: "POST", path: `/folios/${folioId}/payments`, actor: L1, body: { entryId, amount: 1000, notes: "e2e advance payment" } }), 201);
  expectStatus("S3 reconcile advance payment", await runStep("S3 reconcile advance payment", { method: "POST", path: `/folios/${folioId}/advance-payment/reconcile`, actor: L1, body: { entryId, note: "e2e reconcile" } }), 200);

  expectStatus("S3 cancellation disclosure", await runStep("S3 cancellation disclosure", { method: "POST", path: `/entries/${entryId}/disclosures/cancellation`, actor: L1, body: { noShowTreatmentStatement: "Standard no-show policy", disclosedTerms: { windowHours: 24 } } }), 201);
  expectStatus("S3 committed hold", await runStep("S3 committed hold", { method: "POST", path: `/entries/${entryId}/holds/committed`, actor: L1, body: { roomId: firstRoomId, commercialJustification: "Voucher scenario hold" } }), 201);

  const entryFreshS3 = await http<any>("GET", `/entries/${entryId}`, L1);
  expectStatus("S3->S4 confirm reservation", await runStep("S3->S4 confirm reservation", { method: "POST", path: `/entries/${entryId}/confirm`, actor: L1, body: { version: (entryFreshS3.json as any).version } }), 200);

  // --- W4 activation to S5
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

  const entryAtS5 = await http<any>("GET", `/entries/${entryId}`, L1);
  const preArrivalTasks = ((entryAtS5.json as any)?.preArrivalTasks ?? []) as any[];
  for (const t of preArrivalTasks) {
    expectStatus(`S5 complete pre-arrival task ${t.id}`, await runStep(`S5 complete pre-arrival task ${t.id}`, { method: "PATCH", path: `/pre-arrival-tasks/${t.id}`, actor: L1, body: { action: "COMPLETE" } }), 200);
  }

  expectStatus("S5 room assignment", await runStep("S5 room assignment", { method: "POST", path: `/entries/${entryId}/room-assignments`, actor: L1, body: { roomId: firstRoomId, notes: "e2e assign" } }), 201);

  // H1 accept+fulfil
  const afterRa = await http<any>("GET", `/entries/${entryId}`, L1);
  const h1 = ((afterRa.json as any)?.handoffs ?? []).find((h: any) => h.handoffType === "H1");
  if (!h1) throw new Error("Expected H1 handoff at S5");

  const checklist = ((await getActiveConfigValue<any[]>("handoff.H1.checklist")) ?? []).filter((i) => i?.mandatory);
  const checklistCompletion: Record<string, boolean> = {};
  for (const item of checklist) checklistCompletion[String(item.code)] = true;
  expectStatus("S5 accept H1", await runStep("S5 accept H1", { method: "POST", path: `/handoffs/${h1.id}/accept`, actor: L1, body: { checklistCompletion } }), 200);

  const roomAssignmentId = (afterRa.json as any)?.roomAssignments?.[0]?.id as string | undefined;
  if (!roomAssignmentId) throw new Error("Expected roomAssignmentId after room assignment");
  expectStatus(
    "S5 fulfil H1",
    await runStep("S5 fulfil H1", {
      method: "POST",
      path: `/handoffs/${h1.id}/fulfil`,
      actor: L1,
      body: { fulfilmentEvidence: { roomAssignmentId, readinessConfirmed: true, paymentStatusConfirmed: true, ceilingProximityAddressed: true } } as any,
    }),
    200,
  );

  // --- S5->S6
  const entryFreshS5 = await http<any>("GET", `/entries/${entryId}`, L1);
  expectStatus(
    "S5->S6 progress-stage (guest present)",
    await runStep("S5->S6 progress-stage (guest present)", { method: "POST", path: `/entries/${entryId}/progress-stage`, actor: L1, body: { targetStage: "S6", version: (entryFreshS5.json as any).version, guestPhysicallyPresent: true } }),
    200,
  );

  // --- S6
  const entryAfterS6 = await http<any>("GET", `/entries/${entryId}`, L1);
  const roomNumber = ((entryAfterS6.json as any)?.roomAssignments?.[0]?.room?.roomNumber as string | undefined) ?? "101";
  expectStatus("S6 create H2", await runStep("S6 create H2", { method: "POST", path: `/entries/${entryId}/handoffs/h2`, actor: L1, body: { roomNumber, guestProfileId: guest.id, deficientConditionStatus: null } }), 201);

  const docTypes = ((await getActiveConfigValue<any[]>("identity.documentTypes")) ?? []).filter((d) => d?.isActive !== false);
  const docType = (docTypes[0]?.documentTypeCode as string | undefined) ?? "PASSPORT";
  expectStatus(
    "S6 verify guest identity",
    await runStep("S6 verify guest identity", { method: "POST", path: `/guest-profiles/${guest.id}/verify-identity`, actor: L1, body: { entryId, verificationPath: "FIRST_TIME", documentType: docType, documentNumber: `E2E-${Date.now()}`, issuingCountry: "BT" } }),
    200,
  );

  const entryFreshS6 = await http<any>("GET", `/entries/${entryId}`, L1);
  expectStatus(
    "S6->S7 progress-stage (complete check-in)",
    await runStep("S6->S7 progress-stage (complete check-in)", { method: "POST", path: `/entries/${entryId}/progress-stage`, actor: L1, body: { targetStage: "S7", version: (entryFreshS6.json as any).version, transitionData: { keyCount: 2, registrationConfirmed: true } } as any }),
    200,
  );

  // --- S7: post an extra charge so voucher can be partial
  const afterCheckIn = await http<any>("GET", `/entries/${entryId}`, L1);
  const liveFolioId = (afterCheckIn.json as any)?.folio?.id as string | undefined;
  if (!liveFolioId) throw new Error("Expected live folio at S7");
  expectStatus(
    "S7 post an extra charge (room service)",
    await runStep("S7 post an extra charge (room service)", {
      method: "POST",
      path: `/folios/${liveFolioId}/charges`,
      actor: L1,
      body: {
        entryId,
        lineType: "F_AND_B",
        description: "Room service",
        amount: 120,
        chargeDate: new Date().toISOString(),
      } as any,
    }),
    200,
  );

  // night audit last operating date
  const eS7 = await http<any>("GET", `/entries/${entryId}`, L1);
  const checkout = new Date((eS7.json as any).checkOutDate as string);
  const lastNight = new Date(Date.UTC(checkout.getUTCFullYear(), checkout.getUTCMonth(), checkout.getUTCDate() - 1, 0, 0, 0, 0));
  expectStatus("S7 run night audit (last operating date)", await runStep("S7 run night audit (last operating date)", { method: "POST", path: "/night-audit/run", actor: L2, body: { operatingDate: lastNight.toISOString() } }), 200);

  expectStatus("S7 initiate H4", await runStep("S7 initiate H4", { method: "POST", path: `/entries/${entryId}/handoffs/h4`, actor: L1, body: { notes: "e2e pre-checkout handoff" } }), 201);

  const entryFreshS7 = await http<any>("GET", `/entries/${entryId}`, L1);
  expectStatus("S7->S8 progress-stage (stay exit)", await runStep("S7->S8 progress-stage (stay exit)", { method: "POST", path: `/entries/${entryId}/progress-stage`, actor: L1, body: { targetStage: "S8", version: (entryFreshS7.json as any).version } }), 200);

  // --- S8: key return + inspection + fulfil H4
  const s8Entry = await http<any>("GET", `/entries/${entryId}`, L1);
  const keysIssued = Number((s8Entry.json as any).keysIssuedCount ?? 2);
  expectStatus("S8 record key return", await runStep("S8 record key return", { method: "POST", path: `/entries/${entryId}/key-return`, actor: L1, body: { keyCountReturned: keysIssued } }), 200);
  expectStatus("S8 record room inspection", await runStep("S8 record room inspection", { method: "POST", path: `/entries/${entryId}/room-inspection`, actor: L1, body: { isDeferred: false, deficientFlagStatus: "NOT_APPLICABLE", damageFound: false } as any }), 200);

  const h4 = await prisma.handoffRecord.findFirstOrThrow({ where: { entryId, handoffType: "H4" }, orderBy: { createdAt: "desc" } });
  expectStatus(
    "S8 fulfil H4",
    await runStep("S8 fulfil H4", {
      method: "POST",
      path: `/handoffs/${h4.id}/fulfil`,
      actor: L1,
      body: { fulfilmentEvidence: { chargesPostedConfirmation: true, roomInspectionStatus: "RECORDED_OR_DEFERRED", damageAssessmentStatus: "COMPLETE_OR_DEFERRED", deficientFlagFinalStatus: "RECORDED" } } as any,
    }),
    200,
  );

  // Voucher settlement: cover most but leave a small remainder so folio becomes OUTSTANDING and H5 is created.
  const folioNow = await runStep("S8 get folio", { method: "GET", path: `/folios/${liveFolioId}`, actor: L1 });
  expectStatus("S8 get folio", folioNow, 200);
  const outstanding = Number(((folioNow.json as any).outstandingBalance ?? "0").toString());
  const voucherAmount = outstanding > 20 ? outstanding - 10 : Math.max(0, outstanding);
  expectStatus(
    "S8 settle folio (VOUCHER partial => OUTSTANDING)",
    await runStep("S8 settle folio (VOUCHER partial => OUTSTANDING)", {
      method: "POST",
      path: `/folios/${liveFolioId}/settle`,
      actor: L1,
      body: { settlementMethod: "VOUCHER", voucherAmount, billingModelConfirmation: "GUEST_PAY" } as any,
    }),
    200,
  );

  const entryFreshS8 = await http<any>("GET", `/entries/${entryId}`, L1);
  expectStatus("S8->S9 progress-stage (closure stage)", await runStep("S8->S9 progress-stage (closure stage)", { method: "POST", path: `/entries/${entryId}/progress-stage`, actor: L1, body: { targetStage: "S9", version: (entryFreshS8.json as any).version } }), 200);

  // Fulfil H5 (required for OUTSTANDING)
  const h5 = await prisma.handoffRecord.findFirst({ where: { entryId, handoffType: "H5" }, orderBy: { createdAt: "desc" } });
  if (h5) {
    expectStatus(
      "S9 fulfil H5",
      await runStep("S9 fulfil H5", { method: "POST", path: `/handoffs/${h5.id}/fulfil`, actor: L1, body: { fulfilmentEvidence: { resolutionBasis: "VOUCHER_AND_AGENT_BILLING" } } as any }),
      200,
    );
  }

  // Dispatch any DRAFT invoices (if any)
  const invList = await runStep("S9 list invoices", { method: "GET", path: `/folios/${liveFolioId}/invoices`, actor: L1 });
  expectStatus("S9 list invoices", invList, 200);
  const invoices = (invList.json as any[]) ?? [];
  for (const inv of invoices) {
    if (inv?.state === "DRAFT") {
      expectStatus(`S9 dispatch invoice ${inv.id}`, await runStep(`S9 dispatch invoice ${inv.id}`, { method: "POST", path: `/invoices/${inv.id}/dispatch`, actor: L1, body: { dispatchedTo: "agent@example.com" } }), 200);
    }
  }

  expectStatus("S9 close entry", await runStep("S9 close entry", { method: "POST", path: `/entries/${entryId}/close`, actor: L2 }), 200);

  const outDir = path.resolve(process.cwd(), "..", "Documentation_V2");
  fs.mkdirSync(outDir, { recursive: true });
  const outMd = path.join(outDir, "E2E-voucher-s1-to-s9-test-report.no-db.md");

  const md = [
    "# E2E voucher flow report (S1 → S9) — no DB diffs",
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
    console.error("E2E voucher flow: FAILED", e);
    process.exit(1);
  });

