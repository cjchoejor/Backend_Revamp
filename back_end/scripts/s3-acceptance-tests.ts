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

  const inq = await http<any>("POST", "/inquiries", L1, { guestProfileId, sourceChannel: "DIRECT" });
  const inquiryId = inq.json?.id as string | undefined;
  if (!inquiryId) throw new Error("Missing inquiryId");

  const entry = await http<any>("POST", "/entries", L1, { inquiryId, useType: "LEISURE" });
  const entryId = entry.json?.id as string | undefined;
  if (!entryId) throw new Error("Missing entryId");

  const avail = await http<any>("POST", `/entries/${entryId}/availability/query`, L1, {
    checkInDate: new Date(Date.now() + 86400_000).toISOString(),
    checkOutDate: new Date(Date.now() + 2 * 86400_000).toISOString(),
  });
  const cfgId = avail.json?.configuration?.id as string | undefined;
  const firstOk = (avail.json?.result?.availableRooms ?? [])[0];
  if (!cfgId || !firstOk?.roomId) throw new Error("Missing configuration/room");
  await http("PATCH", `/availability/configurations/${cfgId}/select`, L1, { roomId: firstOk.roomId });

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

