import type { Prisma } from "@prisma/client";
import { CommunicationChannel, CommunicationType, Stage } from "@prisma/client";
import { getTimerEngine } from "../infrastructure/timer-management-service.js";

export type OutboundQuotationCommunicationInput = {
  entryId: string;
  actorId: string;
  channel: "EMAIL" | "WHATSAPP";
  contentSummary: string;
  acknowledgementTimeoutAt: Date;
  payload?: Record<string, unknown>;
};

/**
 * SIG-S2 §6 — CommunicationService slice for governed outbound quotation communications.
 * Immutable CommunicationRecord creation; timer registration remains with the caller (QuotationService / TimerEngine).
 */
export async function sendOutboundQuotationCommunication(
  tx: Prisma.TransactionClient,
  input: OutboundQuotationCommunicationInput,
) {
  return tx.communicationRecord.create({
    data: {
      entryId: input.entryId,
      channel: input.channel,
      commType: CommunicationType.QUOTATION,
      stageContext: Stage.S2,
      direction: "OUTBOUND",
      sendStatus: "DISPATCHED",
      acknowledgementStatus: "PENDING",
      acknowledgementTimeoutAt: input.acknowledgementTimeoutAt,
      contentSummary: input.contentSummary,
      actorId: input.actorId,
      payload: (input.payload ?? {}) as any,
      createdBy: input.actorId,
    },
  });
}

export type DispatchConfirmationVoucherTxInput = {
  entryId: string;
  actorId: string;
  reservationId: string;
  otaSource: boolean;
  voucherAckSeconds: number;
  voucherRef: string;
  templateKey: string;
  contentSummary?: string;
};

/**
 * SIG-S4 §6.5 — governed confirmation voucher outbound + **W22** ack window (skipped for OTA auto-fulfilment).
 */
export async function dispatchConfirmationVoucherTx(tx: Prisma.TransactionClient, input: DispatchConfirmationVoucherTxInput) {
  const comm = await tx.communicationRecord.create({
    data: {
      entryId: input.entryId,
      channel: CommunicationChannel.EMAIL,
      commType: CommunicationType.CONFIRMATION_VOUCHER,
      stageContext: Stage.S4,
      direction: "OUTBOUND",
      sendStatus: "DISPATCHED",
      acknowledgementStatus: input.otaSource ? "RECEIVED" : "PENDING",
      acknowledgementTimeoutAt: input.otaSource ? null : new Date(Date.now() + input.voucherAckSeconds * 1000),
      actorId: input.actorId,
      contentSummary: input.contentSummary ?? "Confirmation voucher dispatched",
      payload: { reservationId: input.reservationId, voucherRef: input.voucherRef, templateKey: input.templateKey },
      createdBy: input.actorId,
    },
  });

  if (!input.otaSource) {
    const engine = await getTimerEngine();
    const ackAt = new Date(Date.now() + input.voucherAckSeconds * 1000);
    const ackJobId = await engine.schedule("ACKNOWLEDGEMENT_WINDOW_W22", { communicationRecordId: comm.id }, { startAfter: ackAt });
    await tx.timerRecord.create({
      data: {
        entryId: input.entryId,
        entityType: "CommunicationRecord",
        entityId: comm.id,
        timerType: "ACKNOWLEDGEMENT_WINDOW_W22",
        timerCode: "ACKNOWLEDGEMENT_WINDOW_W22",
        stageContext: Stage.S4,
        dueAt: ackAt,
        firesAt: ackAt,
        status: "SCHEDULED",
        createdBy: input.actorId,
        pgBossJobId: ackJobId,
        payload: { communicationRecordId: comm.id },
      },
    });
  }

  return comm;
}

export type DispatchPreArrivalOutboundTxInput = {
  entryId: string;
  actorId: string;
  reservationId: string;
  otaSource: boolean;
  ackSeconds: number;
  ref: string;
  templateKey: string;
  contentSummary?: string;
};

/**
 * SIG-S5 Policy 52 — governed pre-arrival outbound + **W22** ack window (skipped for OTA auto-fulfilment pattern).
 */
export async function dispatchPreArrivalOutboundTx(tx: Prisma.TransactionClient, input: DispatchPreArrivalOutboundTxInput) {
  const comm = await tx.communicationRecord.create({
    data: {
      entryId: input.entryId,
      channel: CommunicationChannel.EMAIL,
      commType: CommunicationType.PRE_ARRIVAL_REMINDER,
      stageContext: Stage.S5,
      direction: "OUTBOUND",
      sendStatus: "DISPATCHED",
      acknowledgementStatus: input.otaSource ? "RECEIVED" : "PENDING",
      acknowledgementTimeoutAt: input.otaSource ? null : new Date(Date.now() + input.ackSeconds * 1000),
      actorId: input.actorId,
      contentSummary: input.contentSummary ?? "Pre-arrival reminder dispatched",
      payload: { reservationId: input.reservationId, ref: input.ref, templateKey: input.templateKey },
      createdBy: input.actorId,
    },
  });

  if (!input.otaSource) {
    const engine = await getTimerEngine();
    const ackAt = new Date(Date.now() + input.ackSeconds * 1000);
    const ackJobId = await engine.schedule("ACKNOWLEDGEMENT_WINDOW_W22", { communicationRecordId: comm.id }, { startAfter: ackAt });
    await tx.timerRecord.create({
      data: {
        entryId: input.entryId,
        entityType: "CommunicationRecord",
        entityId: comm.id,
        timerType: "ACKNOWLEDGEMENT_WINDOW_W22",
        timerCode: "ACKNOWLEDGEMENT_WINDOW_W22",
        stageContext: Stage.S5,
        dueAt: ackAt,
        firesAt: ackAt,
        status: "SCHEDULED",
        createdBy: input.actorId,
        pgBossJobId: ackJobId,
        payload: { communicationRecordId: comm.id },
      },
    });
  }

  return comm;
}
