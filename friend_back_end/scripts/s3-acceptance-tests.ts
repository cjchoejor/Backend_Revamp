import fs from "node:fs";
import path from "node:path";
import { PrismaClient } from "@prisma/client";

type Json = Record<string, unknown> | unknown[] | string | number | boolean | null;

const baseUrl = process.env.API_BASE_URL ?? "http://localhost:4000/api";
const prisma = new PrismaClient();
const DOC_V2_DIR = path.join(process.cwd(), "..", "Documentation_V2");
const OUT_MD = path.join(DOC_V2_DIR, "S3-test-report.md");
const OUT_JSON = path.join(DOC_V2_DIR, "S3-test-output.json");

type Actor = { id: string; level: "L1" | "L2" | "L3" };
const L1: Actor = { id: "s3-fd-1", level: "L1" };
const L2: Actor = { id: "s3-fom-1", level: "L2" };

function headers(actor: Actor) {
  return { "content-type": "application/json", "x-actor-id": actor.id, "x-actor-level": actor.level };
}

async function http<T = Json>(method: string, p: string, actor: Actor, body?: Json) {
  const res = await fetch(`${baseUrl}${p}`, { method, headers: headers(actor), body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let json: any = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = text;
  }
  return { status: res.status, json: json as T };
}

function ensureDir(p: string) {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}

type Step = { id: string; title: string; pass: boolean; status: number; body: any; explanation: string; dbImpact: string };

async function main() {
  ensureDir(DOC_V2_DIR);
  const steps: Step[] = [];

  const guestProfileId = (await prisma.guestProfile.findFirst({ orderBy: { createdAt: "desc" }, select: { id: true } }))?.id;
  if (!guestProfileId) throw new Error("No guest profile found");
  await prisma.guestProfile.update({
    where: { id: guestProfileId },
    data: { email: `s3-acceptance-guest-${Date.now()}@example.com`, phone: "+97517000003" },
  });

  const inq = await http<any>("POST", "/inquiries", L1, { guestProfileId, sourceChannel: "DIRECT" });
  const inquiryId = inq.json?.id as string | undefined;
  if (!inquiryId) throw new Error("Missing inquiryId");

  const checkInDate = new Date(Date.now() + 86400_000).toISOString();
  const checkOutDate = new Date(Date.now() + 2 * 86400_000).toISOString();

  const entry = await http<any>("POST", "/entries", L1, {
    inquiryId,
    useType: "LEISURE",
    guestCount: 1,
    checkInDate,
    checkOutDate,
  });
  const entryId = entry.json?.id as string | undefined;
  if (!entryId) throw new Error("Missing entryId");

  const avail = await http<any>("POST", `/entries/${entryId}/availability/query`, L1, {
    checkInDate,
    checkOutDate,
  });
  const cfgId = avail.json?.configuration?.id as string | undefined;
  const firstOk = (avail.json?.result?.availableRooms ?? [])[0] as { roomId?: string; inventoryId?: string } | undefined;
  const selectRoomId = firstOk?.roomId ?? firstOk?.inventoryId;
  if (!cfgId || !selectRoomId) throw new Error("Missing configuration/room");
  await http("PATCH", `/availability/configurations/${cfgId}/select`, L1, { roomId: selectRoomId });

  const e1 = await prisma.entry.findUniqueOrThrow({ where: { id: entryId } });
  const toS2 = await http<any>("POST", `/entries/${entryId}/progress-stage`, L1, { targetStage: "S2", version: e1.version, guestPhysicallyPresent: true });
  const e2 = await prisma.entry.findUniqueOrThrow({ where: { id: entryId } });

  const draft = await http<any>("POST", `/entries/${entryId}/quotations`, L1, { commercialTerms: { nightlyRate: 500 }, totalAmount: 1000 });
  const qid = draft.json?.id as string | undefined;
  if (!qid) throw new Error("Missing quotation id");
  await http("POST", `/quotations/${qid}/send`, L1, { validDays: 2, sentTo: "guest@example.com" });
  await http("POST", `/quotations/${qid}/accept`, L1, {});

  const toS3 = await http<any>("POST", `/entries/${entryId}/progress-stage`, L1, { targetStage: "S3", version: e2.version, guestPhysicallyPresent: true });
  steps.push({
    id: "AC-S3-setup",
    title: "Progress S2→S3 requires accepted quotation",
    pass: toS3.status === 200 && toS3.json?.currentStage === "S3",
    status: toS3.status,
    body: toS3.json,
    explanation: "S3 entry requires accepted quotation from S2.",
    dbImpact: "Updates Entry.currentStage to S3.",
  });

  const folio = await http<any>("POST", `/entries/${entryId}/folio/provisional`, L1, { billingModel: "GUEST_PAY" });
  steps.push({
    id: "AC-S3-002-ish",
    title: "Create provisional folio + billing model transition + proforma invoice",
    pass: folio.status === 201 && folio.json?.state === "PROVISIONAL" && Array.isArray(folio.json?.invoices) && folio.json.invoices.length > 0,
    status: folio.status,
    body: folio.json,
    explanation: "S3 setup creates/retrieves PROVISIONAL folio, fixes billing model, writes BillingModelTransitionRecord, and issues a PROFORMA invoice.",
    dbImpact: "Creates Folio (if absent), BillingModelTransitionRecord, and Invoice(invoiceType=PROFORMA).",
  });

  await http("POST", `/entries/${entryId}/disclosures/cancellation`, L1, {
    noShowTreatmentStatement: "No-show: charge 1 night",
    disclosedTerms: { noShow: true },
  });
  const folioId = (await prisma.folio.findUniqueOrThrow({ where: { entryId } })).id;
  const payIn = await http<any>("POST", `/folios/${folioId}/payments`, L1, { entryId, amount: 100, notes: "S3 inbound advance slice" });
  steps.push({
    id: "AC-S3-003",
    title: "Record folio payment at S3 (Policy 27 inbound slice)",
    pass: payIn.status === 201 && !!payIn.json?.id,
    status: payIn.status,
    body: payIn.json,
    explanation: "Advance payment recorded against provisional folio while entry remains at S3.",
    dbImpact: "Inserts PaymentRecord; may schedule advance-payment follow-up timers per config.",
  });

  const hold = await http<any>("POST", `/entries/${entryId}/holds/committed`, L1, {
    roomId: selectRoomId,
    commercialJustification: "SIG-S3 acceptance: committed hold at S3",
  });
  steps.push({
    id: "AC-S3-004",
    title: "Place committed hold at S3 (disclosure + folio + advance satisfied)",
    pass: hold.status === 201 && hold.json?.state === "PLACED",
    status: hold.status,
    body: hold.json,
    explanation: "Committed hold placement requires cancellation disclosure, folio, and advance/credit gate per hold-service.",
    dbImpact: "Inserts committed_holds; room COMMITTED_HELD; schedules COMMITTED_HOLD_EXPIRY_W3 when configured.",
  });

  const payStatus = await http<any>("GET", `/entries/${entryId}/payment-status`, L1);
  steps.push({
    id: "AC-S3-005",
    title: "GET payment-status reflects folio advance evaluation",
    pass: payStatus.status === 200 && typeof payStatus.json === "object" && payStatus.json !== null && "satisfied" in payStatus.json,
    status: payStatus.status,
    body: payStatus.json,
    explanation: "Payment status endpoint exposes evaluateAdvancePaymentCondition for UI / downstream gates.",
    dbImpact: "Read-only evaluation; no row writes.",
  });

  const l1Reentry = await http<any>("POST", `/entries/${entryId}/re-entry/s2`, L1, { reason: "Should be denied" });
  const l1Blocked =
    (l1Reentry.status === 403 && l1Reentry.json?.error === "AuthorizationError") ||
    (l1Reentry.status === 409 && l1Reentry.json?.blockingCondition === "AUTH_REQUIRED_L2");
  steps.push({
    id: "AC-S3-006",
    title: "S3→S2 re-entry requires L2+ (L1 blocked)",
    pass: l1Blocked,
    status: l1Reentry.status,
    body: l1Reentry.json,
    explanation: "SIG-S3 back-flow is FOM-gated; route may return 403 (middleware) or 409 AUTH_REQUIRED_L2 (policy) depending on wiring.",
    dbImpact: "No transition; no segment seal.",
  });

  const l2Reentry = await http<any>("POST", `/entries/${entryId}/re-entry/s2`, L2, { reason: "Guest requested rate renegotiation" });
  steps.push({
    id: "AC-S3-007",
    title: "S3→S2 re-entry succeeds for L2 with renegotiation context",
    pass: l2Reentry.status === 200 && l2Reentry.json?.entry?.currentStage === "S2" && l2Reentry.json?.renegotiationContext != null,
    status: l2Reentry.status,
    body: l2Reentry.json,
    explanation: "FOM initiates S3→S2: segment sealed, new S2 segment, dwell sealed, committed hold retained per state machine.",
    dbImpact: "Seals S3 segment; creates S2 segment; updates Entry.currentStage; trace ENTRY.REENTRY_S3_TO_S2.",
  });

  fs.writeFileSync(OUT_JSON, JSON.stringify({ baseUrl, steps }, null, 2), "utf8");
  const passed = steps.filter((s) => s.pass).length;
  const md: string[] = [];
  md.push(`# S3 acceptance test report (slice)`);
  md.push(``);
  md.push(`- Base URL: \`${baseUrl}\``);
  md.push(`- Passed: **${passed}/${steps.length}**`);
  md.push(``);
  md.push(`## Steps`);
  for (const s of steps) {
    md.push(``);
    md.push(`### ${s.id} — ${s.title}`);
    md.push(`- **Pass**: ${s.pass ? "YES" : "NO"}`);
    md.push(`- **HTTP**: ${s.status}`);
    md.push(`- **What is happening**: ${s.explanation}`);
    md.push(`- **Database (PostgreSQL)**: ${s.dbImpact}`);
    md.push(`- **Response (truncated)**: \`${JSON.stringify(s.body).slice(0, 800)}\``);
  }
  fs.writeFileSync(OUT_MD, md.join("\n"), "utf8");
  process.stdout.write(`Wrote ${path.relative(process.cwd(), OUT_MD)} and ${path.relative(process.cwd(), OUT_JSON)}\n`);
  if (passed !== steps.length) process.exitCode = 1;
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

