/**
 * Whether the desk must note the guest's reply to each email (2026-11-03, operator: "a setting
 * where we can disable the guest replies for the email sent … not mandatorily have to note the
 * reply … keep one setting for each email"). Admin console, Channels and replies.
 *
 * On is the rule the desk has always run, and a setting with no row reads as on. Off means, for as
 * long as it stays off: nothing waits for that email's reply, no reply clock shows or runs out, and
 * the steps say nothing about a reply and offer no way to note one (2026-11-03, operator: "it doesn't
 * have to show the record reply button, and also it shouldn't show awaiting reply from guest").
 *
 * Turning one off writes only the setting, never a booking, so a mistaken switch is undone by
 * flipping it back. A paper SENT while it is off is marked NOT_ASKED and stays exempt when the
 * setting comes back on; one sent before it waits again.
 */
import type { CommunicationType, Prisma, PrismaClient } from "@prisma/client";

type Db = PrismaClient | Prisma.TransactionClient;

/** One setting per email, in the order the guest receives them. */
export const GUEST_REPLY_SETTINGS: ReadonlyArray<{ key: string; commType: CommunicationType }> = [
  { key: "guestReply.quotation", commType: "QUOTATION" },
  { key: "guestReply.proforma", commType: "PROFORMA_INVOICE" },
  { key: "guestReply.confirmationVoucher", commType: "CONFIRMATION_VOUCHER" },
  { key: "guestReply.preArrivalMessage", commType: "PRE_ARRIVAL_REMINDER" },
  { key: "guestReply.interimBill", commType: "INTERIM_INVOICE" },
  { key: "guestReply.taxInvoice", commType: "FINAL_INVOICE" },
] as ReadonlyArray<{ key: string; commType: CommunicationType }>;

/** The status of a paper sent while its reply setting was off. */
export const REPLY_NOT_ASKED = "NOT_ASKED";

/** Nothing more is wanted from the guest on this paper: they answered, or they were never asked. */
export function replySettled(status: string | null | undefined): boolean {
  return status === "RECEIVED" || status === REPLY_NOT_ASKED;
}

/** The emails whose reply is off now, each with the moment it was turned off. */
export async function guestRepliesOff(db: Db): Promise<Map<CommunicationType, Date>> {
  const now = new Date();
  const rows = await db.configurationEntry.findMany({
    where: {
      configKey: { in: GUEST_REPLY_SETTINGS.map((s) => s.key) },
      effectiveFrom: { lte: now },
      OR: [{ effectiveTo: null }, { effectiveTo: { gt: now } }],
    },
    orderBy: { effectiveFrom: "desc" },
    select: { configKey: true, configValue: true, effectiveFrom: true },
  });
  const off = new Map<CommunicationType, Date>();
  const seen = new Set<string>();
  for (const r of rows) {
    if (seen.has(r.configKey)) continue;
    seen.add(r.configKey);
    if ((r.configValue as { required?: unknown } | null)?.required !== false) continue;
    const setting = GUEST_REPLY_SETTINGS.find((s) => s.key === r.configKey);
    if (setting) off.set(setting.commType, r.effectiveFrom);
  }
  return off;
}
