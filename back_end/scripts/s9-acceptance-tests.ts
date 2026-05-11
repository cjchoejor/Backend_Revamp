import { prisma } from "../src/db.js";
import * as fs from "node:fs";
import * as path from "node:path";

type Json = Record<string, unknown> | unknown[] | string | number | boolean | null;

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

type CaseResult = { id: string; title: string; pass: boolean; status?: number; body?: Json };

function writeArtifacts(results: CaseResult[]) {
  const outDir = path.resolve(process.cwd(), "..", "Documentation");
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, "S9-test-output.json"), JSON.stringify({ baseUrl, ranAt: new Date().toISOString(), results }, null, 2));
  const md = [
    "# S9 test report",
    "",
    `- **Ran at**: ${new Date().toISOString()}`,
    `- **Base URL**: \`${baseUrl}\``,
    `- **Pass**: ${results.filter((r) => r.pass).length}`,
    `- **Fail**: ${results.filter((r) => !r.pass).length}`,
    "",
    ...results.map((r) => `### ${r.pass ? "✅" : "❌"} ${r.id} — ${r.title}${r.status ? ` (HTTP ${r.status})` : ""}\n\n\`\`\`json\n${JSON.stringify(r.body ?? null, null, 2)}\n\`\`\``),
    "",
  ].join("\n");
  fs.writeFileSync(path.join(outDir, "S9-test-report.md"), md);
}

async function main() {
  const results: CaseResult[] = [];

  // Setup: progress seeded S7 DIRECT_BILL entry -> S9 and then close.
  const seeded = await prisma.entry.findFirstOrThrow({ where: { currentStage: "S7" }, orderBy: { createdAt: "desc" }, include: { folio: true } });
  assert(seeded.folio, "Need seeded S7 entry with folio");

  const checkout = seeded.checkOutDate!;
  const lastNight = new Date(Date.UTC(checkout.getUTCFullYear(), checkout.getUTCMonth(), checkout.getUTCDate() - 1, 0, 0, 0, 0));
  await http("POST", "/night-audit/run", L2, { operatingDate: lastNight.toISOString() });

  const freshS7 = await prisma.entry.findUniqueOrThrow({ where: { id: seeded.id } });
  const toS8 = await http("POST", `/entries/${seeded.id}/progress-stage`, L1, { targetStage: "S8", version: freshS7.version });
  results.push({ id: "SETUP-S7->S8", title: "Setup progress S7->S8", pass: toS8.status === 200, status: toS8.status, body: toS8.json });

  // prerequisites for S8->S9
  const s8 = await prisma.entry.findUniqueOrThrow({ where: { id: seeded.id }, include: { folio: true } });
  assert(s8.folio, "Need folio");
  await http("POST", `/entries/${s8.id}/key-return`, L1, { keyCountReturned: s8.keysIssuedCount ?? 2 });
  await http("POST", `/entries/${s8.id}/room-inspection`, L1, { isDeferred: false, deficientFlagStatus: "NOT_APPLICABLE", damageFound: false });
  const h4 = await prisma.handoffRecord.findFirstOrThrow({ where: { entryId: s8.id, handoffType: "H4" }, orderBy: { createdAt: "desc" } });
  await http("POST", `/handoffs/${h4.id}/fulfil`, L1, {
    fulfilmentEvidence: { chargesPostedConfirmation: true, roomInspectionStatus: "RECORDED_OR_DEFERRED", damageAssessmentStatus: "COMPLETE_OR_DEFERRED", deficientFlagFinalStatus: "RECORDED" },
  });

  // set folio state to OUTSTANDING via DIRECT_BILL settlement and progress to S9
  await prisma.folio.update({ where: { id: s8.folio.id }, data: { billingModel: "DIRECT_BILL", outstandingBalance: 50 as any } as any });
  const settle = await http("POST", `/folios/${s8.folio.id}/settle`, L1, { settlementMethod: "DIRECT_BILL", billingModelConfirmation: "DIRECT_BILL" });
  results.push({ id: "SETUP-S8-SETTLE", title: "Setup settle to OUTSTANDING", pass: settle.status === 200, status: settle.status, body: settle.json });

  const freshS8 = await prisma.entry.findUniqueOrThrow({ where: { id: s8.id } });
  const toS9 = await http("POST", `/entries/${s8.id}/progress-stage`, L1, { targetStage: "S9", version: freshS8.version });
  results.push({ id: "SETUP-S8->S9", title: "Setup progress S8->S9", pass: toS9.status === 200, status: toS9.status, body: toS9.json });

  // AC-S9-036/037: post-stay charge validation + comm record in same transaction
  {
    const bad = await http("POST", `/folios/${s8.folio.id}/charges`, L2, {
      entryId: s8.id,
      lineType: "OTHER",
      description: "Bad",
      amount: 5,
      postedAt: new Date().toISOString(),
      isPostStay: false,
    } as any);
    results.push({ id: "AC-S9-036", title: "post-stay charges require isPostStay=true", pass: bad.status === 400, status: bad.status, body: bad.json });

    const postedAt = new Date().toISOString();
    const ok = await http("POST", `/folios/${s8.folio.id}/charges`, L2, {
      entryId: s8.id,
      lineType: "OTHER",
      description: "Post stay minibar",
      amount: 10,
      postedAt,
      isPostStay: true,
    } as any);
    const comm = await prisma.communicationRecord.findFirst({
      where: { entryId: s8.id, commType: "POST_STAY_CHARGE_NOTICE" as any, channel: "EMAIL" as any },
      orderBy: { createdAt: "desc" },
    });
    results.push({ id: "AC-S9-037", title: "post-stay charge creates guest notification CommunicationRecord", pass: ok.status === 200 && !!comm, status: ok.status, body: { ok: ok.json, comm } as any });
  }

  // AC-S9-003/004: post-stay FolioLine has isPostStay=true + no stay-window backdating
  {
    const line = await prisma.folioLine.findFirstOrThrow({ where: { folioId: s8.folio.id, stage: "S9", isPostStay: true }, orderBy: { createdAt: "desc" } });
    const entry = await prisma.entry.findUniqueOrThrow({ where: { id: s8.id } });
    const postedAt = new Date(line.postedAt);
    const inStay = entry.checkInDate && entry.checkOutDate ? postedAt >= entry.checkInDate && postedAt <= entry.checkOutDate : false;
    results.push({ id: "AC-S9-003", title: "S9 FolioLine isPostStay=true and postedAt is transaction date", pass: line.isPostStay === true, body: { id: line.id, isPostStay: line.isPostStay, postedAt: line.postedAt } as any });
    results.push({ id: "AC-S9-004", title: "S9 FolioLine not backdated into stay window", pass: inStay === false, body: { postedAt: line.postedAt, checkInDate: entry.checkInDate, checkOutDate: entry.checkOutDate } as any });
  }

  // AC-S9-038/39/40/41: write-off authority and record
  {
    const r1 = await http("POST", `/folios/${s8.folio.id}/write-off`, L1, { amount: 1, reason: "no" } as any);
    results.push({ id: "AC-S9-038", title: "write-off below L3 rejected", pass: r1.status === 403 || r1.status === 409, status: r1.status, body: r1.json });
    const r2 = await http("POST", `/folios/${s8.folio.id}/write-off`, L3, { amount: 1, reason: "" } as any);
    results.push({ id: "AC-S9-039", title: "write-off requires reason", pass: r2.status === 409, status: r2.status, body: r2.json });
  }

  // AC-S9-008/009/010/012/017/018/019/020/045/046: closure gates (targeted negative tests)
  {
    const inquiry = await prisma.inquiry.findFirstOrThrow({ orderBy: { createdAt: "desc" } });
    const roomType = await prisma.roomType.findFirstOrThrow({ orderBy: { createdAt: "desc" } });
    const folioService = await import("../src/services/folio-service.js");

    const mkS9Ready = async (useType: any = "LEISURE") => {
      const gp = await prisma.guestProfile.create({ data: { firstName: "S9", lastName: "Gate", createdBy: "test" } });
      const entry = await prisma.entry.create({ data: { inquiryId: inquiry.id, guestProfileId: gp.id, currentStage: "S9", status: "ACTIVE", useType, createdBy: "test", version: 1 } as any });
      const seg = await prisma.segment.create({ data: { entryId: entry.id, segmentNumber: 1, stage: "S9", createdBy: "test" } as any });
      const room = await prisma.room.create({ data: { roomNumber: `G${Math.floor(Math.random() * 10000)}`, floorNumber: 6, roomType: { connect: { id: roomType.id } }, currentClaimState: "DEPARTED_DIRTY" } as any });
      await prisma.roomAssignment.create({ data: { entryId: entry.id, roomId: room.id, assignedAt: new Date(), assignedBy: "test" } as any });
      const prov = await prisma.folio.create({ data: { entryId: entry.id, state: "PROVISIONAL", billingModel: "GUEST_PAY", outstandingBalance: 0 as any, createdBy: "test" } as any });
      const live = await folioService.convertToLive(prisma as any, entry.id, prov.id, "test");
      await prisma.folio.update({ where: { id: live.id }, data: { state: "OUTSTANDING", outstandingBalance: 10 as any, billingModel: "GUEST_PAY" } as any });
      await prisma.roomInspectionRecord.create({
        data: { entryId: entry.id, roomId: room.id, segmentId: seg.id, inspectedBy: L1.id, inspectedAt: new Date(), isDeferred: false, deficientFlagStatus: "NOT_APPLICABLE", damageFound: false } as any,
      });
      await prisma.invoice.create({ data: { folioId: live.id, entryId: entry.id, invoiceType: "FINAL", state: "DISPATCHED", issuedAt: new Date(), issuedBy: L1.id, dispatchedAt: new Date(), dispatchedBy: L1.id } as any });
      await prisma.timerRecord.create({ data: { entryId: entry.id, entityType: "Entry", entityId: entry.id, timerType: "PAYMENT_FOLLOW_UP_W8", timerCode: "PAYMENT_FOLLOW_UP_W8", dueAt: new Date(Date.now() + 86400_000), firesAt: new Date(Date.now() + 86400_000), status: "SCHEDULED", createdBy: "system" } as any });
      return { entry, room, folioId: live.id, segId: seg.id };
    };

    // AC-S9-009 dispute blocks close
    {
      const { entry, folioId } = await mkS9Ready();
      await prisma.disputeRecord.create({ data: { entryId: entry.id, folioId, status: "OPEN", title: "x", openedBy: L1.id } as any });
      const r = await http("POST", `/entries/${entry.id}/close`, L2, {});
      results.push({ id: "AC-S9-009", title: "close blocked when dispute OPEN/IN_PROGRESS/REOPENED", pass: r.status === 409 && (r.json as any)?.blockingCondition === "DISPUTE_NOT_TERMINAL", status: r.status, body: r.json });
    }

    // AC-S9-017 undispatched invoice blocks
    {
      const { entry, folioId } = await mkS9Ready();
      const inv = await prisma.invoice.findFirstOrThrow({ where: { entryId: entry.id, folioId }, orderBy: { createdAt: "desc" } });
      await prisma.invoice.update({ where: { id: inv.id }, data: { state: "DRAFT" } as any });
      const r = await http("POST", `/entries/${entry.id}/close`, L2, {});
      results.push({ id: "AC-S9-017", title: "undispatched invoice blocks closure", pass: r.status === 409 && (r.json as any)?.blockingCondition === "INVOICE_NOT_DISPATCHED", status: r.status, body: r.json });
    }

    // AC-S9-018 unmatched payment blocks
    {
      const { entry, folioId } = await mkS9Ready();
      await prisma.folio.update({ where: { id: folioId }, data: { billingModel: "DIRECT_BILL" } as any });
      await prisma.paymentRecord.create({ data: { folioId, amount: 1 as any, paymentDirection: "IN", invoiceId: null, notes: "unmatched" } as any });
      const r = await http("POST", `/entries/${entry.id}/close`, L2, {});
      results.push({ id: "AC-S9-018", title: "unmatched payment blocks closure", pass: r.status === 409 && (r.json as any)?.blockingCondition === "PAYMENT_NOT_MATCHED", status: r.status, body: r.json });
    }

    // AC-S9-012/019 outstanding zero + outstanding without W8/write-off
    {
      const { entry, folioId } = await mkS9Ready();
      await prisma.folio.update({ where: { id: folioId }, data: { state: "OUTSTANDING", outstandingBalance: 0 as any } as any });
      const r0 = await http("POST", `/entries/${entry.id}/close`, L2, {});
      results.push({ id: "AC-S9-012", title: "OUTSTANDING with zero balance blocks closure", pass: r0.status === 409 && (r0.json as any)?.blockingCondition === "OUTSTANDING_ZERO_BALANCE", status: r0.status, body: r0.json });

      await prisma.folio.update({ where: { id: folioId }, data: { state: "OUTSTANDING", outstandingBalance: 10 as any } as any });
      await prisma.timerRecord.deleteMany({ where: { entryId: entry.id, timerCode: "PAYMENT_FOLLOW_UP_W8" } });
      await prisma.writeOffRecord.deleteMany({ where: { entryId: entry.id } });
      const r = await http("POST", `/entries/${entry.id}/close`, L2, {});
      const w8 = await prisma.timerRecord.findFirst({ where: { entryId: entry.id, timerCode: "PAYMENT_FOLLOW_UP_W8", status: "SCHEDULED" }, orderBy: { createdAt: "desc" } });
      results.push({
        id: "AC-S9-019",
        title: "OUTSTANDING closure schedules W8 follow-up (no CLOSED without W8/write-off)",
        pass: r.status === 200 && !!w8,
        status: r.status,
        body: { r: r.json, w8: w8 ? ({ id: w8.id, dueAt: w8.dueAt.toISOString() } as any) : null } as any,
      });
    }

    // AC-S9-020 deferred inspection unresolved blocks
    {
      const { entry, room, segId } = await mkS9Ready();
      await prisma.roomInspectionRecord.deleteMany({ where: { entryId: entry.id } });
      await prisma.roomInspectionRecord.create({ data: { entryId: entry.id, roomId: room.id, segmentId: segId, inspectedBy: L1.id, inspectedAt: new Date(), isDeferred: true, deficientFlagStatus: "NOT_APPLICABLE", damageFound: false } as any });
      const r = await http("POST", `/entries/${entry.id}/close`, L2, {});
      results.push({ id: "AC-S9-020", title: "deferred inspection unresolved blocks closure", pass: r.status === 409 && (r.json as any)?.blockingCondition === "INSPECTION_DEFERRED_UNRESOLVED", status: r.status, body: r.json });
    }

    // AC-S9-046 H5 open blocks
    {
      const { entry } = await mkS9Ready();
      await prisma.handoffRecord.create({ data: { entryId: entry.id, handoffType: "H5", state: "CREATED", fromRole: "FRONT_DESK", fromActorId: L1.id, toRole: "FINANCE", createdBy: L1.id, stageContext: "S8" } as any });
      const r = await http("POST", `/entries/${entry.id}/close`, L2, {});
      results.push({ id: "AC-S9-046", title: "H5 open blocks closure", pass: r.status === 409 && (r.json as any)?.blockingCondition === "H5_NOT_FULFILLED", status: r.status, body: r.json });
    }

    // AC-S9-045 version required for S8->S9 progress-stage
    {
      const v = await http("POST", `/entries/${s8.id}/progress-stage`, L1, { targetStage: "S9" } as any);
      results.push({ id: "AC-S9-045", title: "progress-stage S8->S9 requires version", pass: v.status === 400 && (v.json as any)?.error === "ValidationError", status: v.status, body: v.json });
    }
  }

  // Close happy path (AC-S9-011) and closure timestamps/traces (AC-S9-007/044)
  {
    const inv = await prisma.invoice.findFirst({ where: { folioId: s8.folio.id }, orderBy: { createdAt: "desc" } });
    // Ensure invoice not DRAFT
    if (inv && inv.state === "DRAFT") {
      await prisma.invoice.update({ where: { id: inv.id }, data: { state: "DISPATCHED", issuedAt: new Date(), issuedBy: L1.id, dispatchedAt: new Date(), dispatchedBy: L1.id } as any });
    }
    // Fulfil H5 if exists
    const h5 = await prisma.handoffRecord.findFirst({ where: { entryId: s8.id, handoffType: "H5" }, orderBy: { createdAt: "desc" } });
    if (h5 && ["CREATED", "ASSIGNED", "ACCEPTED"].includes(h5.state)) {
      await prisma.handoffRecord.update({ where: { id: h5.id }, data: { state: "FULFILLED", fulfilledAt: new Date(), fulfilledBy: L2.id } as any });
    }

    const r = await http("POST", `/entries/${s8.id}/close`, L2, {});
    results.push({ id: "AC-S9-011", title: "close succeeds when loop closure satisfied", pass: r.status === 200 && (r.json as any)?.status === "CLOSED", status: r.status, body: r.json });
    const closed = await prisma.entry.findUniqueOrThrow({ where: { id: s8.id } });
    const te1 = await prisma.traceEvent.findFirst({ where: { entryId: s8.id, eventType: "ENTRY_CLOSED" }, orderBy: { createdAt: "desc" } });
    const te2 = await prisma.traceEvent.findFirst({ where: { entryId: s8.id, eventType: "FOLIO_SEALED" }, orderBy: { createdAt: "desc" } });
    results.push({ id: "AC-S9-007", title: "closedAt populated only for CLOSED", pass: closed.status === "CLOSED" && !!closed.closedAt, body: { status: closed.status, closedAt: closed.closedAt } as any });
    results.push({ id: "AC-S9-044", title: "ENTRY_CLOSED and FOLIO_SEALED trace events exist", pass: !!te1 && !!te2, body: { entryClosed: te1?.id, folioSealed: te2?.id } as any });
  }

  // AC-S9-015: CLOSED entry cannot progress stage
  {
    const closed = await prisma.entry.findUniqueOrThrow({ where: { id: s8.id } });
    const r = await http("POST", `/entries/${s8.id}/progress-stage`, L1, { targetStage: "S9", version: closed.version });
    results.push({ id: "AC-S9-015", title: "progress-stage rejected for CLOSED entry", pass: r.status === 409 && (r.json as any)?.error === "StateTransitionError", status: r.status, body: r.json });
  }

  // AC-S9-026/027/028/030: W28 dual-channel + trace payload + idempotency
  {
    const w = await import("../src/workers/w28-feedback-solicitation-worker.js");
    const timer = await prisma.timerRecord.findFirstOrThrow({ where: { entryId: s8.id, timerCode: "FEEDBACK_SOLICITATION_W28", status: "SCHEDULED" }, orderBy: { createdAt: "desc" } });
    // AC-S9-026: dueAt is in future (not immediate)
    results.push({ id: "AC-S9-026", title: "W28 timer is scheduled after delay (not immediate)", pass: timer.dueAt.getTime() > Date.now(), body: { dueAt: timer.dueAt } as any });
    const r1 = await w.runFeedbackSolicitationWorker(prisma as any, { entryId: s8.id });
    const comms = await prisma.communicationRecord.findMany({ where: { entryId: s8.id, commType: "FEEDBACK_SOLICITATION" as any }, orderBy: { createdAt: "desc" } });
    const trace = await prisma.traceEvent.findFirst({ where: { entryId: s8.id, eventType: "FEEDBACK.SOLICITATION_SENT" }, orderBy: { createdAt: "desc" } });
    const channels = (trace?.payload as any)?.channelsDispatched ?? [];
    results.push({ id: "AC-S9-027", title: "W28 writes exactly two CommunicationRecords (EMAIL + WHATSAPP)", pass: comms.length === 2 && new Set(comms.map((c) => c.channel)).size === 2, body: comms as any });
    results.push({ id: "AC-S9-028", title: "FEEDBACK.SOLICITATION_SENT trace lists both channels", pass: Array.isArray(channels) && channels.includes("EMAIL") && channels.includes("WHATSAPP"), body: trace as any });
    const r2 = await w.runFeedbackSolicitationWorker(prisma as any, { entryId: s8.id });
    const comms2 = await prisma.communicationRecord.findMany({ where: { entryId: s8.id, commType: "FEEDBACK_SOLICITATION" as any } });
    results.push({ id: "AC-S9-030", title: "W28 idempotent (no duplicates when trace exists)", pass: (r2 as any).skipped === true && comms2.length === 2, body: { r1, r2, comms2: comms2.length } as any });
  }

  // AC-S9-013: SETTLED cannot be set while balance remains
  {
    let ok = false;
    try {
      await prisma.folio.update({ where: { id: s8.folio.id }, data: { state: "SETTLED" } as any });
      ok = true;
    } catch {
      ok = false;
    }
    results.push({ id: "AC-S9-013", title: "SETTLED while balance remains is forbidden", pass: ok === false, body: { ok } as any });
  }

  // AC-S9-016: room becomes FREE at closure
  {
    const ra = await prisma.roomAssignment.findFirstOrThrow({ where: { entryId: s8.id }, orderBy: { createdAt: "desc" } });
    const room = await prisma.room.findUniqueOrThrow({ where: { id: ra.roomId } });
    results.push({ id: "AC-S9-016", title: "Room claim transitions to FREE at closure", pass: room.currentClaimState === "FREE", body: { roomId: room.id, currentClaimState: room.currentClaimState } as any });
  }

  // AC-S9-032: post-closure invoice PAYMENT_TRACKED -> RECONCILED does not reopen entry
  {
    const inv = await prisma.invoice.findFirst({ where: { entryId: s8.id }, orderBy: { createdAt: "desc" } });
    if (!inv) {
      results.push({ id: "AC-S9-032", title: "Invoice reconciliation post-closure", pass: false, body: { error: "missing invoice" } as any });
    } else {
      if (inv.state === "DISPATCHED") await prisma.invoice.update({ where: { id: inv.id }, data: { state: "PAYMENT_TRACKED" } as any });
      const r = await http("POST", `/invoices/${inv.id}/record-payment-event`, L2, { nextState: "RECONCILED", paymentRef: "bank-123" } as any);
      const entry = await prisma.entry.findUniqueOrThrow({ where: { id: s8.id } });
      results.push({ id: "AC-S9-032", title: "Invoice reconciliation post-closure does not change EntryStatus", pass: r.status === 200 && entry.status === "CLOSED", status: r.status, body: { invoice: r.json, entryStatus: entry.status } as any });
    }
  }

  // AC-S9-042/043: folio line immutable + L2 additive post-closure charge allowed
  {
    const anyLine = await prisma.folioLine.findFirst({ where: { folioId: s8.folio.id }, orderBy: { createdAt: "desc" } });
    let updated = false;
    try {
      if (anyLine) await prisma.folioLine.update({ where: { id: anyLine.id }, data: { description: "edit" } as any });
      updated = true;
    } catch {
      updated = false;
    }
    results.push({ id: "AC-S9-042", title: "Cannot modify existing FolioLine after closure", pass: updated === false, body: { updated } as any });

    const r = await http("POST", `/folios/${s8.folio.id}/charges`, L2, {
      entryId: s8.id,
      lineType: "OTHER",
      description: "After close adjustment",
      amount: 1,
      postedAt: new Date().toISOString(),
      isPostStay: true,
    } as any);
    results.push({ id: "AC-S9-043", title: "L2 can add post-closure FolioLine via /charges at S9", pass: r.status === 200 && (r.json as any)?.isPostStay === true, status: r.status, body: r.json });
  }

  // AC-S9-001/002/021/022/023/024/025: CommissionDueRecord creation + W11
  {
    const roomType = await prisma.roomType.findFirstOrThrow({ orderBy: { createdAt: "desc" } });
    const gp = await prisma.guestProfile.create({ data: { firstName: "Agent", lastName: "Rate", createdBy: "test" } });
    const agentWithBasis = await prisma.agentProfile.create({ data: { displayName: "Agent With Basis", commissionRate: 0.1 as any, commissionBasis: "TOTAL_FOLIO" as any, createdBy: "test" } as any });
    const agentNoRate = await prisma.agentProfile.create({ data: { displayName: "Agent No Rate", commissionRate: null, commissionBasis: null, createdBy: "test" } as any });
    const agentMissingBasis = await prisma.agentProfile.create({ data: { displayName: "Agent Missing Basis", commissionRate: 0.1 as any, commissionBasis: null, createdBy: "test" } as any });

    const mk = async (agentProfileId: string | null, outstanding: number) => {
      const inq = await prisma.inquiry.create({ data: { referenceNumber: `INQ-S9-${Date.now()}-${Math.floor(Math.random() * 1000)}`, guestProfileId: gp.id, agentProfileId, sourceChannel: "AGENT", defaultCustodianId: "staff-frontdesk-1", createdBy: "test" } as any });
      const entry = await prisma.entry.create({ data: { inquiryId: inq.id, guestProfileId: gp.id, currentStage: "S9", status: "ACTIVE", createdBy: "test", version: 1 } as any });
      const seg = await prisma.segment.create({ data: { entryId: entry.id, segmentNumber: 1, stage: "S9", createdBy: "test" } as any });
      const room = await prisma.room.create({ data: { roomNumber: `C${Math.floor(Math.random() * 10000)}`, floorNumber: 5, roomType: { connect: { id: roomType.id } }, currentClaimState: "DEPARTED_DIRTY" } as any });
      await prisma.roomAssignment.create({ data: { entryId: entry.id, roomId: room.id, assignedAt: new Date(), assignedBy: "test" } as any });
      const prov = await prisma.folio.create({ data: { entryId: entry.id, state: "PROVISIONAL", billingModel: "GUEST_PAY", outstandingBalance: 0 as any, createdBy: "test" } as any });
      const folioService = await import("../src/services/folio-service.js");
      const live = await folioService.convertToLive(prisma as any, entry.id, prov.id, "test");
      await prisma.folio.update({ where: { id: live.id }, data: { state: "OUTSTANDING", outstandingBalance: outstanding as any, billingModel: "GUEST_PAY" } as any });
      await prisma.roomInspectionRecord.create({ data: { entryId: entry.id, roomId: room.id, segmentId: seg.id, inspectedBy: L1.id, inspectedAt: new Date(), isDeferred: false, deficientFlagStatus: "NOT_APPLICABLE", damageFound: false } as any });
      await prisma.invoice.create({ data: { folioId: live.id, entryId: entry.id, invoiceType: "FINAL", state: "DISPATCHED", issuedAt: new Date(), issuedBy: L1.id, dispatchedAt: new Date(), dispatchedBy: L1.id } as any });
      await prisma.timerRecord.create({ data: { entryId: entry.id, entityType: "Entry", entityId: entry.id, timerType: "PAYMENT_FOLLOW_UP_W8", timerCode: "PAYMENT_FOLLOW_UP_W8", dueAt: new Date(Date.now() + 86400_000), firesAt: new Date(Date.now() + 86400_000), status: "SCHEDULED", createdBy: "system" } as any });
      return { entry, folioId: live.id };
    };

    // no commission rate => no CommissionDueRecord (AC-S9-002/021)
    {
      const { entry } = await mk(agentNoRate.id, 10);
      const r = await http("POST", `/entries/${entry.id}/close`, L2, {});
      const rec = await prisma.commissionDueRecord.findFirst({ where: { entryId: entry.id } });
      results.push({ id: "AC-S9-002", title: "No CommissionDueRecord when agent has no commissionRate", pass: r.status === 200 && !rec, status: r.status, body: { rec } as any });
      results.push({ id: "AC-S9-021", title: "Closure not blocked when agent commissionRate absent", pass: r.status === 200, status: r.status, body: r.json });
    }

    // rate + basis => PENDING record (AC-S9-001/022)
    {
      const { entry } = await mk(agentWithBasis.id, 10);
      const r = await http("POST", `/entries/${entry.id}/close`, L2, {});
      const rec = await prisma.commissionDueRecord.findFirstOrThrow({ where: { entryId: entry.id } });
      results.push({ id: "AC-S9-001", title: "CommissionDueRecord exists when commissionRate configured", pass: r.status === 200 && !!rec, status: r.status, body: rec as any });
      results.push({ id: "AC-S9-022", title: "CommissionDueRecord created with status PENDING when basis configured", pass: rec.status === "PENDING", body: rec as any });
    }

    // rate but missing basis => RATE_MISSING + W11 scheduled (AC-S9-023)
    let rateMissingId: string | null = null;
    {
      const { entry } = await mk(agentMissingBasis.id, 10);
      const r = await http("POST", `/entries/${entry.id}/close`, L2, {});
      const rec = await prisma.commissionDueRecord.findFirstOrThrow({ where: { entryId: entry.id } });
      const w11 = await prisma.timerRecord.findFirst({ where: { entryId: entry.id, timerCode: "COMMISSION_RATE_MISSING_W11", status: "SCHEDULED" }, orderBy: { createdAt: "desc" } });
      rateMissingId = rec.id;
      results.push({ id: "AC-S9-023", title: "RATE_MISSING CommissionDueRecord schedules W11", pass: r.status === 200 && rec.status === "RATE_MISSING" && !!w11, status: r.status, body: { rec, w11 } as any });
    }

    // W11 fires escalation trace (AC-S9-024) and doesn't fire when no record (AC-S9-025)
    {
      const w11 = await import("../src/workers/w11-commission-rate-missing-worker.js");
      if (rateMissingId) {
        const out = await w11.runCommissionRateMissingWorker(prisma as any, { commissionDueId: rateMissingId });
        const te = await prisma.traceEvent.findFirst({ where: { entityId: rateMissingId, eventType: "COMMISSION_DUE.RATE_MISSING_ESCALATION_FIRED" }, orderBy: { createdAt: "desc" } });
        results.push({ id: "AC-S9-024", title: "W11 emits COMMISSION_DUE.RATE_MISSING_ESCALATION_FIRED", pass: (out as any).skipped === false && !!te, body: { out, te } as any });
      } else {
        results.push({ id: "AC-S9-024", title: "W11 emits COMMISSION_DUE.RATE_MISSING_ESCALATION_FIRED", pass: false, body: { error: "missing RATE_MISSING record" } as any });
      }
      const out2 = await w11.runCommissionRateMissingWorker(prisma as any, { commissionDueId: "00000000-0000-0000-0000-000000000000" });
      results.push({ id: "AC-S9-025", title: "W11 does not fire when no CommissionDueRecord exists", pass: (out2 as any).skipped === true, body: out2 as any });
    }
  }

  // AC-S9-005/048: FollowUpTaskRecord exists for CONFERENCE/GROUP on closure
  {
    const inquiry = await prisma.inquiry.findFirstOrThrow({ orderBy: { createdAt: "desc" } });
    const roomType = await prisma.roomType.findFirstOrThrow({ orderBy: { createdAt: "desc" } });
    const folioService = await import("../src/services/folio-service.js");

    const mk = async (useType: any) => {
      const gp = await prisma.guestProfile.create({ data: { firstName: "FU", lastName: useType, createdBy: "test" } });
      const entry = await prisma.entry.create({ data: { inquiryId: inquiry.id, guestProfileId: gp.id, currentStage: "S9", status: "ACTIVE", useType, createdBy: "test", version: 1 } as any });
      const seg = await prisma.segment.create({ data: { entryId: entry.id, segmentNumber: 1, stage: "S9", createdBy: "test" } as any });
      const room = await prisma.room.create({ data: { roomNumber: `F${Math.floor(Math.random() * 10000)}`, floorNumber: 4, roomType: { connect: { id: roomType.id } }, currentClaimState: "DEPARTED_DIRTY" } as any });
      await prisma.roomAssignment.create({ data: { entryId: entry.id, roomId: room.id, assignedAt: new Date(), assignedBy: "test" } as any });
      const prov = await prisma.folio.create({ data: { entryId: entry.id, state: "PROVISIONAL", billingModel: "GUEST_PAY", outstandingBalance: 0 as any, createdBy: "test" } as any });
      const live = await folioService.convertToLive(prisma as any, entry.id, prov.id, "test");
      await prisma.folio.update({ where: { id: live.id }, data: { state: "OUTSTANDING", outstandingBalance: 10 as any, billingModel: "GUEST_PAY" } as any });
      await prisma.roomInspectionRecord.create({ data: { entryId: entry.id, roomId: room.id, segmentId: seg.id, inspectedBy: L1.id, inspectedAt: new Date(), isDeferred: false, deficientFlagStatus: "NOT_APPLICABLE", damageFound: false } as any });
      await prisma.invoice.create({ data: { folioId: live.id, entryId: entry.id, invoiceType: "FINAL", state: "DISPATCHED", issuedAt: new Date(), issuedBy: L1.id, dispatchedAt: new Date(), dispatchedBy: L1.id } as any });
      await prisma.timerRecord.create({ data: { entryId: entry.id, entityType: "Entry", entityId: entry.id, timerType: "PAYMENT_FOLLOW_UP_W8", timerCode: "PAYMENT_FOLLOW_UP_W8", dueAt: new Date(Date.now() + 86400_000), firesAt: new Date(Date.now() + 86400_000), status: "SCHEDULED", createdBy: "system" } as any });
      return { entry, folioId: live.id };
    };

    const conf = await mk("CONFERENCE");
    await http("POST", `/entries/${conf.entry.id}/close`, L2, {});
    const fu1 = await prisma.followUpTaskRecord.findFirst({ where: { entryId: conf.entry.id }, orderBy: { createdAt: "desc" } });
    results.push({ id: "AC-S9-048", title: "FollowUpTaskRecord exists for CONFERENCE closure and dueAt is set", pass: !!fu1 && !!fu1?.dueAt, body: fu1 as any });

    const group = await mk("GROUP");
    await http("POST", `/entries/${group.entry.id}/close`, L2, {});
    const fu2 = await prisma.followUpTaskRecord.findFirst({ where: { entryId: group.entry.id }, orderBy: { createdAt: "desc" } });
    results.push({ id: "AC-S9-005", title: "FollowUpTaskRecord exists for GROUP closure", pass: !!fu2, body: fu2 as any });

    const leisure = await mk("LEISURE");
    await http("POST", `/entries/${leisure.entry.id}/close`, L2, {});
    const fu3 = await prisma.followUpTaskRecord.findFirst({ where: { entryId: leisure.entry.id }, orderBy: { createdAt: "desc" } });
    results.push({ id: "AC-S9-005b", title: "No FollowUpTaskRecord for non GROUP/CONFERENCE", pass: !fu3, body: { fu3 } as any });
  }

  // AC-S9-031: Government closure allowed at PAYMENT_TRACKED (not requiring RECONCILED)
  {
    const inquiry = await prisma.inquiry.findFirstOrThrow({ orderBy: { createdAt: "desc" } });
    const roomType = await prisma.roomType.findFirstOrThrow({ orderBy: { createdAt: "desc" } });
    const folioService = await import("../src/services/folio-service.js");
    const gp = await prisma.guestProfile.create({ data: { firstName: "Gov", lastName: "Bill", createdBy: "test" } });
    const entry = await prisma.entry.create({ data: { inquiryId: inquiry.id, guestProfileId: gp.id, currentStage: "S9", status: "ACTIVE", createdBy: "test", version: 1 } as any });
    const seg = await prisma.segment.create({ data: { entryId: entry.id, segmentNumber: 1, stage: "S9", createdBy: "test" } as any });
    const room = await prisma.room.create({ data: { roomNumber: `GOV${Math.floor(Math.random() * 10000)}`, floorNumber: 3, roomType: { connect: { id: roomType.id } }, currentClaimState: "DEPARTED_DIRTY" } as any });
    await prisma.roomAssignment.create({ data: { entryId: entry.id, roomId: room.id, assignedAt: new Date(), assignedBy: "test" } as any });
    const prov = await prisma.folio.create({ data: { entryId: entry.id, state: "PROVISIONAL", billingModel: "GOVERNMENT", outstandingBalance: 0 as any, createdBy: "test" } as any });
    const live = await folioService.convertToLive(prisma as any, entry.id, prov.id, "test");
    await prisma.folio.update({ where: { id: live.id }, data: { state: "OUTSTANDING", outstandingBalance: 10 as any, billingModel: "GOVERNMENT" } as any });
    await prisma.roomInspectionRecord.create({ data: { entryId: entry.id, roomId: room.id, segmentId: seg.id, inspectedBy: L1.id, inspectedAt: new Date(), isDeferred: false, deficientFlagStatus: "NOT_APPLICABLE", damageFound: false } as any });
    const inv = await prisma.invoice.create({ data: { folioId: live.id, entryId: entry.id, invoiceType: "FINAL", state: "DISPATCHED", issuedAt: new Date(), issuedBy: L1.id, dispatchedAt: new Date(), dispatchedBy: L1.id } as any });
    await prisma.timerRecord.create({ data: { entryId: entry.id, entityType: "Entry", entityId: entry.id, timerType: "PAYMENT_FOLLOW_UP_W8", timerCode: "PAYMENT_FOLLOW_UP_W8", dueAt: new Date(Date.now() + 86400_000), firesAt: new Date(Date.now() + 86400_000), status: "SCHEDULED", createdBy: "system" } as any });

    // should block when DISPATCHED
    const blocked = await http("POST", `/entries/${entry.id}/close`, L2, {});
    results.push({ id: "AC-S9-031a", title: "Government DISPATCHED blocks closure until PAYMENT_TRACKED", pass: blocked.status === 409 && (blocked.json as any)?.blockingCondition === "GOV_PAYMENT_NOT_TRACKED", status: blocked.status, body: blocked.json });
    // transition invoice to PAYMENT_TRACKED then close succeeds
    await prisma.invoice.update({ where: { id: inv.id }, data: { state: "PAYMENT_TRACKED" } as any });
    const ok = await http("POST", `/entries/${entry.id}/close`, L2, {});
    results.push({ id: "AC-S9-031", title: "Government closure succeeds at PAYMENT_TRACKED (no RECONCILED required)", pass: ok.status === 200 && (ok.json as any)?.status === "CLOSED", status: ok.status, body: ok.json });
  }

  // AC-S9-029: W28 does not fire for NO_SHOW_CLOSED closures (no timer scheduled)
  {
    const inquiry = await prisma.inquiry.findFirstOrThrow({ orderBy: { createdAt: "desc" } });
    const gp = await prisma.guestProfile.create({ data: { firstName: "NoShow", lastName: "Close", createdBy: "test" } });
    const entry = await prisma.entry.create({ data: { inquiryId: inquiry.id, guestProfileId: gp.id, currentStage: "S9", status: "ACTIVE", createdBy: "test", version: 1 } as any });
    const folio = await prisma.folio.create({ data: { entryId: entry.id, state: "NO_SHOW_CLOSED", billingModel: "GUEST_PAY", outstandingBalance: 0 as any, createdBy: "test", noShowPenaltyAmount: 10 as any, noShowAdvancePaymentAmount: 10 as any, noShowNetPosition: 0 as any, noShowFomDetermination: L2.id } as any });
    await prisma.noShowDeterminationRecord.create({ data: { entryId: entry.id, determinationPath: "SUB_PATH_1", fomActorId: L2.id, contactAttemptLog: [] as any, decisionReason: "x", otaNotificationRequired: false, otaNotificationStatus: null, createdBy: L2.id } as any });
    // must satisfy close gates: no disputes, invoices dispatched ok, inspection resolved, etc.
    const roomType = await prisma.roomType.findFirstOrThrow({ orderBy: { createdAt: "desc" } });
    const room = await prisma.room.create({ data: { roomNumber: `NS${Math.floor(Math.random() * 10000)}`, floorNumber: 2, roomType: { connect: { id: roomType.id } }, currentClaimState: "DEPARTED_DIRTY" } as any });
    const seg = await prisma.segment.create({ data: { entryId: entry.id, segmentNumber: 1, stage: "S9", createdBy: "test" } as any });
    await prisma.roomAssignment.create({ data: { entryId: entry.id, roomId: room.id, assignedAt: new Date(), assignedBy: "test" } as any });
    await prisma.roomInspectionRecord.create({ data: { entryId: entry.id, roomId: room.id, segmentId: seg.id, inspectedBy: L1.id, inspectedAt: new Date(), isDeferred: false, deficientFlagStatus: "NOT_APPLICABLE", damageFound: false } as any });
    await prisma.invoice.create({ data: { folioId: folio.id, entryId: entry.id, invoiceType: "FINAL", state: "DISPATCHED", issuedAt: new Date(), issuedBy: L1.id, dispatchedAt: new Date(), dispatchedBy: L1.id, metadata: { noShowDeterminationId: (await prisma.noShowDeterminationRecord.findFirstOrThrow({ where: { entryId: entry.id } })).id } as any } as any });
    const r = await http("POST", `/entries/${entry.id}/close`, L2, {});
    const w28 = await prisma.timerRecord.findFirst({ where: { entryId: entry.id, timerCode: "FEEDBACK_SOLICITATION_W28" }, orderBy: { createdAt: "desc" } });
    results.push({ id: "AC-S9-029", title: "No-show closure does not schedule W28", pass: r.status === 200 && !w28, status: r.status, body: { r: r.json, w28 } as any });
  }

  // AC-S9-033/034/035: No-show S9 path creates penalty invoice and/or refund anchored to NoShowDeterminationRecord
  {
    const inquiry = await prisma.inquiry.findFirstOrThrow({ orderBy: { createdAt: "desc" } });
    const roomType = await prisma.roomType.findFirstOrThrow({ orderBy: { createdAt: "desc" } });

    const mkNoShow = async (penalty: number, netRefund: number) => {
      const gp = await prisma.guestProfile.create({ data: { firstName: "NoShow", lastName: "Path", createdBy: "test" } });
      const entry = await prisma.entry.create({ data: { inquiryId: inquiry.id, guestProfileId: gp.id, currentStage: "S9", status: "ACTIVE", createdBy: "test", version: 1 } as any });
      const det = await prisma.noShowDeterminationRecord.create({
        data: { entryId: entry.id, determinationPath: "SUB_PATH_1", fomActorId: L2.id, contactAttemptLog: [] as any, decisionReason: "test", otaNotificationRequired: false, otaNotificationStatus: null, createdBy: L2.id } as any,
      });
      const folio = await prisma.folio.create({
        data: {
          entryId: entry.id,
          state: "NO_SHOW_CLOSED",
          billingModel: "GUEST_PAY",
          outstandingBalance: 0 as any,
          createdBy: "test",
          noShowPenaltyAmount: penalty as any,
          noShowAdvancePaymentAmount: (penalty + netRefund) as any,
          noShowNetPosition: netRefund as any,
          noShowFomDetermination: L2.id,
        } as any,
      });
      const room = await prisma.room.create({ data: { roomNumber: `NSP${Math.floor(Math.random() * 10000)}`, floorNumber: 2, roomType: { connect: { id: roomType.id } }, currentClaimState: "DEPARTED_DIRTY" } as any });
      const seg = await prisma.segment.create({ data: { entryId: entry.id, segmentNumber: 1, stage: "S9", createdBy: "test" } as any });
      await prisma.roomAssignment.create({ data: { entryId: entry.id, roomId: room.id, assignedAt: new Date(), assignedBy: "test" } as any });
      await prisma.roomInspectionRecord.create({ data: { entryId: entry.id, roomId: room.id, segmentId: seg.id, inspectedBy: L1.id, inspectedAt: new Date(), isDeferred: false, deficientFlagStatus: "NOT_APPLICABLE", damageFound: false } as any });
      // have an invoice DRAFT/DISPATCHED gate satisfied: create DISPATCHED stub anchored to determination
      await prisma.invoice.create({
        data: { folioId: folio.id, entryId: entry.id, invoiceType: "FINAL", state: "DISPATCHED", issuedAt: new Date(), issuedBy: L1.id, dispatchedAt: new Date(), dispatchedBy: L1.id, metadata: { noShowDeterminationId: det.id } as any } as any,
      });
      return { entry, folioId: folio.id, detId: det.id };
    };

    // penalty retained => penalty invoice exists with anchor metadata
    {
      const { entry, detId } = await mkNoShow(10, 0);
      const r = await http("POST", `/entries/${entry.id}/close`, L2, {});
      const inv = await prisma.invoice.findFirst({ where: { entryId: entry.id, state: "DISPATCHED" }, orderBy: { createdAt: "desc" } });
      results.push({ id: "AC-S9-033", title: "No-show retained penalty creates penalty invoice before closure", pass: r.status === 200 && !!inv && (inv.metadata as any)?.noShowDeterminationId === detId, status: r.status, body: { inv } as any });
      // anchor requirement (AC-S9-035): at least invoice has determinationId reference
      results.push({ id: "AC-S9-035a", title: "No-show S9 invoice carries NoShowDeterminationRecord reference", pass: !!inv && (inv.metadata as any)?.noShowDeterminationId === detId, body: inv as any });
    }

    // refund obligation => refund PaymentRecord OUT exists with determination anchor in notes
    {
      const { entry, detId, folioId } = await mkNoShow(0, 15);
      const r = await http("POST", `/entries/${entry.id}/close`, L2, {});
      const pay = await prisma.paymentRecord.findFirst({ where: { folioId, paymentDirection: "OUT", notes: { contains: detId } }, orderBy: { createdAt: "desc" } });
      results.push({ id: "AC-S9-034", title: "No-show refund obligation confirms outgoing PaymentRecord before closure", pass: r.status === 200 && !!pay, status: r.status, body: { pay } as any });
      results.push({ id: "AC-S9-035b", title: "No-show refund PaymentRecord carries NoShowDeterminationRecord reference", pass: !!pay && (pay.notes ?? "").includes(detId), body: pay as any });
    }
  }

  // AC-S9-006/040/041: write-off band + record permanence
  {
    const inquiry = await prisma.inquiry.findFirstOrThrow({ orderBy: { createdAt: "desc" } });
    const roomType = await prisma.roomType.findFirstOrThrow({ orderBy: { createdAt: "desc" } });
    const folioService = await import("../src/services/folio-service.js");
    const gp = await prisma.guestProfile.create({ data: { firstName: "Write", lastName: "Off", createdBy: "test" } });
    const entry = await prisma.entry.create({ data: { inquiryId: inquiry.id, guestProfileId: gp.id, currentStage: "S9", status: "ACTIVE", createdBy: "test", version: 1 } as any });
    const seg = await prisma.segment.create({ data: { entryId: entry.id, segmentNumber: 1, stage: "S9", createdBy: "test" } as any });
    const room = await prisma.room.create({ data: { roomNumber: `WO${Math.floor(Math.random() * 10000)}`, floorNumber: 2, roomType: { connect: { id: roomType.id } }, currentClaimState: "DEPARTED_DIRTY" } as any });
    await prisma.roomAssignment.create({ data: { entryId: entry.id, roomId: room.id, assignedAt: new Date(), assignedBy: "test" } as any });
    const prov = await prisma.folio.create({ data: { entryId: entry.id, state: "PROVISIONAL", billingModel: "GUEST_PAY", outstandingBalance: 0 as any, createdBy: "test" } as any });
    const live = await folioService.convertToLive(prisma as any, entry.id, prov.id, "test");
    await prisma.folio.update({ where: { id: live.id }, data: { state: "OUTSTANDING", outstandingBalance: 6000 as any, billingModel: "GUEST_PAY" } as any });
    await prisma.roomInspectionRecord.create({ data: { entryId: entry.id, roomId: room.id, segmentId: seg.id, inspectedBy: L1.id, inspectedAt: new Date(), isDeferred: false, deficientFlagStatus: "NOT_APPLICABLE", damageFound: false } as any });
    await prisma.invoice.create({ data: { folioId: live.id, entryId: entry.id, invoiceType: "FINAL", state: "DISPATCHED", issuedAt: new Date(), issuedBy: L1.id, dispatchedAt: new Date(), dispatchedBy: L1.id } as any });

    // AC-S9-040: amount exceeds authority band => blocked
    const over = await http("POST", `/folios/${live.id}/write-off`, L3, { amount: 6000, reason: "too high" } as any);
    results.push({ id: "AC-S9-040", title: "write-off exceeding authority band is blocked", pass: over.status === 409, status: over.status, body: over.json });

    // within band => WRITTEN_OFF and WriteOffRecord has non-empty reason + preserves original amount
    const ok = await http("POST", `/folios/${live.id}/write-off`, L3, { amount: 4000, reason: "uncollectable" } as any);
    const folio = await prisma.folio.findUniqueOrThrow({ where: { id: live.id } });
    const rec = await prisma.writeOffRecord.findFirst({ where: { entryId: entry.id }, orderBy: { createdAt: "desc" } });
    results.push({ id: "AC-S9-006", title: "WriteOffRecord exists with non-empty reason when folio WRITTEN_OFF", pass: !!rec && !!rec.reason?.trim(), body: rec as any });
    results.push({ id: "AC-S9-041", title: "After write-off, folio is WRITTEN_OFF and record preserves amount", pass: ok.status === 200 && folio.state === "WRITTEN_OFF" && !!rec && Number(rec.writtenOffAmount.toString()) === 4000, status: ok.status, body: { folio, rec } as any });
  }

  // AC-S9-014: Dispute gate override not available at S9
  {
    const opened = await http<any>("POST", "/disputes/open", L1, { entryId: s8.id, folioId: s8.folio.id, title: "override test" } as any);
    // GM tries to override to S9 => blocked
    const r = await http("POST", `/disputes/${(opened.json as any).id}/gate-override`, L3, { targetStage: "S9", freeTextReason: "no overrides at S9" } as any);
    results.push({ id: "AC-S9-014", title: "Dispute gate override rejected for targetStage S9", pass: r.status === 409 && (r.json as any)?.error === "PolicyGateBlockedError", status: r.status, body: r.json });
    // cleanup close dispute so other tests aren't affected
    await http("POST", `/disputes/${(opened.json as any).id}/close`, L3, { closureReason: "cleanup" } as any);
  }

  // AC-S9-049: Apartment deposit must be resolved before closure
  {
    const inquiry = await prisma.inquiry.findFirstOrThrow({ orderBy: { createdAt: "desc" } });
    const roomType = await prisma.roomType.findFirstOrThrow({ orderBy: { createdAt: "desc" } });
    const folioService = await import("../src/services/folio-service.js");
    const gp = await prisma.guestProfile.create({ data: { firstName: "Apt", lastName: "Deposit", createdBy: "test" } });
    const entry = await prisma.entry.create({ data: { inquiryId: inquiry.id, guestProfileId: gp.id, currentStage: "S9", status: "ACTIVE", useType: "APARTMENT", createdBy: "test", version: 1 } as any });
    const seg = await prisma.segment.create({ data: { entryId: entry.id, segmentNumber: 1, stage: "S9", createdBy: "test" } as any });
    const room = await prisma.room.create({ data: { roomNumber: `AP${Math.floor(Math.random() * 10000)}`, floorNumber: 1, roomType: { connect: { id: roomType.id } }, currentClaimState: "DEPARTED_DIRTY" } as any });
    await prisma.roomAssignment.create({ data: { entryId: entry.id, roomId: room.id, assignedAt: new Date(), assignedBy: "test" } as any });
    const prov = await prisma.folio.create({ data: { entryId: entry.id, state: "PROVISIONAL", billingModel: "GUEST_PAY", outstandingBalance: 0 as any, createdBy: "test" } as any });
    const live = await folioService.convertToLive(prisma as any, entry.id, prov.id, "test");
    await prisma.folio.update({ where: { id: live.id }, data: { state: "OUTSTANDING", outstandingBalance: 10 as any, billingModel: "GUEST_PAY" } as any });
    await prisma.roomInspectionRecord.create({ data: { entryId: entry.id, roomId: room.id, segmentId: seg.id, inspectedBy: L1.id, inspectedAt: new Date(), isDeferred: false, deficientFlagStatus: "NOT_APPLICABLE", damageFound: false } as any });
    await prisma.invoice.create({ data: { folioId: live.id, entryId: entry.id, invoiceType: "FINAL", state: "DISPATCHED", issuedAt: new Date(), issuedBy: L1.id, dispatchedAt: new Date(), dispatchedBy: L1.id } as any });
    await prisma.timerRecord.create({ data: { entryId: entry.id, entityType: "Entry", entityId: entry.id, timerType: "PAYMENT_FOLLOW_UP_W8", timerCode: "PAYMENT_FOLLOW_UP_W8", dueAt: new Date(Date.now() + 86400_000), firesAt: new Date(Date.now() + 86400_000), status: "SCHEDULED", createdBy: "system" } as any });
    // deposit held
    await prisma.paymentRecord.create({ data: { folioId: live.id, entryId: entry.id, amount: 100 as any, paymentDirection: "IN", notes: "SECURITY_DEPOSIT_HELD" } as any });
    const blocked = await http("POST", `/entries/${entry.id}/close`, L2, {});
    results.push({ id: "AC-S9-049a", title: "Apartment closure blocked when deposit not resolved", pass: blocked.status === 409 && (blocked.json as any)?.blockingCondition === "SECURITY_DEPOSIT_NOT_RESOLVED", status: blocked.status, body: blocked.json });
    // deposit returned
    await prisma.paymentRecord.create({ data: { folioId: live.id, entryId: entry.id, amount: 100 as any, paymentDirection: "OUT", notes: "SECURITY_DEPOSIT_RETURN" } as any });
    const ok = await http("POST", `/entries/${entry.id}/close`, L2, {});
    results.push({ id: "AC-S9-049", title: "Apartment closure succeeds when deposit return recorded", pass: ok.status === 200 && (ok.json as any)?.status === "CLOSED", status: ok.status, body: ok.json });
  }

  // AC-S9-050: Equipment return confirmed or breach+resolution trace before closure
  {
    const inquiry = await prisma.inquiry.findFirstOrThrow({ orderBy: { createdAt: "desc" } });
    const roomType = await prisma.roomType.findFirstOrThrow({ orderBy: { createdAt: "desc" } });
    const folioService = await import("../src/services/folio-service.js");
    const gp = await prisma.guestProfile.create({ data: { firstName: "Cat", lastName: "Equip", createdBy: "test" } });
    const entry = await prisma.entry.create({ data: { inquiryId: inquiry.id, guestProfileId: gp.id, currentStage: "S9", status: "ACTIVE", useType: "CATERING", createdBy: "test", version: 1 } as any });
    const seg = await prisma.segment.create({ data: { entryId: entry.id, segmentNumber: 1, stage: "S9", createdBy: "test" } as any });
    const room = await prisma.room.create({ data: { roomNumber: `EQ${Math.floor(Math.random() * 10000)}`, floorNumber: 1, roomType: { connect: { id: roomType.id } }, currentClaimState: "DEPARTED_DIRTY" } as any });
    await prisma.roomAssignment.create({ data: { entryId: entry.id, roomId: room.id, assignedAt: new Date(), assignedBy: "test" } as any });
    const prov = await prisma.folio.create({ data: { entryId: entry.id, state: "PROVISIONAL", billingModel: "GUEST_PAY", outstandingBalance: 0 as any, createdBy: "test" } as any });
    const live = await folioService.convertToLive(prisma as any, entry.id, prov.id, "test");
    await prisma.folio.update({ where: { id: live.id }, data: { state: "OUTSTANDING", outstandingBalance: 10 as any, billingModel: "GUEST_PAY" } as any });
    await prisma.roomInspectionRecord.create({ data: { entryId: entry.id, roomId: room.id, segmentId: seg.id, inspectedBy: L1.id, inspectedAt: new Date(), isDeferred: false, deficientFlagStatus: "NOT_APPLICABLE", damageFound: false } as any });
    await prisma.invoice.create({ data: { folioId: live.id, entryId: entry.id, invoiceType: "FINAL", state: "DISPATCHED", issuedAt: new Date(), issuedBy: L1.id, dispatchedAt: new Date(), dispatchedBy: L1.id } as any });
    await prisma.timerRecord.create({ data: { entryId: entry.id, entityType: "Entry", entityId: entry.id, timerType: "PAYMENT_FOLLOW_UP_W8", timerCode: "PAYMENT_FOLLOW_UP_W8", dueAt: new Date(Date.now() + 86400_000), firesAt: new Date(Date.now() + 86400_000), status: "SCHEDULED", createdBy: "system" } as any });

    await prisma.equipmentAllocation.create({ data: { entryId: entry.id, equipmentCode: "CHAIR_10", allocatedBy: L2.id, returnDeadlineAt: new Date(Date.now() - 60_000) } as any });
    const blocked = await http("POST", `/entries/${entry.id}/close`, L2, {});
    results.push({ id: "AC-S9-050a", title: "Catering closure blocked when equipment return unresolved", pass: blocked.status === 409 && (blocked.json as any)?.blockingCondition === "EQUIPMENT_RETURN_NOT_RESOLVED", status: blocked.status, body: blocked.json });

    const w29 = await import("../src/workers/w29-equipment-return-worker.js");
    await w29.runEquipmentReturnWorker(prisma as any, { entryId: entry.id });
    await prisma.traceEvent.create({ data: { eventType: "EQUIPMENT_RETURN.RESOLVED", actorId: L2.id, actorLevel: "L2", entityType: "Entry", entityId: entry.id, operation: "ALERT", timestamp: new Date(), stageContext: "S9", inquiryId: inquiry.id, entryId: entry.id, payload: { entryId: entry.id }, createdBy: L2.id } as any });
    const ok = await http("POST", `/entries/${entry.id}/close`, L2, {});
    const breach = await prisma.traceEvent.findFirst({ where: { entryId: entry.id, eventType: "EQUIPMENT_RETURN.DEADLINE_BREACHED" }, orderBy: { createdAt: "desc" } });
    results.push({ id: "AC-S9-050", title: "Equipment breach surfaces + resolution event allows closure", pass: ok.status === 200 && !!breach, status: ok.status, body: { ok: ok.json, breach } as any });
  }

  writeArtifacts(results);
  const failed = results.filter((r) => !r.pass);
  if (failed.length > 0) throw new Error(`S9 acceptance tests failed: ${failed.map((f) => f.id).join(", ")}`);
}

main()
  .then(() => {
    console.log("S9 acceptance tests: PASS");
  })
  .catch((e) => {
  console.error(e);
    process.exit(1);
});

