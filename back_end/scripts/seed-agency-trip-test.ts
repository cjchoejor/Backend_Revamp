/**
 * Seed a two-stay trip booked by Bhutan INC on its Season package, for testing (2026-11-10,
 * operator: "a dummy data for multiple entry by travel agent bhutan inc with seasonal rating").
 * Everything it writes is `TEST-TRIP-` prefixed.
 *
 *   npx tsx scripts/seed-agency-trip-test.ts            # dry run — prints what it would create
 *   npx tsx scripts/seed-agency-trip-test.ts --commit   # write (clears its own earlier seed first)
 *   npx tsx scripts/seed-agency-trip-test.ts --clean --commit
 *
 * One enquiry from Bhutan INC, priced on its current Season package, who pays "Everything to
 * travel agent". The party: 4 adults and 2 children (6 and 7), two rooms (a Deluxe Double and a
 * Standard Double), each 2 adults and a child, everyone on breakfast (CP). Priced by the same
 * function a quotation uses (`computeQuotationCompositionTotals`), the children's breakfast at the
 * child policy's share.
 *
 *   Stay 1 · 1 → 2 Nov 2026 — seeded in house (S7) with three charges from its night, dated 1 Nov
 *     and written the way Post a charge writes them (that day's night audit is closed, so the desk
 *     route would refuse them). The walk to Closed is done over the real routes afterwards.
 *   Stay 2 · 9 → 10 Nov 2026 — in house (S7), checks out today. Its night and charges go through
 *     the real routes afterwards.
 *
 * Shape: what the real S1→S7 walk leaves behind (the in-house fixture's, seed-in-house-test-
 * booking.ts), per stay. Cleaning runs `delete-booking.ts` on each stay, which removes everything
 * hanging off it, papers and emails' records included.
 */
import { execFileSync } from "node:child_process";
import path from "node:path";
import { PrismaClient, Prisma, FolioLineType, Stage } from "@prisma/client";
import { computeQuotationCompositionTotals, type RoomCompositionInput, type RoomCompositionRateContext } from "../src/lib/room-composition.js";
import { loadChildPolicyBundle } from "../src/services/domain/child-policy-service.js";
import { resolveChargeRates } from "../src/services/infrastructure/compute-stay-charges.js";
import { buildInitialBillingModelDefaults, resolveBillingModelForNewLine } from "../src/lib/billing-model-defaults.js";
import { allocateFolioLineId } from "../src/lib/readable-id.js";
import { postChargeTaxCompanionsTx } from "../src/services/domain/s7-folio-lines-service.js";
import { recomputeFolioOutstandingBalance } from "../src/lib/folio-outstanding-from-payment.js";
import { findRoomBookingConflicts } from "../src/lib/room-booking-conflicts.js";

const prisma = new PrismaClient();
const argv = process.argv.slice(2);
const COMMIT = argv.includes("--commit");
const CLEAN = argv.includes("--clean");
const P = "TEST-TRIP-";
const day = (ymd: string) => new Date(`${ymd}T00:00:00Z`);

const STAYS = [
  { tag: "S1", checkIn: "2026-11-01", checkOut: "2026-11-02" },
  { tag: "S2", checkIn: "2026-11-09", checkOut: "2026-11-10" },
] as const;

async function clean() {
  const entries = await prisma.entry.findMany({ where: { id: { startsWith: P } }, select: { id: true }, orderBy: { id: "desc" } });
  console.log(`removing ${entries.length} test stays`);
  if (!COMMIT) return;
  for (const e of entries) {
    execFileSync("npx", ["tsx", path.join("scripts", "delete-booking.ts"), e.id, "--commit", "--allow-paid"], { stdio: "inherit", shell: true });
  }
  await prisma.inquiry.deleteMany({ where: { id: { startsWith: P } } });
  await prisma.guestProfile.deleteMany({ where: { id: { startsWith: P } } });
}

async function main() {
  if (CLEAN) return clean();
  if (COMMIT) await clean();

  const staff = await prisma.staffUser.findFirst({ where: { actorLevel: "L4" }, select: { id: true } });
  if (!staff) throw new Error("no L4 staff user to own the test data");
  const agent = await prisma.travelAgent.findFirst({ where: { displayName: "Bhutan INC", isActive: true } });
  if (!agent) throw new Error("Bhutan INC is not on file");
  const pkg = await prisma.ratePackage.findFirst({ where: { travelAgentId: agent.id, name: "Season", effectiveTo: null }, include: { overrides: true } });
  if (!pkg) throw new Error("Bhutan INC has no current Season package");
  const contact = (Array.isArray(agent.coordinators) ? (agent.coordinators as Array<{ name?: string; phone?: string; email?: string }>) : [])[0] ?? null;

  const rates = await resolveChargeRates(prisma);
  const child = await loadChildPolicyBundle(prisma);
  const dec = (v: Prisma.Decimal | null | undefined) => new Prisma.Decimal(v ?? 0);
  const rateFor = (roomTypeId: string) => dec(pkg.overrides.find((o) => o.roomTypeId === roomTypeId)?.roomBaseRate ?? pkg.roomBaseRate);

  // Two rooms per stay, one Deluxe Double and one Standard Double, free over the stay and free
  // now (the stay is seeded in house), and not the other stay's.
  const taken = new Set<string>();
  const pickRooms = async (checkIn: Date, checkOut: Date) => {
    const out: Array<{ id: string; roomNumber: string; roomTypeId: string }> = [];
    for (const code of ["DLXD", "STDD"]) {
      const cands = await prisma.room.findMany({
        where: { roomType: { code }, isShadowInventory: false, isBlocked: false, currentClaimState: "FREE" },
        select: { id: true, roomNumber: true, roomTypeId: true },
        orderBy: { roomNumber: "asc" },
      });
      let chosen: (typeof cands)[number] | null = null;
      for (const c of cands) {
        if (taken.has(c.id)) continue;
        const clash = await findRoomBookingConflicts(prisma, { roomIds: [c.id], checkIn, checkOut });
        if (clash.length === 0) {
          chosen = c;
          break;
        }
      }
      if (!chosen) throw new Error(`no free ${code} room for ${checkIn.toISOString().slice(0, 10)}`);
      taken.add(chosen.id);
      out.push(chosen);
    }
    return out;
  };

  const plans = [];
  for (const s of STAYS) {
    const checkIn = day(s.checkIn);
    const checkOut = day(s.checkOut);
    const rooms = await pickRooms(checkIn, checkOut);
    const ctxFor = (roomTypeId: string): RoomCompositionRateContext => ({
      defaultRoomRate: rateFor(roomTypeId),
      defaultExtraBedRate: dec(pkg.extraBedRate),
      defaultBreakfastRate: dec(pkg.breakfastRate),
      defaultLunchRate: dec(pkg.lunchRate),
      defaultDinnerRate: dec(pkg.dinnerRate),
      defaultCpRate: pkg.cpRate,
      defaultMapLunchRate: pkg.mapLunchRate,
      defaultMapDinnerRate: pkg.mapDinnerRate,
      defaultApRate: pkg.apRate,
      serviceChargeRate: rates.serviceChargeRate,
      gstRate: rates.gstRate,
      childMealPricing: child.mealPricing,
      nights: 1,
    });
    const inputs: Array<RoomCompositionInput & { roomId: string }> = rooms.map((r) => ({
      roomId: r.id,
      occupantCount: 3,
      adultCount: 2,
      cnb6To10Count: 1,
      cnbUnder6Count: 0,
      extraBedCount: 0,
      mealPlanCpCount: 3,
      startDate: checkIn,
      endDate: checkOut,
    }));
    const totals = computeQuotationCompositionTotals(
      rooms.map((r, i) => ({ input: inputs[i], ctx: ctxFor(r.roomTypeId), roomId: r.id, roomNumber: r.roomNumber })),
    );
    plans.push({ ...s, checkInDate: checkIn, checkOutDate: checkOut, rooms, inputs, totals });
    console.log(
      `${s.tag} · ${s.checkIn} → ${s.checkOut} · rooms ${rooms.map((r) => r.roomNumber).join(" + ")} · ` +
        totals.perRoom.map((r) => `${r.roomNumber}: room ${r.roomRate} + breakfast ${r.mealsSubtotal.toFixed(2)} = ${r.subtotal.toFixed(2)} net, ${r.total.toFixed(2)} with tax`).join(" · ") +
        ` · stay total ${totals.total.toFixed(2)}`,
    );
  }
  if (!COMMIT) return console.log("(dry run — pass --commit to write)");

  const gp = await prisma.guestProfile.create({
    data: { id: `${P}GP`, title: "Mr", firstName: "Tashi", lastName: "Tripguest", phone: "+975 17000088", email: null },
  });
  const inq = await prisma.inquiry.create({
    data: {
      id: `${P}INQ`,
      referenceNumber: `${P}INQ`,
      guestProfileId: gp.id,
      defaultCustodianId: staff.id,
      sourceChannel: "TRAVEL_AGENT",
      travelAgentId: agent.id,
      ratePackageId: pkg.id,
      callerFirstName: agent.displayName,
      callerEmail: agent.contactEmail,
      partyContactName: contact?.name ?? null,
      partyContactPhone: contact?.phone ?? null,
      partyContactEmail: contact?.email ?? null,
      notes: "Seeded test trip — Bhutan INC, Season package",
    } as Prisma.InquiryUncheckedCreateInput,
  });

  for (const s of plans) {
    const E = `${P}${s.tag}-`;
    const { rooms, totals } = s;
    const entry = await prisma.entry.create({
      data: {
        id: `${E}ENT`,
        inquiryId: inq.id,
        guestProfileId: gp.id,
        useType: "LEISURE",
        status: "ACTIVE",
        currentStage: "S7",
        checkInDate: s.checkInDate,
        checkOutDate: s.checkOutDate,
        guestCount: 6,
        adultCount: 4,
        childCount: 2,
        childAges: [6, 7],
        numberOfRooms: 2,
        contactPersonName: "Mr Tashi Tripguest",
        contactPersonPhone: "+975 17000088",
        createdBy: staff.id,
        keysIssuedAt: s.checkInDate,
        keysIssuedCount: 2,
        keysIssuedBy: staff.id,
        registrationCompletedAt: s.checkInDate,
        registrationCompletedBy: staff.id,
      },
    });
    const seg = await prisma.segment.create({ data: { id: `${E}SEG`, entryId: entry.id, segmentNumber: 1, stage: "S7", createdBy: staff.id } });
    await prisma.committedHold.create({
      data: {
        id: `${E}CH`, entryId: entry.id, segmentId: seg.id, roomId: rooms[0].id, roomTypeId: rooms[0].roomTypeId, state: "CONFIRMED",
        placedBy: staff.id, ttlSeconds: 86_400, expiresAt: s.checkOutDate,
        perNightBreakdown: [{ date: s.checkIn, roomIds: rooms.map((r) => ({ roomId: r.id })) }] as Prisma.InputJsonValue,
      },
    });
    const commercialTerms = {
      roomCompositions: s.inputs.map((i) => ({ ...i, startDate: undefined, endDate: undefined })),
      ratePackage: { id: pkg.id, name: pkg.name, partyName: agent.displayName },
      compositionTotals: {
        subtotal: Number(totals.subtotal.toFixed(2)),
        serviceCharge: Number(totals.serviceCharge.toFixed(2)),
        gst: Number(totals.gst.toFixed(2)),
        total: Number(totals.total.toFixed(2)),
        perRoom: totals.perRoom.map((r) => ({
          roomId: r.roomId,
          roomNumber: r.roomNumber,
          nights: r.nights,
          effectiveBreakfastPax: r.effectiveBreakfastPax,
          effectiveLunchPax: r.effectiveLunchPax,
          effectiveDinnerPax: r.effectiveDinnerPax,
          roomRate: Number(r.roomRate.toFixed(2)),
          extraBedRate: Number(r.extraBedRate.toFixed(2)),
          breakfastRate: Number(r.breakfastRate.toFixed(2)),
          lunchRate: Number(r.lunchRate.toFixed(2)),
          dinnerRate: Number(r.dinnerRate.toFixed(2)),
          subtotal: Number(r.subtotal.toFixed(2)),
          serviceCharge: Number(r.serviceCharge.toFixed(2)),
          gst: Number(r.gst.toFixed(2)),
          total: Number(r.total.toFixed(2)),
          mealsSubtotal: Number(r.mealsSubtotal.toFixed(2)),
          perNightMeals: Number(r.perNightMeals.toFixed(2)),
          extraBedSubtotal: Number(r.extraBedSubtotal.toFixed(2)),
          extraBedsVaryByNight: r.extraBedsVaryByNight,
          perNightMealBreakdown: [],
        })),
      },
    };
    await prisma.quotation.create({
      data: {
        id: `${E}QUO`, entryId: entry.id, segmentId: seg.id, referenceNumber: `${E}QUO`, createdBy: staff.id,
        state: "ACCEPTED", acceptedAt: s.checkInDate, totalAmount: totals.total, currency: pkg.currency,
        commercialTerms: commercialTerms as Prisma.InputJsonValue,
      } as Prisma.QuotationUncheckedCreateInput,
    });
    await prisma.reservation.create({
      data: {
        id: `${E}RES`, entryId: entry.id, segmentId: seg.id,
        frozenRate: rateFor(rooms[0].roomTypeId), frozenRatePlanId: pkg.id,
        frozenBillingModel: "DIRECT_BILL", frozenCheckInDate: s.checkInDate, frozenCheckOutDate: s.checkOutDate,
        frozenGuestCount: 6, frozenCommercialTerms: commercialTerms as Prisma.InputJsonValue,
        confirmedAt: s.checkInDate, confirmedBy: staff.id,
      } as Prisma.ReservationUncheckedCreateInput,
    });
    await prisma.entry.update({ where: { id: entry.id }, data: { currentReservationId: `${E}RES` } });
    const folioId = `${E}FOL`;
    await prisma.folio.create({
      data: { id: folioId, entryId: entry.id, state: "LIVE", billingModel: "DIRECT_BILL", createdBy: staff.id, convertedToLiveAt: s.checkInDate, convertedBy: staff.id, outstandingBalance: new Prisma.Decimal(0) },
    });
    // Who pays, per kind of charge, as Set up writes it: "Everything to travel agent".
    const defaults = await buildInitialBillingModelDefaults(prisma, folioId, "DIRECT_BILL");
    await prisma.folio.update({ where: { id: folioId }, data: { billingModelDefaults: defaults as Prisma.InputJsonValue } });
    await prisma.billingModelTransitionRecord.create({
      data: { folioId, segmentId: seg.id, toModel: "DIRECT_BILL", createdBy: staff.id, changeSource: "INITIAL_FIXATION" },
    });
    await prisma.cancellationDisclosureRecord.create({
      data: { entryId: entry.id, segmentId: seg.id, noShowTreatmentStatement: "Seeded test trip — a no-show is charged the first night.", disclosedBy: staff.id },
    });
    await prisma.invoice.create({
      data: { id: `${E}INV`, folioId, entryId: entry.id, invoiceType: "PROFORMA", state: "DRAFT", totalAmount: totals.total } as Prisma.InvoiceUncheckedCreateInput,
    });
    for (const [i, r] of rooms.entries()) {
      const priced = totals.perRoom[i];
      await prisma.roomAssignment.create({
        data: {
          id: `${E}RA${i + 1}`, entryId: entry.id, roomId: r.id, assignedBy: staff.id, startDate: s.checkInDate, endDate: s.checkOutDate,
          occupantCount: 3, adultCount: 2, cnb6To10Count: 1, cnbUnder6Count: 0, mealPlanCpCount: 3,
          frozenSubtotal: priced.subtotal, frozenTotal: priced.total, keyIssuedAt: s.checkInDate, keyIssuedBy: staff.id,
        } as Prisma.RoomAssignmentUncheckedCreateInput,
      });
      await prisma.room.update({ where: { id: r.id }, data: { currentClaimState: "OCCUPIED" } });
    }
    await prisma.stageDwellRecord.create({ data: { entryId: entry.id, stage: "S7", enteredAt: new Date() } });

    // Stay 1's own charges, dated its night. That day's night audit is closed, so they are written
    // here the way Post a charge writes them: the charge, then its service charge and GST.
    if (s.tag === "S1") {
      const charges: Array<{ lineType: FolioLineType; description: string; amount: number; roomId: string }> = [
        { lineType: FolioLineType.F_AND_B, description: "Restaurant · dinner for 6", amount: 3200, roomId: rooms[0].id },
        { lineType: FolioLineType.F_AND_B, description: "Bar · soft drinks", amount: 650, roomId: rooms[0].id },
        { lineType: FolioLineType.SERVICE, description: "Laundry · 4 pieces", amount: 400, roomId: rooms[1].id },
      ];
      await prisma.$transaction(async (tx) => {
        for (const c of charges) {
          const billingModel = await resolveBillingModelForNewLine(tx, folioId, c.lineType);
          await tx.folioLine.create({
            data: {
              id: await allocateFolioLineId(tx, folioId),
              folioId, lineType: c.lineType, description: c.description, amount: new Prisma.Decimal(c.amount),
              currency: pkg.currency, chargeDate: s.checkInDate, stage: Stage.S7, postedBy: staff.id, billingModel, roomId: c.roomId,
            },
          });
          await postChargeTaxCompanionsTx(tx, {
            folioId, baseAmount: c.amount, description: c.description, currency: pkg.currency, chargeDate: s.checkInDate,
            stage: Stage.S7, actorId: staff.id, billingModel, roomId: c.roomId,
          });
        }
        await recomputeFolioOutstandingBalance(tx, folioId);
      });
    }
    console.log(`created ${entry.id}`);
  }
}

main()
  .catch((e) => {
    console.error("FAILED:", e.message);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
