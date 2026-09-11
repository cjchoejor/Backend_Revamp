/**
 * Post the meal plan the night audit never billed (2026-09-11).
 *
 *   npx tsx scripts/backfill-night-audit-meal-lines.ts            # dry run — prints what it would post
 *   npx tsx scripts/backfill-night-audit-meal-lines.ts --commit   # apply
 *
 * WHY. Until today the night audit used a room's frozen composition subtotal (room + extra bed
 * + meals) ONLY when the assignment row also carried start/end dates. A plain single-room
 * booking stores neither, so it fell through to `reservation.frozenRate` — the ROOM rate — and
 * the meals were never posted. The guest was under-billed, and settlement then refused with
 * `SETTLEMENT_RATE_BASIS_MISMATCH` because p22 measures against the full composition. Found
 * live on ENT-20260908-0001 (2,100 posted against 2,650 frozen; the 550 was one MAP+D night).
 *
 * WHAT IT WILL NOT DO. A folio audited from a DATED row already has the meals inside its
 * ROOM_CHARGE line. Posting again would double-charge the guest, so every line is classified
 * before anything is written:
 *
 *   - amount ≈ accommodation-per-night  → the meals are missing  → post them
 *   - amount ≈ subtotal-per-night       → already combined       → skip, reported
 *   - anything else                     → not understood         → skip, reported
 *
 * Only LIVE / OUTSTANDING folios on ACTIVE entries are touched. A SETTLED or closed folio is
 * reported and never written to — money that has already been reconciled is not re-opened by a
 * script; that needs a deliberate correction at the desk.
 *
 * Idempotent: a room+date that already has its meal line is skipped.
 */
import { FolioLineType, Prisma, PrismaClient, Stage } from "@prisma/client";
import { frozenCompositionByRoom, splitFrozenRow } from "../src/lib/frozen-room-composition.js";
import { gstLineDescription, serviceChargeLineDescription } from "../src/lib/folio-tax-lines.js";
import { mulMoney, round2, toDecimal, ZERO } from "../src/lib/money.js";
import { recomputeFolioOutstandingBalance } from "../src/lib/folio-outstanding-from-payment.js";
import { allocateFolioLineId } from "../src/lib/readable-id.js";
import { resolveChargeRates } from "../src/services/infrastructure/compute-stay-charges.js";

const prisma = new PrismaClient();
const COMMIT = process.argv.includes("--commit");

const ymd = (d: Date) => d.toISOString().slice(0, 10);
const near = (a: Prisma.Decimal, b: Prisma.Decimal) => a.sub(b).abs().lte(new Prisma.Decimal("0.05"));

async function main() {
  console.log(`${COMMIT ? "COMMIT" : "DRY RUN"} — night-audit meal lines\n`);
  const { gstRate, serviceChargeRate } = await resolveChargeRates(prisma);

  const entries = await prisma.entry.findMany({
    where: { status: "ACTIVE", folio: { state: { in: ["LIVE", "OUTSTANDING"] } } },
    include: {
      reservation: true,
      folio: { select: { id: true, state: true } },
      roomAssignments: { select: { roomId: true, frozenSubtotal: true, startDate: true, endDate: true } },
    },
  });

  let posted = 0;
  let alreadyCombined = 0;
  let unrecognised = 0;
  let skippedHasMeal = 0;
  const touchedFolios = new Set<string>();

  for (const e of entries) {
    if (!e.folio) continue;
    const composition = frozenCompositionByRoom([e.reservation?.frozenCommercialTerms ?? null]);
    if (composition.size === 0) continue;

    const roomLines = await prisma.folioLine.findMany({
      where: { folioId: e.folio.id, lineType: FolioLineType.ROOM_CHARGE, nightAuditRecordId: { not: null }, roomId: { not: null } },
      orderBy: { chargeDate: "asc" },
    });
    if (roomLines.length === 0) continue;

    for (const line of roomLines) {
      const roomId = line.roomId!;
      const row = e.roomAssignments.find((a) => a.roomId === roomId);
      const split = splitFrozenRow({
        roomId,
        rowSubtotal: row?.frozenSubtotal ?? null,
        rowNights:
          row?.startDate && row?.endDate
            ? Math.max(1, Math.round((row.endDate.getTime() - row.startDate.getTime()) / 86_400_000))
            : null,
        composition: composition.get(roomId),
      });
      if (!split || split.meals.lte(0)) continue;

      const accPerNight = round2(split.accommodation.div(split.nights));
      const mealsPerNight = round2(split.meals.div(split.nights));
      const subtotalPerNight = round2(split.subtotal.div(split.nights));
      const amount = toDecimal(line.amount);

      if (near(amount, subtotalPerNight) && !near(subtotalPerNight, accPerNight)) {
        alreadyCombined += 1;
        continue;
      }
      if (!near(amount, accPerNight)) {
        unrecognised += 1;
        console.log(
          `  ?? ${e.id} room line ${line.id} ${ymd(line.chargeDate)} amount ${amount} matches neither ` +
            `accommodation ${accPerNight} nor subtotal ${subtotalPerNight} — left alone`,
        );
        continue;
      }

      const description = line.description.replace("Night audit room charge", "Night audit meal plan");
      const existing = await prisma.folioLine.findFirst({
        where: { folioId: e.folio.id, lineType: FolioLineType.F_AND_B, chargeDate: line.chargeDate, description },
      });
      if (existing) {
        skippedHasMeal += 1;
        continue;
      }

      const sc = serviceChargeRate > 0 ? round2(mulMoney(mealsPerNight, serviceChargeRate)) : ZERO;
      const gst = gstRate > 0 ? round2(mulMoney(mealsPerNight.add(sc), gstRate)) : ZERO;
      console.log(
        `  ${e.id} · folio ${e.folio.id} · ${ymd(line.chargeDate)} · ${description}` +
          `  ${mealsPerNight} + SC ${sc} + GST ${gst} = ${mealsPerNight.add(sc).add(gst)}`,
      );
      posted += 1;
      touchedFolios.add(e.folio.id);

      if (!COMMIT) continue;
      await prisma.$transaction(async (tx) => {
        const base = {
          folioId: e.folio!.id,
          currency: line.currency,
          chargeDate: line.chargeDate,
          stage: Stage.S7,
          postedBy: line.postedBy,
          nightAuditRecordId: line.nightAuditRecordId,
          billingModel: line.billingModel,
          roomId,
        };
        await tx.folioLine.create({
          data: { ...base, id: await allocateFolioLineId(tx, e.folio!.id), lineType: FolioLineType.F_AND_B, description, amount: mealsPerNight },
        });
        if (sc.gt(0)) {
          await tx.folioLine.create({
            data: { ...base, id: await allocateFolioLineId(tx, e.folio!.id), lineType: FolioLineType.SERVICE, description: serviceChargeLineDescription(serviceChargeRate, description), amount: sc },
          });
        }
        if (gst.gt(0)) {
          await tx.folioLine.create({
            data: { ...base, id: await allocateFolioLineId(tx, e.folio!.id), lineType: FolioLineType.OTHER, description: gstLineDescription(gstRate, description), amount: gst },
          });
        }
      });
    }
  }

  if (COMMIT) for (const f of touchedFolios) await recomputeFolioOutstandingBalance(prisma, f);

  console.log(`\nentries examined        : ${entries.length}`);
  console.log(`meal lines posted       : ${posted}`);
  console.log(`already combined (skip) : ${alreadyCombined}`);
  console.log(`already had a meal line : ${skippedHasMeal}`);
  console.log(`not understood (skip)   : ${unrecognised}`);
  console.log(`folios rebalanced       : ${COMMIT ? touchedFolios.size : 0}`);
  if (!COMMIT) console.log(`\nDry run — nothing written. Re-run with --commit to apply.`);
}

main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => prisma.$disconnect());
