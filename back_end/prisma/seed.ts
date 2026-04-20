import { PrismaClient, Stage, EntryStatus, HoldState, HandoffType, HandoffState, FolioState, InventoryClaimState, TaskStatus, TaskCategory, PreArrivalTaskType, RoomPhysicalState, PaymentDirection, EntryUseType } from "@prisma/client";

const prisma = new PrismaClient();

async function main() {
  await prisma.vIPArrivalNotificationEvent.deleteMany();
  await prisma.roomClaimStateEvent.deleteMany();
  await prisma.guestIdentityDocument.deleteMany();
  await prisma.configurationEntry.deleteMany();
  await prisma.noShowDeterminationRecord.deleteMany();
  await prisma.roomAssignment.deleteMany();
  await prisma.preArrivalTask.deleteMany();
  await prisma.deficientConditionRecord.deleteMany();
  await prisma.handoffRecord.deleteMany();
  await prisma.paymentRecord.deleteMany();
  await prisma.folio.deleteMany();
  await prisma.reservation.deleteMany();
  await prisma.cancellationDisclosureRecord.deleteMany();
  await prisma.committedHold.deleteMany();
  await prisma.stageDwellRecord.deleteMany();
  await prisma.segment.deleteMany();
  await prisma.entry.deleteMany();
  await prisma.guestProfile.deleteMany();
  await prisma.room.deleteMany();
  await prisma.roomType.deleteMany();
  await prisma.inquiry.deleteMany();

  await prisma.configurationEntry.createMany({
    data: [
      {
        configKey: "handoff.H1.checklist",
        value: [
          { code: "VOUCHER_VERIFIED", mandatory: true, description: "Confirmation voucher on file" },
          { code: "PAYMENT_STATUS_REVIEWED", mandatory: true, description: "Advance payment status reviewed" },
          { code: "SPECIAL_REQUESTS_NOTED", mandatory: false, description: "Special requests noted" },
        ],
      },
      {
        configKey: "handoff.H2.checklist",
        value: [{ code: "ROOM_DETAILS_CONFIRMED", mandatory: true, description: "Room and stay details confirmed for HK" }],
      },
      {
        configKey: "handoff.H3.checklist",
        value: [{ code: "F_B_BRIEF_CONFIRMED", mandatory: true, description: "F&B briefing items confirmed" }],
      },
      {
        configKey: "identity.documentTypes",
        value: [
          { documentTypeCode: "PASSPORT", documentTypeName: "Passport", isActive: true },
          { documentTypeCode: "CID", documentTypeName: "National ID", isActive: true },
        ],
      },
      {
        configKey: "identity.retentionPeriodDays",
        value: { PASSPORT: 2555, CID: 2555, DEFAULT: 2555 },
      },
      {
        configKey: "billingModel.availablePerSource",
        value: { LEISURE: ["GUEST_PAY"], CORPORATE: ["GUEST_PAY", "DIRECT_BILL"] },
      },
      {
        configKey: "vipNotification.routingPerTier",
        value: { PLATINUM: ["FOM", "GM"], GOLD: ["FOM"], DEFAULT: ["FOM"] },
      },
      {
        configKey: "noShow.cutoffWindowMinutes",
        value: 120,
      },
      {
        configKey: "cancellation.policyTiers",
        value: {
          sameDayPenaltyAmount: 100,
        },
      },
      {
        configKey: "creditCeiling.proximityThresholds",
        value: { tier1Percent: 75, tier2Percent: 90 },
      },
    ],
  });

  const roomType = await prisma.roomType.create({
    data: { code: "DLX", name: "Deluxe King" },
  });

  const roomClean = await prisma.room.create({
    data: {
      roomNumber: "501",
      roomTypeId: roomType.id,
      floorNumber: 5,
      capacity: 2,
      currentClaimState: InventoryClaimState.CONFIRMED,
      physicalState: RoomPhysicalState.AVAILABLE_CLEAN,
    },
  });

  await prisma.room.create({
    data: {
      roomNumber: "502-DEF",
      roomTypeId: roomType.id,
      floorNumber: 5,
      capacity: 2,
      currentClaimState: InventoryClaimState.CONFIRMED,
      physicalState: RoomPhysicalState.AVAILABLE_CLEAN,
    },
  });

  const deficientRoom = await prisma.room.findFirstOrThrow({
    where: { roomNumber: "502-DEF" },
  });

  await prisma.deficientConditionRecord.create({
    data: {
      roomId: deficientRoom.id,
      category: "HOUSEKEEPING",
      description: "Minor stain on carpet — guest to be informed",
      detectedAt: new Date(),
      detectedBy: "actor-seed-hk",
      resolutionDeadline: new Date(Date.now() + 48 * 3600 * 1000),
      status: "UNRESOLVED",
    },
  });

  const inquiry = await prisma.inquiry.create({ data: {} });

  const guestProfile = await prisma.guestProfile.create({
    data: {
      firstName: "Tashi",
      lastName: "Dorji",
      email: "tashi.dorji@example.com",
      vipTier: null,
      clientTier: "STANDARD",
      createdBy: "actor-seed-system",
    },
  });

  const guestProfileCorp = await prisma.guestProfile.create({
    data: {
      firstName: "Corp",
      lastName: "Coordinator",
      email: "corp@example.com",
      vipTier: null,
      createdBy: "actor-seed-system",
    },
  });

  const checkIn = new Date();
  checkIn.setDate(checkIn.getDate() + 3);
  checkIn.setHours(15, 0, 0, 0);
  const checkOut = new Date(checkIn);
  checkOut.setDate(checkOut.getDate() + 2);

  const entry = await prisma.entry.create({
    data: {
      inquiryId: inquiry.id,
      guestProfileId: guestProfile.id,
      segmentNumber: 1,
      useType: EntryUseType.LEISURE,
      status: EntryStatus.ACTIVE,
      currentStage: Stage.S5,
      checkInDate: checkIn,
      checkOutDate: checkOut,
      guestCount: 2,
      otaSource: false,
      createdBy: "actor-seed-system",
      version: 1,
      noShowCutoffReachedAt: null,
    },
  });

  const segment = await prisma.segment.create({
    data: { entryId: entry.id, segmentNumber: 1 },
  });

  await prisma.cancellationDisclosureRecord.create({
    data: {
      entryId: entry.id,
      segmentId: segment.id,
      noShowTreatmentStatement: "No-show fee applies per disclosed cancellation terms.",
      disclosedTerms: { tiers: [{ timing: "same_day", amount: 100 }] },
    },
  });

  await prisma.reservation.create({
    data: {
      entryId: entry.id,
      segmentId: segment.id,
      frozenRate: 350,
      frozenRatePlanId: "rp-dlx-weekday",
      frozenInclusions: {},
      frozenCancellationTerms: { sameDayPenaltyAmount: 100 },
      frozenBillingModel: "GUEST_PAY",
      frozenCheckInDate: checkIn,
      frozenCheckOutDate: checkOut,
      frozenGuestCount: 2,
      creditCeilingIfExtended: null,
      confirmedAt: new Date(),
      confirmedBy: "actor-seed-res",
      confirmationVoucherSent: true,
    },
  });

  const folio = await prisma.folio.create({
    data: {
      entryId: entry.id,
      state: FolioState.PROVISIONAL,
      billingModel: "GUEST_PAY",
      createdBy: "actor-seed-system",
      outstandingBalance: 350,
      advancePaymentReconciliationComplete: true,
    },
  });

  await prisma.paymentRecord.create({
    data: {
      folioId: folio.id,
      amount: 350,
      paymentDirection: PaymentDirection.IN,
      notes: "Advance deposit (seed)",
    },
  });

  const holdExpires = new Date(Date.now() + 7 * 24 * 3600 * 1000);
  await prisma.committedHold.create({
    data: {
      entryId: entry.id,
      segmentId: segment.id,
      roomTypeId: roomType.id,
      state: HoldState.CONFIRMED,
      placedAt: new Date(),
      placedBy: "actor-seed-system",
      confirmedAt: new Date(),
      confirmedBy: "actor-seed-system",
      expiresAt: holdExpires,
    },
  });

  await prisma.handoffRecord.create({
    data: {
      entryId: entry.id,
      handoffType: HandoffType.H1,
      state: HandoffState.CREATED,
      fromRole: "RESERVATIONS",
      fromActorId: "actor-seed-res",
      toRole: "FRONT_DESK",
      checklistContent: {},
      createdBy: "actor-seed-system",
      stageContext: Stage.S4,
      isAutoFulfilled: false,
    },
  });

  const taskBase = { entryId: entry.id, createdBy: "actor-seed-system" };

  await prisma.preArrivalTask.createMany({
    data: [
      { ...taskBase, taskType: PreArrivalTaskType.PAYMENT_RECONCILIATION, category: TaskCategory.ADMINISTRATIVE, status: TaskStatus.PENDING },
      { ...taskBase, taskType: PreArrivalTaskType.NIGHT_AUDIT_TIMER_REGISTRATION, category: TaskCategory.ADMINISTRATIVE, status: TaskStatus.PENDING },
      { ...taskBase, taskType: PreArrivalTaskType.PRE_ARRIVAL_COMMUNICATION, category: TaskCategory.COMMUNICATION, status: TaskStatus.PENDING },
    ],
  });

  await prisma.stageDwellRecord.create({
    data: { entryId: entry.id, stage: Stage.S5, enteredAt: new Date() },
  });

  // --- Second entry: credit ceiling Tier 2 (tests FOM acknowledgement gate) ---
  const entryCredit = await prisma.entry.create({
    data: {
      inquiryId: inquiry.id,
      guestProfileId: guestProfileCorp.id,
      segmentNumber: 1,
      useType: EntryUseType.CORPORATE,
      status: EntryStatus.ACTIVE,
      currentStage: Stage.S5,
      checkInDate: checkIn,
      checkOutDate: checkOut,
      guestCount: 1,
      createdBy: "actor-seed-system",
      version: 1,
    },
  });

  const seg2 = await prisma.segment.create({
    data: { entryId: entryCredit.id, segmentNumber: 1 },
  });

  await prisma.cancellationDisclosureRecord.create({
    data: {
      entryId: entryCredit.id,
      segmentId: seg2.id,
      noShowTreatmentStatement: "Corporate no-show terms apply.",
      disclosedTerms: {},
    },
  });

  await prisma.reservation.create({
    data: {
      entryId: entryCredit.id,
      segmentId: seg2.id,
      frozenRate: 200,
      frozenRatePlanId: "rp-corp",
      frozenInclusions: {},
      frozenCancellationTerms: { sameDayPenaltyAmount: 50 },
      frozenBillingModel: "DIRECT_BILL",
      frozenCheckInDate: checkIn,
      frozenCheckOutDate: checkOut,
      frozenGuestCount: 1,
      creditCeilingIfExtended: 1000,
      confirmedAt: new Date(),
      confirmedBy: "actor-seed-res",
    },
  });

  const folioCredit = await prisma.folio.create({
    data: {
      entryId: entryCredit.id,
      state: FolioState.PROVISIONAL,
      billingModel: "DIRECT_BILL",
      createdBy: "actor-seed-system",
      outstandingBalance: 950,
      advancePaymentReconciliationComplete: true,
    },
  });

  await prisma.committedHold.create({
    data: {
      entryId: entryCredit.id,
      segmentId: seg2.id,
      roomTypeId: roomType.id,
      state: HoldState.CONFIRMED,
      placedAt: new Date(),
      placedBy: "actor-seed-system",
      confirmedAt: new Date(),
      confirmedBy: "actor-seed-system",
      expiresAt: holdExpires,
    },
  });

  await prisma.handoffRecord.create({
    data: {
      entryId: entryCredit.id,
      handoffType: HandoffType.H1,
      state: HandoffState.FULFILLED,
      fromRole: "RESERVATIONS",
      fromActorId: "actor-seed-res",
      toRole: "FRONT_DESK",
      checklistContent: {},
      createdBy: "actor-seed-system",
      stageContext: Stage.S4,
      acceptedAt: new Date(),
      acceptedBy: "actor-fd-1",
      fulfilledAt: new Date(),
      fulfilledBy: "actor-fd-1",
      fulfilmentEvidence: { seeded: true },
    },
  });

  await prisma.preArrivalTask.createMany({
    data: [
      {
        entryId: entryCredit.id,
        createdBy: "actor-seed-system",
        taskType: PreArrivalTaskType.PAYMENT_RECONCILIATION,
        category: TaskCategory.ADMINISTRATIVE,
        status: TaskStatus.COMPLETE,
        completedAt: new Date(),
        completedBy: "actor-fd-1",
      },
      {
        entryId: entryCredit.id,
        createdBy: "actor-seed-system",
        taskType: PreArrivalTaskType.CREDIT_CEILING_CHECK,
        category: TaskCategory.ADMINISTRATIVE,
        status: TaskStatus.COMPLETE,
        completedAt: new Date(),
        completedBy: "actor-fd-1",
      },
      {
        entryId: entryCredit.id,
        createdBy: "actor-seed-system",
        taskType: PreArrivalTaskType.NIGHT_AUDIT_TIMER_REGISTRATION,
        category: TaskCategory.ADMINISTRATIVE,
        status: TaskStatus.COMPLETE,
        completedAt: new Date(),
        completedBy: "actor-fd-1",
      },
    ],
  });

  await prisma.roomAssignment.create({
    data: {
      entryId: entryCredit.id,
      roomId: roomClean.id,
      assignedBy: "actor-fd-1",
      deficientAtAssignment: false,
    },
  });

  await prisma.stageDwellRecord.create({
    data: { entryId: entryCredit.id, stage: Stage.S5, enteredAt: new Date() },
  });

  console.log("Seed complete.");
  console.log("Primary S5 test entry id:", entry.id);
  console.log("Guest profile id (verify-identity):", guestProfile.id);
  console.log("Room 501 (clean) id:", roomClean.id);
  console.log("Room 502-DEF (DEFICIENT) id:", deficientRoom.id);
  console.log("Credit Tier-2 scenario entry id:", entryCredit.id, "(needs creditCeilingTier2Ack before S6)");
}

main()
  .then(() => prisma.$disconnect())
  .catch((e) => {
    console.error(e);
    prisma.$disconnect();
    process.exit(1);
  });
