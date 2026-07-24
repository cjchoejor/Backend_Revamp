import { prisma } from "../src/db.js";
import * as fs from "node:fs";
import * as path from "node:path";
import { createTimerEngine } from "../src/lib/timer-engine.js";
import { runPreArrivalWindowActivationWorker } from "../src/workers/w4-pre-arrival-window-activation-worker.js";

type Json = Record<string, unknown> | unknown[] | string | number | boolean | null;

const baseUrl = process.env.API_BASE_URL ?? "http://localhost:4000/api";

type Actor = { id: string; level: "L1" | "L2" | "L3" };
const L1: Actor = { id: "e2e-fd-8", level: "L1" };
const L2: Actor = { id: "e2e-fom-8", level: "L2" };
const L3: Actor = { id: "e2e-gm-8", level: "L3" };

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

type StepReport = {
  step: string;
  request: { method: string; path: string; actor: Actor; body?: Json };
  response: { status: number; body: Json };
};

function expectStatus(step: string, got: { status: number; json: unknown }, expected: number) {
  if (got.status !== expected) throw new Error(`${step} failed: expected ${expected} got ${got.status} body=${JSON.stringify(safeJson(got.json), null, 2)}`);
}

async function waitForStage(entryId: string, stage: string, timeoutMs = 30_000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const r = await http<any>("GET", `/entries/${entryId}`, L1);
    if ((r.json as any)?.currentStage === stage) return r.json;
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

  // S1 -> S3 skeleton
  const inq = await runStep("S1 create inquiry", { method: "POST", path: "/inquiries", actor: L1, body: { guestProfileId: guest.id, sourceChannel: "WALK_IN", notes: "e2e outstanding writeoff close" } });
  expectStatus("S1 create inquiry", inq, 201);
  const inquiryId = (inq.json as any).id as string;
  const entryCreated = await runStep("S1 create entry", { method: "POST", path: "/entries", actor: L1, body: { inquiryId, useType: "LEISURE", checkInDate, checkOutDate, guestCount: 1, otaSource: false } });
  expectStatus("S1 create entry", entryCreated, 201);
  const entryId = (entryCreated.json as any).id as string;
  const avail = await runStep("S1 availability search", { method: "POST", path: "/availability/search", actor: L1, body: { entryId, checkInDate, checkOutDate, guestCount: 1, useType: "LEISURE" } });
  expectStatus("S1 availability search", avail, 200);
  const cfgId = (avail.json as any).configurationId as string;
  const results = (avail.json as any).results as any;
  const roomId = (results?.availableRooms?.[0]?.roomId ?? results?.deficientRooms?.[0]?.roomId) as string | undefined;
  if (!roomId) throw new Error("No roomId found");
  expectStatus("S1 select availability option", await runStep("S1 select availability option", { method: "PATCH", path: `/availability/configurations/${cfgId}/select`, actor: L1, body: { roomId } }), 200);
  const e1 = await http<any>("GET", `/entries/${entryId}`, L1);
  expectStatus("S1->S2 progress-stage", await runStep("S1->S2 progress-stage", { method: "POST", path: `/entries/${entryId}/progress-stage`, actor: L1, body: { targetStage: "S2", version: (e1.json as any).version } }), 200);

  const q = await runStep("S2 create quotation", { method: "POST", path: `/entries/${entryId}/quotations`, actor: L1, body: { nightlyRate: 100, currency: "BTN", notes: "quote" } as any });
  expectStatus("S2 create quotation", q, 201);
  const qid = (q.json as any).id as string;
  expectStatus("S2 send quotation", await runStep("S2 send quotation", { method: "POST", path: `/quotations/${qid}/send`, actor: L1, body: {} }), 200);
  expectStatus("S2 accept quotation", await runStep("S2 accept quotation", { method: "POST", path: `/quotations/${qid}/accept`, actor: L1, body: {} }), 200);
  const e2 = await http<any>("GET", `/entries/${entryId}`, L1);
  expectStatus("S2->S3 progress-stage", await runStep("S2->S3 progress-stage", { method: "POST", path: `/entries/${entryId}/progress-stage`, actor: L1, body: { targetStage: "S3", version: (e2.json as any).version } }), 200);

  // S3 setup to S4
  expectStatus("S3 ensure provisional folio + billing model", await runStep("S3 ensure provisional folio + billing model", { method: "POST", path: `/entries/${entryId}/folio/provisional`, actor: L1, body: { billingModel: "GUEST_PAY" } }), 201);
  const e3 = await http<any>("GET", `/entries/${entryId}`, L1);
  const folioId = (e3.json as any)?.folio?.id as string;
  expectStatus("S3 record advance payment", await runStep("S3 record advance payment", { method: "POST", path: `/folios/${folioId}/payments`, actor: L1, body: { entryId, amount: 500, notes: "advance" } }), 201);
  expectStatus("S3 reconcile advance payment", await runStep("S3 reconcile advance payment", { method: "POST", path: `/folios/${folioId}/advance-payment/reconcile`, actor: L1, body: { entryId, note: "reconcile" } }), 200);
  expectStatus("S3 cancellation disclosure", await runStep("S3 cancellation disclosure", { method: "POST", path: `/entries/${entryId}/disclosures/cancellation`, actor: L1, body: { noShowTreatmentStatement: "terms", disclosedTerms: { windowHours: 24 } } }), 201);
  expectStatus("S3 committed hold", await runStep("S3 committed hold", { method: "POST", path: `/entries/${entryId}/holds/committed`, actor: L1, body: { roomId, commercialJustification: "hold" } }), 201);
  const e4 = await http<any>("GET", `/entries/${entryId}`, L1);
  expectStatus("S3->S4 confirm reservation", await runStep("S3->S4 confirm reservation", { method: "POST", path: `/entries/${entryId}/confirm`, actor: L1, body: { version: (e4.json as any).version } }), 200);

  // Activate to S5
  try {
    await waitForStage(entryId, "S5", 10_000);
  } catch {
    const timer = await prisma.timerRecord.findFirst({ where: { entryId, status: "SCHEDULED", OR: [{ timerCode: "PRE_ARRIVAL_COUNTDOWN_W4" }, { timerType: "PRE_ARRIVAL_COUNTDOWN_W4" }] }, orderBy: { createdAt: "desc" } });
    if (!timer) throw new Error("Missing W4 timer");
    const conn = process.env.DATABASE_URL;
    if (!conn) throw new Error("DATABASE_URL required");
    const engine = createTimerEngine(conn);
    await engine.start();
    await runWorkerStep("W4 pre-arrival activation (manual trigger)", "PRE_ARRIVAL_COUNTDOWN_W4", async () => runPreArrivalWindowActivationWorker(prisma, engine, { entryId, timerRecordId: timer.id }));
    await engine.stop();
    await waitForStage(entryId, "S5", 10_000);
  }

  // Complete tasks + assign room + accept/fulfil H1 + progress S5->S6, then S6->S7
  const s5 = await http<any>("GET", `/entries/${entryId}`, L1);
  for (const t of ((s5.json as any).preArrivalTasks ?? []) as any[]) {
    expectStatus(`S5 complete pre-arrival task ${t.id}`, await runStep(`S5 complete pre-arrival task ${t.id}`, { method: "PATCH", path: `/pre-arrival-tasks/${t.id}`, actor: L1, body: { action: "COMPLETE" } }), 200);
  }
  expectStatus("S5 room assignment", await runStep("S5 room assignment", { method: "POST", path: `/entries/${entryId}/room-assignments`, actor: L1, body: { roomId, notes: "assign" } }), 201);
  const s5b = await http<any>("GET", `/entries/${entryId}`, L1);
  const h1 = ((s5b.json as any).handoffs ?? []).find((h: any) => h.handoffType === "H1");
  if (!h1) throw new Error("Missing H1");
  const checklist = ((await prisma.configurationEntry.findMany({ where: { configKey: "handoff.H1.checklist" }, orderBy: { effectiveFrom: "desc" }, take: 1 }))[0]?.configValue as any[]) ?? [];
  const completion: Record<string, boolean> = {};
  for (const item of checklist) if (item?.mandatory) completion[String(item.code)] = true;
  expectStatus("S5 accept H1", await runStep("S5 accept H1", { method: "POST", path: `/handoffs/${h1.id}/accept`, actor: L1, body: { checklistCompletion: completion } }), 200);
  const raId = (s5b.json as any)?.roomAssignments?.[0]?.id as string;
  expectStatus("S5 fulfil H1", await runStep("S5 fulfil H1", { method: "POST", path: `/handoffs/${h1.id}/fulfil`, actor: L1, body: { fulfilmentEvidence: { roomAssignmentId: raId, readinessConfirmed: true, paymentStatusConfirmed: true, ceilingProximityAddressed: true } } as any }), 200);
  const s5c = await http<any>("GET", `/entries/${entryId}`, L1);
  expectStatus("S5->S6 progress-stage", await runStep("S5->S6 progress-stage", { method: "POST", path: `/entries/${entryId}/progress-stage`, actor: L1, body: { targetStage: "S6", version: (s5c.json as any).version, guestPhysicallyPresent: true } }), 200);

  expectStatus("S6 create H2", await runStep("S6 create H2", { method: "POST", path: `/entries/${entryId}/handoffs/h2`, actor: L1, body: { roomNumber: "401", guestProfileId: guest.id, deficientConditionStatus: null } }), 201);
  const docTypes = (await prisma.configurationEntry.findMany({ where: { configKey: "identity.documentTypes" }, orderBy: { effectiveFrom: "desc" }, take: 1 }))[0]?.configValue as any[];
  const docType = (docTypes?.find((d) => d?.isActive !== false)?.documentTypeCode as string) ?? "PASSPORT";
  expectStatus("S6 verify guest identity", await runStep("S6 verify guest identity", { method: "POST", path: `/guest-profiles/${guest.id}/verify-identity`, actor: L1, body: { entryId, verificationPath: "FIRST_TIME", documentType: docType, documentNumber: `E2E-${Date.now()}`, issuingCountry: "BT" } }), 200);
  const s6 = await http<any>("GET", `/entries/${entryId}`, L1);
  expectStatus("S6->S7 progress-stage", await runStep("S6->S7 progress-stage", { method: "POST", path: `/entries/${entryId}/progress-stage`, actor: L1, body: { targetStage: "S7", version: (s6.json as any).version, transitionData: { keyCount: 2, registrationConfirmed: true } } as any }), 200);

  // S7 night audit + H4 + progress to S8
  const s7 = await http<any>("GET", `/entries/${entryId}`, L1);
  const co = new Date((s7.json as any).checkOutDate as string);
  const lastNight = new Date(Date.UTC(co.getUTCFullYear(), co.getUTCMonth(), co.getUTCDate() - 1, 0, 0, 0, 0));
  expectStatus("S7 run night audit", await runStep("S7 run night audit", { method: "POST", path: "/night-audit/run", actor: L2, body: { operatingDate: lastNight.toISOString() } }), 200);
  expectStatus("S7 initiate H4", await runStep("S7 initiate H4", { method: "POST", path: `/entries/${entryId}/handoffs/h4`, actor: L1, body: { notes: "h4" } }), 201);
  const s7b2 = await http<any>("GET", `/entries/${entryId}`, L1);
  expectStatus("S7->S8 progress-stage", await runStep("S7->S8 progress-stage", { method: "POST", path: `/entries/${entryId}/progress-stage`, actor: L1, body: { targetStage: "S8", version: (s7b2.json as any).version } }), 200);

  // S8: key return + inspection + fulfil H4
  expectStatus("S8 key return", await runStep("S8 key return", { method: "POST", path: `/entries/${entryId}/key-return`, actor: L1, body: { keyCountReturned: 2 } }), 200);
  expectStatus("S8 inspection", await runStep("S8 inspection", { method: "POST", path: `/entries/${entryId}/room-inspection`, actor: L1, body: { isDeferred: false, deficientFlagStatus: "NOT_APPLICABLE", damageFound: false } as any }), 200);
  const h4 = await prisma.handoffRecord.findFirstOrThrow({ where: { entryId, handoffType: "H4" }, orderBy: { createdAt: "desc" } });
  expectStatus("S8 fulfil H4", await runStep("S8 fulfil H4", { method: "POST", path: `/handoffs/${h4.id}/fulfil`, actor: L1, body: { fulfilmentEvidence: { chargesPostedConfirmation: true, roomInspectionStatus: "RECORDED_OR_DEFERRED", damageAssessmentStatus: "COMPLETE_OR_DEFERRED", deficientFlagFinalStatus: "RECORDED" } } as any }), 200);

  // Force an OUTSTANDING settlement path via DIRECT_BILL (creates invoice DISPATCHED).
  expectStatus("S8 settle DIRECT_BILL (OUTSTANDING)", await runStep("S8 settle DIRECT_BILL (OUTSTANDING)", { method: "POST", path: `/folios/${folioId}/settle`, actor: L1, body: { settlementMethod: "DIRECT_BILL", billingModelConfirmation: "GUEST_PAY" } as any }), 200);

  const s8 = await http<any>("GET", `/entries/${entryId}`, L1);
  expectStatus("S8->S9 progress-stage", await runStep("S8->S9 progress-stage", { method: "POST", path: `/entries/${entryId}/progress-stage`, actor: L1, body: { targetStage: "S9", version: (s8.json as any).version } }), 200);

  // H5 may exist; fulfil it.
  const h5 = await prisma.handoffRecord.findFirst({ where: { entryId, handoffType: "H5" }, orderBy: { createdAt: "desc" } });
  if (h5) {
    expectStatus("S9 fulfil H5", await runStep("S9 fulfil H5", { method: "POST", path: `/handoffs/${h5.id}/fulfil`, actor: L1, body: { fulfilmentEvidence: { resolutionBasis: "WRITE_OFF" } } as any }), 200);
  }

  // Write off at S9: requires L3 and OUTSTANDING folio.
  expectStatus("S9 write-off", await runStep("S9 write-off", { method: "POST", path: `/folios/${folioId}/write-off`, actor: L3, body: { amount: 10, reason: "Small remainder write-off" } as any }), 200);

  // Dispatch any DRAFT invoices
  const inv = await runStep("S9 list invoices", { method: "GET", path: `/folios/${folioId}/invoices`, actor: L1 });
  expectStatus("S9 list invoices", inv, 200);
  for (const i of (inv.json as any[]) ?? []) {
    if (i?.state === "DRAFT") {
      expectStatus(`S9 dispatch invoice ${i.id}`, await runStep(`S9 dispatch invoice ${i.id}`, { method: "POST", path: `/invoices/${i.id}/dispatch`, actor: L1, body: { dispatchedTo: "billing@example.com" } }), 200);
    }
  }

  expectStatus("S9 close entry", await runStep("S9 close entry", { method: "POST", path: `/entries/${entryId}/close`, actor: L2 }), 200);

  const outDir = path.resolve(process.cwd(), "..", "Documentation_V2", "test");
  fs.mkdirSync(outDir, { recursive: true });
  const outMd = path.join(outDir, "E2E-outstanding-writeoff-close.no-db.md");

  const md = [
    "# E2E outstanding + write-off + close — no DB diffs",
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
    console.error("E2E outstanding write-off close: FAILED", e);
    process.exit(1);
  });

