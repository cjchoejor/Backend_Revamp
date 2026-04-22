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

type CaseResult = { id: string; title: string; pass: boolean; status?: number; body?: Json; explanation?: string; dbImpact?: string };

function writeArtifacts(results: CaseResult[]) {
  const outDir = path.resolve(process.cwd(), "..", "Documentation");
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, "S8-test-output.json"), JSON.stringify({ baseUrl, ranAt: new Date().toISOString(), results }, null, 2));

  const passCount = results.filter((r) => r.pass).length;
  const failCount = results.length - passCount;

  const md = [
    "# S8 test report",
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
      return `### ${r.pass ? "✅" : "❌"} ${r.id} — ${r.title}${status}${explain}${db}${body}`;
    }),
    "",
  ].join("\n");

  fs.writeFileSync(path.join(outDir, "S8-test-report.md"), md);
}

async function main() {
  const results: CaseResult[] = [];

  // Create a fresh entry in S8 by using an S7 seeded entry and progressing S7->S8 with required setup
  const seeded = await prisma.entry.findFirstOrThrow({ where: { currentStage: "S7" }, include: { folio: true, handoffs: true } });
  assert(seeded.folio, "Seeded S7 entry missing folio");

  // Ensure a COMPLETE night audit for last night before checkout for S7->S8
  const checkout = seeded.checkOutDate!;
  const lastNight = new Date(Date.UTC(checkout.getUTCFullYear(), checkout.getUTCMonth(), checkout.getUTCDate() - 1, 0, 0, 0, 0));
  await http("POST", "/night-audit/run", L2, { operatingDate: lastNight.toISOString() });

  // Ensure no disputes block S7->S8
  const openDispute = await prisma.disputeRecord.findFirst({ where: { entryId: seeded.id, status: { in: ["OPEN", "IN_PROGRESS", "REOPENED"] } } });
  if (openDispute) await prisma.disputeRecord.update({ where: { id: openDispute.id }, data: { status: "CLOSED", closedAt: new Date(), closedBy: "test-gm-1", closureReason: "setup close", updatedBy: "test-gm-1" } });

  // Progress to S8
  const freshS7 = await prisma.entry.findUniqueOrThrow({ where: { id: seeded.id } });
  const rToS8 = await http("POST", `/entries/${seeded.id}/progress-stage`, L1, { targetStage: "S8", version: freshS7.version });
  results.push({ id: "SETUP-S7->S8", title: "Setup: progress S7->S8", pass: rToS8.status === 200, status: rToS8.status, body: rToS8.json });

  const s8 = await prisma.entry.findUniqueOrThrow({ where: { id: seeded.id }, include: { folio: true } });
  assert(s8.folio, "Entry in S8 must have folio");

  // AC-S8-25/26 Key return discrepancy note required; record accepted when governed
  {
    const r1 = await http("POST", `/entries/${s8.id}/key-return`, L1, { keyCountReturned: 0 });
    results.push({
      id: "AC-S8-25",
      title: "Key return discrepancy requires reconciliationNote",
      pass: r1.status === 400 && (r1.json as any)?.error === "ValidationError",
      status: r1.status,
      body: r1.json,
    });

    const r2 = await http("POST", `/entries/${s8.id}/key-return`, L1, { keyCountReturned: 0, reconciliationNote: "Guest lost key; governed resolution recorded" });
    results.push({
      id: "AC-S8-26",
      title: "KeyReturnRecord with discrepancy satisfies key-return condition",
      pass: r2.status === 200 && (r2.json as any)?.countReconciled === false && !!(r2.json as any)?.reconciliationNote,
      status: r2.status,
      body: r2.json,
    });
  }

  // AC-S8-14/15 Inspection must include deficientFlagStatus; NOT_APPLICABLE rejected when unresolved deficient exists
  {
    // Create unresolved deficient flag for the room
    const ra = await prisma.roomAssignment.findFirstOrThrow({ where: { entryId: s8.id }, orderBy: { createdAt: "desc" } });
    await prisma.deficientConditionRecord.create({
      data: {
        roomId: ra.roomId,
        category: "MAINTENANCE",
        description: "Test unresolved deficient",
        detectedAt: new Date(),
        detectedBy: "test",
        resolutionDeadline: new Date(Date.now() + 86400_000),
        status: "UNRESOLVED",
      },
    });

    const r1 = await http("POST", `/entries/${s8.id}/room-inspection`, L1, { isDeferred: false, deficientFlagStatus: "NOT_APPLICABLE", damageFound: false });
    results.push({
      id: "AC-S8-15",
      title: "Inspection NOT_APPLICABLE rejected when unresolved deficient exists",
      pass: r1.status === 409 && (r1.json as any)?.error === "PolicyGateBlockedError",
      status: r1.status,
      body: r1.json,
    });

    const def = await prisma.deficientConditionRecord.findFirstOrThrow({ where: { roomId: ra.roomId, status: "UNRESOLVED" }, orderBy: { detectedAt: "desc" } });
    const r2 = await http("POST", `/entries/${s8.id}/room-inspection`, L1, {
      isDeferred: true,
      deficientFlagStatus: "UNRESOLVED_AT_CHECKOUT",
      deficientConditionId: def.id,
      inspectorAssessment: "Condition present; governed service recovery",
      damageFound: false,
    });
    results.push({
      id: "AC-S8-14",
      title: "RoomInspectionRecord always carries deficientFlagStatus and can schedule deferral (W9)",
      pass: r2.status === 200 && (r2.json as any)?.deficientFlagStatus === "UNRESOLVED_AT_CHECKOUT" && (r2.json as any)?.isDeferred === true,
      status: r2.status,
      body: r2.json,
    });

    const w9 = await prisma.timerRecord.findFirst({ where: { entryId: s8.id, timerCode: "POST_CHECKOUT_INSPECTION_W9", status: "SCHEDULED" }, orderBy: { createdAt: "desc" } });
    results.push({
      id: "AC-S8-23",
      title: "Inspection deferral registers W9 timer in same workflow",
      pass: !!w9,
      body: w9 ? ({ id: w9.id, dueAt: w9.dueAt.toISOString(), timerCode: w9.timerCode } as any) : null,
    });
  }

  // Settlement: Guest-pay SETTLED + departed dirty + W24 registered
  {
    const beforeRoom = await prisma.roomAssignment.findFirstOrThrow({ where: { entryId: s8.id }, orderBy: { createdAt: "desc" }, include: { room: true } });
    const r = await http("POST", `/folios/${s8.folio.id}/settle`, L1, {
      settlementMethod: "CASH",
      billingModelConfirmation: "GUEST_PAY",
      paymentVerificationRef: "cash-verify-001",
    });
    results.push({
      id: "AC-S8-06",
      title: "Guest-pay CASH settlement transitions folio to SETTLED and creates payment record",
      pass: r.status === 200 && (r.json as any)?.state === "SETTLED",
      status: r.status,
      body: r.json,
    });

    const afterRoom = await prisma.room.findUniqueOrThrow({ where: { id: beforeRoom.roomId } });
    results.push({
      id: "AC-S8-01",
      title: "Checkout completion moves room OCCUPIED -> DEPARTED_DIRTY",
      pass: afterRoom.currentClaimState === "DEPARTED_DIRTY",
      body: { before: beforeRoom.room.currentClaimState, after: afterRoom.currentClaimState } as any,
    });

    const w24 = await prisma.timerRecord.findFirst({ where: { entryId: s8.id, timerCode: "HOUSEKEEPING_SLA_W24", status: "SCHEDULED" }, orderBy: { createdAt: "desc" } });
    results.push({
      id: "AC-S8-03",
      title: "DEPARTED_DIRTY write registers W24 timer",
      pass: !!w24,
      body: w24 ? ({ id: w24.id, dueAt: w24.dueAt.toISOString() } as any) : null,
    });
  }

  // AC-S8-17 H4 fulfilment requires complete evidence (and fulfil H4 for exit)
  {
    const h4 = await prisma.handoffRecord.findFirstOrThrow({ where: { entryId: s8.id, handoffType: "H4" }, orderBy: { createdAt: "desc" } });
    const r1 = await http("POST", `/handoffs/${h4.id}/fulfil`, L1, { fulfilmentEvidence: { chargesPostedConfirmation: true } });
    results.push({
      id: "AC-S8-17",
      title: "H4 fulfilment evidence must be complete",
      pass: r1.status === 409 && (r1.json as any)?.error === "PolicyGateBlockedError" && (r1.json as any)?.blockingCondition === "H4_FULFILMENT_EVIDENCE_INCOMPLETE",
      status: r1.status,
      body: r1.json,
    });

    const r2 = await http("POST", `/handoffs/${h4.id}/fulfil`, L1, {
      fulfilmentEvidence: {
        chargesPostedConfirmation: true,
        roomInspectionStatus: "RECORDED_OR_DEFERRED",
        damageAssessmentStatus: "COMPLETE_OR_DEFERRED",
        deficientFlagFinalStatus: "RECORDED",
      },
    });
    results.push({ id: "SETUP-H4-FULFIL", title: "Setup: fulfil H4 with complete evidence", pass: r2.status === 200, status: r2.status, body: r2.json });
  }

  // Dispute gate blocks S8->S9 and no override available
  {
    const opened = await http<any>("POST", "/disputes/open", L1, { entryId: s8.id, folioId: s8.folio.id, title: "Checkout dispute" });
    assert(opened.status === 200, "Failed to open dispute for S8 gate test");

    const fresh = await prisma.entry.findUniqueOrThrow({ where: { id: s8.id } });
    const r1 = await http("POST", `/entries/${s8.id}/progress-stage`, L1, { targetStage: "S9", version: fresh.version });
    results.push({
      id: "AC-S8-11",
      title: "S8->S9 blocked when dispute gate BLOCKED (no override)",
      pass: r1.status === 409 && (r1.json as any)?.error === "StageGateBlockedError" && (r1.json as any)?.blockingCondition === "DISPUTE_GATE_BLOCKED",
      status: r1.status,
      body: r1.json,
    });

    const r2 = await http("POST", `/disputes/${(opened.json as any).id}/gate-override`, L3, { targetStage: "S9", freeTextReason: "should be rejected" });
    results.push({
      id: "AC-S8-12",
      title: "Dispute gate override endpoint rejects targetStage S9",
      pass: r2.status === 409 && (r2.json as any)?.error === "PolicyGateBlockedError",
      status: r2.status,
      body: r2.json,
    });

    // GM closes dispute (reuse existing close route + closureReason)
    const r3 = await http("POST", `/disputes/${(opened.json as any).id}/close`, L3, { closureReason: "GM closed at checkout" });
    results.push({ id: "AC-S8-13-setup", title: "GM closes dispute", pass: r3.status === 200, status: r3.status, body: r3.json });
  }

  // Final S8->S9 after dispute closed
  {
    const fresh = await prisma.entry.findUniqueOrThrow({ where: { id: s8.id } });
    const r = await http("POST", `/entries/${s8.id}/progress-stage`, L1, { targetStage: "S9", version: fresh.version });
    results.push({
      id: "S8->S9",
      title: "Progress S8->S9 after settlement + key return + inspection + dispute clear",
      pass: r.status === 200 && (r.json as any)?.currentStage === "S9",
      status: r.status,
      body: r.json,
    });
  }

  writeArtifacts(results);

  const failed = results.filter((r) => !r.pass);
  if (failed.length > 0) throw new Error(`S8 acceptance tests failed: ${failed.map((f) => f.id).join(", ")}`);
}

main()
  .then(async () => {
    await prisma.$disconnect();
    console.log("S8 acceptance tests: PASS");
  })
  .catch(async (e) => {
    await prisma.$disconnect();
    console.error(e);
    process.exit(1);
  });

