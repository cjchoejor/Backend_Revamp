import type { Prisma } from "@prisma/client";
import { CommunicationChannel, CommunicationType, Stage } from "@prisma/client";
import { ValidationError } from "../../lib/errors.js";
import { getTimerEngine } from "../infrastructure/timer-management-service.js";

export type VipArrivalCommencementTxInput = {
  entryId: string;
  inquiryId: string | null;
  guestProfileId: string;
  vipTier: string;
  roomNumber: string;
  preferences: unknown;
  actorId: string;
  routingPerTier: Record<string, string[]>;
};

/**
 * SIG-S6 §6.1 step 4 — VIP arrival at **check-in commencement** (S5→S6), before S6→S7 completion.
 * Creates `VIPArrivalNotificationEvent`, trace, per-role `CommunicationRecord`, and W22 ack timers.
 */
export async function issueVipArrivalNotificationAtCommencementTx(
  tx: Prisma.TransactionClient,
  input: VipArrivalCommencementTxInput,
  vipAckWindowSeconds: number,
) {
  const existing = await tx.vIPArrivalNotificationEvent.findFirst({ where: { entryId: input.entryId } });
  if (existing) return existing;

  const roles = input.routingPerTier[input.vipTier] ?? input.routingPerTier.DEFAULT ?? ["FOM", "GM"];
  if (!Array.isArray(roles) || roles.length === 0) {
    throw new ValidationError("vipNotification.routingPerTier has no roles for this VIP tier");
  }

  const now = new Date();
  const row = await tx.vIPArrivalNotificationEvent.create({
    data: {
      entryId: input.entryId,
      guestProfileId: input.guestProfileId,
      roomNumber: input.roomNumber,
      vipTier: input.vipTier,
      preferences: (input.preferences ?? undefined) as any,
      specialNotes: null,
      checkInInitiatedAt: now,
      recipientRoles: roles as any,
      createdBy: input.actorId,
    },
  });

  await tx.traceEvent.create({
    data: {
      eventType: "VIP_ARRIVAL_NOTIFICATION_ISSUED",
      actorId: input.actorId,
      actorLevel: "L1",
      entityType: "Entry",
      entityId: input.entryId,
      operation: "ALERT",
      timestamp: now,
      stageContext: Stage.S6,
      inquiryId: input.inquiryId,
      entryId: input.entryId,
      payload: {
        entryId: input.entryId,
        guestProfileId: input.guestProfileId,
        vipTier: input.vipTier,
        recipientRoles: roles,
        checkInInitiatedAt: now.toISOString(),
      },
      createdBy: input.actorId,
    },
  });

  const engine = await getTimerEngine();
  const ackSeconds = Math.max(60, vipAckWindowSeconds);

  for (const role of roles) {
    const r = typeof role === "string" ? role : String(role);
    const ackAt = new Date(now.getTime() + ackSeconds * 1000);
    const comm = await tx.communicationRecord.create({
      data: {
        entryId: input.entryId,
        channel: CommunicationChannel.EMAIL,
        commType: CommunicationType.VIP_ARRIVAL_NOTIFICATION,
        stageContext: Stage.S6,
        direction: "OUTBOUND",
        sendStatus: "DISPATCHED",
        acknowledgementStatus: "PENDING",
        acknowledgementTimeoutAt: ackAt,
        contentSummary: `VIP arrival notification (${input.vipTier}) — room ${input.roomNumber} — role ${r}`,
        actorId: input.actorId,
        payload: { role: r, vipTier: input.vipTier, vipArrivalNotificationEventId: row.id },
        createdBy: input.actorId,
      },
    });

    const jobId = await engine.schedule("ACKNOWLEDGEMENT_WINDOW_W22", { communicationRecordId: comm.id }, { startAfter: ackAt });
    await tx.timerRecord.create({
      data: {
        entryId: input.entryId,
        entityType: "CommunicationRecord",
        entityId: comm.id,
        timerType: "ACKNOWLEDGEMENT_WINDOW_W22",
        timerCode: "ACKNOWLEDGEMENT_WINDOW_W22",
        stageContext: Stage.S6,
        dueAt: ackAt,
        firesAt: ackAt,
        status: "SCHEDULED",
        createdBy: input.actorId,
        pgBossJobId: jobId,
        payload: { communicationRecordId: comm.id, vipRole: r },
      },
    });
  }

  return row;
}
