import type { PrismaClient } from "@prisma/client";
import { CommunicationType } from "@prisma/client";
import { NotFoundError } from "../../lib/errors.js";
import { getTimerEngine } from "../infrastructure/timer-management-service.js";
import * as auditService from "../infrastructure/audit-service.js";
import {
  ACKNOWLEDGEABLE_COMM_TYPES,
  enforceAcknowledgementEvidence,
  enforceAcknowledgementNotAlreadyReceived,
  enforceCommunicationDispatchedForAcknowledgement,
  enforceCommunicationIsAcknowledgeable,
} from "../../policies/20-communication-acknowledgement-tracking/p52-communication-acknowledgement-capture.js";

/**
 * Capture of guest acknowledgement against governed outbound communications — the generalisation
 * of what `s2-quotation-service.acceptQuotation` already did for the S2 quotation, now available
 * for the proforma invoice (S3), confirmation voucher (S4) and pre-arrival reminder (S5).
 *
 * Each of those already opened a W22 acknowledgement loop on dispatch; none of them had any way
 * to CLOSE it except letting the window time out. That is what this service adds.
 *
 * Scope boundary: recording an acknowledgement is **evidence, not a gate** — with one deliberate
 * exception (2026-07-31 operator ruling): a proforma invoice that was actually DISPATCHED must
 * have its answer recorded before the S3→S4 freeze
 * (`enforceDispatchedProformaGuestAnswerRecordedForS4Confirmation`, p40). Everything else here
 * stays gate-free: quotation, voucher and pre-arrival acknowledgements never block progression,
 * and a proforma that was generated but never sent doesn't either.
 */

export type AcknowledgementInput = {
  method: "WRITTEN" | "VERBAL";
  verbatimNote?: string | null;
  /** When the guest actually responded, if the operator is recording it after the fact. */
  receivedAt?: string | Date | null;
};

/** Per-type trace prefix, so each stage's acknowledgement is greppable on its own. */
const TRACE_PREFIX: Record<string, string> = {
  [CommunicationType.QUOTATION]: "QUOTATION",
  [CommunicationType.PROFORMA_INVOICE]: "PROFORMA_INVOICE",
  [CommunicationType.CONFIRMATION_VOUCHER]: "CONFIRMATION_VOUCHER",
  [CommunicationType.PRE_ARRIVAL_REMINDER]: "PRE_ARRIVAL_REMINDER",
  [CommunicationType.FINAL_INVOICE]: "FINAL_INVOICE",
  [CommunicationType.INTERIM_INVOICE]: "INTERIM_INVOICE",
};

function resolveReceivedAt(raw: AcknowledgementInput["receivedAt"], now: Date): Date {
  if (raw == null) return now;
  const parsed = raw instanceof Date ? raw : new Date(raw);
  if (Number.isNaN(parsed.getTime())) return now;
  // A back-dated acknowledgement is legitimate (the operator is catching up); a future-dated one
  // is not — clamp rather than reject so the capture still succeeds.
  return parsed.getTime() > now.getTime() ? now : parsed;
}

/**
 * Record that the guest acknowledged / accepted an outbound communication.
 *
 * Sets `acknowledgementStatus = RECEIVED`, cancels the outstanding W22 window (both the pg-boss
 * job and its TimerRecord), and writes a `<TYPE>.ACKNOWLEDGEMENT_RECORDED` trace carrying the
 * method and, for a verbal acknowledgement, the operator's verbatim note.
 */
export async function recordCommunicationAcknowledgement(
  prisma: PrismaClient,
  communicationRecordId: string,
  actor: { actorId: string; actorLevel: "L1" | "L2" | "L3" | "L4" },
  input: AcknowledgementInput,
) {
  const comm = await prisma.communicationRecord.findUnique({ where: { id: communicationRecordId } });
  if (!comm) throw new NotFoundError("CommunicationRecord");

  enforceCommunicationIsAcknowledgeable({ commType: comm.commType, direction: comm.direction });
  enforceCommunicationDispatchedForAcknowledgement({ sendStatus: comm.sendStatus });
  enforceAcknowledgementNotAlreadyReceived({ acknowledgementStatus: comm.acknowledgementStatus });
  const { method, verbatimNote } = enforceAcknowledgementEvidence({
    method: input.method,
    verbatimNote: input.verbatimNote,
  });

  const now = new Date();
  const receivedAt = resolveReceivedAt(input.receivedAt, now);
  // Whether the guest beat the clock. Worth recording: a late-but-received acknowledgement is a
  // different operational story from an on-time one, and the W22 timeout may already have fired.
  const withinWindow = comm.acknowledgementTimeoutAt ? receivedAt <= comm.acknowledgementTimeoutAt : true;
  const timedOutBeforeCapture = comm.acknowledgementStatus === "TIMED_OUT";

  return prisma.$transaction(async (tx) => {
    const updated = await tx.communicationRecord.update({
      where: { id: communicationRecordId },
      data: { acknowledgementStatus: "RECEIVED", acknowledgementReceivedAt: receivedAt },
    });

    // Close the W22 loop. Cancel the pg-boss job first so a fired-but-unprocessed one can't
    // still flip the record to TIMED_OUT after we've recorded a real response.
    const timers = await tx.timerRecord.findMany({
      where: {
        entityType: "CommunicationRecord",
        entityId: communicationRecordId,
        timerType: "ACKNOWLEDGEMENT_WINDOW_W22",
        status: "SCHEDULED",
      },
      select: { id: true, pgBossJobId: true },
    });
    if (timers.length) {
      const engine = await getTimerEngine();
      for (const t of timers) if (t.pgBossJobId) await engine.cancel(t.pgBossJobId);
      await tx.timerRecord.updateMany({
        where: { id: { in: timers.map((t) => t.id) } },
        data: {
          status: "CANCELLED",
          cancelledAt: now,
          cancelledBy: actor.actorId,
          cancelledReason: "ACKNOWLEDGEMENT_RECEIVED",
        },
      });
    }

    await auditService.emit(tx as any, { actorId: actor.actorId, actorLevel: actor.actorLevel }, {
      eventType: `${TRACE_PREFIX[comm.commType] ?? "COMMUNICATION"}.ACKNOWLEDGEMENT_RECORDED`,
      entityType: "CommunicationRecord",
      entityId: communicationRecordId,
      operation: "UPDATE",
      timestamp: now,
      stageContext: comm.stageContext as any,
      inquiryId: null,
      entryId: comm.entryId,
      payload: {
        communicationRecordId,
        commType: comm.commType,
        acknowledgementMethod: method,
        verbatimNote,
        receivedAt: receivedAt.toISOString(),
        withinWindow,
        timedOutBeforeCapture,
        timersCancelled: timers.length,
      },
      createdBy: actor.actorId,
    });

    return { ...updated, withinWindow, timedOutBeforeCapture };
  });
}

/**
 * The entry's governed outbound communications, newest first — what the desk renders as the
 * "sent to guest / accepted" list on the S2–S5 steps. Read-only projection; no money, no
 * derivation the caller could get wrong.
 */
export async function listEntryCommunications(prisma: PrismaClient, entryId: string) {
  const entry = await prisma.entry.findUnique({ where: { id: entryId }, select: { id: true } });
  if (!entry) throw new NotFoundError("Entry");

  const rows = await prisma.communicationRecord.findMany({
    where: { entryId, commType: { in: [...ACKNOWLEDGEABLE_COMM_TYPES] } },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      commType: true,
      channel: true,
      stageContext: true,
      direction: true,
      sendStatus: true,
      acknowledgementStatus: true,
      acknowledgementReceivedAt: true,
      acknowledgementTimeoutAt: true,
      contentSummary: true,
      payload: true,
      createdAt: true,
      createdBy: true,
    },
  });

  return {
    entryId,
    items: rows.map((r) => ({
      ...r,
      // Pre-computed so every frontend renders the same states rather than each re-deriving them.
      canAcknowledge:
        r.direction === "OUTBOUND" && r.sendStatus === "DISPATCHED" && r.acknowledgementStatus !== "RECEIVED",
      isOverdue:
        r.acknowledgementStatus !== "RECEIVED" &&
        !!r.acknowledgementTimeoutAt &&
        r.acknowledgementTimeoutAt.getTime() < Date.now(),
    })),
  };
}
