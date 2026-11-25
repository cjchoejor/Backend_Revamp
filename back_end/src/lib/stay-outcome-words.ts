/**
 * How the stay ended, in the bills' words (2026-11-25, operator: "the invoice and master bill need to
 * say actual check-in and check-out and the early checked-out date and the number of days actually
 * stayed; if they are fined, then also specify it").
 *
 * ONE reading for the tax invoice, the master bill and the tentative invoice, so they cannot word the
 * same stay two ways. The figures come from the records, never worked out here: the dates and nights
 * from the early-departure record (`EarlyDepartureRecord`, written when the stay was shortened), the
 * fee from its own lines on the bill — the fee line and the service charge and GST posted on it.
 *
 * A stay that ran its course reads as before: Check-in, then Check-out with its nights.
 */
import type { PrismaClient } from "@prisma/client";
import { Prisma } from "@prisma/client";
import { formatDocDate } from "../services/infrastructure/pdf-templates/legphel-document-format.js";
import { formatMoney } from "./pdf-render-context.js";

export type StayInfoRow = { k: string; v: string; strong?: boolean };

const nightsWord = (n: number) => `${n} night${n === 1 ? "" : "s"}`;

/** The rows a bill's stay block prints after Check-in, in place of the plain Check-out row. */
export async function stayOutcomeRows(prisma: PrismaClient, entryId: string): Promise<StayInfoRow[] | null> {
  const ed = await prisma.earlyDepartureRecord.findFirst({
    where: { entryId },
    orderBy: { recordedAt: "desc" },
    select: {
      originalCheckOutDate: true,
      departureDate: true,
      bookedNights: true,
      sleptNights: true,
      unstayedNights: true,
      feeAmount: true,
      feeWaived: true,
      feeFolioLineId: true,
      feeBasis: true,
    },
  });
  if (!ed) return null;

  const rows: StayInfoRow[] = [
    { k: "Checked out", v: `${formatDocDate(ed.departureDate)} · left early`, strong: true },
    { k: "Booked to", v: formatDocDate(ed.originalCheckOutDate) },
    { k: "Nights stayed", v: `${ed.sleptNights} of ${nightsWord(ed.bookedNights)} booked` },
  ];

  // The fee: its own line on the bill and the service charge and GST posted on it.
  if (ed.feeWaived) {
    const why = (ed.feeBasis as { waiveReason?: string | null } | null)?.waiveReason?.trim();
    rows.push({ k: "Early departure fee", v: why ? `Waived — ${why}` : "Waived" });
  } else if (ed.feeFolioLineId) {
    const fee = await prisma.folioLine.findUnique({ where: { id: ed.feeFolioLineId }, select: { folioId: true, description: true, amount: true } });
    if (fee) {
      const taxes = await prisma.folioLine.findMany({
        where: { folioId: fee.folioId, description: { endsWith: `on: ${fee.description}` } },
        select: { amount: true },
      });
      const withTax = taxes.reduce((s, t) => s.plus(t.amount), new Prisma.Decimal(fee.amount));
      // "1 night charged for leaving 2 nights early" — the fee line's own words, without the dates.
      const what = fee.description.replace(/^Early departure fee · /, "").replace(/ \([^)]*\)$/, "").trim();
      const taxed = taxes.length ? " with service charge and GST" : "";
      rows.push({ k: "Early departure fee", v: `Nu. ${formatMoney(withTax.toFixed(2))}${taxed} · ${what}` });
    }
  } else if (new Prisma.Decimal(ed.feeAmount ?? 0).gt(0)) {
    rows.push({ k: "Early departure fee", v: `Nu. ${formatMoney(new Prisma.Decimal(ed.feeAmount).toFixed(2))} net` });
  } else {
    rows.push({ k: "Early departure fee", v: "None charged" });
  }
  return rows;
}

export { nightsWord };
