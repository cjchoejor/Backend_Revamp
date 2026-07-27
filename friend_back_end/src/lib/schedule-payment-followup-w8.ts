import type { Prisma, PrismaClient } from "@prisma/client";
import { FolioState } from "@prisma/client";
import { randomUUID } from "node:crypto";
import { requireActiveConfigValue } from "./config-store.js";
import { getTimerEngine } from "../services/infrastructure/timer-management-service.js";
import { shouldRunPostStayPaymentFollowUp } from "../policies/03-expiry-parking/p11-post-stay-payment-follow-up.js";

type Db = Prisma.TransactionClient | PrismaClient;

/** Schedules **W8** when the folio is **OUTSTANDING** and no active W8 timer exists (idempotent). */
export async function schedulePaymentFollowUpW8IfOutstanding(
  db: Db,
  args: { entryId: string; folioId: string; folioState: FolioState; outstandingBalance?: Prisma.Decimal | null },
) {
  const outstanding = Number(args.outstandingBalance?.toString() ?? "0");
  if (!shouldRunPostStayPaymentFollowUp({ folioState: args.folioState, outstandingBalance: outstanding })) return;
  const ttl = Number(await requireActiveConfigValue<number>(db as any, "payment.followUp.ttlDays").catch(() => 7));
  const dueAt = new Date(Date.now() + ttl * 86400_000);
  const existing = await db.timerRecord.findFirst({ where: { entryId: args.entryId, timerCode: "PAYMENT_FOLLOW_UP_W8", status: "SCHEDULED" } });
  if (existing) return;
  const timerRecordId = randomUUID();
  const engine = await getTimerEngine();
  const pgBossJobId = await engine.schedule("PAYMENT_FOLLOW_UP_W8", { entryId: args.entryId, timerRecordId }, { startAfter: dueAt });
  await db.timerRecord.create({
    data: {
      id: timerRecordId,
      entryId: args.entryId,
      entityType: "Entry",
      entityId: args.entryId,
      timerType: "PAYMENT_FOLLOW_UP_W8",
      timerCode: "PAYMENT_FOLLOW_UP_W8",
      dueAt,
      firesAt: dueAt,
      status: "SCHEDULED",
      createdBy: "system",
      pgBossJobId,
      payload: {
        entryId: args.entryId,
        folioId: args.folioId,
        outstandingBalance: args.outstandingBalance?.toString() ?? null,
        timerRecordId,
      },
    },
  });
}
