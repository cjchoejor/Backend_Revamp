import { PrismaClient, Stage } from "@prisma/client";

type Json = Record<string, unknown> | unknown[] | string | number | boolean | null;

const prisma = new PrismaClient();
const baseUrl = process.env.API_BASE_URL ?? "http://localhost:4000/api";

type Actor = { id: string; level: "L1" | "L2" | "L3" | "L4" };
const L1: Actor = { id: "test-fd-1", level: "L1" };

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

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

type CaseResult = {
  id: string;
  title: string;
  pass: boolean;
  status?: number;
  body?: Json;
  notes?: string;
};

async function progressS5ToS6(entryId: string) {
  const e = await prisma.entry.findUniqueOrThrow({
    where: { id: entryId },
    include: { handoffs: true, preArrivalTasks: true, roomAssignments: true },
  });

  const h1 = e.handoffs.find((h) => h.handoffType === "H1");
  assert(h1, "Seed missing H1 for S5 entry");

  // Accept H1 if needed
  if (h1.state === "CREATED") {
    await http("POST", `/handoffs/${h1.id}/accept`, L1, {
      checklistCompletion: { VOUCHER_VERIFIED: true, PAYMENT_STATUS_REVIEWED: true },
    });
  }

  // Assign room if needed
  if (e.roomAssignments.length === 0) {
    const roomClean = await prisma.room.findFirstOrThrow({ where: { roomNumber: "501" } });
    await http("POST", `/entries/${entryId}/room-assignments`, L1, { roomId: roomClean.id });
  }

  // Fulfil H1 if needed
  const h1After = await prisma.handoffRecord.findUniqueOrThrow({ where: { id: h1.id } });
  if (h1After.state === "ACCEPTED") {
    const ra = await prisma.roomAssignment.findFirstOrThrow({ where: { entryId }, orderBy: { createdAt: "desc" } });
    await http("POST", `/handoffs/${h1.id}/fulfil`, L1, {
      fulfilmentEvidence: {
        roomAssignmentId: ra.id,
        readinessConfirmed: true,
        paymentStatusConfirmed: true,
        ceilingProximityAddressed: true,
      },
    });
  }

  // Complete tasks
  const pending = await prisma.preArrivalTask.findMany({ where: { entryId, status: "PENDING" } });
  for (const t of pending) {
    await http("PATCH", `/pre-arrival-tasks/${t.id}`, L1, { action: "COMPLETE" });
  }

  const e2 = await prisma.entry.findUniqueOrThrow({ where: { id: entryId } });
  return http("POST", `/entries/${entryId}/progress-stage`, L1, {
    targetStage: "S6",
    version: e2.version,
    transitionData: { guestPresentConfirmation: true },
  });
}

async function run() {
  const startedAt = new Date().toISOString();
  const results: CaseResult[] = [];

  const seeded = await prisma.entry.findFirstOrThrow({
    where: { useType: "LEISURE", currentStage: Stage.S5 },
    orderBy: { createdAt: "desc" },
    include: { guestProfile: true, folio: true, roomAssignments: { include: { room: true } }, handoffs: true },
  });
  assert(seeded.guestProfile, "Seed missing guestProfile");

  // Move to S6 (setup)
  {
    const r = await progressS5ToS6(seeded.id);
    results.push({ id: "SETUP-S5->S6", title: "Setup: progress S5->S6", pass: r.status === 200, status: r.status, body: r.json });
  }

  const s6 = await prisma.entry.findUniqueOrThrow({
    where: { id: seeded.id },
    include: { guestProfile: true, folio: true, roomAssignments: { include: { room: true } }, handoffs: true },
  });

  // AC-S6-028: S6->S7 blocked if identity not verified
  {
    // ensure identity not verified
    await prisma.guestProfile.update({ where: { id: s6.guestProfileId! }, data: { identityVerifiedAt: null, identityVerifiedBy: null, identityVerificationPath: null } });
    const r = await http("POST", `/entries/${s6.id}/progress-stage`, L1, {
      targetStage: "S7",
      version: s6.version,
      transitionData: { keyCount: 1, registrationConfirmed: true },
    });
    const pass = r.status === 409 && (r.json as any)?.blockingCondition === "IDENTITY_NOT_VERIFIED";
    results.push({ id: "AC-S6-028", title: "S6 exit blocked if identity not verified", pass, status: r.status, body: r.json });
  }

  // AC-S6-001: FIRST_TIME creates GuestIdentityDocument with retentionExpiresAt math
  {
    const before = await prisma.guestIdentityDocument.count({ where: { guestProfileId: s6.guestProfileId! } });
    const r = await http("POST", `/guest-profiles/${s6.guestProfileId}/verify-identity`, L1, {
      entryId: s6.id,
      verificationPath: "FIRST_TIME",
      documentType: "PASSPORT",
      documentNumber: "AB1234567",
      issuingCountry: "BT",
      expiryDate: "2030-01-01T00:00:00.000Z",
    });
    const after = await prisma.guestIdentityDocument.findMany({ where: { guestProfileId: s6.guestProfileId! }, orderBy: { createdAt: "desc" } });
    const created = after.length === before + 1 ? after[0] : after[0];
    const pass =
      r.status === 200 &&
      created != null &&
      created.retentionPeriod > 0 &&
      Math.abs(created.retentionExpiresAt.getTime() - (created.capturedAt.getTime() + created.retentionPeriod * 86400000)) < 2000;
    results.push({ id: "AC-S6-001", title: "FIRST_TIME identity creates GuestIdentityDocument + retention expires", pass, status: r.status, body: r.json });
  }

  // AC-S6-011: Check-in completion blocked if room not ready (we simulate DIRTY)
  {
    const assignment = await prisma.roomAssignment.findFirstOrThrow({ where: { entryId: s6.id }, orderBy: { createdAt: "desc" }, include: { room: true } });
    await prisma.room.update({ where: { id: assignment.roomId }, data: { physicalState: "DIRTY" } });
    const fresh = await prisma.entry.findUniqueOrThrow({ where: { id: s6.id } });
    const r = await http("POST", `/entries/${s6.id}/progress-stage`, L1, {
      targetStage: "S7",
      version: fresh.version,
      transitionData: { keyCount: 1, registrationConfirmed: true },
    });
    const pass = r.status === 409 && (r.json as any)?.blockingCondition === "ROOM_NOT_READY";
    results.push({ id: "AC-S6-011", title: "S6->S7 blocked when room not ready", pass, status: r.status, body: r.json });
    // restore room
    await prisma.room.update({ where: { id: assignment.roomId }, data: { physicalState: "AVAILABLE_CLEAN" } });
  }

  // AC-S6-027 + AC-S6-005 + AC-S6-010 + AC-S6-012: Happy path S6->S7 sets LIVE, OCCUPIED, RoomClaimStateEvent, closes H1, creates H2/H3
  {
    const before = await prisma.entry.findUniqueOrThrow({ where: { id: s6.id }, include: { folio: true, roomAssignments: { include: { room: true } }, handoffs: true } });
    const r = await http<any>("POST", `/entries/${s6.id}/progress-stage`, L1, {
      targetStage: "S7",
      version: before.version,
      transitionData: { keyCount: 2, registrationConfirmed: true },
    });
    const after = await prisma.entry.findUniqueOrThrow({
      where: { id: s6.id },
      include: { folio: true, roomAssignments: { include: { room: true } }, handoffs: true },
    });
    const room = after.roomAssignments[0]?.room;
    const claimEvent = room ? await prisma.roomClaimStateEvent.findFirst({ where: { roomId: room.id, entryId: after.id }, orderBy: { createdAt: "desc" } }) : null;
    const h1 = after.handoffs.find((h) => h.handoffType === "H1");
    const h2 = after.handoffs.find((h) => h.handoffType === "H2" && h.stageContext === "S6");
    const h3 = after.handoffs.find((h) => h.handoffType === "H3" && h.stageContext === "S6");

    const pass =
      r.status === 200 &&
      (r.json as any)?.currentStage === "S7" &&
      after.folio?.state === "LIVE" &&
      !!after.folio?.convertedToLiveAt &&
      !!after.folio?.convertedBy &&
      room?.currentClaimState === "OCCUPIED" &&
      claimEvent?.fromState === "CONFIRMED" &&
      claimEvent?.toState === "OCCUPIED" &&
      h1?.state === "CLOSED" &&
      !!h1?.closedAt &&
      !!h2 &&
      !!h3;

    results.push({
      id: "AC-S6-027/005/010/012",
      title: "Happy path completes S6->S7 (folio LIVE, room OCCUPIED, H1 CLOSED, H2/H3 created)",
      pass,
      status: r.status,
      body: r.json,
      notes: JSON.stringify({ folio: after.folio?.state, room: room?.currentClaimState, h1: h1?.state }, null, 0),
    });
  }

  // AC-S6-033: missing identity.documentTypes -> MissingConfigurationError
  {
    // create new guest+entry for isolated test
    const inquiry = await prisma.inquiry.findFirstOrThrow({ orderBy: { createdAt: "desc" } });
    const gp = await prisma.guestProfile.create({ data: { firstName: "New", lastName: "Guest", createdBy: "test" } });
    const e = await prisma.entry.create({
      data: { inquiryId: inquiry.id, guestProfileId: gp.id, currentStage: "S6", status: "ACTIVE", createdBy: "test", version: 1 },
    });
    await prisma.folio.create({ data: { entryId: e.id, billingModel: "GUEST_PAY", createdBy: "test", advancePaymentReconciliationComplete: true } });
    await prisma.configurationEntry.delete({ where: { configKey: "identity.documentTypes" } });

    const r = await http("POST", `/guest-profiles/${gp.id}/verify-identity`, L1, {
      entryId: e.id,
      verificationPath: "FIRST_TIME",
      documentType: "PASSPORT",
      documentNumber: "X1",
    });
    const pass = r.status === 422 && (r.json as any)?.error === "MissingConfigurationError";
    results.push({ id: "AC-S6-033", title: "Missing identity.documentTypes blocks verify-identity", pass, status: r.status, body: r.json });
  }

  // AC-S6-034: VIP guest missing vipNotification.routingPerTier blocks completion
  {
    // restore identity config to proceed
    await prisma.configurationEntry.upsert({
      where: { configKey: "identity.documentTypes" },
      update: { value: [{ documentTypeCode: "PASSPORT", isActive: true }] },
      create: { configKey: "identity.documentTypes", value: [{ documentTypeCode: "PASSPORT", isActive: true }] },
    });
    await prisma.configurationEntry.upsert({
      where: { configKey: "identity.retentionPeriodDays" },
      update: { value: { DEFAULT: 2555, PASSPORT: 2555 } },
      create: { configKey: "identity.retentionPeriodDays", value: { DEFAULT: 2555, PASSPORT: 2555 } },
    });

    const inquiry = await prisma.inquiry.findFirstOrThrow({ orderBy: { createdAt: "desc" } });
    const room = await prisma.room.findFirstOrThrow({ where: { roomNumber: "501" } });
    const gpVip = await prisma.guestProfile.create({ data: { firstName: "VIP", lastName: "Guest", vipTier: "PLATINUM", createdBy: "test" } });
    const vipEntry = await prisma.entry.create({
      data: { inquiryId: inquiry.id, guestProfileId: gpVip.id, currentStage: "S6", status: "ACTIVE", createdBy: "test", version: 1, guestCount: 1 },
    });
    await prisma.folio.create({ data: { entryId: vipEntry.id, billingModel: "GUEST_PAY", createdBy: "test", advancePaymentReconciliationComplete: true } });
    await prisma.roomAssignment.create({ data: { entryId: vipEntry.id, roomId: room.id, assignedBy: "test", deficientAtAssignment: false } });
    await prisma.handoffRecord.create({
      data: { entryId: vipEntry.id, handoffType: "H1", state: "FULFILLED", fromRole: "RES", fromActorId: "test", toRole: "FD", checklistContent: {}, createdBy: "test", stageContext: "S4" },
    });
    await prisma.guestProfile.update({ where: { id: gpVip.id }, data: { identityVerifiedAt: new Date(), identityVerifiedBy: "test", identityVerificationPath: "VIP" } });

    await prisma.configurationEntry.delete({ where: { configKey: "vipNotification.routingPerTier" } });
    const r = await http("POST", `/entries/${vipEntry.id}/progress-stage`, L1, {
      targetStage: "S7",
      version: 1,
      transitionData: { keyCount: 1, registrationConfirmed: true },
    });
    const pass = r.status === 422 && (r.json as any)?.error === "MissingConfigurationError";
    results.push({ id: "AC-S6-034", title: "Missing vipNotification.routingPerTier blocks VIP completion", pass, status: r.status, body: r.json });
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

