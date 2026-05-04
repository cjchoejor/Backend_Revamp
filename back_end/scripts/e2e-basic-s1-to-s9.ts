import { prisma } from "../src/db.js";
import * as fs from "node:fs";
import * as path from "node:path";
import { createTimerEngine } from "../src/lib/timer-engine.js";
import { runPreArrivalWindowActivationWorker } from "../src/workers/w4-pre-arrival-window-activation-worker.js";

type Json = Record<string, unknown> | unknown[] | string | number | boolean | null;

const baseUrl = process.env.API_BASE_URL ?? "http://localhost:4000/api";

type Actor = { id: string; level: "L1" | "L2" | "L3" };
const L1: Actor = { id: "e2e-fd-1", level: "L1" };
const L2: Actor = { id: "e2e-fom-1", level: "L2" };

function headers(actor: Actor) {
  return { "content-type": "application/json", "x-actor-id": actor.id, "x-actor-level": actor.level };
}

async function http<T = Json>(method: string, p: string, actor: Actor, body?: Json) {
  const res = await fetch(`${baseUrl}${p}`, { method, headers: headers(actor), body: body === undefined ? undefined : JSON.stringify(body) });
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
    where: {
      configKey: key,
      effectiveFrom: { lte: now },
      OR: [{ effectiveTo: null }, { effectiveTo: { gt: now } }],
    },
    orderBy: { effectiveFrom: "desc" },
    take: 1,
  });
  const row = rows[0];
  if (!row) throw new Error(`Missing active config: ${key}`);
  return row.configValue as T;
}

function diffObjects(before: any, after: any) {
  if (!before && !after) return null;
  if (!before) return { inserted: after };
  if (!after) return { deleted: before };

  const b = safeJson(before);
  const a = safeJson(after);
  const changes: Record<string, { before: unknown; after: unknown }> = {};

  const keys = new Set<string>([...Object.keys(b ?? {}), ...Object.keys(a ?? {})]);
  for (const k of keys) {
    const bv = (b as any)?.[k];
    const av = (a as any)?.[k];
    if (JSON.stringify(bv) !== JSON.stringify(av)) changes[k] = { before: bv, after: av };
  }
  return Object.keys(changes).length > 0 ? changes : null;
}

async function snapshot(entryId: string) {
  const entry = await prisma.entry.findUnique({
    where: { id: entryId },
    include: {
      inquiry: true,
      guestProfile: true,
      segments: { orderBy: { segmentNumber: "asc" } },
      quotations: { orderBy: { createdAt: "asc" } },
      committedHold: true,
      reservation: true,
      folio: { include: { invoices: true, payments: true, lines: true, writeOffRecords: true } },
      handoffs: { orderBy: { createdAt: "asc" } },
      preArrivalTasks: { orderBy: { createdAt: "asc" } },
      roomAssignments: { orderBy: { createdAt: "asc" }, include: { room: true } },
      timers: { orderBy: { createdAt: "asc" } } as any,
      traceEvents: { orderBy: { createdAt: "asc" } } as any,
    } as any,
  });

  const folioId = (entry as any)?.folio?.id as string | undefined;

  const related = {
    keyReturn: await prisma.keyReturnRecord.findFirst({ where: { entryId }, orderBy: { createdAt: "desc" } }).catch(() => null),
    inspection: await prisma.roomInspectionRecord.findFirst({ where: { entryId }, orderBy: { createdAt: "desc" } }).catch(() => null),
    timers: await prisma.timerRecord.findMany({ where: { entryId }, orderBy: { createdAt: "asc" } }),
    traceTail: await prisma.traceEvent.findMany({ where: { entryId }, orderBy: { createdAt: "desc" }, take: 10 }),
    folioId,
  };

  return safeJson({ entry, related });
}

type StepReport = {
  step: string;
  request: { method: string; path: string; actor: Actor; body?: Json };
  response: { status: number; body: Json };
  dbDiff: Record<string, unknown> | null;
};

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
  const reports: StepReport[] = [];

  // Setup (DB): pick a guest profile from seed so we can create an Inquiry via API.
  const guest = await prisma.guestProfile.findFirstOrThrow({ orderBy: { createdAt: "asc" } });

  // Use "today" arrival to let W4 (pre-arrival activation) fire immediately once workers are running.
  const now = new Date();
  const checkInDate = isoDay(now);
  const checkOutDate = isoDay(new Date(now.getTime() + 86400_000));

  // S1: inquiry -> entry -> availability search -> select -> progress to S2
  const inq = await http<any>("POST", "/inquiries", L1, { guestProfileId: guest.id, sourceChannel: "WALK_IN", notes: "e2e basic flow" });
  if (inq.status !== 201) throw new Error(`Inquiry create failed: ${inq.status}`);
  const inquiryId = (inq.json as any).id as string;

  const entryCreated = await http<any>("POST", "/entries", L1, {
    inquiryId,
    useType: "LEISURE",
    checkInDate,
    checkOutDate,
    guestCount: 1,
    otaSource: false,
  });
  if (entryCreated.status !== 201) throw new Error(`Entry create failed: ${entryCreated.status}`);
  const entryId = (entryCreated.json as any).id as string;

  async function runStep(step: string, req: StepReport["request"]) {
    const before = await snapshot(entryId);
    const resp = await http(req.method, req.path, req.actor, req.body);
    const after = await snapshot(entryId);
    const dbDiff = diffObjects(before, after);
    reports.push({
      step,
      request: req,
      response: { status: resp.status, body: safeJson(resp.json) },
      dbDiff,
    });
    return resp;
  }

  function expectStatus(step: string, got: { status: number; json: unknown }, expected: number) {
    if (got.status !== expected) {
      throw new Error(`${step} failed: expected HTTP ${expected}, got ${got.status} body=${JSON.stringify(safeJson(got.json), null, 2)}`);
    }
  }

  async function runWorkerStep(step: string, workerName: string, run: () => Promise<unknown>) {
    const before = await snapshot(entryId);
    const out = await run();
    const after = await snapshot(entryId);
    const dbDiff = diffObjects(before, after);
    reports.push({
      step,
      request: { method: "WORKER", path: workerName, actor: { id: "SYSTEM", level: "L1" } as any },
      response: { status: 200, body: safeJson(out) as any },
      dbDiff,
    });
  }

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

  await runStep("S1 select availability option", {
    method: "PATCH",
    path: `/availability/configurations/${cfgId}/select`,
    actor: L1,
    body: { roomId: firstRoomId },
  });

  const entryFreshS1 = await http<any>("GET", `/entries/${entryId}`, L1);
  const s1Version = (entryFreshS1.json as any).version as number;

  const toS2 = await runStep("S1->S2 progress-stage", {
    method: "POST",
    path: `/entries/${entryId}/progress-stage`,
    actor: L1,
    body: { targetStage: "S2", version: s1Version },
  });
  expectStatus("S1->S2 progress-stage", toS2, 200);

  // S2: quotation -> send -> accept -> progress to S3
  const q1 = await runStep("S2 create quotation", {
    method: "POST",
    path: `/entries/${entryId}/quotations`,
    actor: L1,
    body: { roomTypeId: null, nightlyRate: 100, currency: "BTN", notes: "e2e quotation" } as any,
  });
  expectStatus("S2 create quotation", q1, 201);
  const quotationId = (q1.json as any).id as string;

  const qSend = await runStep("S2 send quotation", { method: "POST", path: `/quotations/${quotationId}/send`, actor: L1, body: {} });
  expectStatus("S2 send quotation", qSend, 200);
  const qAcc = await runStep("S2 accept quotation", { method: "POST", path: `/quotations/${quotationId}/accept`, actor: L1, body: {} });
  expectStatus("S2 accept quotation", qAcc, 200);

  const entryFreshS2 = await http<any>("GET", `/entries/${entryId}`, L1);
  const s2Version = (entryFreshS2.json as any).version as number;

  const toS3 = await runStep("S2->S3 progress-stage", {
    method: "POST",
    path: `/entries/${entryId}/progress-stage`,
    actor: L1,
    body: { targetStage: "S3", version: s2Version },
  });
  expectStatus("S2->S3 progress-stage", toS3, 200);

  // S3: ensure folio + cancellation disclosure + committed hold + confirm (S4)
  const mkFolio = await runStep("S3 ensure provisional folio + billing model", {
    method: "POST",
    path: `/entries/${entryId}/folio/provisional`,
    actor: L1,
    body: { billingModel: "GUEST_PAY" },
  });
  expectStatus("S3 ensure provisional folio + billing model", mkFolio, 201);

  // Record an advance payment so committed hold policy can pass.
  const entryWithFolioApi = await http<any>("GET", `/entries/${entryId}`, L1);
  const folioIdForPay = (entryWithFolioApi.json as any)?.folio?.id as string | undefined;
  if (!folioIdForPay) throw new Error("Expected folio after S3 setup");
  const pay = await runStep("S3 record advance payment", {
    method: "POST",
    path: `/folios/${folioIdForPay}/payments`,
    actor: L1,
    body: { entryId, amount: 1000, notes: "e2e advance payment" },
  });
  expectStatus("S3 record advance payment", pay, 201);

  const recon = await runStep("S3 reconcile advance payment", {
    method: "POST",
    path: `/folios/${folioIdForPay}/advance-payment/reconcile`,
    actor: L1,
    body: { entryId, note: "e2e reconcile" },
  });
  expectStatus("S3 reconcile advance payment", recon, 200);

  const disclosure = await runStep("S3 cancellation disclosure", {
    method: "POST",
    path: `/entries/${entryId}/disclosures/cancellation`,
    actor: L1,
    body: { noShowTreatmentStatement: "Standard no-show policy", disclosedTerms: { windowHours: 24 } },
  });
  expectStatus("S3 cancellation disclosure", disclosure, 201);

  const cHold = await runStep("S3 committed hold", {
    method: "POST",
    path: `/entries/${entryId}/holds/committed`,
    actor: L1,
    body: { roomId: firstRoomId, commercialJustification: "Basic reservation committed hold" },
  });
  expectStatus("S3 committed hold", cHold, 201);

  const entryFreshS3 = await http<any>("GET", `/entries/${entryId}`, L1);
  const s3Version = (entryFreshS3.json as any).version as number;

  const confirm = await runStep("S3->S4 confirm reservation", {
    method: "POST",
    path: `/entries/${entryId}/confirm`,
    actor: L1,
    body: { version: s3Version },
  });
  expectStatus("S3->S4 confirm reservation", confirm, 200);

  // Wait for W4 to move S4 -> S5. If the background worker doesn't pick up the job quickly,
  // trigger W4 manually (still the same business logic, but executed in-process).
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
    const done = await runStep(`S5 complete pre-arrival task ${t.id}`, { method: "PATCH", path: `/pre-arrival-tasks/${t.id}`, actor: L1, body: { action: "COMPLETE" } });
    expectStatus(`S5 complete pre-arrival task ${t.id}`, done, 200);
  }

  const ra = await runStep("S5 room assignment", {
    method: "POST",
    path: `/entries/${entryId}/room-assignments`,
    actor: L1,
    body: { roomId: firstRoomId, notes: "e2e assign" },
  });
  expectStatus("S5 room assignment", ra, 201);

  // H1 must be accepted + fulfilled before check-in (S5->S6 gate).
  const afterRa = await http<any>("GET", `/entries/${entryId}`, L1);
  const h1 = ((afterRa.json as any)?.handoffs ?? []).find((h: any) => h.handoffType === "H1");
  if (!h1) throw new Error("Expected H1 handoff at S5");

  const checklist = (await getActiveConfigValue<any[]>("handoff.H1.checklist", new Date())) ?? [];
  const checklistCompletion: Record<string, boolean> = {};
  for (const item of checklist) {
    if (item?.mandatory) checklistCompletion[String(item.code)] = true;
  }
  const h1Accept = await runStep("S5 accept H1", { method: "POST", path: `/handoffs/${h1.id}/accept`, actor: L1, body: { checklistCompletion } });
  expectStatus("S5 accept H1", h1Accept, 200);

  const roomAssignmentId = (afterRa.json as any)?.roomAssignments?.[0]?.id as string | undefined;
  if (!roomAssignmentId) throw new Error("Expected roomAssignmentId after room assignment");
  const h1Fulfil = await runStep("S5 fulfil H1", {
    method: "POST",
    path: `/handoffs/${h1.id}/fulfil`,
    actor: L1,
    body: {
      fulfilmentEvidence: {
        roomAssignmentId,
        readinessConfirmed: true,
        paymentStatusConfirmed: true,
        ceilingProximityAddressed: true,
      },
    } as any,
  });
  expectStatus("S5 fulfil H1", h1Fulfil, 200);

  const entryFreshS5 = await http<any>("GET", `/entries/${entryId}`, L1);
  const s5Version = (entryFreshS5.json as any).version as number;

  const toS6 = await runStep("S5->S6 progress-stage (guest present)", {
    method: "POST",
    path: `/entries/${entryId}/progress-stage`,
    actor: L1,
    body: { targetStage: "S6", version: s5Version, guestPhysicallyPresent: true },
  });
  expectStatus("S5->S6 progress-stage (guest present)", toS6, 200);

  // S6: create H2 then complete check-in -> S7
  const entryAfterS6 = await http<any>("GET", `/entries/${entryId}`, L1);
  const roomNumber = ((entryAfterS6.json as any)?.roomAssignments?.[0]?.room?.roomNumber as string | undefined) ?? "101";
  const h2 = await runStep("S6 create H2", {
    method: "POST",
    path: `/entries/${entryId}/handoffs/h2`,
    actor: L1,
    body: { roomNumber, guestProfileId: guest.id, deficientConditionStatus: null },
  });
  expectStatus("S6 create H2", h2, 201);

  // Registration / identity verification gate for S6->S7.
  const docTypes = ((await getActiveConfigValue<any[]>("identity.documentTypes", new Date())) ?? []).filter((d) => d?.isActive !== false);
  const docType = (docTypes[0]?.documentTypeCode as string | undefined) ?? "PASSPORT";
  const verify = await runStep("S6 verify guest identity", {
    method: "POST",
    path: `/guest-profiles/${guest.id}/verify-identity`,
    actor: L1,
    body: {
      entryId,
      verificationPath: "FIRST_TIME",
      documentType: docType,
      documentNumber: `E2E-${Date.now()}`,
      issuingCountry: "BT",
    },
  });
  expectStatus("S6 verify guest identity", verify, 200);

  const entryFreshS6 = await http<any>("GET", `/entries/${entryId}`, L1);
  const s6Version = (entryFreshS6.json as any).version as number;
  const toS7 = await runStep("S6->S7 progress-stage (complete check-in)", {
    method: "POST",
    path: `/entries/${entryId}/progress-stage`,
    actor: L1,
    body: { targetStage: "S7", version: s6Version, transitionData: { keyCount: 2, registrationConfirmed: true } },
  });
  expectStatus("S6->S7 progress-stage (complete check-in)", toS7, 200);

  // S7: night audit for last operating date then exit to S8
  const eS7 = await http<any>("GET", `/entries/${entryId}`, L1);
  const checkout = new Date((eS7.json as any).checkOutDate as string);
  const lastNight = new Date(Date.UTC(checkout.getUTCFullYear(), checkout.getUTCMonth(), checkout.getUTCDate() - 1, 0, 0, 0, 0));
  const na = await runStep("S7 run night audit (last operating date)", { method: "POST", path: "/night-audit/run", actor: L2, body: { operatingDate: lastNight.toISOString() } });
  expectStatus("S7 run night audit (last operating date)", na, 200);

  const h4Create = await runStep("S7 initiate H4", {
    method: "POST",
    path: `/entries/${entryId}/handoffs/h4`,
    actor: L1,
    body: { notes: "e2e pre-checkout handoff" },
  });
  expectStatus("S7 initiate H4", h4Create, 201);

  const entryFreshS7 = await http<any>("GET", `/entries/${entryId}`, L1);
  const s7Version = (entryFreshS7.json as any).version as number;
  const toS8 = await runStep("S7->S8 progress-stage (stay exit)", {
    method: "POST",
    path: `/entries/${entryId}/progress-stage`,
    actor: L1,
    body: { targetStage: "S8", version: s7Version },
  });
  expectStatus("S7->S8 progress-stage (stay exit)", toS8, 200);

  // S8: key return + inspection + fulfil H4 + settle (cash) + progress to S9
  const s8Entry = await http<any>("GET", `/entries/${entryId}`, L1);
  const keysIssued = Number((s8Entry.json as any).keysIssuedCount ?? 2);
  const kr = await runStep("S8 record key return", { method: "POST", path: `/entries/${entryId}/key-return`, actor: L1, body: { keyCountReturned: keysIssued } });
  expectStatus("S8 record key return", kr, 200);
  const insp = await runStep("S8 record room inspection", {
    method: "POST",
    path: `/entries/${entryId}/room-inspection`,
    actor: L1,
    body: { isDeferred: false, deficientFlagStatus: "NOT_APPLICABLE", damageFound: false },
  });
  expectStatus("S8 record room inspection", insp, 200);

  const h4 = await prisma.handoffRecord.findFirstOrThrow({ where: { entryId, handoffType: "H4" }, orderBy: { createdAt: "desc" } });
  const fulfilH4 = await runStep("S8 fulfil H4", {
    method: "POST",
    path: `/handoffs/${h4.id}/fulfil`,
    actor: L1,
    body: { fulfilmentEvidence: { chargesPostedConfirmation: true, roomInspectionStatus: "RECORDED_OR_DEFERRED", damageAssessmentStatus: "COMPLETE_OR_DEFERRED", deficientFlagFinalStatus: "RECORDED" } } as any,
  });
  expectStatus("S8 fulfil H4", fulfilH4, 200);

  const entryWithFolio = await prisma.entry.findUniqueOrThrow({ where: { id: entryId }, include: { folio: true } });
  if (!entryWithFolio.folio) throw new Error("Missing folio");

  const settle = await runStep("S8 settle folio (CASH => SETTLED)", {
    method: "POST",
    path: `/folios/${entryWithFolio.folio.id}/settle`,
    actor: L1,
    body: { settlementMethod: "CASH", paymentVerificationRef: `CASH-${Date.now()}`, billingModelConfirmation: "GUEST_PAY" } as any,
  });
  expectStatus("S8 settle folio (CASH => SETTLED)", settle, 200);

  const entryFreshS8 = await http<any>("GET", `/entries/${entryId}`, L1);
  const s8Version = (entryFreshS8.json as any).version as number;
  const toS9 = await runStep("S8->S9 progress-stage (closure stage)", {
    method: "POST",
    path: `/entries/${entryId}/progress-stage`,
    actor: L1,
    body: { targetStage: "S9", version: s8Version },
  });
  expectStatus("S8->S9 progress-stage (closure stage)", toS9, 200);

  // Ensure invoices are dispatched (closure gate).
  const entryAtS9 = await http<any>("GET", `/entries/${entryId}`, L1);
  const folioId = (entryAtS9.json as any)?.folio?.id as string | undefined;
  if (!folioId) throw new Error("Expected folio at S9");
  const invList = await runStep("S9 list invoices", { method: "GET", path: `/folios/${folioId}/invoices`, actor: L1 });
  expectStatus("S9 list invoices", invList, 200);
  const invoices = (invList.json as any[]) ?? [];
  for (const inv of invoices) {
    if (inv?.state === "DRAFT") {
      const dispatched = await runStep(`S9 dispatch invoice ${inv.id}`, { method: "POST", path: `/invoices/${inv.id}/dispatch`, actor: L1, body: { dispatchedTo: "guest@example.com" } });
      expectStatus(`S9 dispatch invoice ${inv.id}`, dispatched, 200);
    }
  }

  // S9: close
  const close = await runStep("S9 close entry", { method: "POST", path: `/entries/${entryId}/close`, actor: L2 });
  expectStatus("S9 close entry", close, 200);

  const outDir = path.resolve(process.cwd(), "..", "Documentation_V2");
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(
    path.join(outDir, "E2E-basic-s1-to-s9-test-output.json"),
    JSON.stringify({ baseUrl, ranAt: ranAt.toISOString(), entryId, inquiryId, guestProfileId: guest.id, steps: reports }, null, 2),
  );

  const md = [
    "# E2E basic flow report (S1 → S9)",
    "",
    `- **Ran at**: ${ranAt.toISOString()}`,
    `- **Base URL**: \`${baseUrl}\``,
    `- **Entry ID**: \`${entryId}\``,
    `- **Inquiry ID**: \`${inquiryId}\``,
    `- **GuestProfile ID (seeded)**: \`${guest.id}\``,
    "",
    "## Steps",
    "",
    ...reports.flatMap((r) => [
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
      "- **DB changes (diff of snapshots)**:",
      "",
      "```json",
      JSON.stringify(r.dbDiff ?? null, null, 2),
      "```",
      "",
    ]),
  ].join("\n");
  fs.writeFileSync(path.join(outDir, "E2E-basic-s1-to-s9-test-report.md"), md);
}

main()
  .then(() => {
    console.log("E2E basic flow: DONE");
    process.exit(0);
  })
  .catch((e) => {
    console.error("E2E basic flow: FAILED", e);
    process.exit(1);
  });

