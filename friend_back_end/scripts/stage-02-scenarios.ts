import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { PrismaClient } from "@prisma/client";

type Actor = { id: string; level: "L1" | "L2" | "L3" };
type HttpMethod = "GET" | "POST" | "PATCH";
type Json = Record<string, unknown> | unknown[] | string | number | boolean | null;

const prisma = new PrismaClient();
const baseUrl = process.env.API_BASE_URL ?? "http://localhost:4000/api";

const L1: Actor = { id: "stage02-fd-1", level: "L1" };
const L2: Actor = { id: "stage02-fom-1", level: "L2" };
const L3: Actor = { id: "stage02-gm-1", level: "L3" };

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
  lines.push(`# Stage 02 scenario — ${name}`);
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

async function pickGuestProfileId() {
  const gp = await prisma.guestProfile.findFirst({ orderBy: { createdAt: "desc" }, select: { id: true } });
  if (!gp) throw new Error("Seed must create at least one GuestProfile");
  return gp.id;
}

async function timeboxConfig<T>(configKey: string, configValue: T, fn: () => Promise<void>) {
  const id = crypto.randomUUID();
  await prisma.configurationEntry.create({
    data: { id, configKey, configValue: configValue as any, effectiveFrom: new Date(Date.now() - 1_000), effectiveTo: new Date(Date.now() + 5 * 60_000), setBy: "stage02-test", notes: "timeboxConfig" },
  } as any);
  try {
    await fn();
  } finally {
    await prisma.configurationEntry.deleteMany({ where: { id } });
  }
}

async function createEntryProgressedToS2() {
  const guestProfileId = await pickGuestProfileId();
  const inq = await http("POST", "/inquiries", L1, { guestProfileId, sourceChannel: "DIRECT" });
  const inquiryId = inq.json?.id as string;
  const entry = await http("POST", "/entries", L1, {
    inquiryId,
    useType: "LEISURE",
    guestCount: 1,
    checkInDate: new Date(Date.now() + 86400_000).toISOString(),
    checkOutDate: new Date(Date.now() + 2 * 86400_000).toISOString(),
  });
  const entryId = entry.json?.id as string;
  const q = await http("POST", `/entries/${entryId}/availability/query`, L1, {
    checkInDate: new Date(Date.now() + 86400_000).toISOString(),
    checkOutDate: new Date(Date.now() + 2 * 86400_000).toISOString(),
  });
  const cfgId = q.json?.configuration?.id as string;
  const firstOk = (q.json?.result?.availableRooms ?? [])[0];
  await http("PATCH", `/availability/configurations/${cfgId}/select`, L1, { roomId: firstOk.roomId });
  const snapS1 = await prisma.entry.findUniqueOrThrow({ where: { id: entryId } });
  await http("POST", `/entries/${entryId}/progress-stage`, L1, { targetStage: "S2", version: snapS1.version });
  return { entryId };
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

async function main() {
  const outDir = path.join(process.cwd(), "..", "Documentation_V2", "Stage_02");
  ensureDir(outDir);

  const summaries: Array<{ name: string; outPath: string; passed: number; total: number }> = [];

  // Scenario 01 — S2 happy path: create draft → (optional discount approve) → send → accept → progress S2→S3
  {
    const steps: Step[] = [];
    const { entryId } = await createEntryProgressedToS2();

    const draft = await http("POST", `/entries/${entryId}/quotations`, L1, { notes: "stage02 happy path" });
    const quotationId = draft.json?.id as string;
    steps.push({ title: "Create DRAFT quotation", method: "POST", path: `/entries/${entryId}/quotations`, status: draft.status, response: draft.json, pass: draft.status === 201 && draft.json?.state === "DRAFT" });

    const sent = await http("POST", `/quotations/${quotationId}/send`, L1, { validDays: 2, channel: "EMAIL", recipientAddress: "guest@example.com" });
    steps.push({ title: "Send quotation", method: "POST", path: `/quotations/${quotationId}/send`, status: sent.status, response: sent.json, pass: sent.status === 200 && sent.json?.state === "SENT" });

    const acc = await http("POST", `/quotations/${quotationId}/accept`, L1, { acceptanceMethod: "VERBAL", verbatimNote: "accepted" });
    steps.push({ title: "Accept quotation", method: "POST", path: `/quotations/${quotationId}/accept`, status: acc.status, response: acc.json, pass: acc.status === 200 && acc.json?.state === "ACCEPTED" });

    const snap = await prisma.entry.findUniqueOrThrow({ where: { id: entryId } });
    const toS3 = await http("POST", `/entries/${entryId}/progress-stage`, L1, { targetStage: "S3", version: snap.version });
    steps.push({ title: "Progress S2→S3", method: "POST", path: `/entries/${entryId}/progress-stage`, status: toS3.status, response: toS3.json, pass: toS3.status === 200 && toS3.json?.currentStage === "S3" });

    summaries.push({ name: "scenario_01_happy_path", ...writeScenario(outDir, "scenario_01_happy_path", steps) });
  }

  // Scenario 02 — Discount requires approval: send should be blocked until approval trace exists.
  {
    const steps: Step[] = [];
    const { entryId } = await createEntryProgressedToS2();

    const draft = await http("POST", `/entries/${entryId}/quotations`, L1, { requestedDiscount: { discountPercent: 15, discountBasis: "promo" } });
    const quotationId = draft.json?.id as string | undefined;
    steps.push({ title: "Create DRAFT quotation with discount request", method: "POST", path: `/entries/${entryId}/quotations`, status: draft.status, response: draft.json, pass: draft.status === 201 && draft.json?.state === "DRAFT" });
    if (!quotationId) {
      summaries.push({ name: "scenario_02_discount_requires_approval", ...writeScenario(outDir, "scenario_02_discount_requires_approval", steps) });
      return;
    }

    const sendBlocked = await http("POST", `/quotations/${quotationId}/send`, L1, { validDays: 2, channel: "EMAIL", recipientAddress: "guest@example.com" });
    steps.push({ title: "Send blocked without approval", method: "POST", path: `/quotations/${quotationId}/send`, status: sendBlocked.status, response: sendBlocked.json, pass: sendBlocked.status === 409 || sendBlocked.status === 400 });

    const approve = await http("POST", `/quotations/${quotationId}/discount/approve`, L2, {});
    steps.push({ title: "FOM approves discount", method: "POST", path: `/quotations/${quotationId}/discount/approve`, status: approve.status, response: approve.json, pass: approve.status === 200 });

    const sent = await http("POST", `/quotations/${quotationId}/send`, L1, { validDays: 2, channel: "EMAIL", recipientAddress: "guest@example.com" });
    steps.push({ title: "Send succeeds after approval", method: "POST", path: `/quotations/${quotationId}/send`, status: sent.status, response: sent.json, pass: sent.status === 200 && sent.json?.state === "SENT" });

    summaries.push({ name: "scenario_02_discount_requires_approval", ...writeScenario(outDir, "scenario_02_discount_requires_approval", steps) });
  }

  // Scenario 03 — W15 expiry transitions SENT → EXPIRED after validUntil
  {
    const steps: Step[] = [];
    const { entryId } = await createEntryProgressedToS2();

    const draft = await http("POST", `/entries/${entryId}/quotations`, L1, {});
    const quotationId = draft.json?.id as string;
    const sent = await http("POST", `/quotations/${quotationId}/send`, L1, { validDays: 1, channel: "EMAIL", recipientAddress: "guest@example.com" });
    // Force validUntil to past, then schedule validity worker.
    const validUntil = new Date(Date.now() - 1_200);
    await prisma.quotation.update({ where: { id: quotationId }, data: { validUntil } });
    await http("POST", `/admin/enqueue`, { id: "stage02-admin-1", level: "L4" }, { jobName: "QUOTATION_VALIDITY_W15", data: { quotationId }, startAfterMs: 100 });

    const after = await waitFor(() => prisma.quotation.findUnique({ where: { id: quotationId } }), (v) => (v as any)?.state === "EXPIRED", 30_000);
    steps.push({ title: "Quotation expired by W15", pass: (after as any)?.state === "EXPIRED", notes: `Observed state=${(after as any)?.state}` });
    summaries.push({ name: "scenario_03_w15_expiry", ...writeScenario(outDir, "scenario_03_w15_expiry", steps) });
  }

  // Scenario 04 — Supersede creates new DRAFT and cancels timers on prior version
  {
    const steps: Step[] = [];
    const { entryId } = await createEntryProgressedToS2();

    const draft = await http("POST", `/entries/${entryId}/quotations`, L1, { notes: "v1" });
    const q1 = draft.json?.id as string;
    const sent1 = await http("POST", `/quotations/${q1}/send`, L1, { validDays: 2, channel: "EMAIL", recipientAddress: "guest@example.com" });
    steps.push({ title: "Send v1", method: "POST", path: `/quotations/${q1}/send`, status: sent1.status, response: sent1.json, pass: sent1.status === 200 && sent1.json?.state === "SENT" });

    const sup = await http("POST", `/quotations/${q1}/supersede`, L1, { notes: "v2 changes" });
    const q2 = sup.json?.id as string;
    steps.push({ title: "Supersede creates v2 DRAFT", method: "POST", path: `/quotations/${q1}/supersede`, status: sup.status, response: sup.json, pass: sup.status === 201 && sup.json?.state === "DRAFT" && typeof q2 === "string" });

    const old = await prisma.quotation.findUnique({ where: { id: q1 } });
    const timersOld = await prisma.timerRecord.findMany({ where: { entityType: "Quotation", entityId: q1 }, orderBy: { createdAt: "asc" } });
    const cancelledCount = timersOld.filter((t) => t.status === "CANCELLED").length;
    steps.push({
      title: "Prior quotation is SUPERSEDED and timers cancelled",
      pass: (old as any)?.state === "SUPERSEDED" && cancelledCount >= 1,
      notes: `oldState=${(old as any)?.state}; timers=${timersOld.map((t) => `${t.timerCode}:${t.status}`).join(", ")}`,
    });

    summaries.push({ name: "scenario_04_supersede_cancels_timers", ...writeScenario(outDir, "scenario_04_supersede_cancels_timers", steps) });
  }

  // Scenario 05 — W22 acknowledgement window times out CommunicationRecord (PENDING → TIMED_OUT)
  {
    const steps: Step[] = [];
    const { entryId } = await createEntryProgressedToS2();
    const draft = await http("POST", `/entries/${entryId}/quotations`, L1, {});
    const quotationId = draft.json?.id as string;
    await http("POST", `/quotations/${quotationId}/send`, L1, { validDays: 2, channel: "EMAIL", recipientAddress: "guest@example.com" });

    const q = await prisma.quotation.findUniqueOrThrow({ where: { id: quotationId } });
    const commId = q.communicationRecordId as string;
    const commBefore = await prisma.communicationRecord.findUniqueOrThrow({ where: { id: commId } });
    steps.push({ title: "Comm starts as PENDING", pass: commBefore.acknowledgementStatus === "PENDING", notes: `commId=${commId}` });

    await prisma.communicationRecord.update({ where: { id: commId }, data: { acknowledgementTimeoutAt: new Date(Date.now() + 1_200) } });
    await http("POST", `/admin/enqueue`, { id: "stage02-admin-1", level: "L4" } as any, {
      jobName: "ACKNOWLEDGEMENT_WINDOW_W22",
      data: { communicationRecordId: commId },
      startAfterMs: 100,
    });

    const commAfter = await waitFor(() => prisma.communicationRecord.findUnique({ where: { id: commId } }), (v) => (v as any)?.acknowledgementStatus === "TIMED_OUT", 30_000);
    steps.push({ title: "W22 sets TIMED_OUT", pass: (commAfter as any)?.acknowledgementStatus === "TIMED_OUT", notes: `ack=${(commAfter as any)?.acknowledgementStatus}` });
    summaries.push({ name: "scenario_05_w22_ack_window_timeout", ...writeScenario(outDir, "scenario_05_w22_ack_window_timeout", steps) });
  }

  // Scenario 06 — W2 speculative hold expiry releases inventory + writes RoomClaimStateEvent
  {
    const steps: Step[] = [];
    const { entryId } = await createEntryProgressedToS2();
    const room = await prisma.room.findFirst({ where: { currentClaimState: "FREE" }, orderBy: { createdAt: "asc" } });
    if (!room) throw new Error("No FREE room in seed");

    const seg = await prisma.segment.findFirst({ where: { entryId }, orderBy: { startedAt: "desc" }, select: { id: true } });
    if (!seg) throw new Error("Entry must have a Segment");

    const hold = await prisma.speculativeHold.create({
      data: {
        entryId,
        segmentId: seg.id,
        roomId: room.id,
        state: "PLACED",
        placedBy: "stage02-test",
        ttlSeconds: 2,
        expiresAt: new Date(Date.now() + 1_200),
      } as any,
    });
    await prisma.room.update({ where: { id: room.id }, data: { currentClaimState: "SPECULATIVELY_HELD" } });

    await http("POST", `/admin/enqueue`, { id: "stage02-admin-1", level: "L4" } as any, {
      jobName: "SPECULATIVE_HOLD_EXPIRY_W2",
      data: { holdId: hold.id },
      startAfterMs: 100,
    });

    const after = await waitFor(() => prisma.speculativeHold.findUnique({ where: { id: hold.id } }), (v) => (v as any)?.state === "RELEASED", 30_000);
    const roomAfter = await prisma.room.findUniqueOrThrow({ where: { id: room.id } });
    const events = await prisma.roomClaimStateEvent.findMany({ where: { roomId: room.id, entryId }, orderBy: { createdAt: "desc" }, take: 3 });
    steps.push({
      title: "Hold RELEASED and room FREE with event",
      pass: (after as any)?.state === "RELEASED" && roomAfter.currentClaimState === "FREE" && events.some((e) => e.reason === "SPECULATIVE_HOLD_EXPIRED"),
      notes: `holdState=${(after as any)?.state}; room=${roomAfter.currentClaimState}; events=${events.map((e) => e.reason).join(",")}`,
    });

    summaries.push({ name: "scenario_06_w2_spec_hold_expiry", ...writeScenario(outDir, "scenario_06_w2_spec_hold_expiry", steps) });
  }

  // Scenario 07 — Ack window exceeded blocks S2→S3 until FOM resolves open loop
  {
    const steps: Step[] = [];
    const { entryId } = await createEntryProgressedToS2();
    const draft = await http("POST", `/entries/${entryId}/quotations`, L1, {});
    const quotationId = draft.json?.id as string;
    await http("POST", `/quotations/${quotationId}/send`, L1, { validDays: 2, channel: "EMAIL", recipientAddress: "guest@example.com" });

    await http("POST", `/admin/enqueue`, { id: "stage02-admin-1", level: "L4" } as any, { jobName: "QUOTATION_ACK_TRACKER", data: { quotationId }, startAfterMs: 100 });
    const exceeded = await waitFor(
      () => prisma.traceEvent.findFirst({ where: { eventType: "S2.QUOTATION_ACK_WINDOW_EXCEEDED", entityType: "Quotation", entityId: quotationId }, orderBy: { timestamp: "desc" } }),
      (v) => !!v,
      30_000,
    );
    steps.push({ title: "Ack window exceeded recorded (precondition)", pass: !!exceeded, notes: exceeded ? `traceId=${(exceeded as any).id}` : "missing" });

    // Accept only after the exceed trace is present (otherwise worker may skip after acceptance).
    await http("POST", `/quotations/${quotationId}/accept`, L1, { acceptanceMethod: "VERBAL", verbatimNote: "accepted after ack window exceeded trace" });
    const snap = await prisma.entry.findUniqueOrThrow({ where: { id: entryId } });
    const blocked = await http("POST", `/entries/${entryId}/progress-stage`, L1, { targetStage: "S3", version: snap.version });
    steps.push({ title: "S2→S3 blocked until open loop resolved", method: "POST", path: `/entries/${entryId}/progress-stage`, status: blocked.status, response: blocked.json, pass: blocked.status === 409 || blocked.status === 400 });

    const resolved = await http("POST", `/quotations/${quotationId}/ack-open-loop/resolve`, L2, { resolutionType: "CUSTODIAN_DECISION", decisionReason: "Guest confirmed verbally; proceed", note: "FOM resolution" });
    steps.push({ title: "FOM resolves ack open loop", method: "POST", path: `/quotations/${quotationId}/ack-open-loop/resolve`, status: resolved.status, response: resolved.json, pass: resolved.status === 200 && resolved.json?.ok === true });

    const snap2 = await prisma.entry.findUniqueOrThrow({ where: { id: entryId } });
    const ok = await http("POST", `/entries/${entryId}/progress-stage`, L1, { targetStage: "S3", version: snap2.version });
    steps.push({ title: "S2→S3 succeeds after resolution", method: "POST", path: `/entries/${entryId}/progress-stage`, status: ok.status, response: ok.json, pass: ok.status === 200 && ok.json?.currentStage === "S3" });

    summaries.push({ name: "scenario_07_ack_open_loop_blocks_exit", ...writeScenario(outDir, "scenario_07_ack_open_loop_blocks_exit", steps) });
  }

  // Scenario 08 — Speculative hold escalation: config forces FOM authority; L1 is blocked
  {
    const steps: Step[] = [];
    const { entryId } = await createEntryProgressedToS2();
    const room = await prisma.room.findFirst({ where: { currentClaimState: "FREE" }, orderBy: { createdAt: "asc" } });
    if (!room) throw new Error("No FREE room in seed");

    await timeboxConfig("speculativeHold.placementThresholds", { thresholds: [{ maxRooms: 1, authorityRequired: "FOM", maxConcurrentHolds: null }] }, async () => {
      const out = await http("POST", `/entries/${entryId}/holds/speculative`, L1, { roomId: room.id, ttlSeconds: 60, commercialBasis: "test", notes: "expect escalation" });
      steps.push({ title: "L1 blocked; escalation required", method: "POST", path: `/entries/${entryId}/holds/speculative`, status: out.status, response: out.json, pass: out.status === 409 || out.status === 400 });
    });

    summaries.push({ name: "scenario_08_hold_requires_fom_escalation", ...writeScenario(outDir, "scenario_08_hold_requires_fom_escalation", steps) });
  }

  // Scenario 09 — Speculative hold release requires L2 and frees inventory
  {
    const steps: Step[] = [];
    const { entryId } = await createEntryProgressedToS2();
    const room = await prisma.room.findFirst({ where: { currentClaimState: "FREE" }, orderBy: { createdAt: "asc" } });
    if (!room) throw new Error("No FREE room in seed");

    const placed = await http("POST", `/entries/${entryId}/holds/speculative`, L2, { roomId: room.id, ttlSeconds: 120, commercialBasis: "test", notes: "release test" });
    const holdId = placed.json?.id as string;
    steps.push({ title: "Hold placed by L2", method: "POST", path: `/entries/${entryId}/holds/speculative`, status: placed.status, response: placed.json, pass: placed.status === 201 });

    const rel = await http("POST", `/entries/${entryId}/holds/speculative/${holdId}/release`, L2, { releaseReason: "Guest changed mind" });
    steps.push({ title: "Hold released by L2", method: "POST", path: `/entries/${entryId}/holds/speculative/${holdId}/release`, status: rel.status, response: rel.json, pass: rel.status === 200 && rel.json?.state === "RELEASED" });

    const roomAfter = await prisma.room.findUniqueOrThrow({ where: { id: room.id } });
    steps.push({ title: "Room is FREE after release", pass: roomAfter.currentClaimState === "FREE", notes: `roomState=${roomAfter.currentClaimState}` });

    summaries.push({ name: "scenario_09_hold_release_l2", ...writeScenario(outDir, "scenario_09_hold_release_l2", steps) });
  }

  // Scenario 10 — Validity lapsed blocks S2→S3 (accepted quotation past validUntil)
  {
    const steps: Step[] = [];
    const { entryId } = await createEntryProgressedToS2();
    const draft = await http("POST", `/entries/${entryId}/quotations`, L1, {});
    const quotationId = draft.json?.id as string;
    await http("POST", `/quotations/${quotationId}/send`, L1, { validDays: 2, channel: "EMAIL", recipientAddress: "guest@example.com" });
    await http("POST", `/quotations/${quotationId}/accept`, L1, { acceptanceMethod: "WRITTEN" });
    await prisma.quotation.update({ where: { id: quotationId }, data: { validUntil: new Date(Date.now() - 5_000) } });

    const snap = await prisma.entry.findUniqueOrThrow({ where: { id: entryId } });
    const out = await http("POST", `/entries/${entryId}/progress-stage`, L1, { targetStage: "S3", version: snap.version });
    steps.push({ title: "S2→S3 blocked due to validity lapsed", method: "POST", path: `/entries/${entryId}/progress-stage`, status: out.status, response: out.json, pass: out.status === 409 || out.status === 400 });
    summaries.push({ name: "scenario_10_validity_lapsed_blocks_exit", ...writeScenario(outDir, "scenario_10_validity_lapsed_blocks_exit", steps) });
  }

  // Scenario 11 — Duplicate flag OPEN blocks S2→S3
  {
    const steps: Step[] = [];
    const guestProfileId = await pickGuestProfileId();
    const inq = await http("POST", "/inquiries", L1, { guestProfileId, sourceChannel: "DIRECT" });
    const inquiryId = inq.json?.id as string;
    await prisma.duplicateDetectionFlag.create({ data: { inquiryId, status: "OPEN", createdBy: "stage02-test" } as any });

    const entry = await http("POST", "/entries", L1, {
      inquiryId,
      useType: "LEISURE",
      guestCount: 1,
      checkInDate: new Date(Date.now() + 86400_000).toISOString(),
      checkOutDate: new Date(Date.now() + 2 * 86400_000).toISOString(),
    });
    const entryId = entry.json?.id as string;
    const q = await http("POST", `/entries/${entryId}/availability/query`, L1, {
      checkInDate: new Date(Date.now() + 86400_000).toISOString(),
      checkOutDate: new Date(Date.now() + 2 * 86400_000).toISOString(),
    });
    const cfgId = q.json?.configuration?.id as string;
    const firstOk = (q.json?.result?.availableRooms ?? [])[0];
    await http("PATCH", `/availability/configurations/${cfgId}/select`, L1, { roomId: firstOk.roomId });
    const snapS1 = await prisma.entry.findUniqueOrThrow({ where: { id: entryId } });
    await http("POST", `/entries/${entryId}/progress-stage`, L1, { targetStage: "S2", version: snapS1.version });

    const draft = await http("POST", `/entries/${entryId}/quotations`, L1, {});
    const quotationId = draft.json?.id as string;
    await http("POST", `/quotations/${quotationId}/send`, L1, { validDays: 2, channel: "EMAIL", recipientAddress: "guest@example.com" });
    await http("POST", `/quotations/${quotationId}/accept`, L1, { acceptanceMethod: "WRITTEN" });

    const snap = await prisma.entry.findUniqueOrThrow({ where: { id: entryId } });
    const out = await http("POST", `/entries/${entryId}/progress-stage`, L1, { targetStage: "S3", version: snap.version });
    steps.push({ title: "S2→S3 blocked due to duplicate OPEN", method: "POST", path: `/entries/${entryId}/progress-stage`, status: out.status, response: out.json, pass: out.status === 409 || out.status === 400 });
    summaries.push({ name: "scenario_11_duplicate_open_blocks_exit", ...writeScenario(outDir, "scenario_11_duplicate_open_blocks_exit", steps) });
  }

  // Scenario 12 — S2 auto-fulfilment: S1 entry jumps to S3 with S2 evidence TraceEvent
  {
    const steps: Step[] = [];
    const guestProfileId = await pickGuestProfileId();
    const inq = await http("POST", "/inquiries", L1, { guestProfileId, sourceChannel: "DIRECT" });
    const inquiryId = inq.json?.id as string;
    const entry = await http("POST", "/entries", L1, {
      inquiryId,
      useType: "LEISURE",
      guestCount: 1,
      checkInDate: new Date(Date.now() + 86400_000).toISOString(),
      checkOutDate: new Date(Date.now() + 2 * 86400_000).toISOString(),
    });
    const entryId = entry.json?.id as string;
    const q = await http("POST", `/entries/${entryId}/availability/query`, L1, {
      checkInDate: new Date(Date.now() + 86400_000).toISOString(),
      checkOutDate: new Date(Date.now() + 2 * 86400_000).toISOString(),
    });
    const cfgId = q.json?.configuration?.id as string;
    const firstOk = (q.json?.result?.availableRooms ?? [])[0];
    await http("PATCH", `/availability/configurations/${cfgId}/select`, L1, { roomId: firstOk.roomId });
    const snap = await prisma.entry.findUniqueOrThrow({ where: { id: entryId } });

    const out = await http("POST", `/entries/${entryId}/s2/auto-fulfil-to-s3`, L1, { version: snap.version });
    steps.push({ title: "Auto-fulfil route transitions to S3", method: "POST", path: `/entries/${entryId}/s2/auto-fulfil-to-s3`, status: out.status, response: out.json, pass: out.status === 200 && out.json?.currentStage === "S3" });

    const evidence = await prisma.traceEvent.findFirst({ where: { eventType: "S2.AUTO_FULFILLED", entityType: "Entry", entityId: entryId }, orderBy: { timestamp: "desc" } });
    steps.push({ title: "TraceEvent evidence recorded", pass: !!evidence, notes: evidence ? `traceId=${evidence.id}` : "missing" });

    summaries.push({ name: "scenario_12_auto_fulfil_s2", ...writeScenario(outDir, "scenario_12_auto_fulfil_s2", steps) });
  }

  const indexPath = path.join(outDir, "README.md");
  const idx: string[] = [];
  idx.push("# Stage_02 — scenario test index");
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

