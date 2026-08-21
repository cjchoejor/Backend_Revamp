/**
 * Re-freeze RoomAssignment rows whose frozen figures were computed WITHOUT the booking discount
 * (repair for the 2026-08-21 hydration fix).
 *
 * `commercialTerms.compositionTotals.perRoom[]` stores each room's POST-discount subtotal/total,
 * but the rates stored beside them are deliberately PRE-discount. Hydration used to re-price from
 * those rates, so every discounted booking froze the UNDISCOUNTED figures — and the night audit
 * posts `frozenSubtotal ÷ nights` per night, so the ledger billed more than the quotation, the
 * proforma and the workspace header say.
 *
 * This script re-runs the (now fixed) hydration for every live booking's assignment rows and
 * writes back ONLY `frozenSubtotal` / `frozenTotal` where they differ. Room charges already
 * posted to a folio are immutable — they are REPORTED, never rewritten; post a correction on the
 * folio for those nights.
 *
 * Dry run by default; pass --commit to write.
 */
import { PrismaClient, Prisma } from "@prisma/client";
import { hydrateRoomAssignmentComposition } from "../src/lib/hydrate-room-assignment-composition.js";

const prisma = new PrismaClient();
const commit = process.argv.includes("--commit");
const D = (x: unknown) => new Prisma.Decimal((x as never) ?? 0);
const money = (d: Prisma.Decimal) => d.toFixed(2);
const DAY = 24 * 60 * 60 * 1000;

async function main() {
  const entries = await prisma.entry.findMany({
    where: { status: { in: ["ACTIVE", "PARKED"] }, currentStage: { in: ["S4", "S5", "S6", "S7", "S8"] } },
    select: {
      id: true,
      currentStage: true,
      roomAssignments: {
        select: { id: true, roomId: true, startDate: true, endDate: true, frozenSubtotal: true, frozenTotal: true },
      },
      folio: { select: { id: true, state: true } },
      segments: { orderBy: { segmentNumber: "desc" }, take: 1, select: { id: true } },
      quotations: { orderBy: { createdAt: "desc" }, take: 1, select: { id: true, commercialTerms: true } },
    },
    orderBy: { createdAt: "asc" },
  });

  let touchedEntries = 0;
  let touchedRows = 0;
  let totalCorrection = D(0);

  for (const e of entries) {
    if (!e.roomAssignments.length) continue;
    if (e.folio?.state === "SETTLED" || e.folio?.state === "CLOSED") continue;

    const terms = (e.quotations[0]?.commercialTerms ?? null) as {
      compositionTotals?: { total?: number; perRoom?: Array<{ roomId: string; nights?: number }> } | null;
    } | null;
    const pricedNights = new Map<string, number>();
    for (const r of terms?.compositionTotals?.perRoom ?? []) {
      if (typeof r.nights === "number") pricedNights.set(r.roomId, r.nights);
    }

    const changes: { id: string; roomId: string; from: [string, string]; to: [string, string] }[] = [];
    for (const a of e.roomAssignments) {
      // A row that covers a different window than the quotation priced (the in-house setup
      // change writes tonight → checkout) must be re-frozen for ITS window, not the stay.
      const span =
        a.startDate && a.endDate ? Math.round((a.endDate.getTime() - a.startDate.getTime()) / DAY) : null;
      // An end-dated remnant of a mid-stay room change can cover ZERO nights (the guest left the
      // room the day they took it). Its frozen 0 is correct — re-pricing it as one night would
      // invent a charge.
      if (span != null && span <= 0) continue;
      const quoted = pricedNights.get(a.roomId) ?? null;
      const windowed = span != null && quoted != null && span !== quoted;
      let fields: Partial<Prisma.RoomAssignmentUncheckedCreateInput> | null = null;
      try {
        fields = await hydrateRoomAssignmentComposition(
          prisma,
          e.id,
          a.roomId,
          windowed ? { nights: span!, startDate: a.startDate! } : undefined,
        );
      } catch {
        continue; // a booking whose basis can't be resolved is left exactly as it is
      }
      if (!fields || fields.frozenSubtotal == null || fields.frozenTotal == null) continue;
      const newSub = D(fields.frozenSubtotal);
      const newTot = D(fields.frozenTotal);
      if (newSub.eq(D(a.frozenSubtotal)) && newTot.eq(D(a.frozenTotal))) continue;
      changes.push({
        id: a.id,
        roomId: a.roomId,
        from: [money(D(a.frozenSubtotal)), money(D(a.frozenTotal))],
        to: [money(newSub), money(newTot)],
      });
    }
    if (!changes.length) continue;

    const before = e.roomAssignments.reduce((s, a) => s.plus(D(a.frozenTotal)), D(0));
    const after = e.roomAssignments.reduce((s, a) => {
      const c = changes.find((x) => x.id === a.id);
      return s.plus(c ? D(c.to[1]) : D(a.frozenTotal));
    }, D(0));
    const quoteTotal = D(terms?.compositionTotals?.total);
    touchedEntries++;
    touchedRows += changes.length;
    totalCorrection = totalCorrection.plus(before.sub(after));

    console.log(
      `\n${e.id} (${e.currentStage}) — ${changes.length} row(s)\n` +
        `  frozen total  ${money(before)} → ${money(after)}   quote total ${money(quoteTotal)}` +
        `${after.eq(quoteTotal) ? "  ✓ reconciles" : "  ⚠ still differs"}`,
    );
    for (const c of changes) {
      console.log(`   row ${c.id} room ${c.roomId}: sub ${c.from[0]} → ${c.to[0]} · total ${c.from[1]} → ${c.to[1]}`);
    }

    // Nights already audited carry the old (over-billed) figure. Folio lines are immutable —
    // say so and let the desk post a correction rather than rewriting history.
    if (e.folio) {
      const posted = await prisma.folioLine.findMany({
        where: { folioId: e.folio.id, lineType: "ROOM_CHARGE", roomId: { in: changes.map((c) => c.roomId) } },
        select: { id: true, amount: true, roomId: true, postedAt: true },
      });
      if (posted.length) {
        const sum = posted.reduce((s, l) => s.plus(D(l.amount)), D(0));
        console.log(
          `   ⚠ ${posted.length} ROOM_CHARGE line(s) totalling ${money(sum)} were already posted for these rooms` +
            ` — those nights were billed at the undiscounted figure; post a folio correction for them.`,
        );
      }
    }

    // Only write when the booking's frozen figures then reconcile with the quotation — this
    // repair exists for the discount, and anything else that moves the sum away from the stay
    // total is a different story that a human should look at.
    if (quoteTotal.gt(0) && !after.eq(quoteTotal)) {
      console.log("   → skipped (would not reconcile with the quotation; needs a look)");
      touchedEntries--;
      touchedRows -= changes.length;
      totalCorrection = totalCorrection.sub(before.sub(after));
      continue;
    }

    if (commit) {
      await prisma.$transaction(
        changes.map((c) =>
          prisma.roomAssignment.update({
            where: { id: c.id },
            data: { frozenSubtotal: new Prisma.Decimal(c.to[0]), frozenTotal: new Prisma.Decimal(c.to[1]) },
          }),
        ),
      );
    }
  }

  console.log(
    `\n${commit ? "COMMITTED" : "DRY RUN"} — ${touchedRows} row(s) across ${touchedEntries} booking(s); ` +
      `frozen totals reduced by ${money(totalCorrection)} in all.` +
      (commit ? "" : "\nRe-run with --commit to write."),
  );
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
