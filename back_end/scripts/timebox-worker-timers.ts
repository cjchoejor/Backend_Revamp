import { prisma } from "../src/db.js";
import * as fs from "node:fs";
import * as path from "node:path";

type ConfigRow = { configKey: string; configValue: unknown; effectiveFrom: Date; effectiveTo: Date | null };

async function getActiveConfig(key: string, now: Date): Promise<ConfigRow | null> {
  const row = await prisma.configurationEntry.findFirst({
    where: {
      configKey: key,
      effectiveFrom: { lte: now },
      OR: [{ effectiveTo: null }, { effectiveTo: { gt: now } }],
    },
    orderBy: { effectiveFrom: "desc" },
  });
  return row
    ? { configKey: row.configKey, configValue: row.configValue as any, effectiveFrom: row.effectiveFrom, effectiveTo: row.effectiveTo }
    : null;
}

function j(v: unknown) {
  return JSON.stringify(v, null, 2);
}

function section(title: string, lines: string[]) {
  return ["## " + title, "", ...lines, ""].join("\n");
}

async function main() {
  const now = new Date();
  const effectiveTo = new Date(now.getTime() + 10 * 60 * 1000); // 10m window (short-lived test config)

  // Keys that directly impact time-based timers/workers in this repo.
  // Note: a few knobs are expressed in DAYS by design; we keep them minimal and explain how to test without waiting days.
  const plan: Array<{
    key: string;
    purpose: string;
    newValue: unknown;
    unitNote: string;
  }> = [
    {
      key: "acknowledgement.windowPerType",
      purpose: "W22 acknowledgement windows + H2/H3 SLA windows (used across S2/S4/S6).",
      newValue: { quotation: 60, voucher: 60, h2: 60, h3: 60 },
      unitNote: "seconds",
    },
    {
      key: "expiry.s1.defaultTtlSeconds",
      purpose: "ENTRY_EXPIRY timer on unpark / S1 expiry.",
      newValue: { DEFAULT: 120 },
      unitNote: "seconds",
    },
    {
      key: "expiry.s2.speculativeHoldTtlSeconds",
      purpose: "SPECULATIVE_HOLD_EXPIRY_W2 dueAt.",
      newValue: 120,
      unitNote: "seconds",
    },
    {
      key: "expiry.s3.committedHoldTtlSeconds",
      purpose: "COMMITTED_HOLD_EXPIRY_W3 dueAt.",
      newValue: 180,
      unitNote: "seconds",
    },
    {
      key: "noShow.cutoffWindowMinutes",
      purpose: "W5 cutoff scheduling (NO_SHOW_CUTOFF_W5 dueAt relative to expected arrival).",
      newValue: 1,
      unitNote: "minutes",
    },
    {
      key: "noShow.awaitingConfirmationWindowMinutes",
      purpose: "AWAITING_WRITTEN_CONFIRMATION_W5 dueAt (NoShow DEFER path).",
      newValue: 1,
      unitNote: "minutes",
    },
    {
      key: "preArrival.windowDays",
      purpose: "W4 PRE_ARRIVAL_COUNTDOWN_W4 schedule time relative to arrival.",
      newValue: 0,
      unitNote: "days (0 => immediate window open)",
    },
    {
      key: "housekeeping.sla.windowMinutes",
      purpose: "W24 HOUSEKEEPING_SLA_W24 dueAt after S8 physical departure + W23 fallback window.",
      newValue: 1,
      unitNote: "minutes",
    },
    {
      key: "housekeeping.sla.readinessWindowMinutes",
      purpose: "W23 ROOM_READINESS_SLA_W23 dueAt after room assignment when room not ready.",
      newValue: 1,
      unitNote: "minutes",
    },
    {
      key: "inspection.postCheckout.windowDays",
      purpose: "W9 POST_CHECKOUT_INSPECTION_W9 dueAt when inspection is deferred at S8.",
      newValue: 1,
      unitNote: "days (min 1 in code; use timer dueAt adjustment for fast test if needed)",
    },
    {
      key: "feedback.solicitation.delaySeconds",
      purpose: "W28 FEEDBACK_SOLICITATION_W28 dueAt after S9 close.",
      newValue: 10,
      unitNote: "seconds",
    },
    {
      key: "commission.rateMissing.resolutionSeconds",
      purpose: "W11 COMMISSION_RATE_MISSING_W11 dueAt after S9 close (RATE_MISSING).",
      newValue: 60,
      unitNote: "seconds",
    },
    {
      key: "payment.followUp.ttlDays",
      purpose: "W8 follow-up dueAt when closing S9 with OUTSTANDING (TimerRecord only in this slice).",
      // Accepts fractional days. 0.003 days ≈ 259 seconds (≤ 5 minutes).
      newValue: 0.003,
      unitNote: "days (fractional allowed; set to ~259 seconds)",
    },
    {
      key: "availability.staleness.ttlSeconds",
      purpose: "W1 StageDwellMonitor uses it to compute availability staleness cutoff.",
      newValue: 30,
      unitNote: "seconds",
    },
    {
      key: "stageDwell.thresholds",
      purpose: "W1 StageDwellMonitor thresholds for dwell escalation (if used).",
      newValue: {
        // Stage-specific keys are used first (e.g. "S1"); DEFAULT is a fallback in this timebox.
        S1: {
          ACTIVE: { warning: 10, critical: 20, escalation: 30 },
          IDLE: { warning: 10, critical: 20, escalation: 30 },
          PARKED: { warning: 10, critical: 20, escalation: 30 },
        },
        DEFAULT: {
          ACTIVE: { warning: 10, critical: 20, escalation: 30 },
          IDLE: { warning: 10, critical: 20, escalation: 30 },
          PARKED: { warning: 10, critical: 20, escalation: 30 },
        },
      },
      unitNote: "seconds",
    },
    {
      key: "processingLock.ttl.perChannel",
      purpose: "PROCESSING_LOCK_TTL scheduling for S1 processing locks.",
      newValue: { DEFAULT: 60 },
      unitNote: "seconds",
    },
    {
      key: "fomOverride.frequency",
      purpose: "W33 rolling window and max frequency (not a timer; used when worker runs).",
      newValue: { rollingWindowDays: 1, maxFrequency: 1 },
      unitNote: "days + count",
    },
  ];

  const before: Record<string, unknown> = {};
  for (const p of plan) {
    before[p.key] = (await getActiveConfig(p.key, now))?.configValue ?? null;
  }

  // Write new entries (we do NOT delete old ones; we add higher-priority effectiveFrom rows).
  await prisma.configurationEntry.createMany({
    data: plan.map((p) => ({
      configKey: p.key,
      configValue: p.newValue as any,
      effectiveFrom: now,
      effectiveTo,
      setBy: "timebox-worker-timers-script",
      notes: `Timeboxed for realtime worker/timer testing (${p.unitNote}).`,
    })),
  });

  const outDir = path.resolve(process.cwd(), "..", "Documentation_V2", "test");
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, "worker-timer-timebox-plan.md");

  const lines: string[] = [];
  lines.push("# Worker/timer timebox plan (30-minute window)");
  lines.push("");
  lines.push(`- **Effective from**: ${now.toISOString()}`);
  lines.push(`- **Effective to**: ${effectiveTo.toISOString()}`);
  lines.push("");
  lines.push("This document records the **current active values** (before) and the **short test values** (after) used to make time-based workers fire within seconds/minutes.");
  lines.push("");
  lines.push(section("How values were set", [
    "- We store timer/worker configuration in the `configuration_entries` table (`ConfigurationEntry` model).",
    "- For each key below, the script inserts a **new ConfigurationEntry row** with:",
    "  - `effectiveFrom = now`",
    "  - `effectiveTo = now + 30 minutes`",
    "  - `configValue = short test value`",
    "- This overrides older values *temporarily* (because selection is by latest effectiveFrom within the active range).",
    "- After the 30-minute window, the test values automatically expire (due to `effectiveTo`).",
  ]));

  lines.push("## Key-by-key changes");
  lines.push("");
  for (const p of plan) {
    lines.push(`### \`${p.key}\``);
    lines.push(`- **Purpose**: ${p.purpose}`);
    lines.push(`- **Unit**: ${p.unitNote}`);
    lines.push("- **Before (active)**:");
    lines.push("```json");
    lines.push(j(before[p.key]));
    lines.push("```");
    lines.push("- **After (test value)**:");
    lines.push("```json");
    lines.push(j(p.newValue));
    lines.push("```");
    lines.push("");
  }

  lines.push(section("Notes / constraints", [
    "- Some windows are designed in **days** (e.g. `inspection.postCheckout.windowDays`, `payment.followUp.ttlDays`).",
    "  - For those, we set them to the smallest valid value, and in the timed test we’ll either:",
    "    - choose flows where the worker is not required to fire, or",
    "    - adjust the scheduled timer’s `dueAt/firesAt` to near-now (still letting pg-boss process it naturally).",
  ]));

  fs.writeFileSync(outPath, lines.join("\n"), "utf8");
  console.log(`Wrote ${outPath}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

