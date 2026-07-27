import fs from "node:fs";
import path from "node:path";
import { prisma } from "../src/db.js";

type Actor = { id: string; level: "L1" | "L2" | "L3" | "L4" };
type HttpMethod = "GET" | "POST" | "PATCH";
type Json = Record<string, unknown> | unknown[] | string | number | boolean | null;

const baseUrl = process.env.API_BASE_URL ?? "http://localhost:4000/api";

const L1: Actor = { id: "staff-frontdesk-1", level: "L1" };
const L2: Actor = { id: "staff-fom-1", level: "L2" };
const L3: Actor = { id: "staff-gm-1", level: "L3" };
const L4: Actor = { id: "staff-admin-1", level: "L4" };

function headers(actor: Actor) {
  return { "content-type": "application/json", "x-actor-id": actor.id, "x-actor-level": actor.level };
}

async function http(method: HttpMethod, p: string, actor: Actor, body?: Json) {
  const res = await fetch(`${baseUrl}${p}`, { method, headers: headers(actor), body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await res.text();
  let json: any = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = text;
  }
  return { status: res.status, json };
}

function ensureDir(p: string) {
  if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
}

function toJsonBlock(value: unknown) {
  if (value === undefined) return "";
  try {
    return "\n\n```json\n" + JSON.stringify(value, null, 2) + "\n```\n";
  } catch {
    return "\n\n```json\n" + String(value) + "\n```\n";
  }
}

type Step = { title: string; method?: HttpMethod; path?: string; request?: unknown; status?: number; response?: unknown; pass: boolean; notes?: string };

function writeScenario(outDir: string, name: string, steps: Step[]) {
  const safe = name.replace(/[^a-zA-Z0-9_-]+/g, "_");
  const outPath = path.join(outDir, `${safe}.md`);
  const passed = steps.filter((s) => s.pass).length;
  const lines: string[] = [];
  lines.push(`# Stage 04 scenario — ${name}`);
  lines.push("");
  lines.push(`- Base URL: \`${baseUrl}\``);
  lines.push(`- Passed: **${passed}/${steps.length}**`);
  lines.push("");
  lines.push("## Steps");
  for (const s of steps) {
    lines.push("");
    lines.push(`### ${s.title}`);
    lines.push(`- **Pass**: ${s.pass ? "YES" : "NO"}`);
    if (s.method && s.path) lines.push(`- **API**: ${s.method} \`${s.path}\`${typeof s.status === "number" ? ` → ${s.status}` : ""}`);
    if (s.request !== undefined) lines.push(`- **Request JSON**:${toJsonBlock(s.request).trimEnd()}`);
    if (s.response !== undefined) lines.push(`- **Response JSON**:${toJsonBlock(s.response).trimEnd()}`);
    if (s.notes) lines.push(`- **Notes**: ${s.notes}`);
  }
  fs.writeFileSync(outPath, lines.join("\n"), "utf8");
  return { outPath, passed, total: steps.length };
}

async function timeboxConfig(configKey: string, configValue: any, ttlMs: number) {
  const now = new Date();
  const effectiveFrom = new Date(now.getTime() - 1_000);
  const effectiveTo = new Date(now.getTime() + ttlMs);
  const created = await prisma.configurationEntry.create({
    data: { configKey, configValue, effectiveFrom, effectiveTo, setBy: "stage04-test", notes: "timeboxConfig" } as any,
    select: { id: true },
  });
  return {
    id: created.id,
    async close() {
      await prisma.configurationEntry.update({ where: { id: created.id }, data: { effectiveTo: new Date(Date.now() - 1_000) } as any });
    },
  };
}

async function pickGuestProfileId() {
  const gp = await prisma.guestProfile.findFirst({ orderBy: { createdAt: "desc" }, select: { id: true } });
  if (!gp) throw new Error("Seed must create at least one GuestProfile");
  return gp.id;
}

async function createGuestProfile() {
  const now = Date.now();
  const gp = await prisma.guestProfile.create({
    data: {
      firstName: `Test${now}`,
      lastName: "Guest",
      email: `test-${now}@example.com`,
      createdBy: "stage04-test",
    } as any,
    select: { id: true },
  });
  return gp.id;
}

async function waitFor<T>(fn: () => Promise<T>, predicate: (v: T) => boolean, timeoutMs: number) {
  const start = Date.now();
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const v = await fn();
    if (predicate(v)) return v;
    if (Date.now() - start > timeoutMs) return v;
    await new Promise((r) => setTimeout(r, 500));
  }
}

async function createEntryProgressedToS3(input?: { guestProfileId?: string; useType?: string }) {
  const guestProfileId = input?.guestProfileId ?? (await createGuestProfile());
  const inq = await http("POST", "/inquiries", L1, { guestProfileId, sourceChannel: "DIRECT" });
  const inquiryId = inq.json?.id as string;
  const checkInDate = new Date(Date.now() + 30 * 86400_000).toISOString();
  const checkOutDate = new Date(Date.now() + 31 * 86400_000).toISOString();
  const entry = await http("POST", "/entries", L1, { inquiryId, useType: input?.useType ?? "LEISURE", guestCount: 1, checkInDate, checkOutDate });
  const entryId = entry.json?.id as string;

  // Create a minimal selected configuration directly (avoid availability flakiness).
  const room = await prisma.room.findFirst({ orderBy: { roomNumber: "asc" } });
  if (!room) throw new Error("No rooms in seed");
  await prisma.room.update({ where: { id: room.id }, data: { currentClaimState: "FREE" as any } });
  await prisma.availabilityConfiguration.create({
    data: {
      entryId,
      searchCriteria: { checkInDate, checkOutDate },
      resultSet: { availableRooms: [{ inventoryId: room.id, roomNumber: room.roomNumber, claimState: "FREE" }], unavailableRooms: [], deficientRooms: [], maintenanceConflicts: [], searchTimestamp: new Date().toISOString(), isRevalidationRequired: false } as any,
      optionSelected: { roomId: room.id, isDeficient: false } as any,
      createdBy: L1.id,
    } as any,
  });

  if ((input?.useType ?? "LEISURE") === "CONFERENCE") {
    // S1 exit guard requires a space allocation with attendeeCount + seatingConfig.
    await http("POST", `/entries/${entryId}/spaces/allocate`, L1, { spaceCode: "HALL-A", attendeeCount: 10, seatingConfig: "THEATER" });
  }

  const snapS1 = await prisma.entry.findUniqueOrThrow({ where: { id: entryId } });
  await http("POST", `/entries/${entryId}/progress-stage`, L1, { targetStage: "S2", version: snapS1.version });
  const draft = await http("POST", `/entries/${entryId}/quotations`, L1, {});
  const quotationId = draft.json?.id as string;
  await http("POST", `/quotations/${quotationId}/send`, L1, { validDays: 2, channel: "EMAIL", recipientAddress: "guest@example.com" });
  await http("POST", `/quotations/${quotationId}/accept`, L1, { acceptanceMethod: "WRITTEN" });
  const snapS2 = await prisma.entry.findUniqueOrThrow({ where: { id: entryId } });
  await http("POST", `/entries/${entryId}/progress-stage`, L1, { targetStage: "S3", version: snapS2.version });
  return { entryId };
}

async function prepareS3ExitEvidence(entryId: string) {
  const folio = await http("POST", `/entries/${entryId}/folio/provisional`, L1, { billingModel: "GUEST_PAY" });
  const folioId = folio.json?.id as string;
  await http("POST", `/entries/${entryId}/disclosures/cancellation`, L1, { noShowTreatmentStatement: "No-show treated as 1-night charge" });
  await http("POST", `/folios/${folioId}/payments`, L1, { entryId, amount: 1 });
  await http("POST", `/folios/${folioId}/advance-payment/reconcile`, L1, { entryId });
  const room = await prisma.room.findFirst({ where: { currentClaimState: "FREE" }, orderBy: { roomNumber: "asc" } });
  if (!room) throw new Error("No FREE room");
  await http("POST", `/entries/${entryId}/holds/committed`, L1, { roomId: room.id, commercialJustification: "S4 confirm prep" });
  const snap = await prisma.entry.findUniqueOrThrow({ where: { id: entryId } });
  return { version: snap.version };
}

async function main() {
  const outDir = path.join(process.cwd(), "..", "Documentation_V2", "Stage_04");
  ensureDir(outDir);
  const summaries: Array<{ name: string; outPath: string; passed: number; total: number }> = [];

  // Scenario 01 — Happy path confirm at S4 creates Reservation + CONFIRMED hold + voucher comm + W22 + W4
  {
    const steps: Step[] = [];
    const { entryId } = await createEntryProgressedToS3();
    const { version } = await prepareS3ExitEvidence(entryId);
    const out = await http("POST", `/entries/${entryId}/confirm`, L1, { version });
    steps.push({ title: "Confirm reservation", method: "POST", path: `/entries/${entryId}/confirm`, status: out.status, response: out.json, pass: out.status === 200 && !!out.json?.reservation?.id });
    const hold = await prisma.committedHold.findUnique({ where: { entryId } });
    steps.push({ title: "CommittedHold is CONFIRMED", pass: hold?.state === "CONFIRMED", notes: `state=${hold?.state}` });
    const w4 = await prisma.timerRecord.findFirst({ where: { entryId, timerType: "PRE_ARRIVAL_COUNTDOWN_W4", status: "SCHEDULED" }, orderBy: { createdAt: "desc" } });
    const w22 = await prisma.timerRecord.findFirst({ where: { entryId, timerType: "ACKNOWLEDGEMENT_WINDOW_W22", status: "SCHEDULED", stageContext: "S4" } as any, orderBy: { createdAt: "desc" } });
    steps.push({ title: "W4 + W22 timers scheduled", pass: !!w4 && !!w22, notes: `w4=${w4?.id ?? "none"} w22=${w22?.id ?? "none"}` });
    summaries.push({ name: "scenario_01_happy_path_confirm", ...writeScenario(outDir, "scenario_01_happy_path_confirm", steps) });
  }

  // Scenario 02 — High value confirmation requires L2 (blocks L1)
  {
    const steps: Step[] = [];
    const { entryId } = await createEntryProgressedToS3();
    const { version } = await prepareS3ExitEvidence(entryId);
    // Force accepted quotation to have high nightly rate
    const seg = await prisma.segment.findFirst({ where: { entryId }, orderBy: { segmentNumber: "desc" } });
    const q = await prisma.quotation.findFirst({ where: { entryId, segmentId: seg?.id, state: "ACCEPTED" } as any, orderBy: { createdAt: "desc" } });
    if (q) await prisma.quotation.update({ where: { id: q.id }, data: { commercialTerms: { ...(q.commercialTerms as any), nightlyRate: 999999 } as any } });
    const blocked = await http("POST", `/entries/${entryId}/confirm`, L1, { version });
    steps.push({ title: "L1 blocked", method: "POST", path: `/entries/${entryId}/confirm`, status: blocked.status, response: blocked.json, pass: blocked.status === 409 || blocked.status === 400 });
    summaries.push({ name: "scenario_02_high_value_requires_l2", ...writeScenario(outDir, "scenario_02_high_value_requires_l2", steps) });
  }

  // Scenario 03 — Overbooking detected requires GM-approved record before confirm
  {
    const steps: Step[] = [];
    // Set maxAllowedRooms=1 so having at least 2 reservations triggers detection
    const cfg = await prisma.configurationEntry.create({
      data: { configKey: "overbooking.maxAllowedRooms", configValue: 1 as any, effectiveFrom: new Date(Date.now() - 1_000), effectiveTo: new Date(Date.now() + 5 * 60_000), setBy: "stage04-test", notes: "scenario_03" } as any,
      select: { id: true },
    });
    // create one existing reservation
    const { entryId: e1 } = await createEntryProgressedToS3();
    const { version: v1 } = await prepareS3ExitEvidence(e1);
    await http("POST", `/entries/${e1}/confirm`, L1, { version: v1 });

    // second entry should be blocked
    const otherGuestId = await createGuestProfile();
    const { entryId } = await createEntryProgressedToS3({ guestProfileId: otherGuestId });
    const { version } = await prepareS3ExitEvidence(entryId);
    const blocked = await http("POST", `/entries/${entryId}/confirm`, L1, { version });
    steps.push({ title: "Blocked due to overbooking", method: "POST", path: `/entries/${entryId}/confirm`, status: blocked.status, response: blocked.json, pass: blocked.status === 409 || blocked.status === 400 });

    // add GM approval record and close mitigation plan, then confirm
    await prisma.otaConflictOverbookingRecord.create({
      data: { entryId, triggerType: "DELIBERATE" as any, gmApprovalActorId: L3.id, gmApprovalAt: new Date(), mitigationPlanStatus: "CLOSED", createdBy: L3.id } as any,
    });
    const ok = await http("POST", `/entries/${entryId}/confirm`, L1, { version });
    steps.push({ title: "Confirm succeeds after GM approval record", method: "POST", path: `/entries/${entryId}/confirm`, status: ok.status, response: ok.json, pass: ok.status === 200 });
    await prisma.configurationEntry.update({ where: { id: cfg.id }, data: { effectiveTo: new Date(Date.now() - 1_000) } as any });
    summaries.push({ name: "scenario_03_overbooking_requires_gm_record", ...writeScenario(outDir, "scenario_03_overbooking_requires_gm_record", steps) });
  }

  // Scenario 04 — Multi-booking overlap requires FOM ack
  {
    const steps: Step[] = [];
    const sharedGuestId = await createGuestProfile();
    const { entryId: a } = await createEntryProgressedToS3({ guestProfileId: sharedGuestId });
    const { version: va } = await prepareS3ExitEvidence(a);
    await http("POST", `/entries/${a}/confirm`, L1, { version: va });

    const { entryId } = await createEntryProgressedToS3({ guestProfileId: sharedGuestId });
    // Force same dates as existing reservation by copying entry a dates
    const ea = await prisma.entry.findUniqueOrThrow({ where: { id: a } });
    await prisma.entry.update({ where: { id: entryId }, data: { checkInDate: ea.checkInDate, checkOutDate: ea.checkOutDate } });
    const { version } = await prepareS3ExitEvidence(entryId);
    const blocked = await http("POST", `/entries/${entryId}/confirm`, L1, { version });
    steps.push({ title: "Blocked for multi-booking", method: "POST", path: `/entries/${entryId}/confirm`, status: blocked.status, response: blocked.json, pass: blocked.status === 409 || blocked.status === 400 });
    const ack = await http("POST", `/entries/${entryId}/multi-booking/ack`, L2, { note: "separate engagements" });
    steps.push({ title: "FOM ack recorded", method: "POST", path: `/entries/${entryId}/multi-booking/ack`, status: ack.status, response: ack.json, pass: ack.status === 201 });
    const ok = await http("POST", `/entries/${entryId}/confirm`, L1, { version });
    steps.push({ title: "Confirm succeeds after ack", method: "POST", path: `/entries/${entryId}/confirm`, status: ok.status, response: ok.json, pass: ok.status === 200 });
    summaries.push({ name: "scenario_04_multi_booking_ack", ...writeScenario(outDir, "scenario_04_multi_booking_ack", steps) });
  }

  // Scenario 05 — W22 ack window expires and marks communication TIMED_OUT
  {
    const steps: Step[] = [];
    const cfg = await timeboxConfig("acknowledgement.windowPerType", { voucher: 1 }, 30_000);
    const { entryId } = await createEntryProgressedToS3();
    const { version } = await prepareS3ExitEvidence(entryId);
    const out = await http("POST", `/entries/${entryId}/confirm`, L1, { version });
    steps.push({ title: "Confirm reservation", method: "POST", path: `/entries/${entryId}/confirm`, status: out.status, response: out.json, pass: out.status === 200 });
    const comm = await prisma.communicationRecord.findFirst({ where: { entryId, commType: "CONFIRMATION_VOUCHER" }, orderBy: { createdAt: "desc" } });
    steps.push({ title: "Voucher communication exists", pass: !!comm, notes: `commId=${comm?.id ?? "none"}` });
    await new Promise((r) => setTimeout(r, 1500));
    if (comm) {
      const enq = await http("POST", "/admin/enqueue", L4, { jobName: "ACKNOWLEDGEMENT_WINDOW_W22", data: { communicationRecordId: comm.id } });
      steps.push({ title: "Enqueue W22", method: "POST", path: "/admin/enqueue", status: enq.status, response: enq.json, pass: enq.status === 201 });
      const updated = await waitFor(
        () => prisma.communicationRecord.findUnique({ where: { id: comm.id } }),
        (c) => (c as any)?.acknowledgementStatus === "TIMED_OUT",
        10_000,
      );
      steps.push({ title: "Communication TIMED_OUT", pass: (updated as any)?.acknowledgementStatus === "TIMED_OUT", notes: `status=${(updated as any)?.acknowledgementStatus}` });
    }
    await cfg.close();
    summaries.push({ name: "scenario_05_w22_ack_timeout", ...writeScenario(outDir, "scenario_05_w22_ack_timeout", steps) });
  }

  // Scenario 06 — W4 pre-arrival activation moves entry S4→S5
  {
    const steps: Step[] = [];
    const cfg = await timeboxConfig("preArrival.windowDays", 0, 30_000);
    const { entryId } = await createEntryProgressedToS3();
    const { version } = await prepareS3ExitEvidence(entryId);
    const out = await http("POST", `/entries/${entryId}/confirm`, L1, { version });
    steps.push({ title: "Confirm reservation", method: "POST", path: `/entries/${entryId}/confirm`, status: out.status, response: out.json, pass: out.status === 200 });
    const enq = await http("POST", "/admin/enqueue", L4, { jobName: "PRE_ARRIVAL_COUNTDOWN_W4", data: { entryId } });
    steps.push({ title: "Enqueue W4", method: "POST", path: "/admin/enqueue", status: enq.status, response: enq.json, pass: enq.status === 201 });
    const updated = await waitFor(
      () => prisma.entry.findUnique({ where: { id: entryId } }),
      (e) => (e as any)?.currentStage === "S5",
      10_000,
    );
    steps.push({ title: "Entry at S5", pass: (updated as any)?.currentStage === "S5", notes: `stage=${(updated as any)?.currentStage}` });
    await cfg.close();
    summaries.push({ name: "scenario_06_w4_pre_arrival_activation", ...writeScenario(outDir, "scenario_06_w4_pre_arrival_activation", steps) });
  }

  // Scenario 07 — OTA source skips W22 timer
  {
    const steps: Step[] = [];
    const guestProfileId = await createGuestProfile();
    const inq = await http("POST", "/inquiries", L1, { guestProfileId, sourceChannel: "OTA" });
    const inquiryId = inq.json?.id as string;
    const checkInDate = new Date(Date.now() + 30 * 86400_000).toISOString();
    const checkOutDate = new Date(Date.now() + 31 * 86400_000).toISOString();
    const entry = await http("POST", "/entries", L1, { inquiryId, useType: "LEISURE", guestCount: 1, checkInDate, checkOutDate, otaSource: true, otaReference: "OTA-REF-1" });
    const entryId = entry.json?.id as string;
    const room = await prisma.room.findFirst({ orderBy: { roomNumber: "asc" } });
    if (!room) throw new Error("No rooms in seed");
    await prisma.room.update({ where: { id: room.id }, data: { currentClaimState: "FREE" as any } });
    await prisma.availabilityConfiguration.create({
      data: {
        entryId,
        searchCriteria: { checkInDate, checkOutDate },
        resultSet: { availableRooms: [{ inventoryId: room.id, roomNumber: room.roomNumber, claimState: "FREE" }], unavailableRooms: [], deficientRooms: [], maintenanceConflicts: [], searchTimestamp: new Date().toISOString(), isRevalidationRequired: false } as any,
        optionSelected: { roomId: room.id, isDeficient: false } as any,
        createdBy: L1.id,
      } as any,
    });
    const snapS1 = await prisma.entry.findUniqueOrThrow({ where: { id: entryId } });
    await http("POST", `/entries/${entryId}/progress-stage`, L1, { targetStage: "S2", version: snapS1.version });
    const draft = await http("POST", `/entries/${entryId}/quotations`, L1, {});
    const quotationId = draft.json?.id as string;
    await http("POST", `/quotations/${quotationId}/send`, L1, { validDays: 2, channel: "EMAIL", recipientAddress: "guest@example.com" });
    await http("POST", `/quotations/${quotationId}/accept`, L1, { acceptanceMethod: "WRITTEN" });
    const snapS2 = await prisma.entry.findUniqueOrThrow({ where: { id: entryId } });
    await http("POST", `/entries/${entryId}/progress-stage`, L1, { targetStage: "S3", version: snapS2.version });
    const { version } = await prepareS3ExitEvidence(entryId);
    const out = await http("POST", `/entries/${entryId}/confirm`, L1, { version });
    steps.push({ title: "Confirm OTA entry", method: "POST", path: `/entries/${entryId}/confirm`, status: out.status, response: out.json, pass: out.status === 200 });
    const comm = await prisma.communicationRecord.findFirst({ where: { entryId, commType: "CONFIRMATION_VOUCHER" }, orderBy: { createdAt: "desc" } });
    const w22 = comm
      ? await prisma.timerRecord.findFirst({
          where: { entryId, timerCode: "ACKNOWLEDGEMENT_WINDOW_W22", status: "SCHEDULED", entityType: "CommunicationRecord", entityId: comm.id, stageContext: "S4" } as any,
          orderBy: { createdAt: "desc" },
        })
      : null;
    steps.push({ title: "No S4 voucher W22 scheduled", pass: !w22, notes: `commId=${comm?.id ?? "none"} w22=${w22?.id ?? "none"}` });
    summaries.push({ name: "scenario_07_ota_skips_w22", ...writeScenario(outDir, "scenario_07_ota_skips_w22", steps) });
  }

  // Scenario 08 — AC-S4-005 atomicity: failure after hold CONFIRMED rolls back (hold remains PLACED)
  {
    const steps: Step[] = [];
    const cfg = await timeboxConfig("dev.failpoints.enabled", true, 60_000);
    const { entryId } = await createEntryProgressedToS3();
    const { version } = await prepareS3ExitEvidence(entryId);
    const holdBefore = await prisma.committedHold.findUnique({ where: { entryId }, select: { roomId: true, state: true } });
    const roomId = holdBefore?.roomId ?? null;
    const roomStateBefore = roomId ? await prisma.room.findUnique({ where: { id: roomId }, select: { currentClaimState: true } }) : null;

    const out = await http("POST", `/entries/${entryId}/confirm`, L1, { version, failpoint: "AFTER_HOLD_CONFIRMED" } as any);
    steps.push({
      title: "Confirm fails at failpoint",
      method: "POST",
      path: `/entries/${entryId}/confirm`,
      request: { version, failpoint: "AFTER_HOLD_CONFIRMED" },
      status: out.status,
      response: out.json,
      pass: out.status >= 400,
    });

    const holdAfter = await prisma.committedHold.findUnique({ where: { entryId }, select: { state: true, roomId: true } });
    steps.push({ title: "CommittedHold still PLACED (rolled back)", pass: holdAfter?.state === "PLACED", notes: `state=${holdAfter?.state}` });

    const roomStateAfter = holdAfter?.roomId ? await prisma.room.findUnique({ where: { id: holdAfter.roomId }, select: { currentClaimState: true } }) : null;
    steps.push({
      title: "Room claim state unchanged",
      pass: (roomStateAfter as any)?.currentClaimState === (roomStateBefore as any)?.currentClaimState,
      notes: `before=${(roomStateBefore as any)?.currentClaimState ?? "none"} after=${(roomStateAfter as any)?.currentClaimState ?? "none"}`,
    });

    const res = await prisma.reservation.findUnique({ where: { entryId } }).catch(() => null);
    steps.push({ title: "No Reservation created", pass: !res, notes: `reservationId=${(res as any)?.id ?? "none"}` });

    await cfg.close();
    summaries.push({ name: "scenario_08_atomic_rollback_failpoint", ...writeScenario(outDir, "scenario_08_atomic_rollback_failpoint", steps) });
  }

  // Scenario 09 — AC-S4-004 Reservation is immutable after creation
  {
    const steps: Step[] = [];
    const { entryId } = await createEntryProgressedToS3();
    const { version } = await prepareS3ExitEvidence(entryId);
    const out = await http("POST", `/entries/${entryId}/confirm`, L1, { version });
    steps.push({ title: "Confirm reservation", method: "POST", path: `/entries/${entryId}/confirm`, status: out.status, response: out.json, pass: out.status === 200 });

    const reservationId = out.json?.reservation?.id as string | undefined;
    steps.push({ title: "Reservation id captured", pass: typeof reservationId === "string" && reservationId.length > 0, notes: `id=${reservationId ?? "none"}` });

    if (reservationId) {
      let updateBlocked = false;
      let updateError: any = null;
      try {
        await prisma.reservation.update({ where: { id: reservationId }, data: { frozenBillingModel: "MUTATION_FORBIDDEN" } as any });
      } catch (e) {
        updateBlocked = true;
        updateError = e;
      }
      steps.push({
        title: "Reservation.update rejected",
        pass: updateBlocked,
        response: updateError ? { name: (updateError as any)?.name, code: (updateError as any)?.code, message: (updateError as any)?.message } : null,
      });

      let deleteBlocked = false;
      let deleteError: any = null;
      try {
        await prisma.reservation.delete({ where: { id: reservationId } });
      } catch (e) {
        deleteBlocked = true;
        deleteError = e;
      }
      steps.push({
        title: "Reservation.delete rejected",
        pass: deleteBlocked,
        response: deleteError ? { name: (deleteError as any)?.name, code: (deleteError as any)?.code, message: (deleteError as any)?.message } : null,
      });
    }

    summaries.push({ name: "scenario_09_reservation_immutable", ...writeScenario(outDir, "scenario_09_reservation_immutable", steps) });
  }

  // Scenario 10 — Policy 39: FOC re-verification blocks without GM approval (then passes)
  {
    const steps: Step[] = [];
    const focCfg = await timeboxConfig("foc.configuration", { enabled: true, entitlement: { perRooms: 1 } }, 120_000);
    const { entryId } = await createEntryProgressedToS3({ useType: "GROUP" });
    const { version } = await prepareS3ExitEvidence(entryId);
    // Make quotation terms include FOC fields expected by S4 minimal logic.
    const seg = await prisma.segment.findFirst({ where: { entryId }, orderBy: { segmentNumber: "desc" } });
    const q = await prisma.quotation.findFirst({ where: { entryId, segmentId: seg?.id, state: "ACCEPTED" } as any, orderBy: { createdAt: "desc" } });
    if (q) {
      await prisma.quotation.update({
        where: { id: q.id },
        data: { commercialTerms: { ...(q.commercialTerms as any), roomsRequested: 2, focRoomsRequested: 1 } as any },
      });
    }
    const blocked = await http("POST", `/entries/${entryId}/confirm`, L1, { version });
    steps.push({ title: "Blocked without GM approval", method: "POST", path: `/entries/${entryId}/confirm`, status: blocked.status, response: blocked.json, pass: blocked.status === 409 || blocked.status === 400 });

    // Record GM approval trace (re-use existing S3 route, but we can also create trace directly).
    await prisma.traceEvent.create({
      data: {
        eventType: "FOC.GM_APPROVED",
        actorId: L3.id,
        actorLevel: "L3",
        entityType: "Entry",
        entityId: entryId,
        operation: "APPROVE",
        timestamp: new Date(),
        stageContext: "S4" as any,
        inquiryId: null,
        entryId,
        payload: { entryId, reason: "stage04-test" },
        createdBy: L3.id,
      },
    });
    const ok = await http("POST", `/entries/${entryId}/confirm`, L1, { version });
    steps.push({ title: "Confirm succeeds after GM approval", method: "POST", path: `/entries/${entryId}/confirm`, status: ok.status, response: ok.json, pass: ok.status === 200 });

    await focCfg.close();
    summaries.push({ name: "scenario_10_foc_reverify_requires_gm", ...writeScenario(outDir, "scenario_10_foc_reverify_requires_gm", steps) });
  }

  // Scenario 11 — Policy 67: CONFERENCE requires FOM verification trace (then passes)
  {
    const steps: Step[] = [];
    const { entryId } = await createEntryProgressedToS3({ useType: "CONFERENCE" });
    const { version } = await prepareS3ExitEvidence(entryId);
    const blocked = await http("POST", `/entries/${entryId}/confirm`, L1, { version });
    steps.push({ title: "Blocked without conference verification", method: "POST", path: `/entries/${entryId}/confirm`, status: blocked.status, response: blocked.json, pass: blocked.status === 409 || blocked.status === 400 });
    const verify = await http("POST", `/entries/${entryId}/conference/verify`, L2, { checklist: { hall: true, seating: true, fb: true, specialRequests: true } });
    steps.push({ title: "FOM verification recorded", method: "POST", path: `/entries/${entryId}/conference/verify`, status: verify.status, response: verify.json, pass: verify.status === 201 });
    const ok = await http("POST", `/entries/${entryId}/confirm`, L1, { version });
    steps.push({ title: "Confirm succeeds after verification", method: "POST", path: `/entries/${entryId}/confirm`, status: ok.status, response: ok.json, pass: ok.status === 200 });
    summaries.push({ name: "scenario_11_conference_requires_verify", ...writeScenario(outDir, "scenario_11_conference_requires_verify", steps) });
  }

  const indexPath = path.join(outDir, "README.md");
  const idx: string[] = [];
  idx.push("# Stage_04 — scenario test index");
  idx.push("");
  idx.push(`- Generated at: ${new Date().toISOString()}`);
  idx.push(`- Base URL: \`${baseUrl}\``);
  idx.push("");
  for (const s of summaries) {
    const rel = path.relative(outDir, s.outPath).replaceAll("\\", "/");
    idx.push(`- **${s.name}**: ${s.passed}/${s.total} — \`${rel}\``);
  }
  fs.writeFileSync(indexPath, idx.join("\n"), "utf8");
  // eslint-disable-next-line no-console
  console.log(`Wrote ${indexPath}`);
}

main()
  .catch((e) => {
    // eslint-disable-next-line no-console
    console.error(e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

