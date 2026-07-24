import { prisma } from "../src/db.js";
import { startWorkers } from "../src/workers/runner.js";
import { placeSpeculativeHold } from "../src/services/s2-hold-service.js";
import * as fs from "node:fs";
import * as path from "node:path";

type TimerSnapshot = {
  timerRecordId: string;
  timerCode: string;
  dueAt: string;
  firesAt: string;
  scheduledAt: string;
  firedAt: string | null;
  status: string;
  expectedWaitSeconds: number;
  observedWaitSeconds: number | null;
  bossJobsBefore: unknown;
  bossJobsAfter: unknown;
};

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

function msToSeconds(ms: number) {
  return Math.round((ms / 1000) * 10) / 10;
}

async function waitForTimerFired(timerRecordId: string, timeoutMs: number) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const row = await prisma.timerRecord.findUnique({ where: { id: timerRecordId } });
    if (row && row.status === "FIRED" && row.firedAt) return row;
    await sleep(500);
  }
  return null;
}

async function main() {
  const engine = await startWorkers();
  const actor = { actorId: "timer-test", actorLevel: "L1" as const };

  const now = new Date();
  const room = await prisma.room.findFirst({ where: { currentClaimState: "FREE" }, orderBy: { createdAt: "desc" } });
  if (!room) throw new Error("No FREE room found to place speculative hold");

  const gp = await prisma.guestProfile.create({
    data: { firstName: "Timer", lastName: "Test", email: "timer.test@example.com", createdBy: actor.actorId } as any,
  });
  const inquiry = await prisma.inquiry.create({
    data: {
      referenceNumber: `TIMER-${Date.now()}`,
      guestProfileId: gp.id,
      defaultCustodianId: actor.actorId,
      sourceChannel: "DIRECT",
      createdBy: actor.actorId,
    } as any,
  });
  const entry = await prisma.entry.create({
    data: {
      inquiryId: inquiry.id,
      guestProfileId: gp.id,
      currentStage: "S2",
      createdBy: actor.actorId,
    } as any,
  });
  await prisma.segment.create({
    data: { entryId: entry.id, segmentNumber: 1, stage: "S2", createdBy: actor.actorId } as any,
  });

  // Short TTL to keep the run under a minute.
  const ttlSeconds = 20;
  const scheduledAt = new Date();
  const hold = await placeSpeculativeHold(prisma, entry.id, actor, {
    roomId: room.id,
    ttlSeconds,
    commercialBasis: "Realtime timer worker test",
    notes: "Expect W2 to fire naturally via pg-boss",
  });

  const timer = await prisma.timerRecord.findFirst({
    where: { entryId: entry.id, entityType: "SpeculativeHold", entityId: hold.id, timerCode: "SPECULATIVE_HOLD_EXPIRY_W2" },
    orderBy: { createdAt: "desc" },
  });
  if (!timer) throw new Error("TimerRecord not created for speculative hold expiry");

  const bossJobsBefore = await prisma.$queryRawUnsafe(
    `select id, name, state, start_after, created_on, completed_on, retry_count from pgboss.job where name = 'SPECULATIVE_HOLD_EXPIRY_W2' order by created_on desc limit 5;`,
  );

  const expectedWaitSeconds = msToSeconds(new Date(timer.firesAt as any).getTime() - scheduledAt.getTime());
  const fired = await waitForTimerFired(timer.id, 180_000);
  const observedWaitSeconds = fired?.firedAt ? msToSeconds(new Date(fired.firedAt as any).getTime() - scheduledAt.getTime()) : null;

  const bossJobsAfter = await prisma.$queryRawUnsafe(
    `select id, name, state, start_after, created_on, completed_on, retry_count from pgboss.job where name = 'SPECULATIVE_HOLD_EXPIRY_W2' order by created_on desc limit 5;`,
  );

  const snapshot: TimerSnapshot = {
    timerRecordId: timer.id,
    timerCode: timer.timerCode,
    dueAt: timer.dueAt.toISOString(),
    firesAt: timer.firesAt.toISOString(),
    scheduledAt: scheduledAt.toISOString(),
    firedAt: fired?.firedAt ? fired.firedAt.toISOString() : null,
    status: fired?.status ?? timer.status,
    expectedWaitSeconds,
    observedWaitSeconds,
    bossJobsBefore,
    bossJobsAfter,
  };

  const outDir = path.resolve(process.cwd(), "..", "Documentation_V2", "test");
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, "realtime-worker-timer-test-report.md");

  const md = [
    "# Realtime worker/timer test report",
    "",
    `- **Ran at**: ${now.toISOString()}`,
    `- **Entry**: ${entry.id}`,
    `- **Room**: ${room.id}`,
    "",
    "## Scenario",
    "",
    "- Create new Entry at **S2** + Segment",
    "- Place a **Speculative Hold** with \(ttlSeconds = 20\)",
    "- Wait for pg-boss queue **SPECULATIVE_HOLD_EXPIRY_W2** to fire naturally",
    "",
    "## Configured vs observed timing",
    "",
    "- **Timer code**: `SPECULATIVE_HOLD_EXPIRY_W2`",
    `- **Configured ttlSeconds (input override)**: ${ttlSeconds}`,
    `- **TimerRecord.firesAt**: ${snapshot.firesAt}`,
    `- **Expected wait (derived)**: ~${snapshot.expectedWaitSeconds}s`,
    `- **Observed firedAt**: ${snapshot.firedAt ?? "(not fired within timeout)"}`,
    `- **Observed wait**: ${snapshot.observedWaitSeconds != null ? `~${snapshot.observedWaitSeconds}s` : "(n/a)"}`,
    `- **Final TimerRecord.status**: ${snapshot.status}`,
    "",
    "## Raw TimerRecord snapshot",
    "",
    "```json",
    JSON.stringify(snapshot, null, 2),
    "```",
    "",
  ].join("\n");

  fs.writeFileSync(outPath, md, "utf8");
  // Stop worker engine to avoid dangling connections.
  await engine.stop();
  console.log(`Wrote ${outPath}`);
  // pg-boss workers can keep the event loop alive; exit explicitly for deterministic CI/dev runs.
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

