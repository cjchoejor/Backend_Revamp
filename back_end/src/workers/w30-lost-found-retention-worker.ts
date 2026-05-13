import type { PrismaClient } from "@prisma/client";
import { Stage } from "@prisma/client";
import { requireActiveConfigValue } from "../lib/config-store.js";

/**
 * W30 — Lost & Found retention (SIG-S9 §7).
 *
 * - Emits warning trace when approaching expiry.
 * - On expiry, records DISPOSED and emits expiry/disposal traces.
 *
 * NOTE: The codebase already uses `w30-guest-data-retention-worker.ts` for Policy 18 (guest data retention).
 * This file implements the SIG-S9 W30 intent explicitly, with a distinct timer code.
 */
export async function runLostFoundRetentionWorker(prisma: PrismaClient, input: { lostAndFoundId: string }) {
  const rec = await (prisma as any).lostAndFoundRecord.findUnique({ where: { id: input.lostAndFoundId } });
  if (!rec) return { skipped: true, reason: "NOT_FOUND" } as const;
  if (rec.returnStatus === "RETURNED" || rec.returnStatus === "DISPOSED") return { skipped: true, reason: "TERMINAL" } as const;

  const warningOffsetDays = Number(await requireActiveConfigValue<number>(prisma as any, "lostFound.retention.warningOffsetDays").catch(() => 3));
  const warningAt = new Date(new Date(rec.retentionExpiresAt).getTime() - warningOffsetDays * 86400_000);
  const now = new Date();

  // If we are before warningAt, do nothing.
  if (now.getTime() < warningAt.getTime()) return { skipped: true, reason: "BEFORE_WARNING_WINDOW" } as const;

  // If we are before expiry, emit approaching trace (idempotent by checking existing trace).
  if (now.getTime() < new Date(rec.retentionExpiresAt).getTime()) {
    const existing = await prisma.traceEvent.findFirst({
      where: { entityType: "LostAndFoundRecord", entityId: rec.id, eventType: "LOST_FOUND.RETENTION_APPROACHING" },
      orderBy: { createdAt: "desc" },
    });
    if (existing) return { skipped: true, reason: "ALREADY_WARNED" } as const;
    await prisma.traceEvent.create({
      data: {
        eventType: "LOST_FOUND.RETENTION_APPROACHING",
        actorId: "SYSTEM",
        actorLevel: "SYSTEM",
        entityType: "LostAndFoundRecord",
        entityId: rec.id,
        operation: "ALERT",
        timestamp: now,
        stageContext: Stage.S9,
        inquiryId: null,
        entryId: rec.entryId ?? null,
        payload: { lostAndFoundId: rec.id, retentionExpiresAt: rec.retentionExpiresAt },
        createdBy: "SYSTEM",
      } as any,
    });
    return { skipped: false, action: "WARNED", id: rec.id } as const;
  }

  // Expired: mark disposed (additive record) and emit expiry/disposal traces (idempotent by state).
  await (prisma as any).lostAndFoundRecord.update({
    where: { id: rec.id },
    data: { returnStatus: "DISPOSED", disposedAt: now },
  });
  await prisma.traceEvent.create({
    data: {
      eventType: "LOST_FOUND.RETENTION_EXPIRED",
      actorId: "SYSTEM",
      actorLevel: "SYSTEM",
      entityType: "LostAndFoundRecord",
      entityId: rec.id,
      operation: "ALERT",
      timestamp: now,
      stageContext: Stage.S9,
      inquiryId: null,
      entryId: rec.entryId ?? null,
      payload: { lostAndFoundId: rec.id, retentionExpiresAt: rec.retentionExpiresAt },
      createdBy: "SYSTEM",
    } as any,
  });
  await prisma.traceEvent.create({
    data: {
      eventType: "LOST_FOUND.DISPOSAL_RECORDED",
      actorId: "SYSTEM",
      actorLevel: "SYSTEM",
      entityType: "LostAndFoundRecord",
      entityId: rec.id,
      operation: "UPDATE",
      timestamp: now,
      stageContext: Stage.S9,
      inquiryId: null,
      entryId: rec.entryId ?? null,
      payload: { lostAndFoundId: rec.id, disposedAt: now.toISOString() },
      createdBy: "SYSTEM",
    } as any,
  });

  return { skipped: false, action: "DISPOSED", id: rec.id } as const;
}

