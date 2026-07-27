import { prisma } from "../src/db.js";
import { startWorkers } from "../src/workers/runner.js";
import { placeSpeculativeHold } from "../src/services/s2-hold-service.js";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function msToSeconds(ms: number) {
  return Math.round((ms / 1000) * 10) / 10;
}

async function waitForTimer(timerId: string, timeoutMs: number) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const row = await prisma.timerRecord.findUnique({ where: { id: timerId } });
    if (row?.status === "FIRED" && row.firedAt) return row;
    await sleep(500);
  }
  return null;
}

async function waitForTraceEvent(
  where: { eventType: string; entityType?: string; entityId?: string; entryId?: string | null },
  timeoutMs: number,
) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const row = await prisma.traceEvent.findFirst({
      where: {
        eventType: where.eventType,
        ...(where.entityType ? { entityType: where.entityType } : {}),
        ...(where.entityId ? { entityId: where.entityId } : {}),
        ...(where.entryId !== undefined ? { entryId: where.entryId } : {}),
      } as any,
      orderBy: { createdAt: "desc" },
    });
    if (row) return row as any;
    await sleep(250);
  }
  return null;
}

async function main() {
  const engine = await startWorkers();
  const now = new Date();

  const results: Array<{
    name: string;
    timerCode: string;
    timerId: string;
    expectedWaitSeconds: number;
    observedWaitSeconds: number | null;
    status: string;
    notes?: string;
  }> = [];

  // Helper: records without TimerRecord still need a consistent shape in the report.
  function pushNonTimerResult(r: { name: string; timerCode: string; notes?: string; pass: boolean }) {
    results.push({
      name: r.name,
      timerCode: r.timerCode,
      timerId: "(no TimerRecord)",
      expectedWaitSeconds: 0,
      observedWaitSeconds: null,
      status: r.pass ? "PASS" : "FAIL",
      notes: r.notes,
    });
  }

  function pushTraceResult(r: {
    name: string;
    timerCode: string;
    scheduledAt: Date;
    expectedWaitSeconds: number;
    trace: { createdAt?: Date } | null;
    notes?: string;
  }) {
    results.push({
      name: r.name,
      timerCode: r.timerCode,
      timerId: "(trace)",
      expectedWaitSeconds: r.expectedWaitSeconds,
      observedWaitSeconds: r.trace?.createdAt ? msToSeconds(r.trace.createdAt.getTime() - r.scheduledAt.getTime()) : null,
      status: r.trace ? "PASS" : "FAIL",
      notes: r.notes,
    });
  }

  // ---------------- W2 (SPECULATIVE_HOLD_EXPIRY_W2) ----------------
  {
    const actor = { actorId: "timer-test", actorLevel: "L1" as const };
    const room = await prisma.room.findFirst({ where: { currentClaimState: "FREE" }, orderBy: { createdAt: "desc" } });
    if (!room) throw new Error("No FREE room found");

    const gp = await prisma.guestProfile.create({ data: { firstName: "Timer", lastName: "W2", createdBy: actor.actorId } as any });
    const inquiry = await prisma.inquiry.create({
      data: { referenceNumber: `TIMER-W2-${Date.now()}`, guestProfileId: gp.id, defaultCustodianId: actor.actorId, sourceChannel: "DIRECT", createdBy: actor.actorId } as any,
    });
    const entry = await prisma.entry.create({ data: { inquiryId: inquiry.id, guestProfileId: gp.id, currentStage: "S2", createdBy: actor.actorId } as any });
    await prisma.segment.create({ data: { entryId: entry.id, segmentNumber: 1, stage: "S2", createdBy: actor.actorId } as any });

    const ttlSeconds = 15;
    const scheduledAt = new Date();
    const hold = await placeSpeculativeHold(prisma, entry.id, actor, { roomId: room.id, ttlSeconds, commercialBasis: "Realtime W2", notes: "auto" });
    const timer = await prisma.timerRecord.findFirstOrThrow({
      where: { entryId: entry.id, entityType: "SpeculativeHold", entityId: hold.id, timerCode: "SPECULATIVE_HOLD_EXPIRY_W2" },
      orderBy: { createdAt: "desc" },
    });

    const expected = msToSeconds(timer.firesAt.getTime() - scheduledAt.getTime());
    const fired = await waitForTimer(timer.id, 330_000);
    results.push({
      name: "W2 SpeculativeHold expiry",
      timerCode: timer.timerCode,
      timerId: timer.id,
      expectedWaitSeconds: expected,
      observedWaitSeconds: fired?.firedAt ? msToSeconds(fired.firedAt.getTime() - scheduledAt.getTime()) : null,
      status: fired?.status ?? timer.status,
    });
  }

  // ---------------- W3 (COMMITTED_HOLD_EXPIRY_W3) ----------------
  {
    const actorId = "timer-test";
    const room = await prisma.room.findFirst({ where: { currentClaimState: "FREE" }, orderBy: { createdAt: "desc" } });
    const roomType = await prisma.roomType.findFirst({ orderBy: { createdAt: "desc" } });
    if (!room || !roomType) throw new Error("Missing room/roomType for W3 test");

    const gp = await prisma.guestProfile.create({ data: { firstName: "Timer", lastName: "W3", createdBy: actorId } as any });
    const inquiry = await prisma.inquiry.create({
      data: { referenceNumber: `TIMER-W3-${Date.now()}`, guestProfileId: gp.id, defaultCustodianId: actorId, sourceChannel: "DIRECT", createdBy: actorId } as any,
    });
    const entry = await prisma.entry.create({ data: { inquiryId: inquiry.id, guestProfileId: gp.id, currentStage: "S3", createdBy: actorId } as any });
    const seg = await prisma.segment.create({ data: { entryId: entry.id, segmentNumber: 1, stage: "S3", createdBy: actorId } as any });

    // mark room as committed-held to match worker's fromState assumption
    await prisma.room.update({ where: { id: room.id }, data: { currentClaimState: "COMMITTED_HELD" } as any });
    const expiresAt = new Date(Date.now() + 10_000);
    const hold = await prisma.committedHold.create({
      data: {
        entryId: entry.id,
        segmentId: seg.id,
        roomId: room.id,
        roomTypeId: roomType.id,
        state: "PLACED",
        placedBy: actorId,
        ttlSeconds: 10,
        expiresAt,
      } as any,
    });

    const timerId = randomUUID();
    const scheduledAt = new Date();
    const jobId = await engine.schedule("COMMITTED_HOLD_EXPIRY_W3", { committedHoldId: hold.id, timerRecordId: timerId }, { startAfter: expiresAt });
    await prisma.timerRecord.create({
      data: {
        id: timerId,
        entryId: entry.id,
        entityType: "CommittedHold",
        entityId: hold.id,
        timerType: "COMMITTED_HOLD_EXPIRY_W3",
        timerCode: "COMMITTED_HOLD_EXPIRY_W3",
        dueAt: expiresAt,
        firesAt: expiresAt,
        status: "SCHEDULED",
        pgBossJobId: jobId,
        createdBy: actorId,
      } as any,
    });

    const fired = await waitForTimer(timerId, 330_000);
    results.push({
      name: "W3 CommittedHold expiry",
      timerCode: "COMMITTED_HOLD_EXPIRY_W3",
      timerId,
      expectedWaitSeconds: msToSeconds(expiresAt.getTime() - scheduledAt.getTime()),
      observedWaitSeconds: fired?.firedAt ? msToSeconds(fired.firedAt.getTime() - scheduledAt.getTime()) : null,
      status: fired?.status ?? "SCHEDULED",
      notes: "This creates a minimal CommittedHold row and schedules expiry near-now.",
    });
  }

  // ---------------- W9 (POST_CHECKOUT_INSPECTION_W9) ----------------
  {
    const actorId = "timer-test";
    const gp = await prisma.guestProfile.create({ data: { firstName: "Timer", lastName: "W9", createdBy: actorId } as any });
    const inquiry = await prisma.inquiry.create({
      data: { referenceNumber: `TIMER-W9-${Date.now()}`, guestProfileId: gp.id, defaultCustodianId: actorId, sourceChannel: "DIRECT", createdBy: actorId } as any,
    });
    const entry = await prisma.entry.create({ data: { inquiryId: inquiry.id, guestProfileId: gp.id, currentStage: "S8", createdBy: actorId } as any });
    const room = await prisma.room.findFirst({ orderBy: { createdAt: "desc" } });
    if (!room) throw new Error("No room found for W9 test");
    const seg = await prisma.segment.create({ data: { entryId: entry.id, segmentNumber: 1, stage: "S8", createdBy: actorId } as any });
    await prisma.roomInspectionRecord.create({
      data: {
        entryId: entry.id,
        roomId: room.id,
        segmentId: seg.id,
        inspectedBy: actorId,
        inspectedAt: new Date(),
        isDeferred: true,
        deficientFlagStatus: "NOT_APPLICABLE",
        damageFound: false,
      } as any,
    });

    const dueAt = new Date(Date.now() + 12_000);
    const timerId = randomUUID();
    const scheduledAt = new Date();
    const jobId = await engine.schedule("POST_CHECKOUT_INSPECTION_W9", { entryId: entry.id, timerRecordId: timerId }, { startAfter: dueAt });
    await prisma.timerRecord.create({
      data: {
        id: timerId,
        entryId: entry.id,
        entityType: "Entry",
        entityId: entry.id,
        timerType: "POST_CHECKOUT_INSPECTION_W9",
        timerCode: "POST_CHECKOUT_INSPECTION_W9",
        dueAt,
        firesAt: dueAt,
        status: "SCHEDULED",
        pgBossJobId: jobId,
        createdBy: actorId,
      } as any,
    });

    const fired = await waitForTimer(timerId, 330_000);
    results.push({
      name: "W9 Post-checkout inspection window",
      timerCode: "POST_CHECKOUT_INSPECTION_W9",
      timerId,
      expectedWaitSeconds: msToSeconds(dueAt.getTime() - scheduledAt.getTime()),
      observedWaitSeconds: fired?.firedAt ? msToSeconds(fired.firedAt.getTime() - scheduledAt.getTime()) : null,
      status: fired?.status ?? "SCHEDULED",
      notes: "This uses an explicit near-now dueAt for realtime validation.",
    });
  }

  // ---------------- W11 (COMMISSION_RATE_MISSING_W11) ----------------
  {
    const actorId = "timer-test";
    const gp = await prisma.guestProfile.create({ data: { firstName: "Timer", lastName: "W11", createdBy: actorId } as any });
    const inquiry = await prisma.inquiry.create({
      data: { referenceNumber: `TIMER-W11-${Date.now()}`, guestProfileId: gp.id, defaultCustodianId: actorId, sourceChannel: "DIRECT", createdBy: actorId } as any,
    });
    const entry = await prisma.entry.create({ data: { inquiryId: inquiry.id, guestProfileId: gp.id, currentStage: "S9", status: "CLOSED", createdBy: actorId } as any });
    const agent = await prisma.agentProfile.create({ data: { displayName: "Timer Agent", commissionRate: "0.10" as any, commissionBasis: null, createdBy: actorId } as any });
    await prisma.inquiry.update({ where: { id: inquiry.id }, data: { agentProfileId: agent.id } as any });
    const due = await prisma.commissionDueRecord.create({
      data: { entryId: entry.id, agentProfileId: agent.id, commissionRate: "0.10" as any, commissionBasis: null, calculatedAmount: null, currency: "BTN", status: "RATE_MISSING", createdBy: actorId } as any,
    });

    const dueAt = new Date(Date.now() + 10_000);
    const timerId = randomUUID();
    const scheduledAt = new Date();
    const jobId = await engine.schedule("COMMISSION_RATE_MISSING_W11", { commissionDueId: due.id, timerRecordId: timerId }, { startAfter: dueAt });
    await prisma.timerRecord.create({
      data: {
        id: timerId,
        entryId: entry.id,
        entityType: "CommissionDueRecord",
        entityId: due.id,
        timerType: "COMMISSION_RATE_MISSING_W11",
        timerCode: "COMMISSION_RATE_MISSING_W11",
        dueAt,
        firesAt: dueAt,
        status: "SCHEDULED",
        pgBossJobId: jobId,
        createdBy: actorId,
        payload: { commissionDueId: due.id, timerRecordId: timerId },
      } as any,
    });

    const fired = await waitForTimer(timerId, 330_000);
    results.push({
      name: "W11 Commission rate missing escalation",
      timerCode: "COMMISSION_RATE_MISSING_W11",
      timerId,
      expectedWaitSeconds: msToSeconds(dueAt.getTime() - scheduledAt.getTime()),
      observedWaitSeconds: fired?.firedAt ? msToSeconds(fired.firedAt.getTime() - scheduledAt.getTime()) : null,
      status: fired?.status ?? "SCHEDULED",
      notes: "This uses an explicit near-now dueAt for realtime validation.",
    });
  }

  // ---------------- W28 (FEEDBACK_SOLICITATION_W28) ----------------
  {
    const actorId = "timer-test";
    const gp = await prisma.guestProfile.create({ data: { firstName: "Timer", lastName: "W28", createdBy: actorId } as any });
    const inquiry = await prisma.inquiry.create({
      data: { referenceNumber: `TIMER-W28-${Date.now()}`, guestProfileId: gp.id, defaultCustodianId: actorId, sourceChannel: "DIRECT", createdBy: actorId } as any,
    });
    const entry = await prisma.entry.create({ data: { inquiryId: inquiry.id, guestProfileId: gp.id, currentStage: "S9", status: "CLOSED", createdBy: actorId } as any });

    const dueAt = new Date(Date.now() + 8_000);
    const timerId = randomUUID();
    const scheduledAt = new Date();
    const jobId = await engine.schedule("FEEDBACK_SOLICITATION_W28", { entryId: entry.id, timerRecordId: timerId }, { startAfter: dueAt });
    await prisma.timerRecord.create({
      data: {
        id: timerId,
        entryId: entry.id,
        entityType: "Entry",
        entityId: entry.id,
        timerType: "FEEDBACK_SOLICITATION_W28",
        timerCode: "FEEDBACK_SOLICITATION_W28",
        dueAt,
        firesAt: dueAt,
        status: "SCHEDULED",
        pgBossJobId: jobId,
        createdBy: actorId,
      } as any,
    });

    const fired = await waitForTimer(timerId, 330_000);
    results.push({
      name: "W28 Feedback solicitation",
      timerCode: "FEEDBACK_SOLICITATION_W28",
      timerId,
      expectedWaitSeconds: msToSeconds(dueAt.getTime() - scheduledAt.getTime()),
      observedWaitSeconds: fired?.firedAt ? msToSeconds(fired.firedAt.getTime() - scheduledAt.getTime()) : null,
      status: fired?.status ?? "SCHEDULED",
      notes: "This uses an explicit near-now dueAt for realtime validation.",
    });
  }

  // ---------------- W29 (EQUIPMENT_RETURN_W29) ----------------
  {
    const actorId = "timer-test";
    const gp = await prisma.guestProfile.create({ data: { firstName: "Timer", lastName: "W29", createdBy: actorId } as any });
    const inquiry = await prisma.inquiry.create({
      data: { referenceNumber: `TIMER-W29-${Date.now()}`, guestProfileId: gp.id, defaultCustodianId: actorId, sourceChannel: "DIRECT", createdBy: actorId } as any,
    });
    const entry = await prisma.entry.create({ data: { inquiryId: inquiry.id, guestProfileId: gp.id, currentStage: "S9", status: "CLOSED", createdBy: actorId } as any });

    const deadline = new Date(Date.now() + 9_000);
    await prisma.equipmentAllocation.create({
      data: { entryId: entry.id, equipmentCode: "CATERING-01", allocatedBy: actorId, returnDeadlineAt: deadline } as any,
    });

    const timerId = randomUUID();
    const scheduledAt = new Date();
    const jobId = await engine.schedule("EQUIPMENT_RETURN_W29", { entryId: entry.id, timerRecordId: timerId }, { startAfter: deadline });
    await prisma.timerRecord.create({
      data: {
        id: timerId,
        entryId: entry.id,
        entityType: "Entry",
        entityId: entry.id,
        timerType: "EQUIPMENT_RETURN_W29",
        timerCode: "EQUIPMENT_RETURN_W29",
        dueAt: deadline,
        firesAt: deadline,
        status: "SCHEDULED",
        pgBossJobId: jobId,
        createdBy: actorId,
      } as any,
    });

    const fired = await waitForTimer(timerId, 330_000);
    results.push({
      name: "W29 Equipment return deadline",
      timerCode: "EQUIPMENT_RETURN_W29",
      timerId,
      expectedWaitSeconds: msToSeconds(deadline.getTime() - scheduledAt.getTime()),
      observedWaitSeconds: fired?.firedAt ? msToSeconds(fired.firedAt.getTime() - scheduledAt.getTime()) : null,
      status: fired?.status ?? "SCHEDULED",
      notes: "This uses an explicit near-now deadline for realtime validation.",
    });
  }

  // ---------------- W8 (PAYMENT_FOLLOW_UP_W8) ----------------
  {
    const actorId = "timer-test";
    const gp = await prisma.guestProfile.create({ data: { firstName: "Timer", lastName: "W8", createdBy: actorId } as any });
    const inquiry = await prisma.inquiry.create({
      data: { referenceNumber: `TIMER-W8-${Date.now()}`, guestProfileId: gp.id, defaultCustodianId: actorId, sourceChannel: "DIRECT", createdBy: actorId } as any,
    });
    const entry = await prisma.entry.create({ data: { inquiryId: inquiry.id, guestProfileId: gp.id, currentStage: "S9", status: "CLOSED", createdBy: actorId } as any });
    const folio = await prisma.folio.create({
      data: { entryId: entry.id, state: "OUTSTANDING", outstandingBalance: "250" as any, createdBy: actorId } as any,
    });
    void folio;

    const dueAt = new Date(Date.now() + 6_000);
    const timerId = randomUUID();
    const scheduledAt = new Date();
    const jobId = await engine.schedule("PAYMENT_FOLLOW_UP_W8", { entryId: entry.id, timerRecordId: timerId }, { startAfter: dueAt });
    await prisma.timerRecord.create({
      data: {
        id: timerId,
        entryId: entry.id,
        entityType: "Entry",
        entityId: entry.id,
        timerType: "PAYMENT_FOLLOW_UP_W8",
        timerCode: "PAYMENT_FOLLOW_UP_W8",
        dueAt,
        firesAt: dueAt,
        status: "SCHEDULED",
        pgBossJobId: jobId,
        createdBy: actorId,
      } as any,
    });

    const fired = await waitForTimer(timerId, 330_000);
    results.push({
      name: "W8 Payment follow-up",
      timerCode: "PAYMENT_FOLLOW_UP_W8",
      timerId,
      expectedWaitSeconds: msToSeconds(dueAt.getTime() - scheduledAt.getTime()),
      observedWaitSeconds: fired?.firedAt ? msToSeconds(fired.firedAt.getTime() - scheduledAt.getTime()) : null,
      status: fired?.status ?? "SCHEDULED",
      notes: "Schedules pg-boss job and verifies TimerRecord flips to FIRED.",
    });
  }

  // ---------------- W24 (HOUSEKEEPING_SLA_W24) ----------------
  {
    const actorId = "timer-test";
    const gp = await prisma.guestProfile.create({ data: { firstName: "Timer", lastName: "W24", createdBy: actorId } as any });
    const inquiry = await prisma.inquiry.create({
      data: { referenceNumber: `TIMER-W24-${Date.now()}`, guestProfileId: gp.id, defaultCustodianId: actorId, sourceChannel: "DIRECT", createdBy: actorId } as any,
    });
    const entry = await prisma.entry.create({ data: { inquiryId: inquiry.id, guestProfileId: gp.id, currentStage: "S8", createdBy: actorId } as any });
    const room = await prisma.room.findFirst({ orderBy: { createdAt: "desc" } });
    if (!room) throw new Error("No room found for W24 test");

    const dueAt = new Date(Date.now() + 6_000);
    const timerId = randomUUID();
    const scheduledAt = new Date();
    const jobId = await engine.schedule("HOUSEKEEPING_SLA_W24", { entryId: entry.id, roomId: room.id, timerRecordId: timerId }, { startAfter: dueAt });
    await prisma.timerRecord.create({
      data: {
        id: timerId,
        entryId: entry.id,
        entityType: "Room",
        entityId: room.id,
        timerType: "HOUSEKEEPING_SLA_W24",
        timerCode: "HOUSEKEEPING_SLA_W24",
        dueAt,
        firesAt: dueAt,
        status: "SCHEDULED",
        pgBossJobId: jobId,
        createdBy: actorId,
        payload: { roomId: room.id, entryId: entry.id },
      } as any,
    });

    const fired = await waitForTimer(timerId, 330_000);
    results.push({
      name: "W24 Housekeeping SLA breach",
      timerCode: "HOUSEKEEPING_SLA_W24",
      timerId,
      expectedWaitSeconds: msToSeconds(dueAt.getTime() - scheduledAt.getTime()),
      observedWaitSeconds: fired?.firedAt ? msToSeconds(fired.firedAt.getTime() - scheduledAt.getTime()) : null,
      status: fired?.status ?? "SCHEDULED",
      notes: "Schedules pg-boss job and verifies TimerRecord flips to FIRED.",
    });
  }

  // ---------------- P18 (GUEST_DATA_RETENTION_P18) ----------------
  {
    const actorId = "timer-test";
    const gp = await prisma.guestProfile.create({ data: { firstName: "Timer", lastName: "P18", createdBy: actorId } as any });
    const inquiry = await prisma.inquiry.create({
      data: { referenceNumber: `TIMER-P18-${Date.now()}`, guestProfileId: gp.id, defaultCustodianId: actorId, sourceChannel: "DIRECT", createdBy: actorId } as any,
    });
    const entry = await prisma.entry.create({ data: { inquiryId: inquiry.id, guestProfileId: gp.id, currentStage: "S9", status: "CLOSED", createdBy: actorId } as any });

    const dueAt = new Date(Date.now() + 6_000);
    const timerId = randomUUID();
    const scheduledAt = new Date();
    const jobId = await engine.schedule("GUEST_DATA_RETENTION_P18", { entryId: entry.id, timerRecordId: timerId }, { startAfter: dueAt });
    await prisma.timerRecord.create({
      data: {
        id: timerId,
        entryId: entry.id,
        entityType: "Entry",
        entityId: entry.id,
        timerType: "GUEST_DATA_RETENTION_P18",
        timerCode: "GUEST_DATA_RETENTION_P18",
        dueAt,
        firesAt: dueAt,
        status: "SCHEDULED",
        pgBossJobId: jobId,
        createdBy: actorId,
      } as any,
    });
    const fired = await waitForTimer(timerId, 330_000);
    results.push({
      name: "P18 Guest data retention (code path for W30)",
      timerCode: "GUEST_DATA_RETENTION_P18",
      timerId,
      expectedWaitSeconds: msToSeconds(dueAt.getTime() - scheduledAt.getTime()),
      observedWaitSeconds: fired?.firedAt ? msToSeconds(fired.firedAt.getTime() - scheduledAt.getTime()) : null,
      status: fired?.status ?? "SCHEDULED",
    });
  }

  // ---------------- W6 (NIGHT_AUDIT_W6) ----------------
  {
    const scheduledAt = new Date();
    const dueAt = new Date(Date.now() + 4_000);
    await engine.schedule("NIGHT_AUDIT_W6", { operatingDate: new Date().toISOString(), actorId: "SYSTEM" }, { startAfter: dueAt });
    const trace = await waitForTraceEvent({ eventType: "NIGHT_AUDIT.W6_FIRED", entityType: "NightAuditRecord" }, 60_000);
    pushTraceResult({
      name: "W6 Night audit",
      timerCode: "NIGHT_AUDIT_W6",
      scheduledAt,
      expectedWaitSeconds: msToSeconds(dueAt.getTime() - scheduledAt.getTime()),
      trace,
      notes: "Validated via TraceEvent (night audit writes immutable NightAuditRecord instead of TimerRecord).",
    });
  }

  // ---------------- W7 (OTA_EMAIL_PARSER_POLL) ----------------
  {
    const scheduledAt = new Date();
    const dueAt = new Date(Date.now() + 4_000);
    const pollId = `poll-${Date.now()}`;
    await engine.schedule("OTA_EMAIL_PARSER_POLL", { pollId }, { startAfter: dueAt });
    const trace = await waitForTraceEvent({ eventType: "OTA_EMAIL_PARSER_POLL.NOOP", entityType: "System", entityId: "W7" }, 60_000);
    pushTraceResult({
      name: "W7 OTA email poll (noop wiring)",
      timerCode: "OTA_EMAIL_PARSER_POLL",
      scheduledAt,
      expectedWaitSeconds: msToSeconds(dueAt.getTime() - scheduledAt.getTime()),
      trace,
      notes: "Repo slice has no IMAP integration; worker is wired and emits a NOOP trace.",
    });
  }

  // ---------------- W12 (CREDIT_CEILING_MONITORING_W12) ----------------
  {
    const actorId = "timer-test";
    const gp = await prisma.guestProfile.create({ data: { firstName: "Timer", lastName: "W12", createdBy: actorId } as any });
    const inquiry = await prisma.inquiry.create({
      data: { referenceNumber: `TIMER-W12-${Date.now()}`, guestProfileId: gp.id, defaultCustodianId: actorId, sourceChannel: "DIRECT", createdBy: actorId } as any,
    });
    const entry = await prisma.entry.create({ data: { inquiryId: inquiry.id, guestProfileId: gp.id, currentStage: "S7", createdBy: actorId } as any });
    const dueAt = new Date(Date.now() + 6_000);
    const timerId = randomUUID();
    const scheduledAt = new Date();
    const jobId = await engine.schedule(
      "CREDIT_CEILING_MONITORING_W12",
      { entryId: entry.id, folioId: "FOLIO", thresholdPercent: 75, timerRecordId: timerId },
      { startAfter: dueAt },
    );
    await prisma.timerRecord.create({
      data: {
        id: timerId,
        entryId: entry.id,
        entityType: "Entry",
        entityId: entry.id,
        timerType: "CREDIT_CEILING_MONITORING_W12",
        timerCode: "CREDIT_CEILING_MONITORING_W12",
        dueAt,
        firesAt: dueAt,
        status: "SCHEDULED",
        pgBossJobId: jobId,
        createdBy: actorId,
      } as any,
    });
    const fired = await waitForTimer(timerId, 330_000);
    results.push({
      name: "W12 Credit ceiling monitoring",
      timerCode: "CREDIT_CEILING_MONITORING_W12",
      timerId,
      expectedWaitSeconds: msToSeconds(dueAt.getTime() - scheduledAt.getTime()),
      observedWaitSeconds: fired?.firedAt ? msToSeconds(fired.firedAt.getTime() - scheduledAt.getTime()) : null,
      status: fired?.status ?? "SCHEDULED",
    });
  }

  // ---------------- W18 (AI_AUDIT_SUPPLEMENT_W18) ----------------
  {
    const scheduledAt = new Date();
    const dueAt = new Date(Date.now() + 4_000);
    await engine.schedule("AI_AUDIT_SUPPLEMENT_W18", { nightAuditRecordId: "NA" }, { startAfter: dueAt });
    const trace = await waitForTraceEvent({ eventType: "AI_AUDIT_SUPPLEMENT.W18_NOOP", entityType: "NightAuditRecord" }, 60_000);
    pushTraceResult({
      name: "W18 AI audit supplement (noop wiring)",
      timerCode: "AI_AUDIT_SUPPLEMENT_W18",
      scheduledAt,
      expectedWaitSeconds: msToSeconds(dueAt.getTime() - scheduledAt.getTime()),
      trace,
    });
  }

  // ---------------- W32 (FOM_OVERRIDE_FREQUENCY_W32) ----------------
  {
    // Create enough overrides inside the rolling window to exceed the configured maxFrequency and force an emitted trace.
    const actorId = "timer-test";
    const gp = await prisma.guestProfile.create({ data: { firstName: "Timer", lastName: "W32", createdBy: actorId } as any });
    const inquiry = await prisma.inquiry.create({
      data: { referenceNumber: `TIMER-W32-${Date.now()}`, guestProfileId: gp.id, defaultCustodianId: actorId, sourceChannel: "DIRECT", createdBy: actorId } as any,
    });
    const entry = await prisma.entry.create({ data: { inquiryId: inquiry.id, guestProfileId: gp.id, currentStage: "S7", createdBy: actorId } as any });
    const folio = await prisma.folio.create({ data: { entryId: entry.id, state: "PROVISIONAL", outstandingBalance: "0" as any, createdBy: actorId } as any });
    const dispute = await prisma.disputeRecord.create({ data: { entryId: entry.id, folioId: folio.id, title: "W32", openedBy: actorId } as any });
    await prisma.disputeGateOverrideRecord.createMany({
      data: [
        { disputeId: dispute.id, targetStage: "S8", freeTextReason: "test-1", createdBy: actorId } as any,
        { disputeId: dispute.id, targetStage: "S8", freeTextReason: "test-2", createdBy: actorId } as any,
      ],
    });

    const scheduledAt = new Date();
    const dueAt = new Date(Date.now() + 4_000);
    const timerId = randomUUID();
    const jobId = await engine.schedule("FOM_OVERRIDE_FREQUENCY_W32", { now: new Date(), timerRecordId: timerId }, { startAfter: dueAt });
    await prisma.timerRecord.create({
      data: {
        id: timerId,
        entryId: entry.id,
        entityType: "DisputeGateOverrideRecord",
        entityId: dispute.id,
        timerType: "FOM_OVERRIDE_FREQUENCY_W32",
        timerCode: "FOM_OVERRIDE_FREQUENCY_W32",
        dueAt,
        firesAt: dueAt,
        status: "SCHEDULED",
        pgBossJobId: jobId,
        createdBy: actorId,
      } as any,
    });
    const fired = await waitForTimer(timerId, 330_000);
    results.push({
      name: "W32 FOM override frequency monitor",
      timerCode: "FOM_OVERRIDE_FREQUENCY_W32",
      timerId,
      expectedWaitSeconds: msToSeconds(dueAt.getTime() - scheduledAt.getTime()),
      observedWaitSeconds: fired?.firedAt ? msToSeconds(fired.firedAt.getTime() - scheduledAt.getTime()) : null,
      status: fired?.status ?? "SCHEDULED",
      notes: "Validated via TimerRecord (worker marks FIRED when timerRecordId is supplied).",
    });
  }

  // ---------------- W10 (DEFICIENT_RESOLUTION_DEADLINE_W10) ----------------
  {
    const actorId = "timer-test";
    const room = await prisma.room.findFirst({ orderBy: { createdAt: "desc" } });
    if (!room) throw new Error("No room found for W10 test");
    const gp = await prisma.guestProfile.create({ data: { firstName: "Timer", lastName: "W10", createdBy: actorId } as any });
    const inquiry = await prisma.inquiry.create({
      data: { referenceNumber: `TIMER-W10-${Date.now()}`, guestProfileId: gp.id, defaultCustodianId: actorId, sourceChannel: "DIRECT", createdBy: actorId } as any,
    });
    const entry = await prisma.entry.create({ data: { inquiryId: inquiry.id, guestProfileId: gp.id, currentStage: "S7", createdBy: actorId } as any });
    const dueAt = new Date(Date.now() + 6_000);
    const timerId = randomUUID();
    const scheduledAt = new Date();
    const jobId = await engine.schedule("DEFICIENT_RESOLUTION_DEADLINE_W10", { entryId: entry.id, roomId: room.id, timerRecordId: timerId }, { startAfter: dueAt });
    await prisma.timerRecord.create({
      data: { id: timerId, entryId: entry.id, entityType: "Room", entityId: room.id, timerType: "DEFICIENT_RESOLUTION_DEADLINE_W10", timerCode: "DEFICIENT_RESOLUTION_DEADLINE_W10", dueAt, firesAt: dueAt, status: "SCHEDULED", pgBossJobId: jobId, createdBy: actorId } as any,
    });
    const fired = await waitForTimer(timerId, 330_000);
    results.push({
      name: "W10 Deficient resolution deadline",
      timerCode: "DEFICIENT_RESOLUTION_DEADLINE_W10",
      timerId,
      expectedWaitSeconds: msToSeconds(dueAt.getTime() - scheduledAt.getTime()),
      observedWaitSeconds: fired?.firedAt ? msToSeconds(fired.firedAt.getTime() - scheduledAt.getTime()) : null,
      status: fired?.status ?? "SCHEDULED",
    });
  }

  // ---------------- W21 (PAYMENT_MILESTONE_W21) ----------------
  {
    const actorId = "timer-test";
    const gp = await prisma.guestProfile.create({ data: { firstName: "Timer", lastName: "W21", createdBy: actorId } as any });
    const inquiry = await prisma.inquiry.create({
      data: { referenceNumber: `TIMER-W21-${Date.now()}`, guestProfileId: gp.id, defaultCustodianId: actorId, sourceChannel: "DIRECT", createdBy: actorId } as any,
    });
    const entry = await prisma.entry.create({ data: { inquiryId: inquiry.id, guestProfileId: gp.id, currentStage: "S7", createdBy: actorId } as any });
    const dueAt = new Date(Date.now() + 6_000);
    const timerId = randomUUID();
    const scheduledAt = new Date();
    const jobId = await engine.schedule("PAYMENT_MILESTONE_W21", { entryId: entry.id, milestone: "DUE", timerRecordId: timerId }, { startAfter: dueAt });
    await prisma.timerRecord.create({
      data: { id: timerId, entryId: entry.id, entityType: "Entry", entityId: entry.id, timerType: "PAYMENT_MILESTONE_W21", timerCode: "PAYMENT_MILESTONE_W21", dueAt, firesAt: dueAt, status: "SCHEDULED", pgBossJobId: jobId, createdBy: actorId } as any,
    });
    const fired = await waitForTimer(timerId, 330_000);
    results.push({
      name: "W21 Payment milestone",
      timerCode: "PAYMENT_MILESTONE_W21",
      timerId,
      expectedWaitSeconds: msToSeconds(dueAt.getTime() - scheduledAt.getTime()),
      observedWaitSeconds: fired?.firedAt ? msToSeconds(fired.firedAt.getTime() - scheduledAt.getTime()) : null,
      status: fired?.status ?? "SCHEDULED",
    });
  }

  // ---------------- W26 (CHECKOUT_TIME_W26) ----------------
  {
    const actorId = "timer-test";
    const gp = await prisma.guestProfile.create({ data: { firstName: "Timer", lastName: "W26", createdBy: actorId } as any });
    const inquiry = await prisma.inquiry.create({
      data: { referenceNumber: `TIMER-W26-${Date.now()}`, guestProfileId: gp.id, defaultCustodianId: actorId, sourceChannel: "DIRECT", createdBy: actorId } as any,
    });
    const entry = await prisma.entry.create({ data: { inquiryId: inquiry.id, guestProfileId: gp.id, currentStage: "S8", createdBy: actorId } as any });
    const dueAt = new Date(Date.now() + 6_000);
    const timerId = randomUUID();
    const scheduledAt = new Date();
    const jobId = await engine.schedule("CHECKOUT_TIME_W26", { entryId: entry.id, kind: "PROMPT", timerRecordId: timerId }, { startAfter: dueAt });
    await prisma.timerRecord.create({
      data: { id: timerId, entryId: entry.id, entityType: "Entry", entityId: entry.id, timerType: "CHECKOUT_TIME_W26", timerCode: "CHECKOUT_TIME_W26", dueAt, firesAt: dueAt, status: "SCHEDULED", pgBossJobId: jobId, createdBy: actorId } as any,
    });
    const fired = await waitForTimer(timerId, 330_000);
    results.push({
      name: "W26 Checkout time prompt",
      timerCode: "CHECKOUT_TIME_W26",
      timerId,
      expectedWaitSeconds: msToSeconds(dueAt.getTime() - scheduledAt.getTime()),
      observedWaitSeconds: fired?.firedAt ? msToSeconds(fired.firedAt.getTime() - scheduledAt.getTime()) : null,
      status: fired?.status ?? "SCHEDULED",
    });
  }

  // ---------------- W27 (DISPUTE_SLA_W27) ----------------
  {
    const actorId = "timer-test";
    const gp = await prisma.guestProfile.create({ data: { firstName: "Timer", lastName: "W27", createdBy: actorId } as any });
    const inquiry = await prisma.inquiry.create({
      data: { referenceNumber: `TIMER-W27-${Date.now()}`, guestProfileId: gp.id, defaultCustodianId: actorId, sourceChannel: "DIRECT", createdBy: actorId } as any,
    });
    const entry = await prisma.entry.create({ data: { inquiryId: inquiry.id, guestProfileId: gp.id, currentStage: "S8", createdBy: actorId } as any });
    const dueAt = new Date(Date.now() + 6_000);
    const timerId = randomUUID();
    const scheduledAt = new Date();
    const jobId = await engine.schedule("DISPUTE_SLA_W27", { entryId: entry.id, disputeId: "D", timerRecordId: timerId }, { startAfter: dueAt });
    await prisma.timerRecord.create({
      data: { id: timerId, entryId: entry.id, entityType: "Entry", entityId: entry.id, timerType: "DISPUTE_SLA_W27", timerCode: "DISPUTE_SLA_W27", dueAt, firesAt: dueAt, status: "SCHEDULED", pgBossJobId: jobId, createdBy: actorId } as any,
    });
    const fired = await waitForTimer(timerId, 330_000);
    results.push({
      name: "W27 Dispute SLA check",
      timerCode: "DISPUTE_SLA_W27",
      timerId,
      expectedWaitSeconds: msToSeconds(dueAt.getTime() - scheduledAt.getTime()),
      observedWaitSeconds: fired?.firedAt ? msToSeconds(fired.firedAt.getTime() - scheduledAt.getTime()) : null,
      status: fired?.status ?? "SCHEDULED",
    });
  }

  // ---------------- W4 (PRE_ARRIVAL_COUNTDOWN_W4) ----------------
  {
    const actorId = "timer-test";
    const gp = await prisma.guestProfile.create({ data: { firstName: "Timer", lastName: "W4", createdBy: actorId } as any });
    const inquiry = await prisma.inquiry.create({
      data: { referenceNumber: `TIMER-W4-${Date.now()}`, guestProfileId: gp.id, defaultCustodianId: actorId, sourceChannel: "DIRECT", createdBy: actorId } as any,
    });
    const entry = await prisma.entry.create({
      data: { inquiryId: inquiry.id, guestProfileId: gp.id, currentStage: "S4", checkInDate: new Date(), createdBy: actorId } as any,
    });
    await prisma.stageDwellRecord.create({ data: { entryId: entry.id, stage: "S4", enteredAt: new Date(Date.now() - 20_000) } as any });
    const timerId = randomUUID();
    const dueAt = new Date(Date.now() + 5_000);
    const scheduledAt = new Date();
    const jobId = await engine.schedule("PRE_ARRIVAL_COUNTDOWN_W4", { entryId: entry.id, timerRecordId: timerId }, { startAfter: dueAt });
    await prisma.timerRecord.create({
      data: {
        id: timerId,
        entryId: entry.id,
        entityType: "Entry",
        entityId: entry.id,
        timerType: "PRE_ARRIVAL_COUNTDOWN_W4",
        timerCode: "PRE_ARRIVAL_COUNTDOWN_W4",
        dueAt,
        firesAt: dueAt,
        status: "SCHEDULED",
        pgBossJobId: jobId,
        createdBy: actorId,
      } as any,
    });
    const fired = await waitForTimer(timerId, 330_000);
    results.push({
      name: "W4 Pre-arrival window activation",
      timerCode: "PRE_ARRIVAL_COUNTDOWN_W4",
      timerId,
      expectedWaitSeconds: msToSeconds(dueAt.getTime() - scheduledAt.getTime()),
      observedWaitSeconds: fired?.firedAt ? msToSeconds(fired.firedAt.getTime() - scheduledAt.getTime()) : null,
      status: fired?.status ?? "SCHEDULED",
      notes: "Transitions Entry S4→S5 and registers NO_SHOW_CUTOFF_W5.",
    });
  }

  // ---------------- W5 (NO_SHOW_CUTOFF_W5) ----------------
  {
    const actorId = "timer-test";
    const gp = await prisma.guestProfile.create({ data: { firstName: "Timer", lastName: "W5", createdBy: actorId } as any });
    const inquiry = await prisma.inquiry.create({
      data: { referenceNumber: `TIMER-W5-${Date.now()}`, guestProfileId: gp.id, defaultCustodianId: actorId, sourceChannel: "DIRECT", createdBy: actorId } as any,
    });
    const entry = await prisma.entry.create({ data: { inquiryId: inquiry.id, guestProfileId: gp.id, currentStage: "S5", createdBy: actorId } as any });
    const timerId = randomUUID();
    const dueAt = new Date(Date.now() + 5_000);
    const scheduledAt = new Date();
    const jobId = await engine.schedule("NO_SHOW_CUTOFF_W5", { entryId: entry.id, timerRecordId: timerId }, { startAfter: dueAt });
    await prisma.timerRecord.create({
      data: {
        id: timerId,
        entryId: entry.id,
        entityType: "Entry",
        entityId: entry.id,
        timerType: "NO_SHOW_CUTOFF_W5",
        timerCode: "NO_SHOW_CUTOFF_W5",
        dueAt,
        firesAt: dueAt,
        status: "SCHEDULED",
        pgBossJobId: jobId,
        createdBy: actorId,
      } as any,
    });
    const fired = await waitForTimer(timerId, 330_000);
    results.push({
      name: "W5 No-show cutoff fired",
      timerCode: "NO_SHOW_CUTOFF_W5",
      timerId,
      expectedWaitSeconds: msToSeconds(dueAt.getTime() - scheduledAt.getTime()),
      observedWaitSeconds: fired?.firedAt ? msToSeconds(fired.firedAt.getTime() - scheduledAt.getTime()) : null,
      status: fired?.status ?? "SCHEDULED",
    });
  }

  // ---------------- W5 (AWAITING_WRITTEN_CONFIRMATION_W5) ----------------
  {
    const actorId = "timer-test";
    const gp = await prisma.guestProfile.create({ data: { firstName: "Timer", lastName: "W5B", createdBy: actorId } as any });
    const inquiry = await prisma.inquiry.create({
      data: { referenceNumber: `TIMER-W5B-${Date.now()}`, guestProfileId: gp.id, defaultCustodianId: actorId, sourceChannel: "DIRECT", createdBy: actorId } as any,
    });
    const entry = await prisma.entry.create({ data: { inquiryId: inquiry.id, guestProfileId: gp.id, currentStage: "S5", awaitingWrittenConfirmationActive: true, createdBy: actorId } as any });
    const folio = await prisma.folio.create({ data: { entryId: entry.id, state: "PROVISIONAL", outstandingBalance: "0" as any, createdBy: actorId } as any });
    await prisma.paymentRecord.create({ data: { folioId: folio.id, amount: "100" as any, paymentDirection: "IN", paymentMethod: "CASH", recordedBy: actorId } as any });

    const timerId = randomUUID();
    const dueAt = new Date(Date.now() + 5_000);
    const scheduledAt = new Date();
    const jobId = await engine.schedule("AWAITING_WRITTEN_CONFIRMATION_W5", { entryId: entry.id, timerRecordId: timerId }, { startAfter: dueAt });
    await prisma.timerRecord.create({
      data: {
        id: timerId,
        entryId: entry.id,
        entityType: "Entry",
        entityId: entry.id,
        timerType: "AWAITING_WRITTEN_CONFIRMATION_W5",
        timerCode: "AWAITING_WRITTEN_CONFIRMATION_W5",
        dueAt,
        firesAt: dueAt,
        status: "SCHEDULED",
        pgBossJobId: jobId,
        createdBy: actorId,
      } as any,
    });
    const fired = await waitForTimer(timerId, 330_000);
    results.push({
      name: "W5 Awaiting written confirmation auto-finalise",
      timerCode: "AWAITING_WRITTEN_CONFIRMATION_W5",
      timerId,
      expectedWaitSeconds: msToSeconds(dueAt.getTime() - scheduledAt.getTime()),
      observedWaitSeconds: fired?.firedAt ? msToSeconds(fired.firedAt.getTime() - scheduledAt.getTime()) : null,
      status: fired?.status ?? "SCHEDULED",
      notes: "Creates Folio+advance payment and lets worker finalize to TERMINAL/NO_SHOW_CLOSED.",
    });
  }

  // ---------------- W15 (QUOTATION_VALIDITY_W15) ----------------
  {
    const actorId = "timer-test";
    const gp = await prisma.guestProfile.create({ data: { firstName: "Timer", lastName: "W15", createdBy: actorId } as any });
    const inquiry = await prisma.inquiry.create({
      data: { referenceNumber: `TIMER-W15-${Date.now()}`, guestProfileId: gp.id, defaultCustodianId: actorId, sourceChannel: "DIRECT", createdBy: actorId } as any,
    });
    const entry = await prisma.entry.create({ data: { inquiryId: inquiry.id, guestProfileId: gp.id, currentStage: "S2", createdBy: actorId } as any });
    const seg = await prisma.segment.create({ data: { entryId: entry.id, segmentNumber: 1, stage: "S2", createdBy: actorId } as any });
    const q = await prisma.quotation.create({
      data: { entryId: entry.id, segmentId: seg.id, referenceNumber: `Q-${Date.now()}`, state: "SENT", commercialTerms: {}, totalAmount: "10" as any, createdBy: actorId, validUntil: new Date(Date.now() - 1_000) } as any,
    });
    const timerId = randomUUID();
    const dueAt = new Date(Date.now() + 5_000);
    const scheduledAt = new Date();
    const jobId = await engine.schedule("QUOTATION_VALIDITY_W15", { quotationId: q.id, timerRecordId: timerId }, { startAfter: dueAt });
    await prisma.timerRecord.create({
      data: {
        id: timerId,
        entryId: entry.id,
        entityType: "Quotation",
        entityId: q.id,
        timerType: "QUOTATION_VALIDITY_W15",
        timerCode: "QUOTATION_VALIDITY_W15",
        dueAt,
        firesAt: dueAt,
        status: "SCHEDULED",
        pgBossJobId: jobId,
        createdBy: actorId,
      } as any,
    });
    const fired = await waitForTimer(timerId, 330_000);
    results.push({
      name: "W15 Quotation expiry",
      timerCode: "QUOTATION_VALIDITY_W15",
      timerId,
      expectedWaitSeconds: msToSeconds(dueAt.getTime() - scheduledAt.getTime()),
      observedWaitSeconds: fired?.firedAt ? msToSeconds(fired.firedAt.getTime() - scheduledAt.getTime()) : null,
      status: fired?.status ?? "SCHEDULED",
    });
  }

  // ---------------- W22 (QUOTATION_ACK_TRACKER) ----------------
  {
    const actorId = "timer-test";
    const gp = await prisma.guestProfile.create({ data: { firstName: "Timer", lastName: "W22Q", createdBy: actorId } as any });
    const inquiry = await prisma.inquiry.create({
      data: { referenceNumber: `TIMER-W22Q-${Date.now()}`, guestProfileId: gp.id, defaultCustodianId: actorId, sourceChannel: "DIRECT", createdBy: actorId } as any,
    });
    const entry = await prisma.entry.create({ data: { inquiryId: inquiry.id, guestProfileId: gp.id, currentStage: "S2", createdBy: actorId } as any });
    const seg = await prisma.segment.create({ data: { entryId: entry.id, segmentNumber: 1, stage: "S2", createdBy: actorId } as any });
    const comm = await prisma.communicationRecord.create({
      data: { entryId: entry.id, channel: "EMAIL", commType: "CONFIRMATION_VOUCHER", stageContext: "S2", acknowledgementStatus: "PENDING", createdBy: actorId } as any,
    });
    const q = await prisma.quotation.create({
      data: { entryId: entry.id, segmentId: seg.id, referenceNumber: `QACK-${Date.now()}`, state: "SENT", commercialTerms: {}, totalAmount: "10" as any, createdBy: actorId, communicationRecordId: comm.id } as any,
    });
    const timerId = randomUUID();
    const dueAt = new Date(Date.now() + 5_000);
    const scheduledAt = new Date();
    const jobId = await engine.schedule("QUOTATION_ACK_TRACKER", { quotationId: q.id, timerRecordId: timerId }, { startAfter: dueAt });
    await prisma.timerRecord.create({
      data: {
        id: timerId,
        entryId: entry.id,
        entityType: "Quotation",
        entityId: q.id,
        timerType: "QUOTATION_ACK_TRACKER",
        timerCode: "QUOTATION_ACK_TRACKER",
        dueAt,
        firesAt: dueAt,
        status: "SCHEDULED",
        pgBossJobId: jobId,
        createdBy: actorId,
      } as any,
    });
    const fired = await waitForTimer(timerId, 330_000);
    results.push({
      name: "W22 Quotation acknowledgement tracker",
      timerCode: "QUOTATION_ACK_TRACKER",
      timerId,
      expectedWaitSeconds: msToSeconds(dueAt.getTime() - scheduledAt.getTime()),
      observedWaitSeconds: fired?.firedAt ? msToSeconds(fired.firedAt.getTime() - scheduledAt.getTime()) : null,
      status: fired?.status ?? "SCHEDULED",
    });
  }

  // ---------------- W22 (ACKNOWLEDGEMENT_WINDOW_W22) ----------------
  {
    const actorId = "timer-test";
    const gp = await prisma.guestProfile.create({ data: { firstName: "Timer", lastName: "W22", createdBy: actorId } as any });
    const inquiry = await prisma.inquiry.create({
      data: { referenceNumber: `TIMER-W22-${Date.now()}`, guestProfileId: gp.id, defaultCustodianId: actorId, sourceChannel: "DIRECT", createdBy: actorId } as any,
    });
    const entry = await prisma.entry.create({ data: { inquiryId: inquiry.id, guestProfileId: gp.id, currentStage: "S2", createdBy: actorId } as any });
    const comm = await prisma.communicationRecord.create({
      data: { entryId: entry.id, channel: "EMAIL", commType: "CONFIRMATION_VOUCHER", stageContext: "S2", acknowledgementStatus: "PENDING", createdBy: actorId } as any,
    });
    const timerId = randomUUID();
    const dueAt = new Date(Date.now() + 5_000);
    const scheduledAt = new Date();
    const jobId = await engine.schedule("ACKNOWLEDGEMENT_WINDOW_W22", { communicationRecordId: comm.id, timerRecordId: timerId }, { startAfter: dueAt });
    await prisma.timerRecord.create({
      data: {
        id: timerId,
        entryId: entry.id,
        entityType: "CommunicationRecord",
        entityId: comm.id,
        timerType: "ACKNOWLEDGEMENT_WINDOW_W22",
        timerCode: "ACKNOWLEDGEMENT_WINDOW_W22",
        dueAt,
        firesAt: dueAt,
        status: "SCHEDULED",
        pgBossJobId: jobId,
        createdBy: actorId,
      } as any,
    });
    const fired = await waitForTimer(timerId, 330_000);
    results.push({
      name: "W22 Acknowledgement window timeout",
      timerCode: "ACKNOWLEDGEMENT_WINDOW_W22",
      timerId,
      expectedWaitSeconds: msToSeconds(dueAt.getTime() - scheduledAt.getTime()),
      observedWaitSeconds: fired?.firedAt ? msToSeconds(fired.firedAt.getTime() - scheduledAt.getTime()) : null,
      status: fired?.status ?? "SCHEDULED",
    });
  }

  // ---------------- W23 (ROOM_READINESS_SLA_W23) ----------------
  {
    const actorId = "timer-test";
    const room = await prisma.room.findFirst({ orderBy: { createdAt: "desc" } });
    if (!room) throw new Error("No room found for W23 test");
    // force not-ready physicalState
    await prisma.room.update({ where: { id: room.id }, data: { physicalState: "DIRTY" } as any });

    const gp = await prisma.guestProfile.create({ data: { firstName: "Timer", lastName: "W23", createdBy: actorId } as any });
    const inquiry = await prisma.inquiry.create({
      data: { referenceNumber: `TIMER-W23-${Date.now()}`, guestProfileId: gp.id, defaultCustodianId: actorId, sourceChannel: "DIRECT", createdBy: actorId } as any,
    });
    const entry = await prisma.entry.create({ data: { inquiryId: inquiry.id, guestProfileId: gp.id, currentStage: "S5", createdBy: actorId } as any });
    const timerId = randomUUID();
    const dueAt = new Date(Date.now() + 5_000);
    const scheduledAt = new Date();
    const jobId = await engine.schedule("ROOM_READINESS_SLA_W23", { entryId: entry.id, roomId: room.id, phase: "BREACH", timerRecordId: timerId }, { startAfter: dueAt });
    await prisma.timerRecord.create({
      data: {
        id: timerId,
        entryId: entry.id,
        entityType: "Room",
        entityId: room.id,
        timerType: "ROOM_READINESS_SLA_W23",
        timerCode: "ROOM_READINESS_SLA_W23",
        dueAt,
        firesAt: dueAt,
        status: "SCHEDULED",
        pgBossJobId: jobId,
        createdBy: actorId,
      } as any,
    });
    const fired = await waitForTimer(timerId, 330_000);
    results.push({
      name: "W23 Room readiness SLA breach",
      timerCode: "ROOM_READINESS_SLA_W23",
      timerId,
      expectedWaitSeconds: msToSeconds(dueAt.getTime() - scheduledAt.getTime()),
      observedWaitSeconds: fired?.firedAt ? msToSeconds(fired.firedAt.getTime() - scheduledAt.getTime()) : null,
      status: fired?.status ?? "SCHEDULED",
    });
  }

  // ---------------- W25 (H2_H3_ACCEPTANCE_W25) ----------------
  {
    const actorId = "timer-test";
    const gp = await prisma.guestProfile.create({ data: { firstName: "Timer", lastName: "W25", createdBy: actorId } as any });
    const inquiry = await prisma.inquiry.create({
      data: { referenceNumber: `TIMER-W25-${Date.now()}`, guestProfileId: gp.id, defaultCustodianId: actorId, sourceChannel: "DIRECT", createdBy: actorId } as any,
    });
    const entry = await prisma.entry.create({ data: { inquiryId: inquiry.id, guestProfileId: gp.id, currentStage: "S6", createdBy: actorId } as any });
    const handoff = await prisma.handoffRecord.create({
      data: { entryId: entry.id, handoffType: "H2", state: "CREATED", fromRole: "FRONT_DESK", fromActorId: actorId, toRole: "HOUSEKEEPING", createdBy: actorId, stageContext: "S6" } as any,
    });
    const timerId = randomUUID();
    const dueAt = new Date(Date.now() + 5_000);
    const scheduledAt = new Date();
    const jobId = await engine.schedule("H2_H3_ACCEPTANCE_W25", { handoffId: handoff.id, timerRecordId: timerId }, { startAfter: dueAt });
    await prisma.timerRecord.create({
      data: {
        id: timerId,
        entryId: entry.id,
        entityType: "HandoffRecord",
        entityId: handoff.id,
        timerType: "H2_H3_ACCEPTANCE_W25",
        timerCode: "H2_H3_ACCEPTANCE_W25",
        dueAt,
        firesAt: dueAt,
        status: "SCHEDULED",
        pgBossJobId: jobId,
        createdBy: actorId,
      } as any,
    });
    const fired = await waitForTimer(timerId, 330_000);
    results.push({
      name: "W25 Handoff acceptance window expiry",
      timerCode: "H2_H3_ACCEPTANCE_W25",
      timerId,
      expectedWaitSeconds: msToSeconds(dueAt.getTime() - scheduledAt.getTime()),
      observedWaitSeconds: fired?.firedAt ? msToSeconds(fired.firedAt.getTime() - scheduledAt.getTime()) : null,
      status: fired?.status ?? "SCHEDULED",
    });
  }

  // ---------------- W34 (ADVANCE_PAYMENT_FOLLOW_UP_W34) ----------------
  {
    const actorId = "timer-test";
    const gp = await prisma.guestProfile.create({ data: { firstName: "Timer", lastName: "W34", createdBy: actorId } as any });
    const inquiry = await prisma.inquiry.create({
      data: { referenceNumber: `TIMER-W34-${Date.now()}`, guestProfileId: gp.id, defaultCustodianId: actorId, sourceChannel: "DIRECT", createdBy: actorId } as any,
    });
    const entry = await prisma.entry.create({ data: { inquiryId: inquiry.id, guestProfileId: gp.id, currentStage: "S3", createdBy: actorId } as any });
    await prisma.folio.create({ data: { entryId: entry.id, state: "PROVISIONAL", outstandingBalance: "0" as any, createdBy: actorId, billingModel: "GUEST_PAY" } as any });
    const timerId = randomUUID();
    const dueAt = new Date(Date.now() + 5_000);
    const scheduledAt = new Date();
    const jobId = await engine.schedule("ADVANCE_PAYMENT_FOLLOW_UP_W34", { entryId: entry.id, tier: 1, timerRecordId: timerId }, { startAfter: dueAt });
    await prisma.timerRecord.create({
      data: {
        id: timerId,
        entryId: entry.id,
        entityType: "Entry",
        entityId: entry.id,
        timerType: "ADVANCE_PAYMENT_FOLLOW_UP_W34",
        timerCode: "ADVANCE_PAYMENT_FOLLOW_UP_W34",
        dueAt,
        firesAt: dueAt,
        status: "SCHEDULED",
        pgBossJobId: jobId,
        createdBy: actorId,
      } as any,
    });
    const fired = await waitForTimer(timerId, 120_000);
    results.push({
      name: "W34 Advance payment follow-up",
      timerCode: "ADVANCE_PAYMENT_FOLLOW_UP_W34",
      timerId,
      expectedWaitSeconds: msToSeconds(dueAt.getTime() - scheduledAt.getTime()),
      observedWaitSeconds: fired?.firedAt ? msToSeconds(fired.firedAt.getTime() - scheduledAt.getTime()) : null,
      status: fired?.status ?? "SCHEDULED",
    });
  }

  // ---------------- W16 (PROCESSING_LOCK_TTL) ----------------
  {
    const actorId = "timer-test";
    const lock = await prisma.processingLockRecord.create({
      data: { actorId, channel: "DEFAULT", inventoryReference: `INV-${Date.now()}`, ttlSeconds: 1, expiresAt: new Date(Date.now() + 5_000) } as any,
    });
    const fireAt = new Date(Date.now() + 5_000);
    await engine.schedule("PROCESSING_LOCK_TTL", { lockId: lock.id }, { startAfter: fireAt });
    await sleep(8_000);
    const updated = await prisma.processingLockRecord.findUnique({ where: { id: lock.id } });
    pushNonTimerResult({
      name: "W16 Processing lock expiry",
      timerCode: "PROCESSING_LOCK_TTL",
      pass: updated?.status === "EXPIRED",
      notes: `Observed lock.status=${updated?.status ?? "null"}`,
    });
  }

  // ---------------- W20 (ENTRY_EXPIRY) ----------------
  {
    const actorId = "timer-test";
    const gp = await prisma.guestProfile.create({ data: { firstName: "Timer", lastName: "W20", createdBy: actorId } as any });
    const inquiry = await prisma.inquiry.create({
      data: { referenceNumber: `TIMER-W20-${Date.now()}`, guestProfileId: gp.id, defaultCustodianId: actorId, sourceChannel: "DIRECT", createdBy: actorId } as any,
    });
    const entry = await prisma.entry.create({ data: { inquiryId: inquiry.id, guestProfileId: gp.id, currentStage: "S1", createdBy: actorId } as any });
    const fireAt = new Date(Date.now() + 5_000);
    await engine.schedule("ENTRY_EXPIRY", { entryId: entry.id }, { startAfter: fireAt });
    await sleep(8_000);
    const updated = await prisma.entry.findUnique({ where: { id: entry.id } });
    pushNonTimerResult({
      name: "W20 Entry expiry",
      timerCode: "ENTRY_EXPIRY",
      pass: updated?.status === "EXPIRED",
      notes: `Observed entry.status=${updated?.status ?? "null"}`,
    });
  }

  // ---------------- W1 (STAGE_DWELL_MONITOR) ----------------
  {
    const actorId = "timer-test";
    const gp = await prisma.guestProfile.create({ data: { firstName: "Timer", lastName: "W1", createdBy: actorId } as any });
    const inquiry = await prisma.inquiry.create({
      data: { referenceNumber: `TIMER-W1-${Date.now()}`, guestProfileId: gp.id, defaultCustodianId: actorId, sourceChannel: "DIRECT", createdBy: actorId } as any,
    });
    const entry = await prisma.entry.create({ data: { inquiryId: inquiry.id, guestProfileId: gp.id, currentStage: "S1", createdBy: actorId } as any });
    await prisma.stageDwellRecord.create({
      data: {
        entryId: entry.id,
        stage: "S1",
        enteredAt: new Date(Date.now() - 60_000),
        lastActiveAt: new Date(Date.now() - 60_000),
        mode: "ACTIVE",
      } as any,
    });
    const fireAt = new Date(Date.now() + 5_000);
    await engine.schedule("STAGE_DWELL_MONITOR", { entryId: entry.id }, { startAfter: fireAt });
    await sleep(8_000);
    const dwell = await prisma.stageDwellRecord.findFirst({ where: { entryId: entry.id, stage: "S1" }, orderBy: { enteredAt: "desc" } });
    pushNonTimerResult({
      name: "W1 Stage dwell monitor",
      timerCode: "STAGE_DWELL_MONITOR",
      pass: !!dwell?.warningFiredAt || !!dwell?.criticalFiredAt || !!dwell?.escalatedAt,
      notes: `warningFiredAt=${dwell?.warningFiredAt?.toISOString() ?? "null"}, criticalFiredAt=${dwell?.criticalFiredAt?.toISOString() ?? "null"}, escalatedAt=${dwell?.escalatedAt?.toISOString() ?? "null"}`,
    });
  }

  const outDir = path.resolve(process.cwd(), "..", "Documentation_V2", "test");
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, "realtime-worker-timer-test-report.ALL.md");

  const md = [
    "# Realtime worker/timer test report (ALL)",
    "",
    `- **Ran at**: ${now.toISOString()}`,
    "",
    "## Why the first realtime test only covered W2/W9/W11/W28/W29",
    "",
    "That first pass was deliberately scoped to validate the **doc gap** we discovered:",
    "",
    "- **Doc expectation**: In the SIG docs, W9/W11/W28/W29 are defined as **pg-boss job types** and should fire on their own after registration.",
    "- **Code reality before this work**:",
    "  - `TimerRecord`s were being created for W9/W11/W28 (and W29 logic existed), but **pg-boss `.work(...)` handlers were not registered** for those job types in `src/workers/runner.ts`, so they couldn't fire autonomously.",
    "  - For W2/W3 and most worker patterns, the worker expects `timerRecordId` in the job payload to flip `TimerRecord.status` to `FIRED`. W2 previously scheduled a placeholder payload first, then re-scheduled without a `timerRecordId`, so `TimerRecord` stayed `SCHEDULED` even if pg-boss completed the job.",
    "",
    "So we validated W2 as a baseline, then fixed the wiring/scheduling gaps and validated W9/W11/W28/W29 end-to-end with realtime waits. After that, we expanded to the remaining workers.",
    "",
    "## Results (configured vs observed)",
    "",
    ...results.map((r) => {
      const obs = r.observedWaitSeconds == null ? "(not fired within timeout)" : `~${r.observedWaitSeconds}s`;
      return [
        `### ${r.name}`,
        `- **timerCode**: \`${r.timerCode}\``,
        `- **timerRecordId**: ${r.timerId}`,
        `- **expected wait**: ~${r.expectedWaitSeconds}s`,
        `- **observed wait**: ${obs}`,
        `- **final status**: ${r.status}`,
        ...(r.notes ? [`- **notes**: ${r.notes}`] : []),
        "",
      ].join("\n");
    }),
    "## Raw JSON",
    "",
    "```json",
    JSON.stringify(results, null, 2),
    "```",
    "",
  ].join("\n");

  fs.writeFileSync(outPath, md, "utf8");
  await engine.stop();
  console.log(`Wrote ${outPath}`);
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

