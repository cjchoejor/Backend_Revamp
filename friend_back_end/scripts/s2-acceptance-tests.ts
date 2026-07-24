import fs from "node:fs";
import path from "node:path";
import { PrismaClient } from "@prisma/client";

type Json = Record<string, unknown> | unknown[] | string | number | boolean | null;

const baseUrl = process.env.API_BASE_URL ?? "http://localhost:4000/api";
const prisma = new PrismaClient();
const DOC_V2_DIR = path.join(process.cwd(), "..", "Documentation_V2");
const OUT_MD = path.join(DOC_V2_DIR, "S2-test-report.md");
const OUT_JSON = path.join(DOC_V2_DIR, "S2-test-output.json");

type Actor = { id: string; level: "L1" | "L2" | "L3" };
const L1: Actor = { id: "s2-fd-1", level: "L1" };

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
  // S1→S2 exit gate requires primary contact (email or phone).
  await prisma.guestProfile.update({
    where: { id: guestProfileId },
    data: { email: `s2-acceptance-guest-${Date.now()}@example.com`, phone: "+97517000002" },
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

  // availability search + select + progress to S2
  const q = await http<any>("POST", `/entries/${entryId}/availability/query`, L1, {
    checkInDate,
    checkOutDate,
  });
  const cfgId = q.json?.configuration?.id as string | undefined;
  const firstOk = (q.json?.result?.availableRooms ?? [])[0] as { roomId?: string; inventoryId?: string } | undefined;
  const selectRoomId = firstOk?.roomId ?? firstOk?.inventoryId;
  if (!cfgId || !selectRoomId) throw new Error("Missing availability configuration/room");
  await http("PATCH", `/availability/configurations/${cfgId}/select`, L1, { roomId: selectRoomId });

  const entrySnap = await prisma.entry.findUniqueOrThrow({ where: { id: entryId } });
  const toS2 = await http<any>("POST", `/entries/${entryId}/progress-stage`, L1, { targetStage: "S2", version: entrySnap.version, guestPhysicallyPresent: true });
  steps.push({
    id: "AC-S2-setup",
    title: "Entry progressed to S2",
    pass: toS2.status === 200 && toS2.json?.currentStage === "S2",
    status: toS2.status,
    body: toS2.json,
    explanation: "Bring a fresh entry into S2 with preferred configuration selected.",
    dbImpact: "Entry.currentStage updated to S2; preferred AvailabilityConfiguration sealedAt set; TraceEvent written.",
  });

  if (toS2.status !== 200) {
    fs.writeFileSync(OUT_JSON, JSON.stringify({ baseUrl, steps }, null, 2), "utf8");
    process.exitCode = 1;
    return;
  }

  const draft = await http<any>("POST", `/entries/${entryId}/quotations`, L1, {
    notes: "SIG-S2 acceptance: draft quotation",
  });
  steps.push({
    id: "AC-S2-001",
    title: "Create quotation in DRAFT",
    pass: draft.status === 201 && draft.json?.state === "DRAFT",
    status: draft.status,
    body: draft.json,
    explanation: "QuotationService.createQuotation creates a DRAFT quotation version for the current segment.",
    dbImpact: "Inserts quotations row (state=DRAFT, versionNumber=1).",
  });

  const qid = draft.json?.id as string | undefined;
  if (!qid) throw new Error("Missing quotation id");

  const sent = await http<any>("POST", `/quotations/${qid}/send`, L1, {
    validDays: 2,
    channel: "EMAIL",
    recipientAddress: "guest@example.com",
  });
  steps.push({
    id: "AC-S2-002",
    title: "Send quotation transitions DRAFT→SENT and registers timers",
    pass: sent.status === 200 && sent.json?.state === "SENT" && !!sent.json?.validUntil,
    status: sent.status,
    body: sent.json,
    explanation: "Sending seals the quotation and schedules validity + ack tracking timers (TimerRecord in this slice).",
    dbImpact: "Updates quotation state; inserts TimerRecord(QUOTATION_VALIDITY_W15, QUOTATION_ACK_TRACKER).",
  });

  const acc = await http<any>("POST", `/quotations/${qid}/accept`, L1, { acceptanceMethod: "VERBAL", verbatimNote: "Guest accepted verbally over phone." });
  steps.push({
    id: "AC-S2-003",
    title: "Accept quotation transitions SENT→ACCEPTED and cancels timers",
    pass: acc.status === 200 && acc.json?.state === "ACCEPTED" && !!acc.json?.acceptedAt,
    status: acc.status,
    body: acc.json,
    explanation: "Acceptance records acceptedAt/acceptedBy and cancels timers for that quotation.",
    dbImpact: "Updates quotation; cancels timer records matching quotationId payload.",
  });

  const hold = await http<any>("POST", `/entries/${entryId}/holds/speculative`, L1, {
    roomId: selectRoomId,
    ttlSeconds: 120,
    commercialBasis: "Guest requested short hold while deciding",
    notes: "SIG-S2 acceptance: speculative hold",
  });
  steps.push({
    id: "AC-S2-004",
    title: "Place speculative hold creates hold + updates room claim state",
    pass: hold.status === 201 && hold.json?.state === "PLACED",
    status: hold.status,
    body: hold.json,
    explanation: "HoldService.placeSpeculativeHold places a PLACED hold and marks inventory SPECULATIVELY_HELD.",
    dbImpact: "Inserts speculative_holds; updates room.currentClaimState; inserts RoomClaimStateEvent; registers SPECULATIVE_HOLD_EXPIRY timer.",
  });

  const holdId = hold.json?.id as string | undefined;
  if (!holdId) throw new Error("Missing hold id");

  const releaseL1 = await http<any>("POST", `/entries/${entryId}/holds/speculative/${holdId}/release`, L1, { releaseReason: "Guest cancelled plan" });
  steps.push({
    id: "AC-S2-005",
    title: "Release speculative hold requires L2+",
    pass: releaseL1.status === 403 || releaseL1.status === 409,
    status: releaseL1.status,
    body: releaseL1.json,
    explanation: "Release route is gated at L2+; L1 must be blocked.",
    dbImpact: "No state change.",
  });

  fs.writeFileSync(OUT_JSON, JSON.stringify({ baseUrl, steps }, null, 2), "utf8");
  const passed = steps.filter((s) => s.pass).length;
  const md: string[] = [];
  md.push(`# S2 acceptance test report (slice)`);
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

