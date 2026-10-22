import type { Prisma } from "@prisma/client";
import { Stage } from "@prisma/client";
import { requireActiveConfigValue } from "./config-store.js";
import { getRegistryPolicy } from "./policy-registry-runtime.js";
import type { getTimerEngine } from "../services/infrastructure/timer-management-service.js";

/**
 * The Inquiry clock — the S1 entry-expiry window (SIG-S1 §3.4), one place for it (2026-10-22).
 *
 * It was armed in two places — at entry creation and on unpark at S1 — each with its own copy of
 * the window, and NOT when a booking came back to Inquiry: a booking sent from Negotiation back to
 * Inquiry for new dates or rooms ran no clock at all (operator, on ENT-20261022-0002: "it should
 * still have the timer run again"). Now:
 *
 *  - armed at entry creation, on unpark at Inquiry, and whenever a backflow lands at Inquiry;
 *  - the window is `registry.s1Expiry.minutes` when that policy is enabled, else
 *    `expiry.s1.defaultTtlSeconds.DEFAULT` (3600) — the rule createEntry always used;
 *  - a booking that has been to Set up (it has a folio, or a reservation from an earlier pass)
 *    never gets it — it may hold money, so ending it is the desk's call, not a clock's. Same rule
 *    as the Negotiation clock (`lib/negotiation-expiry.ts`);
 *  - exactly one live row: arming cancels any earlier inquiry clock first.
 *
 * The row is an `ENTRY_EXPIRY` TimerRecord with an empty `timerCode`, so the Negotiation clock
 * (`NEGOTIATION_EXPIRY`) and the park follow-up (`PARKING_FOLLOW_UP`) stay distinguishable.
 */

type Tx = Prisma.TransactionClient;
type Engine = Awaited<ReturnType<typeof getTimerEngine>>;

/** The inquiry window, in seconds: the registry policy when enabled, else the config default. */
export async function resolveInquiryTtlSeconds(db: Tx): Promise<number> {
  const policy = await getRegistryPolicy(db as any, "registry.s1Expiry.minutes");
  if (policy && policy.enabled !== false && typeof policy.minutes === "number") return (policy.minutes as number) * 60;
  const ttl = await requireActiveConfigValue<{ DEFAULT: number }>(db as any, "expiry.s1.defaultTtlSeconds");
  return Number(ttl.DEFAULT ?? 3600);
}

/** True when the booking has been to Set up — a folio, or a reservation from an earlier pass. */
export async function hasBeenToSetup(db: Tx, entryId: string): Promise<boolean> {
  const e = await db.entry.findUnique({
    where: { id: entryId },
    select: { folio: { select: { id: true } }, reservations: { select: { id: true }, take: 1 } },
  });
  return !!e?.folio || (e?.reservations?.length ?? 0) > 0;
}

/**
 * Arm the Inquiry clock. Returns null (arms nothing) for a booking that has been to Set up.
 */
export async function armInquiryExpiryTx(
  tx: Tx,
  engine: Engine,
  args: { entryId: string; actorId: string; now?: Date },
): Promise<{ firesAt: Date; ttlSeconds: number } | null> {
  const now = args.now ?? new Date();
  if (await hasBeenToSetup(tx, args.entryId)) return null;
  const earlier = await tx.timerRecord.findMany({
    where: { entryId: args.entryId, timerType: "ENTRY_EXPIRY", timerCode: "", status: "SCHEDULED" },
    select: { id: true, pgBossJobId: true },
  });
  if (earlier.length > 0) {
    await Promise.all(earlier.map((r) => (r.pgBossJobId ? engine.cancel(r.pgBossJobId) : Promise.resolve())));
    await tx.timerRecord.updateMany({
      where: { id: { in: earlier.map((r) => r.id) } },
      data: { status: "CANCELLED", cancelledAt: now, cancelledBy: args.actorId, cancelledReason: "REARMED" },
    });
  }
  const ttlSeconds = await resolveInquiryTtlSeconds(tx);
  const firesAt = new Date(now.getTime() + ttlSeconds * 1000);
  const jobId = await engine.schedule("ENTRY_EXPIRY", { entryId: args.entryId }, { startAfter: firesAt });
  await tx.timerRecord.create({
    data: {
      entryId: args.entryId,
      entityType: "Entry",
      entityId: args.entryId,
      timerType: "ENTRY_EXPIRY",
      stageContext: Stage.S1,
      firesAt,
      dueAt: firesAt,
      status: "SCHEDULED",
      payload: { entryId: args.entryId, ttlSeconds },
      pgBossJobId: jobId,
      createdBy: args.actorId,
    },
  });
  return { firesAt, ttlSeconds };
}
