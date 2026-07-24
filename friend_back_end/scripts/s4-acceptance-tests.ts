import fs from "node:fs";
import path from "node:path";
import { PrismaClient } from "@prisma/client";

type Json = Record<string, unknown> | unknown[] | string | number | boolean | null;

const baseUrl = process.env.API_BASE_URL ?? "http://localhost:4000/api";
const prisma = new PrismaClient();
const DOC_V2_DIR = path.join(process.cwd(), "..", "Documentation_V2");
const OUT_MD = path.join(DOC_V2_DIR, "S4-test-report.md");
const OUT_JSON = path.join(DOC_V2_DIR, "S4-test-output.json");

type Actor = { id: string; level: "L1" | "L2" | "L3" };
const L1: Actor = { id: "s4-fd-1", level: "L1" };

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
    data: { email: `s4-acceptance-guest-${Date.now()}@example.com`, phone: "+97517000004" },
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
  const roomsList = (avail.json?.result?.availableRooms ?? []) as { roomId?: string; inventoryId?: string }[];
  const selectRoomId = (roomsList[0]?.roomId ?? roomsList[0]?.inventoryId) as string | undefined;
  if (!cfgId || !selectRoomId) throw new Error("Missing configuration/room");
  await http("PATCH", `/availability/configurations/${cfgId}/select`, L1, { roomId: selectRoomId });

  const e1 = await prisma.entry.findUniqueOrThrow({ where: { id: entryId } });
  await http("POST", `/entries/${entryId}/progress-stage`, L1, { targetStage: "S2", version: e1.version, guestPhysicallyPresent: true });

  const q = await http<any>("POST", `/entries/${entryId}/quotations`, L1, { notes: "S4 setup quotation" });
  const qid = q.json?.id as string | undefined;
  if (!qid) throw new Error("Missing quotation id");
  await http("POST", `/quotations/${qid}/send`, L1, { validDays: 2, channel: "EMAIL", recipientAddress: "guest@example.com" });
  await http("POST", `/quotations/${qid}/accept`, L1, { acceptanceMethod: "VERBAL", verbatimNote: "Guest accepted verbally." });

  const e2 = await prisma.entry.findUniqueOrThrow({ where: { id: entryId } });
  await http("POST", `/entries/${entryId}/progress-stage`, L1, { targetStage: "S3", version: e2.version, guestPhysicallyPresent: true });

  await http("POST", `/entries/${entryId}/folio/provisional`, L1, { billingModel: "GUEST_PAY" });

  await http("POST", `/entries/${entryId}/disclosures/cancellation`, L1, {
    noShowTreatmentStatement: "No-show: charge 1 night",
    disclosedTerms: { noShow: true },
  });
  const folioId = (await prisma.folio.findUniqueOrThrow({ where: { entryId } })).id;
  await http("POST", `/folios/${folioId}/payments`, L1, { entryId, amount: 100, notes: "Advance deposit" });

  const eS3 = await prisma.entry.findUniqueOrThrow({ where: { id: entryId } });
  const noHoldConfirm = await http<any>("POST", `/entries/${entryId}/confirm`, L1, { version: eS3.version });
  steps.push({
    id: "AC-S4-002",
    title: "Confirm rejected without committed hold (readiness gate)",
    pass: noHoldConfirm.status === 409 && noHoldConfirm.json?.blockingCondition === "MISSING_COMMITTED_HOLD",
    status: noHoldConfirm.status,
    body: noHoldConfirm.json,
    explanation: "p40-s4-confirmation-readiness-gates: enforceCommittedHoldReadyForS4Confirmation before transaction.",
    dbImpact: "No reservation row; entry remains S3.",
  });

  const payStatus = await http<any>("GET", `/entries/${entryId}/payment-status`, L1);
  steps.push({
    id: "AC-S4-003",
    title: "GET payment-status at S3 (advance evaluation)",
    pass: payStatus.status === 200 && payStatus.json?.satisfied === true,
    status: payStatus.status,
    body: payStatus.json,
    explanation: "Folio advance threshold evaluation exposed for S3 confirmation readiness (Policy 42 slice).",
    dbImpact: "Read-only; no writes.",
  });

  await http("POST", `/entries/${entryId}/holds/committed`, L1, {
    roomId: selectRoomId,
    commercialJustification: "Ready to confirm",
  });

  const eProg = await prisma.entry.findUniqueOrThrow({ where: { id: entryId } });
  const viaProgress = await http<any>("POST", `/entries/${entryId}/progress-stage`, L1, {
    targetStage: "S4",
    version: eProg.version,
    guestPhysicallyPresent: true,
  });
  steps.push({
    id: "AC-S4-001-ish",
    title: "POST progress-stage target S4 confirms reservation (delegated confirm path)",
    pass: viaProgress.status === 200 && !!viaProgress.json?.reservation?.id && viaProgress.json?.entry?.currentStage === "S4",
    status: viaProgress.status,
    body: viaProgress.json,
    explanation: "reservationsRouter: targetStage S4 calls reservationService.confirmReservation — primary happy-path confirm for this slice.",
    dbImpact: "Creates Reservation; confirms hold; H1 + comms slice per s4-confirmation-service.",
  });

  const eDup = await prisma.entry.findUniqueOrThrow({ where: { id: entryId } });
  const dupConfirm = await http<any>("POST", `/entries/${entryId}/confirm`, L1, { version: eDup.version });
  steps.push({
    id: "AC-S4-004",
    title: "Second confirm when already at S4 is rejected",
    pass: dupConfirm.status === 409 && (dupConfirm.json?.blockingCondition === "NOT_AT_S3" || dupConfirm.json?.error === "StageGateBlockedError"),
    status: dupConfirm.status,
    body: dupConfirm.json,
    explanation: "Idempotency / stage guard: confirmReservation requires entry at S3.",
    dbImpact: "No second reservation.",
  });

  fs.writeFileSync(OUT_JSON, JSON.stringify({ baseUrl, steps }, null, 2), "utf8");
  const passed = steps.filter((s) => s.pass).length;
  const md: string[] = [];
  md.push(`# S4 acceptance test report (slice)`);
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
    md.push(`- **Response (truncated)**: \`${JSON.stringify(s.body).slice(0, 900)}\``);
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
