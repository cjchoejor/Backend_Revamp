import { PrismaClient, Stage } from "@prisma/client";
import { RoomPhysicalState } from "@prisma/client";
import { runPreArrivalWindowActivationWorker } from "../src/workers/w4-pre-arrival-window-activation-worker.js";
import { runNoShowCutoffWorker } from "../src/workers/w5-no-show-cutoff-worker.js";
import { runRoomReadinessSlaWorker } from "../src/workers/w23-room-readiness-sla-worker.js";
import * as preArrivalService from "../src/services/pre-arrival-service.js";
import { createTimerEngine } from "../src/lib/timer-engine.js";

type Json = Record<string, unknown> | unknown[] | string | number | boolean | null;

const prisma = new PrismaClient();

const baseUrl = process.env.API_BASE_URL ?? "http://localhost:4000/api";

type Actor = { id: string; level: "L1" | "L2" | "L3" | "L4" };

const L1: Actor = { id: "test-fd-1", level: "L1" };
const L2: Actor = { id: "test-fom-1", level: "L2" };

function headers(actor: Actor) {
  return {
    "content-type": "application/json",
    "x-actor-id": actor.id,
    "x-actor-level": actor.level,
  };
}

async function http<T = Json>(method: string, path: string, actor: Actor, body?: Json) {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: headers(actor),
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  const json = text ? (JSON.parse(text) as T) : (null as unknown as T);
  return { status: res.status, json };
}

function assert(cond: unknown, message: string): asserts cond {
  if (!cond) throw new Error(message);
}

type CaseResult = {
  id: string;
  title: string;
  pass: boolean;
  status?: number;
  body?: Json;
  notes?: string;
};

async function getSeedIds() {
  // Seed creates at least one LEISURE S5 entry and one corporate Tier2 S5 entry.
  const leisure = await prisma.entry.findFirstOrThrow({
    where: { useType: "LEISURE", currentStage: Stage.S5 },
    orderBy: { createdAt: "desc" },
    include: {
      handoffs: true,
      preArrivalTasks: true,
      roomAssignments: true,
      reservation: true,
      folio: true,
    },
  });

  const corporate = await prisma.entry.findFirstOrThrow({
    where: { useType: "CORPORATE", currentStage: Stage.S5 },
    orderBy: { createdAt: "desc" },
    include: { reservation: true, folio: true, handoffs: true, preArrivalTasks: true, roomAssignments: true },
  });

  const roomClean = await prisma.room.findFirstOrThrow({ where: { roomNumber: "501" } });
  const roomDef = await prisma.room.findFirstOrThrow({ where: { roomNumber: "502-DEF" } });

  return { leisure, corporate, roomClean, roomDef };
}

async function run() {
  const results: CaseResult[] = [];
  const startedAt = new Date().toISOString();

  const { leisure, corporate, roomClean, roomDef } = await getSeedIds();

  // Helper IDs
  const entryId = leisure.id;
  const h1 = leisure.handoffs.find((h) => h.handoffType === "H1");
  assert(h1, "Seed missing H1 for leisure entry");

  const pendingTasks = leisure.preArrivalTasks.filter((t) => t.status === "PENDING");
  assert(pendingTasks.length > 0, "Seed expected at least one PENDING pre-arrival task");

  // --- AC-S5-013: Incomplete checklist blocks H1 accept ---
  {
    const r = await http("POST", `/handoffs/${h1.id}/accept`, L1, {
      checklistCompletion: { VOUCHER_VERIFIED: true },
    });
    const pass = r.status === 409 && (r.json as any)?.error === "PolicyGateBlockedError";
    results.push({ id: "AC-S5-013", title: "H1 acceptance blocks on incomplete checklist", pass, status: r.status, body: r.json });
  }

  // --- Accept H1 properly (setup for later cases) ---
  {
    const r = await http("POST", `/handoffs/${h1.id}/accept`, L1, {
      checklistCompletion: { VOUCHER_VERIFIED: true, PAYMENT_STATUS_REVIEWED: true },
    });
    results.push({ id: "SETUP-H1-ACCEPT", title: "Setup: accept H1", pass: r.status === 200, status: r.status, body: r.json });
  }

  // --- AC-S5-009: fulfil from CREATED is rejected ---
  {
    // Create a fresh entry with H1 CREATED
    const entry2 = await prisma.entry.create({
      data: {
        inquiryId: leisure.inquiryId,
        guestProfileId: leisure.guestProfileId,
        useType: "LEISURE",
        status: "ACTIVE",
        currentStage: Stage.S5,
        checkInDate: leisure.checkInDate,
        checkOutDate: leisure.checkOutDate,
        guestCount: 1,
        createdBy: "test-system",
      },
    });
    await prisma.segment.create({ data: { entryId: entry2.id, segmentNumber: 1 } });
    await prisma.folio.create({
      data: { entryId: entry2.id, billingModel: "GUEST_PAY", createdBy: "test-system", advancePaymentReconciliationComplete: true },
    });
    await prisma.handoffRecord.create({
      data: {
        entryId: entry2.id,
        handoffType: "H1",
        state: "CREATED",
        fromRole: "RESERVATIONS",
        fromActorId: "test-res",
        toRole: "FRONT_DESK",
        checklistContent: {},
        createdBy: "test-system",
        stageContext: Stage.S4,
      },
    });

    const h1Created = await prisma.handoffRecord.findFirstOrThrow({ where: { entryId: entry2.id, handoffType: "H1" } });
    const r = await http("POST", `/handoffs/${h1Created.id}/fulfil`, L1, {
      fulfilmentEvidence: {
        roomAssignmentId: "dummy",
        readinessConfirmed: true,
        paymentStatusConfirmed: true,
        ceilingProximityAddressed: true,
      },
    });
    const pass = r.status === 409 && (r.json as any)?.error === "StateTransitionError";
    results.push({ id: "AC-S5-009", title: "H1 fulfil from CREATED rejected", pass, status: r.status, body: r.json });
  }

  // --- AC-S5-011: H1 must be FULFILLED for S5→S6 ---
  {
    const r = await http("POST", `/entries/${entryId}/progress-stage`, L1, {
      targetStage: "S6",
      version: leisure.version,
      guestPhysicallyPresent: true,
    });
    const pass = r.status === 409 && (r.json as any)?.error === "StageGateBlockedError" && (r.json as any)?.blockingCondition === "H1_NOT_FULFILLED";
    results.push({ id: "AC-S5-011", title: "S5→S6 blocked when H1 only ACCEPTED", pass, status: r.status, body: r.json });
  }

  // --- Assign DEFICIENT room without ack (AC-S5-014) ---
  {
    const r = await http("POST", `/entries/${entryId}/room-assignments`, L1, { roomId: roomDef.id });
    const pass =
      r.status === 409 &&
      (r.json as any)?.error === "PolicyGateBlockedError" &&
      (r.json as any)?.blockingCondition === "DEFICIENT_ACKNOWLEDGEMENT_REQUIRED";
    results.push({ id: "AC-S5-014", title: "DEFICIENT room requires acknowledgement", pass, status: r.status, body: r.json });
  }

  // --- AC-S5-016: UNDER_MAINTENANCE without expectedReadyAt may not be assigned ---
  {
    const maintRoom = await prisma.room.create({
      data: {
        roomNumber: `MAINT-${Date.now()}`,
        roomTypeId: roomClean.roomTypeId,
        floorNumber: 5,
        capacity: 2,
        currentClaimState: "CONFIRMED",
        physicalState: "UNDER_MAINTENANCE",
        expectedReadyAt: null,
      },
    });
    const r = await http("POST", `/entries/${entryId}/room-assignments`, L1, { roomId: maintRoom.id });
    const pass = r.status === 409 && (r.json as any)?.blockingCondition === "UNDER_MAINTENANCE_WITHOUT_SCHEDULE";
    results.push({ id: "AC-S5-016", title: "Under maintenance without expectedReadyAt blocked", pass, status: r.status, body: r.json });
  }

  // --- Assign clean room (setup) ---
  const roomAssign = await http<any>("POST", `/entries/${entryId}/room-assignments`, L1, { roomId: roomClean.id });
  results.push({
    id: "SETUP-ROOM",
    title: "Setup: assign clean room",
    pass: roomAssign.status === 201,
    status: roomAssign.status,
    body: roomAssign.json,
  });

  const roomAssignmentId = (roomAssign.json as any)?.id as string | undefined;
  assert(roomAssignmentId, "Room assignment id missing from response");

  // --- AC-S5-015: DeficientConditionRecordId preserved after resolution (uses a separate entry and DEF room) ---
  {
    const entryDef = await prisma.entry.create({
      data: {
        inquiryId: leisure.inquiryId,
        guestProfileId: leisure.guestProfileId,
        useType: "LEISURE",
        status: "ACTIVE",
        currentStage: Stage.S5,
        checkInDate: leisure.checkInDate,
        checkOutDate: leisure.checkOutDate,
        guestCount: 1,
        createdBy: "test-system",
      },
    });
    await prisma.segment.create({ data: { entryId: entryDef.id, segmentNumber: 1 } });
    await prisma.folio.create({
      data: { entryId: entryDef.id, billingModel: "GUEST_PAY", createdBy: "test-system", advancePaymentReconciliationComplete: true },
    });
    await prisma.committedHold.create({
      data: {
        entryId: entryDef.id,
        segmentId: (await prisma.segment.findFirstOrThrow({ where: { entryId: entryDef.id } })).id,
        roomTypeId: roomDef.roomTypeId,
        state: "CONFIRMED",
        placedBy: "test-system",
        expiresAt: new Date(Date.now() + 86400_000),
      },
    });

    const ackBody = {
      roomId: roomDef.id,
      deficientAcknowledgement: {
        acknowledgementActorId: L2.id,
        acknowledgementAt: new Date().toISOString(),
        decisionTaken: "Assign with guest informed",
      },
    };

    const assigned = await http<any>("POST", `/entries/${entryDef.id}/room-assignments`, L2, ackBody);
    const assignmentId = (assigned.json as any)?.id as string | undefined;
    const defRecordId = (assigned.json as any)?.deficientConditionRecordId as string | undefined;
    const passSetup = assigned.status === 201 && !!defRecordId;

    if (defRecordId) {
      await prisma.deficientConditionRecord.update({ where: { id: defRecordId }, data: { status: "RESOLVED", resolvedAt: new Date(), resolvedBy: "test-hk" } });
    }

    const assignmentAfter = assignmentId ? await prisma.roomAssignment.findUnique({ where: { id: assignmentId } }) : null;
    const pass = passSetup && assignmentAfter?.deficientConditionRecordId === defRecordId;
    results.push({
      id: "AC-S5-015",
      title: "DEFICIENT assignment preserves deficientConditionRecordId after resolution",
      pass,
      body: { assigned, defRecordId, after: assignmentAfter?.deficientConditionRecordId },
    });
  }

  // --- Fulfil H1 properly (setup) ---
  {
    const r = await http("POST", `/handoffs/${h1.id}/fulfil`, L1, {
      fulfilmentEvidence: {
        roomAssignmentId,
        readinessConfirmed: true,
        paymentStatusConfirmed: true,
        ceilingProximityAddressed: true,
      },
    });
    results.push({ id: "SETUP-H1-FULFIL", title: "Setup: fulfil H1", pass: r.status === 200, status: r.status, body: r.json });
  }

  // --- AC-S5-018: pending pre-arrival tasks block S5→S6 (after H1 is FULFILLED) ---
  {
    const entryNow = await prisma.entry.findUniqueOrThrow({ where: { id: entryId } });
    const r = await http("POST", `/entries/${entryId}/progress-stage`, L1, {
      targetStage: "S6",
      version: entryNow.version,
      guestPhysicallyPresent: true,
    });
    const pass =
      r.status === 409 &&
      (r.json as any)?.error === "StageGateBlockedError" &&
      (r.json as any)?.blockingCondition === "PRE_ARRIVAL_TASK_PENDING";
    results.push({ id: "AC-S5-018", title: "S5->S6 blocked if any task PENDING", pass, status: r.status, body: r.json });
  }

  // --- AC-S5-019: WAIVE requires reason ---
  {
    const taskId = pendingTasks[0].id;
    const r = await http("PATCH", `/pre-arrival-tasks/${taskId}`, L1, { action: "WAIVE" });
    const pass = r.status === 409 && (r.json as any)?.error === "PolicyGateBlockedError";
    results.push({ id: "AC-S5-019", title: "Waive task requires waivedReason", pass, status: r.status, body: r.json });
  }

  // --- Complete tasks (setup for happy path) ---
  {
    const tasks = await prisma.preArrivalTask.findMany({ where: { entryId, status: "PENDING" } });
    for (const t of tasks) {
      await http("PATCH", `/pre-arrival-tasks/${t.id}`, L1, { action: "COMPLETE" });
    }
    results.push({ id: "SETUP-TASKS", title: "Setup: complete all pre-arrival tasks", pass: true });
  }

  // --- AC-S5-023: Happy path S5→S6 ---
  {
    const entryNow = await prisma.entry.findUniqueOrThrow({ where: { id: entryId } });
    const r = await http("POST", `/entries/${entryId}/progress-stage`, L1, {
      targetStage: "S6",
      version: entryNow.version,
      guestPhysicallyPresent: true,
    });
    const pass = r.status === 200 && (r.json as any)?.currentStage === "S6";
    results.push({ id: "AC-S5-023", title: "Happy path progresses S5->S6", pass, status: r.status, body: r.json });
  }

  // --- AC-S5-022: Credit ceiling Tier2 blocks until ack ---
  {
    const corpNow = await prisma.entry.findUniqueOrThrow({ where: { id: corporate.id } });
    const r1 = await http("POST", `/entries/${corpNow.id}/progress-stage`, L1, {
      targetStage: "S6",
      version: corpNow.version,
      guestPhysicallyPresent: true,
    });
    const pass1 =
      r1.status === 409 && (r1.json as any)?.error === "StageGateBlockedError" && (r1.json as any)?.blockingCondition === "CREDIT_CEILING_TIER2_UNACKNOWLEDGED";

    const ack = await http("POST", `/entries/${corpNow.id}/credit-ceiling-tier2-ack`, L2, {});
    const corpAfterAck = await prisma.entry.findUniqueOrThrow({ where: { id: corporate.id } });
    const r2 = await http("POST", `/entries/${corpAfterAck.id}/progress-stage`, L1, {
      targetStage: "S6",
      version: corpAfterAck.version,
      guestPhysicallyPresent: true,
    });
    const pass2 = r2.status === 200 && (r2.json as any)?.currentStage === "S6";

    results.push({
      id: "AC-S5-022",
      title: "Credit ceiling Tier2 blocks until FOM ack",
      pass: pass1 && pass2,
      notes: `block=${pass1}, afterAck=${pass2}`,
      body: { block: r1, ack, afterAck: r2 },
    });
  }

  // --- AC-S5-025/026/031: No-show rules ---
  {
    // Create entry at S5 with cutoff NOT reached.
    const ns = await prisma.entry.create({
      data: {
        inquiryId: leisure.inquiryId,
        guestProfileId: leisure.guestProfileId,
        useType: "LEISURE",
        status: "ACTIVE",
        currentStage: Stage.S5,
        checkInDate: leisure.checkInDate,
        checkOutDate: leisure.checkOutDate,
        guestCount: 1,
        createdBy: "test-system",
      },
    });
    await prisma.segment.create({ data: { entryId: ns.id, segmentNumber: 1 } });
    await prisma.reservation.create({
      data: {
        entryId: ns.id,
        segmentId: (await prisma.segment.findFirstOrThrow({ where: { entryId: ns.id } })).id,
        frozenRate: 1,
        frozenRatePlanId: "rp",
        frozenInclusions: {},
        frozenCancellationTerms: { sameDayPenaltyAmount: 9999 },
        frozenBillingModel: "GUEST_PAY",
        frozenCheckInDate: leisure.checkInDate!,
        frozenCheckOutDate: leisure.checkOutDate!,
        frozenGuestCount: 1,
        confirmedAt: new Date(),
        confirmedBy: "test",
      },
    });
    const folio = await prisma.folio.create({ data: { entryId: ns.id, billingModel: "GUEST_PAY", createdBy: "test", advancePaymentReconciliationComplete: true } });
    await prisma.paymentRecord.create({ data: { folioId: folio.id, amount: 100, paymentDirection: "IN" } });

    // L1 should be forbidden (AC-S5-025)
    const rAuth = await http("POST", `/entries/${ns.id}/no-show`, L1, {
      determinationPath: "SUB_PATH_1",
      contactAttemptLog: [{ channel: "PHONE", attemptedAt: new Date().toISOString(), outcome: "NO_ANSWER" }],
      decisionReason: "test",
    });
    const passAuth = rAuth.status === 403 && (rAuth.json as any)?.error === "AuthorizationError";

    // L2 but cutoff not reached (AC-S5-031)
    const rCutoff = await http("POST", `/entries/${ns.id}/no-show`, L2, {
      determinationPath: "SUB_PATH_1",
      contactAttemptLog: [{ channel: "PHONE", attemptedAt: new Date().toISOString(), outcome: "NO_ANSWER" }],
      decisionReason: "test",
    });
    const passCutoff = rCutoff.status === 409 && (rCutoff.json as any)?.blockingCondition === "CUTOFF_NOT_REACHED";

    // Mark cutoff reached
    await prisma.entry.update({ where: { id: ns.id }, data: { noShowCutoffReachedAt: new Date() } });

    // Empty contact attempts (AC-S5-026)
    const rContact = await http("POST", `/entries/${ns.id}/no-show`, L2, {
      determinationPath: "SUB_PATH_1",
      contactAttemptLog: [],
      decisionReason: "test",
    });
    const passContact = rContact.status === 409 && (rContact.json as any)?.blockingCondition === "CONTACT_ATTEMPTS_REQUIRED";

    // Penalty capped at advance payment (AC-S5-028)
    const rDo = await http("POST", `/entries/${ns.id}/no-show`, L2, {
      determinationPath: "SUB_PATH_1",
      contactAttemptLog: [{ channel: "PHONE", attemptedAt: new Date().toISOString(), outcome: "NO_ANSWER" }],
      decisionReason: "no-show confirmed",
    });
    const folioAfter = await prisma.folio.findUniqueOrThrow({ where: { entryId: ns.id } });
    const penalty = Number(folioAfter.noShowPenaltyAmount?.toString() ?? "0");
    const paid = 100;
    const passCap = penalty <= paid;

    results.push({
      id: "AC-S5-025/026/028/031",
      title: "No-show authority, cutoff, contact attempts, penalty cap",
      pass: passAuth && passCutoff && passContact && passCap && rDo.status === 200,
      body: { auth: rAuth, cutoff: rCutoff, contact: rContact, determine: rDo, penalty, paid },
    });
  }

  // --- AC-S5-036: missing handoff.H1.checklist blocks accept ---
  {
    const entry3 = await prisma.entry.create({
      data: {
        inquiryId: leisure.inquiryId,
        guestProfileId: leisure.guestProfileId,
        useType: "LEISURE",
        status: "ACTIVE",
        currentStage: Stage.S5,
        checkInDate: leisure.checkInDate,
        checkOutDate: leisure.checkOutDate,
        guestCount: 1,
        createdBy: "test-system",
      },
    });
    await prisma.segment.create({ data: { entryId: entry3.id, segmentNumber: 1 } });
    const h = await prisma.handoffRecord.create({
      data: {
        entryId: entry3.id,
        handoffType: "H1",
        state: "CREATED",
        fromRole: "RESERVATIONS",
        fromActorId: "test-res",
        toRole: "FRONT_DESK",
        checklistContent: {},
        createdBy: "test-system",
        stageContext: Stage.S4,
      },
    });

    // remove config key
    await prisma.configurationEntry.deleteMany({ where: { configKey: "handoff.H1.checklist" } });
    const r = await http("POST", `/handoffs/${h.id}/accept`, L1, { checklistCompletion: { VOUCHER_VERIFIED: true, PAYMENT_STATUS_REVIEWED: true } });
    const pass = r.status === 422 && (r.json as any)?.error === "MissingConfigurationError";
    results.push({ id: "AC-S5-036", title: "Missing handoff.H1.checklist blocks accept", pass, status: r.status, body: r.json });

    // restore config for subsequent cases
    await prisma.configurationEntry.create({
      data: {
        configKey: "handoff.H1.checklist",
        configValue: [
          { code: "VOUCHER_VERIFIED", mandatory: true, description: "Confirmation voucher on file" },
          { code: "PAYMENT_STATUS_REVIEWED", mandatory: true, description: "Advance payment status reviewed" },
        ],
        effectiveFrom: new Date(),
        effectiveTo: null,
        setBy: "test-system",
        setAt: new Date(),
        notes: "Restored by acceptance test",
      },
    });
  }

  // --- AC-S5-035: missing noShow.cutoffWindowMinutes blocks no-show ---
  {
    // remove config key
    await prisma.configurationEntry.deleteMany({ where: { configKey: "noShow.cutoffWindowMinutes" } });

    // create an entry where cutoff is reached, so failure is config-driven
    const ns2 = await prisma.entry.create({
      data: {
        inquiryId: leisure.inquiryId,
        guestProfileId: leisure.guestProfileId,
        useType: "LEISURE",
        status: "ACTIVE",
        currentStage: Stage.S5,
        checkInDate: leisure.checkInDate,
        checkOutDate: leisure.checkOutDate,
        guestCount: 1,
        createdBy: "test-system",
        noShowCutoffReachedAt: new Date(),
      },
    });
    await prisma.segment.create({ data: { entryId: ns2.id, segmentNumber: 1 } });
    await prisma.folio.create({
      data: { entryId: ns2.id, billingModel: "GUEST_PAY", createdBy: "test", advancePaymentReconciliationComplete: true },
    });

    const r = await http("POST", `/entries/${ns2.id}/no-show`, L2, {
      determinationPath: "SUB_PATH_1",
      contactAttemptLog: [{ channel: "PHONE", attemptedAt: new Date().toISOString(), outcome: "NO_ANSWER" }],
      decisionReason: "test",
    });
    const pass = r.status === 422 && (r.json as any)?.error === "MissingConfigurationError";
    results.push({ id: "AC-S5-035", title: "Missing noShow.cutoffWindowMinutes blocks no-show", pass, status: r.status, body: r.json });

    // restore config for subsequent cases
    await prisma.configurationEntry.create({
      data: {
        configKey: "noShow.cutoffWindowMinutes",
        configValue: 120,
        effectiveFrom: new Date(),
        effectiveTo: null,
        setBy: "test-system",
        setAt: new Date(),
        notes: "Restored by acceptance test",
      },
    });
  }

  // --- AC-S5-020: CREDIT_CEILING_CHECK task only when creditCeilingIfExtended exists ---
  {
    const tasks = await prisma.preArrivalTask.findMany({ where: { entryId } });
    const has = tasks.some((t) => t.taskType === "CREDIT_CEILING_CHECK");
    results.push({
      id: "AC-S5-020",
      title: "CREDIT_CEILING_CHECK task absent when no credit extension",
      pass: has === false,
      body: { taskTypes: tasks.map((t) => t.taskType) },
    });
  }

  // --- AC-S5-021: Tier 1 (75%) ambient notice writes CreditCeilingThresholdEvent ---
  {
    // Create a credit-ceiling entry at exactly 75%.
    const e = await prisma.entry.create({
      data: {
        inquiryId: leisure.inquiryId,
        guestProfileId: leisure.guestProfileId,
        useType: "CORPORATE",
        status: "ACTIVE",
        currentStage: Stage.S5,
        checkInDate: leisure.checkInDate,
        checkOutDate: leisure.checkOutDate,
        guestCount: 1,
        createdBy: "test-system",
      },
    });
    const seg = await prisma.segment.create({ data: { entryId: e.id, segmentNumber: 1 } });
    await prisma.reservation.create({
      data: {
        entryId: e.id,
        segmentId: seg.id,
        frozenRate: 1,
        frozenRatePlanId: "rp",
        frozenInclusions: {},
        frozenCancellationTerms: { sameDayPenaltyAmount: 10 },
        frozenBillingModel: "DIRECT_BILL",
        frozenCheckInDate: leisure.checkInDate!,
        frozenCheckOutDate: leisure.checkOutDate!,
        frozenGuestCount: 1,
        creditCeilingIfExtended: 1000,
        confirmedAt: new Date(),
        confirmedBy: "test",
      },
    });
    await prisma.folio.create({
      data: { entryId: e.id, billingModel: "DIRECT_BILL", createdBy: "test", outstandingBalance: 750, advancePaymentReconciliationComplete: true },
    });
    await preArrivalService.evaluateCreditCeiling(prisma, e.id, L2.id);
    const ev = await prisma.creditCeilingThresholdEvent.findFirst({ where: { entryId: e.id }, orderBy: { createdAt: "desc" } });
    results.push({
      id: "AC-S5-021",
      title: "Credit ceiling Tier1 writes CreditCeilingThresholdEvent",
      pass: !!ev && ev.thresholdPercent === 75,
      body: ev,
    });
  }

  // --- AC-S5-030: OTA entries set otaNotificationRequired/open loop on no-show determination ---
  {
    const ota = await prisma.entry.create({
      data: {
        inquiryId: leisure.inquiryId,
        guestProfileId: leisure.guestProfileId,
        useType: "LEISURE",
        status: "ACTIVE",
        currentStage: Stage.S5,
        checkInDate: leisure.checkInDate,
        checkOutDate: leisure.checkOutDate,
        guestCount: 1,
        createdBy: "test-system",
        otaSource: true,
        noShowCutoffReachedAt: new Date(),
      },
    });
    const seg = await prisma.segment.create({ data: { entryId: ota.id, segmentNumber: 1 } });
    await prisma.reservation.create({
      data: {
        entryId: ota.id,
        segmentId: seg.id,
        frozenRate: 1,
        frozenRatePlanId: "rp",
        frozenInclusions: {},
        frozenCancellationTerms: { sameDayPenaltyAmount: 9999 },
        frozenBillingModel: "GUEST_PAY",
        frozenCheckInDate: leisure.checkInDate!,
        frozenCheckOutDate: leisure.checkOutDate!,
        frozenGuestCount: 1,
        confirmedAt: new Date(),
        confirmedBy: "test",
      },
    });
    const folio = await prisma.folio.create({ data: { entryId: ota.id, billingModel: "GUEST_PAY", createdBy: "test", advancePaymentReconciliationComplete: true } });
    await prisma.paymentRecord.create({ data: { folioId: folio.id, amount: 50, paymentDirection: "IN" } });
    await http("POST", `/entries/${ota.id}/no-show`, L2, {
      determinationPath: "SUB_PATH_1",
      contactAttemptLog: [{ channel: "PHONE", attemptedAt: new Date().toISOString(), outcome: "NO_ANSWER" }],
      decisionReason: "ota no-show",
    });
    const det = await prisma.noShowDeterminationRecord.findUnique({ where: { entryId: ota.id } });
    results.push({
      id: "AC-S5-030",
      title: "OTA no-show registers OTA notification open loop",
      pass: det?.otaNotificationRequired === true && det?.otaNotificationStatus === "OPEN",
      body: det,
    });
  }

  // --- AC-S5-008: AWAITING_WRITTEN_CONFIRMATION sub-state does not update Entry fields at entry ---
  {
    const e = await prisma.entry.create({
      data: {
        inquiryId: leisure.inquiryId,
        guestProfileId: leisure.guestProfileId,
        useType: "LEISURE",
        status: "ACTIVE",
        currentStage: Stage.S5,
        checkInDate: leisure.checkInDate,
        checkOutDate: leisure.checkOutDate,
        guestCount: 1,
        createdBy: "test-system",
        noShowCutoffReachedAt: new Date(),
      },
    });
    await prisma.segment.create({ data: { entryId: e.id, segmentNumber: 1 } });
    await prisma.folio.create({ data: { entryId: e.id, billingModel: "GUEST_PAY", createdBy: "test", advancePaymentReconciliationComplete: true } });
    const before = await prisma.entry.findUniqueOrThrow({ where: { id: e.id } });
    const r = await http("POST", `/entries/${e.id}/no-show`, L2, {
      determinationPath: "DEFER",
      contactAttemptLog: [{ channel: "PHONE", attemptedAt: new Date().toISOString(), outcome: "LATE_ARRIVAL_CLAIM" }],
      decisionReason: "defer",
      awaitingConfirmationWindowMinutes: 5,
    });
    const after = await prisma.entry.findUniqueOrThrow({ where: { id: e.id } });
    const pass = r.status === 200 && after.version === before.version;
    results.push({ id: "AC-S5-008", title: "Awaiting written confirmation does not mutate Entry at entry", pass, body: { before, after, res: r } });
  }

  // --- AC-S5-032: W4 idempotency (second fire skips; no double task seeding) ---
  {
    const now = new Date();
    const entryS4 = await prisma.entry.create({
      data: {
        inquiryId: leisure.inquiryId,
        guestProfileId: leisure.guestProfileId,
        useType: "LEISURE",
        status: "ACTIVE",
        currentStage: Stage.S4,
        checkInDate: leisure.checkInDate,
        checkOutDate: leisure.checkOutDate,
        guestCount: 1,
        createdBy: "test-system",
      },
    });
    await prisma.segment.create({ data: { entryId: entryS4.id, segmentNumber: 1 } });
    await prisma.reservation.create({
      data: {
        entryId: entryS4.id,
        segmentId: (await prisma.segment.findFirstOrThrow({ where: { entryId: entryS4.id } })).id,
        frozenRate: 1,
        frozenRatePlanId: "rp",
        frozenInclusions: {},
        frozenCancellationTerms: {},
        frozenBillingModel: "GUEST_PAY",
        frozenCheckInDate: now,
        frozenCheckOutDate: now,
        frozenGuestCount: 1,
        confirmedAt: now,
        confirmedBy: "test",
      },
    });
    await prisma.folio.create({ data: { entryId: entryS4.id, billingModel: "GUEST_PAY", createdBy: "test", advancePaymentReconciliationComplete: true } });
    await prisma.handoffRecord.create({
      data: {
        entryId: entryS4.id,
        handoffType: "H1",
        state: "CREATED",
        fromRole: "RESERVATIONS",
        fromActorId: "test",
        toRole: "FRONT_DESK",
        checklistContent: {},
        createdBy: "test",
        stageContext: Stage.S4,
      },
    });
    const engine = createTimerEngine(process.env.DATABASE_URL!);
    await engine.start();
    const first = await runPreArrivalWindowActivationWorker(prisma, engine as any, { entryId: entryS4.id });
    const taskCount1 = await prisma.preArrivalTask.count({ where: { entryId: entryS4.id } });
    const second = await runPreArrivalWindowActivationWorker(prisma, engine as any, { entryId: entryS4.id });
    const taskCount2 = await prisma.preArrivalTask.count({ where: { entryId: entryS4.id } });
    await engine.stop();
    results.push({
      id: "AC-S5-032",
      title: "W4 idempotency skips second fire",
      pass: (first as any).skipped === false && (second as any).skipped === true && taskCount1 === taskCount2,
      body: { first, second, taskCount1, taskCount2 },
    });
  }

  // --- AC-S5-007: NO_SHOW_CUTOFF worker does not change stage (stays S5) ---
  {
    const e = await prisma.entry.create({
      data: {
        inquiryId: leisure.inquiryId,
        guestProfileId: leisure.guestProfileId,
        useType: "LEISURE",
        status: "ACTIVE",
        currentStage: Stage.S5,
        checkInDate: leisure.checkInDate,
        checkOutDate: leisure.checkOutDate,
        guestCount: 1,
        createdBy: "test-system",
      },
    });
    await prisma.segment.create({ data: { entryId: e.id, segmentNumber: 1 } });
    const engine = createTimerEngine(process.env.DATABASE_URL!);
    await engine.start();
    await runNoShowCutoffWorker(prisma, engine as any, { entryId: e.id, timerType: "NO_SHOW_CUTOFF_W5" });
    await engine.stop();
    const after = await prisma.entry.findUniqueOrThrow({ where: { id: e.id } });
    results.push({ id: "AC-S5-007", title: "No-show cutoff keeps Entry at S5", pass: after.currentStage === "S5", body: after });
  }

  // --- AC-S5-012: H1 auto-fulfilment records acceptance event ---
  {
    await prisma.configurationEntry.updateMany({ where: { configKey: "handoff.H1.autoFulfil.enabled" }, data: { effectiveTo: new Date() } });
    await prisma.configurationEntry.create({
      data: {
        configKey: "handoff.H1.autoFulfil.enabled",
        configValue: true,
        effectiveFrom: new Date(),
        effectiveTo: null,
        setBy: "test-system",
        setAt: new Date(),
        notes: "Enabled for AC-S5-012",
      },
    });

    const entryS4 = await prisma.entry.create({
      data: {
        inquiryId: leisure.inquiryId,
        guestProfileId: leisure.guestProfileId,
        useType: "LEISURE",
        status: "ACTIVE",
        currentStage: Stage.S4,
        checkInDate: leisure.checkInDate,
        checkOutDate: leisure.checkOutDate,
        guestCount: 1,
        createdBy: "test-system",
      },
    });
    await prisma.segment.create({ data: { entryId: entryS4.id, segmentNumber: 1 } });
    await prisma.reservation.create({
      data: {
        entryId: entryS4.id,
        segmentId: (await prisma.segment.findFirstOrThrow({ where: { entryId: entryS4.id } })).id,
        frozenRate: 1,
        frozenRatePlanId: "rp",
        frozenInclusions: {},
        frozenCancellationTerms: {},
        frozenBillingModel: "GUEST_PAY",
        frozenCheckInDate: leisure.checkInDate!,
        frozenCheckOutDate: leisure.checkOutDate!,
        frozenGuestCount: 1,
        confirmedAt: new Date(),
        confirmedBy: "test",
      },
    });
    await prisma.folio.create({ data: { entryId: entryS4.id, billingModel: "GUEST_PAY", createdBy: "test", advancePaymentReconciliationComplete: true } });
    await prisma.handoffRecord.create({
      data: {
        entryId: entryS4.id,
        handoffType: "H1",
        state: "CREATED",
        fromRole: "RESERVATIONS",
        fromActorId: "test",
        toRole: "FRONT_DESK",
        checklistContent: {},
        createdBy: "test",
        stageContext: Stage.S4,
      },
    });
    const engine = createTimerEngine(process.env.DATABASE_URL!);
    await engine.start();
    await runPreArrivalWindowActivationWorker(prisma, engine as any, { entryId: entryS4.id });
    await engine.stop();

    const h1After = await prisma.handoffRecord.findFirstOrThrow({ where: { entryId: entryS4.id, handoffType: "H1" }, orderBy: { createdAt: "desc" } });
    const pass = h1After.isAutoFulfilled === true && !!h1After.acceptedAt;
    results.push({ id: "AC-S5-012", title: "H1 auto-fulfilment records acceptance event", pass, body: h1After });

    // restore config to false
    await prisma.configurationEntry.updateMany({ where: { configKey: "handoff.H1.autoFulfil.enabled", effectiveTo: null }, data: { effectiveTo: new Date() } });
    await prisma.configurationEntry.create({
      data: {
        configKey: "handoff.H1.autoFulfil.enabled",
        configValue: false,
        effectiveFrom: new Date(),
        effectiveTo: null,
        setBy: "test-system",
        setAt: new Date(),
        notes: "Restored by acceptance test",
      },
    });
  }

  // --- AC-S5-033: W5 idempotency skips when determination exists ---
  {
    const e = await prisma.entry.create({
      data: {
        inquiryId: leisure.inquiryId,
        guestProfileId: leisure.guestProfileId,
        useType: "LEISURE",
        status: "ACTIVE",
        currentStage: Stage.S5,
        checkInDate: leisure.checkInDate,
        checkOutDate: leisure.checkOutDate,
        guestCount: 1,
        createdBy: "test-system",
      },
    });
    await prisma.segment.create({ data: { entryId: e.id, segmentNumber: 1 } });
    await prisma.noShowDeterminationRecord.create({
      data: {
        entryId: e.id,
        determinationPath: "SUB_PATH_1",
        fomActorId: "test-fom-1",
        contactAttemptLog: [],
        decisionReason: "test",
        createdBy: "test-fom-1",
      },
    });
    const engine = createTimerEngine(process.env.DATABASE_URL!);
    await engine.start();
    const out = await runNoShowCutoffWorker(prisma, engine as any, { entryId: e.id, timerType: "NO_SHOW_CUTOFF_W5" });
    await engine.stop();
    results.push({ id: "AC-S5-033", title: "W5 skips when determination already exists", pass: (out as any).skipped === true, body: out });
  }

  // --- AC-S5-034: W23 breach surfaces suggestions and does not create a new RoomAssignment ---
  {
    const dirtyRoom = await prisma.room.create({
      data: {
        roomNumber: `DIRTY-${Date.now()}`,
        roomTypeId: roomClean.roomTypeId,
        floorNumber: 5,
        capacity: 2,
        currentClaimState: "CONFIRMED",
        physicalState: RoomPhysicalState.DIRTY,
      },
    });

    const e = await prisma.entry.create({
      data: {
        inquiryId: leisure.inquiryId,
        guestProfileId: leisure.guestProfileId,
        useType: "LEISURE",
        status: "ACTIVE",
        currentStage: Stage.S5,
        checkInDate: leisure.checkInDate,
        checkOutDate: leisure.checkOutDate,
        guestCount: 1,
        createdBy: "test-system",
      },
    });
    const seg = await prisma.segment.create({ data: { entryId: e.id, segmentNumber: 1 } });
    await prisma.reservation.create({
      data: {
        entryId: e.id,
        segmentId: seg.id,
        frozenRate: 1,
        frozenRatePlanId: "rp",
        frozenInclusions: {},
        frozenCancellationTerms: {},
        frozenBillingModel: "GUEST_PAY",
        frozenCheckInDate: leisure.checkInDate!,
        frozenCheckOutDate: leisure.checkOutDate!,
        frozenGuestCount: 1,
        confirmedAt: new Date(),
        confirmedBy: "test",
      },
    });
    await prisma.folio.create({ data: { entryId: e.id, billingModel: "GUEST_PAY", createdBy: "test", advancePaymentReconciliationComplete: true } });
    await prisma.committedHold.create({
      data: {
        entryId: e.id,
        segmentId: seg.id,
        roomTypeId: roomClean.roomTypeId,
        state: "CONFIRMED",
        placedBy: "test-system",
        expiresAt: new Date(Date.now() + 3600_000),
      },
    });
    await prisma.roomAssignment.create({ data: { entryId: e.id, roomId: dirtyRoom.id, assignedBy: "test-system" } });
    const before = await prisma.roomAssignment.count({ where: { entryId: e.id } });

    const engine = createTimerEngine(process.env.DATABASE_URL!);
    await engine.start();
    await runRoomReadinessSlaWorker(prisma, engine as any, { entryId: e.id, roomId: dirtyRoom.id, phase: "BREACH" });
    await engine.stop();

    const after = await prisma.roomAssignment.count({ where: { entryId: e.id } });
    const trace = await prisma.traceEvent.findFirst({ where: { entryId: e.id, eventType: "ROOM_READINESS_SLA.BREACHED" }, orderBy: { timestamp: "desc" } });
    const suggestions = (trace?.payload as any)?.suggestions as unknown[] | undefined;
    const pass = before === after && Array.isArray(suggestions) && suggestions.length > 0;
    results.push({ id: "AC-S5-034", title: "W23 breach surfaces suggestions without assignment", pass, body: { before, after, trace } });
  }

  return { startedAt, baseUrl, results };
}

run()
  .then(async (out) => {
    await prisma.$disconnect();
    // eslint-disable-next-line no-console
    console.log(JSON.stringify(out, null, 2));
  })
  .catch(async (e) => {
    // eslint-disable-next-line no-console
    console.error(e);
    await prisma.$disconnect();
    process.exit(1);
  });

