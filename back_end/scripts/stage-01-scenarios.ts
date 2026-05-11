import fs from "node:fs";
import path from "node:path";
import { PrismaClient } from "@prisma/client";
import { createTimerEngine } from "../src/lib/timer-engine.js";

type Actor = { id: string; level: "L1" | "L2" | "L3" };
type HttpMethod = "GET" | "POST" | "PATCH";
type Json = Record<string, unknown> | unknown[] | string | number | boolean | null;

const prisma = new PrismaClient();
const baseUrl = process.env.API_BASE_URL ?? "http://localhost:4000/api";
const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error("DATABASE_URL is required");
const engine = createTimerEngine(connectionString);

const L1: Actor = { id: "stage01-fd-1", level: "L1" };
const L2: Actor = { id: "stage01-fom-1", level: "L2" };
void L2;

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

async function timeboxConfig(configKey: string, configValue: unknown) {
  const now = new Date();
  const effectiveTo = new Date(now.getTime() + 10 * 60_000);
  await prisma.configurationEntry.create({
    data: {
      configKey,
      configValue: configValue as any,
      effectiveFrom: now,
      effectiveTo,
      setBy: "stage-01-scenarios",
      notes: "Temporary test override",
    } as any,
  });
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

type Step = { title: string; method?: HttpMethod; path?: string; request?: unknown; status?: number; response?: unknown; pass: boolean; notes?: string };

function toJsonBlock(value: unknown) {
  if (value === undefined) return "";
  try {
    return "\n\n```json\n" + JSON.stringify(value, null, 2) + "\n```\n";
  } catch {
    return "\n\n```json\n" + String(value) + "\n```\n";
  }
}

function writeScenario(outDir: string, name: string, steps: Step[]) {
  const safe = name.replace(/[^a-zA-Z0-9_-]+/g, "_");
  const outPath = path.join(outDir, `${safe}.md`);
  const passed = steps.filter((s) => s.pass).length;
  const lines: string[] = [];
  lines.push(`# Stage 01 scenario — ${name}`);
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
    if (s.request !== undefined) {
      lines.push(`- **Request JSON**:${toJsonBlock(s.request).trimEnd()}`);
    }
    if (s.response !== undefined) {
      lines.push(`- **Response JSON**:${toJsonBlock(s.response).trimEnd()}`);
    }
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

async function main() {
  const outDir = path.join(process.cwd(), "..", "Documentation_V2", "Stage_01");
  ensureDir(outDir);

  const summaries: Array<{ name: string; outPath: string; passed: number; total: number }> = [];
  await engine.start();

  // Scenario 01 — Happy path S1: inquiry → entry → availability → select → progress S1→S2
  {
    const steps: Step[] = [];
    const guestProfileId = await pickGuestProfileId();

    const inq = await http("POST", "/inquiries", L1, { guestProfileId, sourceChannel: "DIRECT" });
    const inquiryId = inq.json?.id as string | undefined;
    steps.push({ title: "Create inquiry", method: "POST", path: "/inquiries", request: { guestProfileId, sourceChannel: "DIRECT" }, status: inq.status, response: inq.json, pass: inq.status === 201 && !!inquiryId });
    if (!inquiryId) throw new Error("Missing inquiryId");

    const entry = await http("POST", "/entries", L1, {
      inquiryId,
      useType: "LEISURE",
      guestCount: 1,
      checkInDate: new Date(Date.now() + 86400_000).toISOString(),
      checkOutDate: new Date(Date.now() + 2 * 86400_000).toISOString(),
      otaSource: false,
    });
    const entryId = entry.json?.id as string | undefined;
    const version = entry.json?.version as number | undefined;
    steps.push({ title: "Create entry", method: "POST", path: "/entries", status: entry.status, response: entry.json, pass: entry.status === 201 && !!entryId && typeof version === "number" });
    if (!entryId || version == null) throw new Error("Missing entryId/version");

    const q = await http("POST", `/entries/${entryId}/availability/query`, L1, {
      checkInDate: new Date(Date.now() + 86400_000).toISOString(),
      checkOutDate: new Date(Date.now() + 2 * 86400_000).toISOString(),
    });
    const cfgId = q.json?.configuration?.id as string | undefined;
    const firstOk = (q.json?.result?.availableRooms ?? [])[0];
    steps.push({ title: "Availability query", method: "POST", path: `/entries/${entryId}/availability/query`, status: q.status, response: q.json, pass: q.status === 200 && !!cfgId && !!firstOk?.roomId });
    if (!cfgId || !firstOk?.roomId) throw new Error("Missing cfgId/roomId");

    const sel = await http("PATCH", `/availability/configurations/${cfgId}/select`, L1, { roomId: firstOk.roomId });
    steps.push({ title: "Select preferred", method: "PATCH", path: `/availability/configurations/${cfgId}/select`, status: sel.status, response: sel.json, pass: sel.status === 200 && !!sel.json?.optionSelected });

    // Ensure GuestProfile has contact info for the S1 exit guard.
    await prisma.guestProfile.update({ where: { id: guestProfileId }, data: { email: "s1@example.com" } as any });

    const prog = await http("POST", `/entries/${entryId}/progress-stage`, L1, { targetStage: "S2", version });
    steps.push({ title: "Progress S1→S2", method: "POST", path: `/entries/${entryId}/progress-stage`, status: prog.status, response: prog.json, pass: prog.status === 200 && prog.json?.currentStage === "S2" });

    summaries.push({ name: "scenario_01_happy_path", ...writeScenario(outDir, "scenario_01_happy_path", steps) });
  }

  // Scenario 02 — Selecting a room not in the configuration resultSet is rejected.
  {
    const steps: Step[] = [];
    const guestProfileId = await pickGuestProfileId();
    const inq = await http("POST", "/inquiries", L1, { guestProfileId, sourceChannel: "DIRECT" });
    const inquiryId = inq.json?.id as string;
    const entry = await http("POST", "/entries", L1, { inquiryId, useType: "LEISURE", guestCount: 1, checkInDate: new Date(Date.now() + 86400_000).toISOString(), checkOutDate: new Date(Date.now() + 2 * 86400_000).toISOString() });
    const entryId = entry.json?.id as string;
    const q = await http("POST", `/entries/${entryId}/availability/query`, L1, { checkInDate: new Date(Date.now() + 86400_000).toISOString(), checkOutDate: new Date(Date.now() + 2 * 86400_000).toISOString() });
    const cfgId = q.json?.configuration?.id as string;
    const fakeRoomId = "00000000-0000-0000-0000-000000000000";
    const sel = await http("PATCH", `/availability/configurations/${cfgId}/select`, L1, { roomId: fakeRoomId });
    steps.push({ title: "Select non-result roomId rejected", method: "PATCH", path: `/availability/configurations/${cfgId}/select`, request: { roomId: fakeRoomId }, status: sel.status, response: sel.json, pass: sel.status === 400 });
    summaries.push({ name: "scenario_02_select_non_result_room_rejected", ...writeScenario(outDir, "scenario_02_select_non_result_room_rejected", steps) });
  }

  // Scenario 03 — Inquiry park/unpark cascades to entries.
  {
    const steps: Step[] = [];
    const guestProfileId = await pickGuestProfileId();
    const inq = await http("POST", "/inquiries", L1, { guestProfileId, sourceChannel: "DIRECT" });
    const inquiryId = inq.json?.id as string;
    const entry = await http("POST", "/entries", L1, { inquiryId, useType: "LEISURE", guestCount: 1, checkInDate: new Date(Date.now() + 86400_000).toISOString(), checkOutDate: new Date(Date.now() + 2 * 86400_000).toISOString() });
    const entryId = entry.json?.id as string;

    const park = await http("POST", `/inquiries/${inquiryId}/park`, L1, { reason: "test" });
    steps.push({ title: "Park inquiry", method: "POST", path: `/inquiries/${inquiryId}/park`, status: park.status, response: park.json, pass: park.status === 200 });
    const parked = await prisma.entry.findUnique({ where: { id: entryId } });
    steps.push({ title: "Entry status became PARKED", pass: parked?.status === "PARKED", notes: `Observed status=${parked?.status}` });

    const unpark = await http("POST", `/inquiries/${inquiryId}/unpark`, L1, {});
    steps.push({ title: "Unpark inquiry", method: "POST", path: `/inquiries/${inquiryId}/unpark`, status: unpark.status, response: unpark.json, pass: unpark.status === 200 });
    const active = await prisma.entry.findUnique({ where: { id: entryId } });
    steps.push({ title: "Entry status became ACTIVE", pass: active?.status === "ACTIVE", notes: `Observed status=${active?.status}` });

    summaries.push({ name: "scenario_03_inquiry_park_unpark", ...writeScenario(outDir, "scenario_03_inquiry_park_unpark", steps) });
  }

  // Scenario 04 — S1→S2 blocked when GuestProfile has no primary contact.
  {
    const steps: Step[] = [];
    const guestProfileId = await pickGuestProfileId();
    // Ensure no contact-ish field is present.
    await prisma.guestProfile.update({ where: { id: guestProfileId }, data: { email: null, phone: null } as any });

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
    const version = entry.json?.version as number;
    const q = await http("POST", `/entries/${entryId}/availability/query`, L1, { checkInDate: new Date(Date.now() + 86400_000).toISOString(), checkOutDate: new Date(Date.now() + 2 * 86400_000).toISOString() });
    const cfgId = q.json?.configuration?.id as string;
    const firstOk = (q.json?.result?.availableRooms ?? [])[0];
    await http("PATCH", `/availability/configurations/${cfgId}/select`, L1, { roomId: firstOk.roomId });

    const prog = await http("POST", `/entries/${entryId}/progress-stage`, L1, { targetStage: "S2", version });
    steps.push({
      title: "Progress S1→S2 rejected without contact details",
      method: "POST",
      path: `/entries/${entryId}/progress-stage`,
      status: prog.status,
      response: prog.json,
      pass: prog.status === 409 && prog.json?.blockingCondition === "MISSING_PRIMARY_CONTACT",
    });
    summaries.push({ name: "scenario_04_exit_block_missing_contact", ...writeScenario(outDir, "scenario_04_exit_block_missing_contact", steps) });
  }

  // Scenario 05 — DEFICIENT room selection requires acknowledgement (API-level).
  {
    const steps: Step[] = [];
    const guestProfileId = await pickGuestProfileId();
    const inq = await http("POST", "/inquiries", L1, { guestProfileId, sourceChannel: "DIRECT" });
    const inquiryId = inq.json?.id as string;
    const entry = await http("POST", "/entries", L1, { inquiryId, useType: "LEISURE", guestCount: 1, checkInDate: new Date(Date.now() + 86400_000).toISOString(), checkOutDate: new Date(Date.now() + 2 * 86400_000).toISOString() });
    const entryId = entry.json?.id as string;
    const q = await http("POST", `/entries/${entryId}/availability/query`, L1, { checkInDate: new Date(Date.now() + 86400_000).toISOString(), checkOutDate: new Date(Date.now() + 2 * 86400_000).toISOString() });
    const cfgId = q.json?.configuration?.id as string;
    const def = (q.json?.result?.deficientRooms ?? [])[0];
    if (!def?.roomId) {
      steps.push({ title: "Seed has at least one DEFICIENT room", pass: false, notes: "No deficientRooms returned; seed may be missing DEFICIENT data." });
    } else {
      const selBad = await http("PATCH", `/availability/configurations/${cfgId}/select`, L1, { roomId: def.roomId });
      steps.push({ title: "Selecting DEFICIENT without acknowledgement rejected", method: "PATCH", path: `/availability/configurations/${cfgId}/select`, status: selBad.status, response: selBad.json, pass: selBad.status === 400 });

      const selOk = await http("PATCH", `/availability/configurations/${cfgId}/select`, L1, { roomId: def.roomId, deficientAcknowledgements: [{ acknowledgedBy: L1.id, acknowledgedAt: new Date().toISOString() }] });
      steps.push({ title: "Selecting DEFICIENT with acknowledgement succeeds", method: "PATCH", path: `/availability/configurations/${cfgId}/select`, status: selOk.status, response: selOk.json, pass: selOk.status === 200 && !!selOk.json?.deficientAcknowledgements });
    }
    summaries.push({ name: "scenario_05_deficient_ack_required", ...writeScenario(outDir, "scenario_05_deficient_ack_required", steps) });
  }

  // Scenario 06 — W1 staleness marking: AvailabilityConfiguration becomes stale after cutoff.
  {
    const steps: Step[] = [];
    await timeboxConfig("availability.staleness.ttlSeconds", 1);
    const guestProfileId = await pickGuestProfileId();
    const inq = await http("POST", "/inquiries", L1, { guestProfileId, sourceChannel: "DIRECT" });
    const inquiryId = inq.json?.id as string;
    const entry = await http("POST", "/entries", L1, { inquiryId, useType: "LEISURE", guestCount: 1, checkInDate: new Date(Date.now() + 86400_000).toISOString(), checkOutDate: new Date(Date.now() + 2 * 86400_000).toISOString() });
    const entryId = entry.json?.id as string;
    const q = await http("POST", `/entries/${entryId}/availability/query`, L1, { checkInDate: new Date(Date.now() + 86400_000).toISOString(), checkOutDate: new Date(Date.now() + 2 * 86400_000).toISOString() });
    const cfgId = q.json?.configuration?.id as string;

    // Force createdAt far in the past, then run STAGE_DWELL_MONITOR once.
    await prisma.availabilityConfiguration.update({ where: { id: cfgId }, data: { createdAt: new Date(Date.now() - 48 * 3600_000) } as any });

    await engine.schedule("STAGE_DWELL_MONITOR", { entryId }, { startAfter: new Date(Date.now() + 1_000) });
    const cfg = await waitFor(
      () => prisma.availabilityConfiguration.findUnique({ where: { id: cfgId } }),
      (v) => (v as any)?.isStale === true,
      20_000,
    );
    steps.push({ title: "W1 marked configuration stale", pass: (cfg as any)?.isStale === true, notes: `Observed isStale=${(cfg as any)?.isStale}` });
    summaries.push({ name: "scenario_06_w1_marks_stale", ...writeScenario(outDir, "scenario_06_w1_marks_stale", steps) });
  }

  // Scenario 07 — W16 processing lock expiry + reconfirm creates RevalidationDeltaRecord.
  {
    const steps: Step[] = [];
    const guestProfileId = await pickGuestProfileId();
    const inq = await http("POST", "/inquiries", L1, { guestProfileId, sourceChannel: "DIRECT" });
    const inquiryId = inq.json?.id as string;
    const entry = await http("POST", "/entries", L1, { inquiryId, useType: "LEISURE", guestCount: 1, checkInDate: new Date(Date.now() + 86400_000).toISOString(), checkOutDate: new Date(Date.now() + 2 * 86400_000).toISOString() });
    const entryId = entry.json?.id as string;

    const lock = await http("POST", "/processing-locks", L1, { inventoryReference: "INV", channel: "FRONT_DESK", entryContext: { entryId } });
    const lockId = lock.json?.lock?.id ?? lock.json?.id;
    steps.push({ title: "Place processing lock", method: "POST", path: "/processing-locks", status: lock.status, response: lock.json, pass: lock.status === 201 || lock.status === 200 });
    if (!lockId) throw new Error("Missing lockId");

    // Force expiresAt near-now then schedule expiry worker.
    const expiresAt = new Date(Date.now() + 1_500);
    await prisma.processingLockRecord.update({ where: { id: lockId }, data: { expiresAt, status: "ACTIVE" } as any });
    await engine.schedule("PROCESSING_LOCK_TTL", { lockId }, { startAfter: expiresAt });
    const after = await waitFor(
      () => prisma.processingLockRecord.findUnique({ where: { id: lockId } }),
      (v) => (v as any)?.status === "EXPIRED",
      30_000,
    );
    steps.push({ title: "Lock became EXPIRED", pass: (after as any)?.status === "EXPIRED", notes: `Observed status=${(after as any)?.status}` });

    const reconfirm = await http("POST", `/processing-locks/${lockId}/reconfirm`, L1, {});
    const newLockId = reconfirm.json?.newLock?.id;
    const deltaId = reconfirm.json?.revalidationDelta?.id;
    steps.push({ title: "Reconfirm created new lock + delta", method: "POST", path: `/processing-locks/${lockId}/reconfirm`, status: reconfirm.status, response: reconfirm.json, pass: reconfirm.status === 200 && !!newLockId && !!deltaId });
    summaries.push({ name: "scenario_07_w16_reconfirm_delta", ...writeScenario(outDir, "scenario_07_w16_reconfirm_delta", steps) });
  }

  // Scenario 08 — W20 entry expiry transitions Entry.status → EXPIRED
  {
    const steps: Step[] = [];
    const guestProfileId = await pickGuestProfileId();
    const inq = await http("POST", "/inquiries", L1, { guestProfileId, sourceChannel: "DIRECT" });
    const inquiryId = inq.json?.id as string;
    const entry = await http("POST", "/entries", L1, { inquiryId, useType: "LEISURE", guestCount: 1, checkInDate: new Date(Date.now() + 86400_000).toISOString(), checkOutDate: new Date(Date.now() + 2 * 86400_000).toISOString() });
    const entryId = entry.json?.id as string;

    await engine.schedule("ENTRY_EXPIRY", { entryId }, { startAfter: new Date(Date.now() + 1_000) });
    const updated = await waitFor(() => prisma.entry.findUnique({ where: { id: entryId } }), (v) => (v as any)?.status === "EXPIRED", 30_000);
    steps.push({ title: "Entry became EXPIRED", pass: (updated as any)?.status === "EXPIRED", notes: `Observed status=${(updated as any)?.status}` });
    summaries.push({ name: "scenario_08_w20_entry_expiry", ...writeScenario(outDir, "scenario_08_w20_entry_expiry", steps) });
  }

  // Scenario 09 — Shadow inventory hidden for L1 (availability results should omit shadow rooms).
  {
    const steps: Step[] = [];
    const guestProfileId = await pickGuestProfileId();
    const inq = await http("POST", "/inquiries", L1, { guestProfileId, sourceChannel: "DIRECT" });
    const inquiryId = inq.json?.id as string;
    const entry = await http("POST", "/entries", L1, { inquiryId, useType: "LEISURE", guestCount: 1, checkInDate: new Date(Date.now() + 86400_000).toISOString(), checkOutDate: new Date(Date.now() + 2 * 86400_000).toISOString() });
    const entryId = entry.json?.id as string;
    const q = await http("POST", `/entries/${entryId}/availability/query`, L1, { checkInDate: new Date(Date.now() + 86400_000).toISOString(), checkOutDate: new Date(Date.now() + 2 * 86400_000).toISOString() });
    const all = [...(q.json?.result?.availableRooms ?? []), ...(q.json?.result?.deficientRooms ?? []), ...(q.json?.result?.unavailableRooms ?? [])];
    const has401 = all.some((r: any) => r.roomNumber === "401");
    steps.push({ title: "L1 does not see shadow room 401", method: "POST", path: `/entries/${entryId}/availability/query`, status: q.status, response: q.json, pass: q.status === 200 && has401 === false });
    summaries.push({ name: "scenario_09_shadow_inventory_hidden_l1", ...writeScenario(outDir, "scenario_09_shadow_inventory_hidden_l1", steps) });
  }

  // Scenario 10 — Duplicate flag blocks S1 exit until resolved.
  {
    const steps: Step[] = [];
    const guestProfileId = await pickGuestProfileId();
    const inq = await http("POST", "/inquiries", L1, { guestProfileId, sourceChannel: "DIRECT", duplicateCheck: { isDuplicate: true, conflictingInquiryId: "conflict-1" } });
    const inquiryId = inq.json?.id as string;
    steps.push({ title: "Create inquiry with duplicate flag", method: "POST", path: "/inquiries", status: inq.status, response: inq.json, pass: inq.status === 201 });

    const entry = await http("POST", "/entries", L1, { inquiryId, useType: "LEISURE", guestCount: 1, checkInDate: new Date(Date.now() + 86400_000).toISOString(), checkOutDate: new Date(Date.now() + 2 * 86400_000).toISOString() });
    const entryId = entry.json?.id as string;
    const version = entry.json?.version as number;
    const q = await http("POST", `/entries/${entryId}/availability/query`, L1, { checkInDate: new Date(Date.now() + 86400_000).toISOString(), checkOutDate: new Date(Date.now() + 2 * 86400_000).toISOString() });
    const cfgId = q.json?.configuration?.id as string;
    const firstOk = (q.json?.result?.availableRooms ?? [])[0];
    await http("PATCH", `/availability/configurations/${cfgId}/select`, L1, { roomId: firstOk.roomId });
    await prisma.guestProfile.update({ where: { id: guestProfileId }, data: { email: "dup@example.com" } as any });

    const progBlocked = await http("POST", `/entries/${entryId}/progress-stage`, L1, { targetStage: "S2", version });
    steps.push({ title: "S1 exit blocked by open duplicate", method: "POST", path: `/entries/${entryId}/progress-stage`, status: progBlocked.status, response: progBlocked.json, pass: progBlocked.status === 409 && progBlocked.json?.blockingCondition === "DUPLICATE_UNRESOLVED" });

    const flag = await prisma.duplicateDetectionFlag.findFirst({ where: { inquiryId, status: "OPEN" as any } as any, orderBy: { createdAt: "desc" } as any });
    if (!flag) throw new Error("Expected duplicate flag");
    const resolved = await http("POST", `/duplicate-flags/${flag.id}/resolve`, L1, { resolutionType: "DISMISS", resolutionReason: "false positive" });
    steps.push({ title: "Resolve duplicate flag", method: "POST", path: `/duplicate-flags/${flag.id}/resolve`, status: resolved.status, response: resolved.json, pass: resolved.status === 200 && resolved.json?.status === "RESOLVED" });

    const latest = await prisma.entry.findUnique({ where: { id: entryId } });
    const progOk = await http("POST", `/entries/${entryId}/progress-stage`, L1, { targetStage: "S2", version: latest?.version });
    steps.push({ title: "S1 exit succeeds after resolution", method: "POST", path: `/entries/${entryId}/progress-stage`, status: progOk.status, response: progOk.json, pass: progOk.status === 200 && progOk.json?.currentStage === "S2" });

    summaries.push({ name: "scenario_10_duplicate_blocks_exit_until_resolved", ...writeScenario(outDir, "scenario_10_duplicate_blocks_exit_until_resolved", steps) });
  }

  // Scenario 11 — Corporate/Government context required when inquiry sourceChannel=CORPORATE.
  {
    const steps: Step[] = [];
    const guestProfileId = await pickGuestProfileId();
    const inq = await http("POST", "/inquiries", L1, { guestProfileId, sourceChannel: "CORPORATE" });
    const inquiryId = inq.json?.id as string;
    const entry = await http("POST", "/entries", L1, { inquiryId, useType: "LEISURE", guestCount: 1, checkInDate: new Date(Date.now() + 86400_000).toISOString(), checkOutDate: new Date(Date.now() + 2 * 86400_000).toISOString() });
    const entryId = entry.json?.id as string;
    const version = entry.json?.version as number;
    const q = await http("POST", `/entries/${entryId}/availability/query`, L1, { checkInDate: new Date(Date.now() + 86400_000).toISOString(), checkOutDate: new Date(Date.now() + 2 * 86400_000).toISOString() });
    const cfgId = q.json?.configuration?.id as string;
    const firstOk = (q.json?.result?.availableRooms ?? [])[0];
    await http("PATCH", `/availability/configurations/${cfgId}/select`, L1, { roomId: firstOk.roomId });
    await prisma.guestProfile.update({ where: { id: guestProfileId }, data: { email: "corp@example.com" } as any });

    const progBlocked = await http("POST", `/entries/${entryId}/progress-stage`, L1, { targetStage: "S2", version });
    steps.push({ title: "Exit blocked without corporate context", method: "POST", path: `/entries/${entryId}/progress-stage`, status: progBlocked.status, response: progBlocked.json, pass: progBlocked.status === 409 && String(progBlocked.json?.blockingCondition ?? "").startsWith("MISSING_CORP_") });

    const cap = await http("PATCH", `/inquiries/${inquiryId}/corporate-context`, L1, { corporateClientRef: "ACME-001", corporateCoordinator: "Coordinator A" });
    steps.push({ title: "Capture corporate context", method: "PATCH", path: `/inquiries/${inquiryId}/corporate-context`, status: cap.status, response: cap.json, pass: cap.status === 200 && !!cap.json?.corporateClientRef });

    const latest = await prisma.entry.findUnique({ where: { id: entryId } });
    const progOk = await http("POST", `/entries/${entryId}/progress-stage`, L1, { targetStage: "S2", version: latest?.version });
    steps.push({ title: "Exit succeeds after corporate context", method: "POST", path: `/entries/${entryId}/progress-stage`, status: progOk.status, response: progOk.json, pass: progOk.status === 200 && progOk.json?.currentStage === "S2" });

    summaries.push({ name: "scenario_11_corporate_context_required", ...writeScenario(outDir, "scenario_11_corporate_context_required", steps) });
  }

  // Scenario 12 — Apartment exit requires duration + tier code.
  {
    const steps: Step[] = [];
    const guestProfileId = await pickGuestProfileId();
    const inq = await http("POST", "/inquiries", L1, { guestProfileId, sourceChannel: "DIRECT" });
    const inquiryId = inq.json?.id as string;
    const entry = await http("POST", "/entries", L1, { inquiryId, useType: "APARTMENT", guestCount: 1, checkInDate: new Date(Date.now() + 86400_000).toISOString(), checkOutDate: new Date(Date.now() + 8 * 86400_000).toISOString() });
    const entryId = entry.json?.id as string;
    const version = entry.json?.version as number;
    const q = await http("POST", `/entries/${entryId}/availability/query`, L1, { checkInDate: new Date(Date.now() + 86400_000).toISOString(), checkOutDate: new Date(Date.now() + 8 * 86400_000).toISOString() });
    const cfgId = q.json?.configuration?.id as string;
    const firstOk = (q.json?.result?.availableRooms ?? [])[0];
    await http("PATCH", `/availability/configurations/${cfgId}/select`, L1, { roomId: firstOk.roomId });
    await prisma.guestProfile.update({ where: { id: guestProfileId }, data: { email: "apt@example.com" } as any });

    const progBlocked = await http("POST", `/entries/${entryId}/progress-stage`, L1, { targetStage: "S2", version });
    steps.push({ title: "Exit blocked without apartment context", method: "POST", path: `/entries/${entryId}/progress-stage`, status: progBlocked.status, response: progBlocked.json, pass: progBlocked.status === 409 && String(progBlocked.json?.blockingCondition ?? "").startsWith("MISSING_APARTMENT_") });

    const ctx = await http("PATCH", `/entries/${entryId}/apartment-context`, L1, { apartmentDurationNights: 7, apartmentRateTierCode: "TIER_7D" });
    steps.push({ title: "Set apartment context", method: "PATCH", path: `/entries/${entryId}/apartment-context`, status: ctx.status, response: ctx.json, pass: ctx.status === 200 && ctx.json?.apartmentRateTierCode === "TIER_7D" });

    const latest = await prisma.entry.findUnique({ where: { id: entryId } });
    const progOk = await http("POST", `/entries/${entryId}/progress-stage`, L1, { targetStage: "S2", version: latest?.version });
    steps.push({ title: "Exit succeeds after apartment context", method: "POST", path: `/entries/${entryId}/progress-stage`, status: progOk.status, response: progOk.json, pass: progOk.status === 200 && progOk.json?.currentStage === "S2" });

    summaries.push({ name: "scenario_12_apartment_context_required", ...writeScenario(outDir, "scenario_12_apartment_context_required", steps) });
  }

  // Index file for convenience.
  const indexPath = path.join(outDir, "README.md");
  const idx: string[] = [];
  idx.push("# Stage_01 — scenario test index");
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
  await engine.stop();
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

