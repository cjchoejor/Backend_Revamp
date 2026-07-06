import {
  PrismaClient,
  ActorLevel,
  Stage,
  EntryStatus,
  HoldState,
  HandoffType,
  HandoffState,
  InvoiceType,
  FolioState,
  InventoryClaimState,
  TaskStatus,
  TaskCategory,
  PreArrivalTaskType,
  RoomPhysicalState,
  PaymentDirection,
  EntryUseType,
  FolioLineType,
} from "@prisma/client";
import bcrypt from "bcryptjs";
import { allocateReadableId, READABLE_ID_PREFIXES } from "../src/lib/readable-id.js";

const prisma = new PrismaClient();

async function main() {
  // Admin console registries
  await prisma.rolePermissionMapping.deleteMany();
  await prisma.roleSessionConfig.deleteMany();
  await prisma.role.deleteMany();
  await prisma.department.deleteMany();
  await prisma.hotelProfile.deleteMany();
  await prisma.workOrderTemplate.deleteMany();
  await prisma.handoffChecklistTemplate.deleteMany();
  await prisma.invoiceTemplate.deleteMany();
  await prisma.communicationTemplate.deleteMany();
  await prisma.vipNotificationRoutingConfig.deleteMany();
  await prisma.feedbackSurveyTemplate.deleteMany();
  await prisma.modeConfiguration.deleteMany();
  await prisma.policyRegistry.deleteMany();
  await prisma.ratePlanRegistry.deleteMany();
  await prisma.seasonCalendar.deleteMany();
  await prisma.packageRegistry.deleteMany();
  await prisma.cancellationPolicyRegistry.deleteMany();
  await prisma.aiActorIdentity.deleteMany();

  await prisma.sessionEventRecord.deleteMany();
  await prisma.sessionRecord.deleteMany();
  await prisma.staffUser.deleteMany();
  await prisma.workOrderAmendmentEvent.deleteMany();
  await prisma.workOrderConsumptionRecord.deleteMany();
  await prisma.workOrderToDoItem.deleteMany();
  await prisma.workOrder.deleteMany();
  await prisma.spaceAllocation.deleteMany();
  await prisma.space.deleteMany();
  await prisma.traceEvent.deleteMany();
  await prisma.revalidationDeltaRecord.deleteMany();
  await prisma.processingLockRecord.deleteMany();
  await prisma.availabilityConfiguration.deleteMany();
  await prisma.speculativeHold.deleteMany();
  await prisma.quotation.deleteMany();
  await prisma.billingModelTransitionRecord.deleteMany();
  // AI draft management tables reference CommunicationRecord (FK), so must be cleared first.
  await (prisma as any).humanDecisionRecord?.deleteMany?.();
  await (prisma as any).aiDraftRecord?.deleteMany?.();
  await prisma.communicationRecord.deleteMany();
  await prisma.followUpTaskRecord.deleteMany();
  await prisma.equipmentAllocation.deleteMany();
  await prisma.commissionDueRecord.deleteMany();
  await prisma.agentProfile.deleteMany();
  await prisma.writeOffRecord.deleteMany();
  await prisma.creditCeilingThresholdEvent.deleteMany();
  await prisma.timerRecord.deleteMany();
  await prisma.keyReturnRecord.deleteMany();
  await prisma.roomInspectionRecord.deleteMany();
  await prisma.invoice.deleteMany();
  await prisma.nightAuditAnomaly.deleteMany();
  await prisma.nightAuditRecord.deleteMany();
  await prisma.folioLine.deleteMany();
  await prisma.disputeGateOverrideRecord.deleteMany();
  await prisma.disputeRecord.deleteMany();
  await prisma.amendmentEventRecord.deleteMany();
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
  await prisma.room.deleteMany();
  await prisma.roomType.deleteMany();
  await prisma.duplicateDetectionFlag.deleteMany();
  await prisma.inquiry.deleteMany();
  await prisma.guestProfile.deleteMany();

  const now = new Date();
  const configRows: Array<{ configKey: string; configValue: any; notes?: string }> = [
    // --- SIG-S1 required keys (Section 9) ---
    {
      configKey: "ownership.assignmentRules",
      configValue: [
        { channel: "DIRECT", strategy: "DEFAULT", custodianActorId: "staff-frontdesk-1" },
        { channel: "OTA", strategy: "DEFAULT", custodianActorId: "staff-frontdesk-1" },
        { channel: "CORPORATE", strategy: "DEFAULT", custodianActorId: "staff-fom-1" },
        { channel: "WALK_IN", strategy: "DEFAULT", custodianActorId: "staff-frontdesk-1" },
        { channel: "AGENT", strategy: "DEFAULT", custodianActorId: "staff-frontdesk-1" },
      ],
      notes: "Seeded ownership assignment rules for S1 Policy 3",
    },
    {
      configKey: "groupDetection.guestCountThreshold",
      configValue: 50,
      notes: "SIG-S1 Policy 64 — guest count at or above this value sets group billing mode on entry create",
    },
    {
      configKey: "expiry.s1.defaultTtlSeconds",
      configValue: { DEFAULT: 3600 },
      notes: "Seeded S1 entry expiry TTL seconds (W20 registration)",
    },
    {
      configKey: "processingLock.ttl.perChannel",
      configValue: { EMAIL_AI: 300, WHATSAPP_AI: 300, FRONT_DESK: 600, PHONE: 600 },
    },
    {
      configKey: "availability.shadowInventory.visibilityRules",
      configValue: [
        { actorLevel: "L1", visible: false },
        { actorLevel: "L2", visible: true },
        { actorLevel: "L3", visible: true },
        { actorLevel: "L4", visible: true },
      ],
    },
    { configKey: "availability.bookablePhysicalStates", configValue: ["FREE"] },
    { configKey: "availability.staleness.ttlSeconds", configValue: 900 },
    {
      configKey: "availability.conferenceSpace.turnaroundBufferMinutes",
      configValue: 120,
      notes: "SIG-S1 §6.5 — buffer expanded on both sides when testing conference/catering space conflicts at availability query",
    },
    {
      configKey: "stageDwell.thresholds",
      configValue: {
        S1: { ACTIVE: { warning: 600, critical: 1200, escalation: 1800 }, IDLE: { warning: 900, critical: 1800, escalation: 2700 }, PARKED: { warning: 1800, critical: 3600, escalation: 5400 } },
        S2: { ACTIVE: { warning: 1200, critical: 2400, escalation: 3600 }, IDLE: { warning: 1800, critical: 3600, escalation: 5400 }, PARKED: { warning: 3600, critical: 7200, escalation: 10800 } },
        S3: { ACTIVE: { warning: 1800, critical: 3600, escalation: 5400 }, IDLE: { warning: 2700, critical: 5400, escalation: 8100 }, PARKED: { warning: 5400, critical: 10800, escalation: 16200 } },
        S4: { ACTIVE: { warning: 1200, critical: 2400, escalation: 3600 }, IDLE: { warning: 1800, critical: 3600, escalation: 5400 }, PARKED: { warning: 3600, critical: 7200, escalation: 10800 } },
        S5: { ACTIVE: { warning: 1800, critical: 3600, escalation: 5400 }, IDLE: { warning: 2700, critical: 5400, escalation: 8100 }, PARKED: { warning: 5400, critical: 10800, escalation: 16200 } },
        S6: { ACTIVE: { warning: 1800, critical: 3600, escalation: 5400 }, IDLE: { warning: 2700, critical: 5400, escalation: 8100 }, PARKED: { warning: 5400, critical: 10800, escalation: 16200 } },
        S7: { ACTIVE: { warning: 1800, critical: 3600, escalation: 5400 }, IDLE: { warning: 2700, critical: 5400, escalation: 8100 }, PARKED: { warning: 5400, critical: 10800, escalation: 16200 } },
      },
    },
    {
      configKey: "deficientCondition.categories",
      configValue: [
        { code: "HOUSEKEEPING", label: "Housekeeping", isActive: true },
        { code: "MAINTENANCE", label: "Maintenance", isActive: true },
        { code: "SOFT_FURNISHING", label: "Soft furnishing", isActive: true },
        { code: "OTHER", label: "Other", isActive: true },
      ],
    },
    { configKey: "ota.sourceFlagConfig", configValue: { OTA: true } },
    { configKey: "availability.walkIn.ratePlanId", configValue: "rp-walkin" },
    {
      configKey: "notification.routing.operatorExpiry",
      configValue: { DEFAULT: ["OPERATOR"] },
      notes: "S1 NotificationService — routing tiers/recipients (placeholder; audit-backed notifications only)",
    },
    {
      configKey: "notification.routing.stageDwell",
      configValue: { WARNING: ["OPERATOR"], CRITICAL: ["FOM"], ESCALATION: ["FOM"] },
      notes: "S1 NotificationService — stage dwell routing by severity (placeholder)",
    },
    { configKey: "ota_email_poll_interval_seconds", configValue: 300, notes: "SIG-S1 W7 — default 5 minutes poll interval" },
    {
      configKey: "ai.confidence.thresholds.perIntent",
      configValue: { DEFAULT: 0.7 },
      notes: "SIG-S1 W7 — confidence threshold per intent category (placeholder)",
    },

    // --- SIG-S2 required keys (Section 9) ---
    { configKey: "expiry.s2.quotationValidityDays", configValue: 2, notes: "S2 quotation validity (days)" },
    { configKey: "expiry.s2.speculativeHoldTtlSeconds", configValue: 900, notes: "S2 speculative hold default TTL seconds" },
    { configKey: "discount.fom.maxPercentage", configValue: 10, notes: "Front desk discount threshold (percent)" },
    { configKey: "discount.gm.maxPercentage", configValue: 25, notes: "FOM discount threshold; above requires GM (percent)" },
    {
      configKey: "speculativeHold.placementThresholds",
      configValue: { thresholds: [{ maxRooms: 5, authorityRequired: "FRONT_DESK", maxConcurrentHolds: 3 }, { maxRooms: 15, authorityRequired: "FOM", maxConcurrentHolds: 10 }, { maxRooms: null, authorityRequired: "GM", maxConcurrentHolds: null }] },
      notes: "Speculative hold placement thresholds",
    },
    {
      configKey: "acknowledgement.windowPerType",
      configValue: {
        quotation: 86400,
        pi: 86400,
        voucher: 172800,
        preArrival: 86400,
        amendment: 43200,
        cancellation: 43200,
        invoice: 604800,
        h2: 3600,
        h3: 3600,
        vipArrival: 3600,
      },
      notes: "Acknowledgement windows per communication type (seconds)",
    },

    // Minimal pricing surface for S2 rate plan resolution.
    {
      configKey: "pricing.ratePlans",
      configValue: [{ id: "rp-dlx-default", type: "INDIVIDUAL", rateAmount: 500, currency: "BTN", msr: 200 }],
      notes: "Seeded rate plans for PricingPipelineEngine (S2 Policy 19); msr optional per plan",
    },
    { configKey: "quotation.document.templateKey", configValue: "quotation-v1", notes: "SIG-S2 document generation template key" },

    // --- SIG-S3 required keys (Section 9) ---
    { configKey: "advancePayment.thresholds", configValue: { DEFAULT: { amount: 1 } }, notes: "Minimal S3 advance payment thresholds (amount in BTN)" },
    { configKey: "expiry.s3.committedHoldTtlSeconds", configValue: 3600, notes: "Committed hold TTL seconds (S3)" },
    { configKey: "creditCeiling.clientTier.thresholds", configValue: { STANDARD: 5000, DEFAULT: 5000 }, notes: "Credit ceiling thresholds per tier (minimal)" },
    { configKey: "proformaInvoice.templates", configValue: { DEFAULT: "proforma-v1" }, notes: "PI templates per billing model (minimal)" },
    { configKey: "advancePayment.followUpWindowSeconds", configValue: 3600, notes: "W34 tier-1 follow-up window" },
    { configKey: "advancePayment.escalationWindowSeconds", configValue: 7200, notes: "W34 tier-2 escalation window" },
    { configKey: "paymentMilestone.scheduleTemplates", configValue: {}, notes: "Milestone templates (placeholder)" },
    { configKey: "foc.configuration", configValue: { enabled: false }, notes: "FOC config (placeholder)" },

    // --- SIG-S4 required keys (Section 9) ---
    { configKey: "overbooking.maxAllowedRooms", configValue: 0, notes: "Overbooking limit (0 = no overbooking allowed)"},
    { configKey: "confirmation.authorityThresholds", configValue: { highValueAmount: 5000 }, notes: "Confirmation authority thresholds (minimal)" },
    { configKey: "overbooking.otaConflictRules", configValue: { enabled: true }, notes: "OTA conflict trigger rules (minimal)" },
    { configKey: "preArrival.windowDays", configValue: 1, notes: "Pre-arrival countdown window days" },
    { configKey: "confirmation.document.templateKey", configValue: "confirmation-v1", notes: "SIG-S4 confirmation voucher template key" },
    { configKey: "ownership.s4.sameTeamAutoFulfilH1", configValue: false, notes: "SIG-S4 D-01 — set H1.isAutoFulfilled at confirmation when same-team" },

    // --- Existing stage keys kept for S5–S9 tests (compat seed) ---
    {
      configKey: "handoff.H1.checklist",
      configValue: [
        { code: "VOUCHER_VERIFIED", mandatory: true, description: "Confirmation voucher on file" },
        { code: "PAYMENT_STATUS_REVIEWED", mandatory: true, description: "Advance payment status reviewed" },
        { code: "SPECIAL_REQUESTS_NOTED", mandatory: false, description: "Special requests noted" },
      ],
    },
    { configKey: "handoff.H1.autoFulfil.enabled", configValue: false, notes: "If true, H1 is auto-accepted on S5 activation (same-team mode)" },
    { configKey: "handoff.H2.checklist", configValue: [{ code: "ROOM_DETAILS_CONFIRMED", mandatory: true, description: "Room and stay details confirmed for HK" }] },
    { configKey: "handoff.H3.checklist", configValue: [{ code: "F_B_BRIEF_CONFIRMED", mandatory: true, description: "F&B briefing items confirmed" }] },
    { configKey: "handoff.H4.checklist", configValue: [{ code: "PRE_CHECKOUT_COORDINATION_STARTED", mandatory: true, description: "Pre-checkout coordination started" }] },
    {
      configKey: "identity.documentTypes",
      configValue: [
        { documentTypeCode: "PASSPORT", documentTypeName: "Passport", isActive: true },
        { documentTypeCode: "CID", documentTypeName: "National ID", isActive: true },
      ],
    },
    { configKey: "identity.retentionPeriodDays", configValue: { PASSPORT: 2555, CID: 2555, DEFAULT: 2555 } },
    { configKey: "billingModel.availablePerSource", configValue: { LEISURE: ["GUEST_PAY"], CORPORATE: ["GUEST_PAY", "DIRECT_BILL"], GOVERNMENT: ["GOVERNMENT"] } },
    { configKey: "vipNotification.routingPerTier", configValue: { PLATINUM: ["FOM", "GM"], GOLD: ["FOM"], DEFAULT: ["FOM"] } },
    { configKey: "noShow.cutoffWindowMinutes", configValue: 120 },
    { configKey: "noShow.awaitingConfirmationWindowMinutes", configValue: 180, notes: "Minutes to await written confirmation after no-show cutoff (S5)" },
    { configKey: "cancellation.policyTiers", configValue: { sameDayPenaltyAmount: 100, postCheckInEarlyDeparturePenaltyAmount: 150 } },
    { configKey: "creditCeiling.proximityThresholds", configValue: { tier1Percent: 75, tier2Percent: 90 } },
    { configKey: "nightAudit.expectedDailyFAndBCharge", configValue: { amount: 50, currency: "BTN" } },
    { configKey: "billing.salesTaxRate", configValue: 0, notes: "S7 charge posting — optional decimal rate (e.g. 0.05); 0 disables automatic tax lines" },
    {
      configKey: "dispute.sla",
      configValue: { firstResponseDueMinutes: 240, resolutionReminderMinutes: 1440 },
      notes: "W27 — offsets from dispute openedAt; second timer only if resolutionReminderMinutes > firstResponseDueMinutes",
    },
    { configKey: "nightAudit.schedule", configValue: { stayNightReminderHourUtc: 14 }, notes: "SIG-S5 Policy 59 — UTC hour for per stay-night W37 countdown jobs" },
    { configKey: "nightAudit.scheduleTime", configValue: "0 2 * * *", notes: "Admin readiness — cron for night audit run" },
    { configKey: "payment.followUp.intervals", configValue: [1, 3, 7], notes: "S9 readiness — days after checkout for payment follow-up" },
    {
      configKey: "invoice.templates",
      configValue: [{ templateKey: "final-v1", isActive: true }, { templateKey: "proforma-v1", isActive: true }],
      notes: "S9 readiness — active invoice template keys",
    },
    { configKey: "feedback.survey.templates", configValue: [{ templateKey: "post-stay-v1", isActive: true }] },
    { configKey: "feedback.platform.links", configValue: { google: "https://example.com/review" } },
    { configKey: "government.submission.config", configValue: { enabled: false } },
    { configKey: "identity.document.retentionPeriodDays", configValue: { PASSPORT: 2555, CID: 2555, DEFAULT: 2555 } },
    { configKey: "expiry.defaults", configValue: { inquiry: 3600, quotation: 86400, hold: 3600 } },
    { configKey: "housekeeping.sla.windowMinutes", configValue: 180 },
    { configKey: "housekeeping.sla.readinessWindowMinutes", configValue: 180, notes: "S5 readiness SLA window from assignment (S5)" },
    { configKey: "room.readiness.slaWindow", configValue: 10800, notes: "Room readiness SLA window (seconds) for W23 at S5–S6 (S6)" },
    {
      configKey: "inspection.postCheckout.windowHours",
      configValue: 18,
      notes: "W9 deferred inspection window — hours after S8 deferral (was windowDays=2)",
    },
    { configKey: "payment.followUp.ttlDays", configValue: 7, notes: "W8 follow-up timer default TTL (days)" },
    { configKey: "fomOverride.frequency", configValue: { rollingWindowDays: 7, maxFrequency: 1 }, notes: "W33 override frequency threshold" },
    { configKey: "invoice.templates.final", configValue: [{ templateKey: "final-v1", isActive: true }] },
    { configKey: "feedback.solicitation.delaySeconds", configValue: 3600 },
    { configKey: "commission.rateMissing.resolutionSeconds", configValue: 60, notes: "W11 resolution window (seconds) for tests" },
    { configKey: "followUp.deadlineDays", configValue: 7 },
    { configKey: "writeOff.authority.thresholds", configValue: { L3: 5000 } },
    { configKey: "invoice.templates.proforma", configValue: [{ templateKey: "proforma-v1", isActive: true }] },
  ];

  await prisma.configurationEntry.createMany({
    data: configRows.map((r) => ({
      configKey: r.configKey,
      configValue: r.configValue,
      effectiveFrom: now,
      effectiveTo: null,
      setBy: "actor-seed-system",
      setAt: now,
      notes: r.notes ?? null,
    })),
  });

  // Seed admin console identity/org surface.
  await prisma.hotelProfile.create({
    data: {
      hotelName: "Legphel Demo Hotel",
      registeredAddress: "Demo Registered Address",
      tradingAddress: "Demo Trading Address",
      contactNumbers: [{ label: "Front Desk", value: "+0000000000" }],
      primaryEmail: "admin@legphel.local",
      operatingHours: { checkIn: "14:00", checkOut: "12:00" },
      publicHolidaySchedule: [],
      timeZone: "Asia/Dhaka",
      propertyCurrency: "BTN",
      createdBy: "actor-seed-system",
    },
  });

  await prisma.department.createMany({
    data: [
      { departmentCode: "FRONT_OFFICE", departmentName: "Front Office", isActive: true, createdBy: "actor-seed-system" },
      { departmentCode: "HOUSEKEEPING", departmentName: "Housekeeping", isActive: true, createdBy: "actor-seed-system" },
      { departmentCode: "ACCOUNTS", departmentName: "Accounts", isActive: true, createdBy: "actor-seed-system" },
    ],
  });

  // Sample policy registry rows (versioned DB definitions — separate from TypeScript runtime guards).
  await prisma.policyRegistry.createMany({
    data: [
      {
        policyId: "registry.noShow.graceMinutes",
        policyClass: "CANCELLATION",
        policyDefinition: { description: "Grace period before no-show treatment", enabled: true, graceMinutes: 120 },
        version: 1,
        isActive: true,
        createdBy: "actor-seed-system",
      },
      {
        policyId: "registry.duplicateInquiry.blockS1Exit",
        policyClass: "DUPLICATE_DETECTION",
        policyDefinition: { description: "Block S1 exit when open duplicate flag exists", enabled: true },
        version: 1,
        isActive: true,
        createdBy: "actor-seed-system",
      },
      {
        policyId: "registry.shadowInventory.l4Only",
        policyClass: "AVAILABILITY",
        policyDefinition: { description: "Shadow inventory visible to L4 only by default", enabled: true },
        version: 1,
        isActive: true,
        createdBy: "actor-seed-system",
      },
    ],
  });

  // --- Admin console registries (ACIG v1.1) ---
  await prisma.ratePlanRegistry.createMany({
    data: [
      // Deluxe Weekday is bound to the Deluxe room type (DLX-0001).
      { name: "Deluxe Weekday", description: "Standard weekday deluxe rate", roomTypeId: "DLX-0001", type: "INDIVIDUAL", baseRate: 500 as any, currency: "BTN", msr: 350 as any, createdBy: "actor-seed-system" },
      // Walk-in Standard is universal — applies to any room type.
      { name: "Walk-in Standard", description: "Default walk-in rate plan", roomTypeId: null, type: "RACK", baseRate: 650 as any, currency: "BTN", msr: 500 as any, overrideMargin: 0.05 as any, createdBy: "actor-seed-system" },
    ],
  });

  await prisma.seasonCalendar.create({
    data: {
      name: "Peak 2026",
      startDate: new Date("2026-10-01T00:00:00.000Z"),
      endDate: new Date("2026-12-31T23:59:59.000Z"),
      rateMultiplier: 1.25 as any,
      priority: 10,
      createdBy: "actor-seed-system",
    },
  });

  await prisma.packageRegistry.create({
    data: {
      name: "Honeymoon Package",
      description: "Romantic add-ons bundle",
      inclusions: [{ label: "Welcome flowers" }, { label: "Candlelight dinner" }],
      priceAdjustment: 1500 as any,
      currency: "BTN",
      createdBy: "actor-seed-system",
    },
  });

  await prisma.cancellationPolicyRegistry.create({
    data: {
      name: "Standard Cancellation",
      penaltyTiers: [
        { daysBeforeArrival: 7, penaltyPercentage: 0 },
        { daysBeforeArrival: 3, penaltyPercentage: 50 },
        { daysBeforeArrival: 0, penaltyPercentage: 100 },
      ],
      noShowTreatment: "FULL_PENALTY",
      createdBy: "actor-seed-system",
    },
  });

  await prisma.aiActorIdentity.create({
    data: { displayName: "Legphel AI Concierge", createdBy: "actor-seed-system" },
  });

  const roles = await prisma.role.createMany({
    data: [
      { roleCode: "FRONT_DESK", displayName: "Front Desk", actorLevel: ActorLevel.L1, isActive: true, createdBy: "actor-seed-system" },
      { roleCode: "FOM", displayName: "Front Office Manager", actorLevel: ActorLevel.L2, isActive: true, createdBy: "actor-seed-system" },
      { roleCode: "GM", displayName: "General Manager", actorLevel: ActorLevel.L3, isActive: true, createdBy: "actor-seed-system" },
      { roleCode: "ADMIN", displayName: "Administrator", actorLevel: ActorLevel.L4, isActive: true, createdBy: "actor-seed-system" },
    ],
  });
  void roles; // createMany returns count only

  const seededRoles = await prisma.role.findMany({ where: { roleCode: { in: ["FRONT_DESK", "FOM", "GM", "ADMIN"] } } });
  await prisma.roleSessionConfig.createMany({
    data: seededRoles.map((r) => ({
      roleId: r.id,
      idleLockTimeoutSeconds: 600,
      hardLogoutTimeoutSeconds: 28800,
      manualLockAvailable: true,
      createdBy: "actor-seed-system",
    })),
  });

  await prisma.communicationTemplate.create({
    data: {
      templateKey: "quotation-v1",
      channel: "EMAIL",
      templateType: "QUOTATION",
      bodyTemplate: "Dear guest, your quotation reference {{entryId}} is ready.",
      createdBy: "actor-seed-system",
    },
  });

  await prisma.invoiceTemplate.createMany({
    data: [
      {
        templateKey: "final-v1",
        invoiceType: InvoiceType.FINAL,
        title: "Final invoice",
        bodyTemplate: "Final invoice for stay {{entryId}}",
        createdBy: "actor-seed-system",
      },
      {
        templateKey: "proforma-v1",
        invoiceType: InvoiceType.PROFORMA,
        title: "Proforma invoice",
        bodyTemplate: "Proforma for reservation {{entryId}}",
        createdBy: "actor-seed-system",
      },
    ],
  });

  for (const handoffType of [HandoffType.H1, HandoffType.H2, HandoffType.H3] as const) {
    const configKey = `handoff.${handoffType}.checklist` as const;
    const row = configRows.find((r) => r.configKey === configKey);
    await prisma.handoffChecklistTemplate.create({
      data: {
        handoffType,
        checklistItems: row?.configValue ?? [],
        version: 1,
        isActive: true,
        createdBy: "actor-seed-system",
      },
    });
  }

  // Seed staff users for auth/session flows (SIG-S1 §8.1).
  const pinHashL1 = await bcrypt.hash("1111", 10);
  const pinHashL2 = await bcrypt.hash("2222", 10);
  const pinHashL3 = await bcrypt.hash("3333", 10);
  const pinHashL4 = await bcrypt.hash("4444", 10);
  await prisma.staffUser.createMany({
    data: [
      { id: "staff-frontdesk-1", fullName: "Front Desk 1", actorLevel: "L1", role: "FRONT_DESK", pinHash: pinHashL1, idleThresholdSeconds: 600, hardLogoutThresholdSeconds: 28800, isActive: true },
      { id: "staff-fom-1", fullName: "FOM 1", actorLevel: "L2", role: "FOM", pinHash: pinHashL2, idleThresholdSeconds: 600, hardLogoutThresholdSeconds: 28800, isActive: true },
      { id: "staff-gm-1", fullName: "GM 1", actorLevel: "L3", role: "GM", pinHash: pinHashL3, idleThresholdSeconds: 600, hardLogoutThresholdSeconds: 28800, isActive: true },
      { id: "staff-admin-1", fullName: "Admin 1", actorLevel: "L4", role: "ADMIN", pinHash: pinHashL4, idleThresholdSeconds: 600, hardLogoutThresholdSeconds: 28800, isActive: true },
    ],
  });

  // Seed one space for S1 conference/catering search.
  await prisma.space.create({
    data: { code: "HALL-A", name: "Hall A", capacity: 200 },
  });

  // Generate the readable `<CODE>-<global-seq>` ID — matches the admin createRoomType service.
  const roomType = await prisma.roomType.create({
    data: { id: "DLX-0001", code: "DLX", name: "Deluxe King" },
  });

  // Rooms for S1 availability (must include at least one FREE and one DEFICIENT-FREE).
  await prisma.room.create({
    data: {
      roomNumber: "401",
      roomTypeId: roomType.id,
      floorNumber: 4,
      capacity: 2,
      currentClaimState: InventoryClaimState.FREE,
      physicalState: RoomPhysicalState.AVAILABLE_CLEAN,
      isDeficient: false,
      isShadowInventory: true,
    },
  });

  // Non-shadow FREE room to keep S1 availability working for L1.
  await prisma.room.create({
    data: {
      roomNumber: "403",
      roomTypeId: roomType.id,
      floorNumber: 4,
      capacity: 2,
      currentClaimState: InventoryClaimState.FREE,
      physicalState: RoomPhysicalState.AVAILABLE_CLEAN,
      isDeficient: false,
      isShadowInventory: false,
    },
  });

  // Additional empty (FREE, clean) rooms for availability / assignment testing.
  for (const roomNumber of ["404", "405", "406", "407", "408", "409", "410"]) {
    await prisma.room.create({
      data: {
        roomNumber,
        roomTypeId: roomType.id,
        floorNumber: Number.parseInt(roomNumber.slice(0, 1), 10),
        capacity: 2,
        currentClaimState: InventoryClaimState.FREE,
        physicalState: RoomPhysicalState.AVAILABLE_CLEAN,
        isDeficient: false,
        isShadowInventory: false,
      },
    });
  }

  await prisma.room.create({
    data: {
      roomNumber: "402-DEF",
      roomTypeId: roomType.id,
      floorNumber: 4,
      capacity: 2,
      currentClaimState: InventoryClaimState.FREE,
      physicalState: RoomPhysicalState.AVAILABLE_CLEAN,
      isDeficient: true,
      deficientConditionCategory: "HOUSEKEEPING",
      deficientSince: new Date(),
      deficientDeadline: new Date(Date.now() + 48 * 3600 * 1000),
    },
  });

  const deficientRoomS1 = await prisma.room.findFirstOrThrow({ where: { roomNumber: "402-DEF" } });
  await prisma.deficientConditionRecord.create({
    data: {
      roomId: deficientRoomS1.id,
      category: "HOUSEKEEPING",
      description: "Minor stain on carpet — guest to be informed",
      detectedAt: new Date(),
      detectedBy: "actor-seed-hk",
      resolutionDeadline: new Date(Date.now() + 48 * 3600 * 1000),
      status: "UNRESOLVED",
    },
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

  const roomS9DirectBill = await prisma.room.create({
    data: {
      roomNumber: "503",
      roomTypeId: roomType.id,
      floorNumber: 5,
      capacity: 2,
      currentClaimState: InventoryClaimState.CONFIRMED,
      physicalState: RoomPhysicalState.AVAILABLE_CLEAN,
    },
  });

  // Keep legacy DEFICIENT room for older stage tests (occupied path), but not for S1 availability.
  const deficientRoom = await prisma.room.create({
    data: {
      roomNumber: "502-DEF",
      roomTypeId: roomType.id,
      floorNumber: 5,
      capacity: 2,
      currentClaimState: InventoryClaimState.CONFIRMED,
      physicalState: RoomPhysicalState.AVAILABLE_CLEAN,
      isDeficient: true,
      deficientConditionCategory: "HOUSEKEEPING",
      deficientSince: new Date(),
      deficientDeadline: new Date(Date.now() + 48 * 3600 * 1000),
    },
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

  const inquiry = await prisma.inquiry.create({
    data: {
      referenceNumber: `INQ-SEED-${Date.now()}`,
      guestProfileId: guestProfile.id,
      agentProfileId: null,
      sourceChannel: "DIRECT",
      defaultCustodianId: "staff-frontdesk-1",
      notes: "Seed inquiry for tests",
      createdBy: "actor-seed-system",
    },
  });

  // --- S9: Agent commission scenarios ---
  const agentWithRate = await prisma.agentProfile.create({
    data: { displayName: "Seed Agent (rate)", commissionRate: 0.1 as any, commissionBasis: "TOTAL_FOLIO" as any, createdBy: "actor-seed-system" } as any,
  });
  const agentNoRate = await prisma.agentProfile.create({
    data: { displayName: "Seed Agent (no-rate)", commissionRate: null, commissionBasis: null, createdBy: "actor-seed-system" } as any,
  });

  const inquiryAgentWithRate = await prisma.inquiry.create({
    data: {
      referenceNumber: `INQ-AGENT-RATE-${Date.now()}`,
      guestProfileId: guestProfile.id,
      agentProfileId: agentWithRate.id,
      sourceChannel: "AGENT",
      defaultCustodianId: "staff-frontdesk-1",
      notes: "Seed inquiry (agent with commission rate) for S9 tests",
      createdBy: "actor-seed-system",
    },
  });
  const inquiryAgentNoRate = await prisma.inquiry.create({
    data: {
      referenceNumber: `INQ-AGENT-NORATE-${Date.now()}`,
      guestProfileId: guestProfile.id,
      agentProfileId: agentNoRate.id,
      sourceChannel: "AGENT",
      defaultCustodianId: "staff-frontdesk-1",
      notes: "Seed inquiry (agent without commission rate) for S9 tests",
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
      id: await allocateReadableId(prisma, READABLE_ID_PREFIXES.RESERVATION),
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
      id: await allocateReadableId(prisma, READABLE_ID_PREFIXES.PAYMENT),
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
      id: await allocateReadableId(prisma, READABLE_ID_PREFIXES.HANDOFF),
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
      id: await allocateReadableId(prisma, READABLE_ID_PREFIXES.RESERVATION),
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
      id: await allocateReadableId(prisma, READABLE_ID_PREFIXES.HANDOFF),
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
      id: await allocateReadableId(prisma, READABLE_ID_PREFIXES.ROOM_ASSIGNMENT),
      entryId: entryCredit.id,
      roomId: roomClean.id,
      assignedBy: "actor-fd-1",
      deficientAtAssignment: false,
    },
  });

  await prisma.stageDwellRecord.create({
    data: { entryId: entryCredit.id, stage: Stage.S5, enteredAt: new Date() },
  });

  // --- Third entry: seeded directly into S7 for stage-7 flows ---
  const checkInS7 = new Date("2026-04-20T09:00:00.000Z");
  const checkOutS7 = new Date("2026-04-22T09:00:00.000Z");

  const guestProfileS7 = await prisma.guestProfile.create({
    data: {
      firstName: "Pema",
      lastName: "Wangchuk",
      email: "pema.wangchuk@example.com",
      clientTier: "STANDARD",
      createdBy: "actor-seed-system",
      identityVerifiedAt: new Date(),
      identityVerifiedBy: "actor-seed-system",
      identityVerificationPath: "RETURNING_VALID",
    },
  });

  const entryS7 = await prisma.entry.create({
    data: {
      inquiryId: inquiry.id,
      guestProfileId: guestProfileS7.id,
      segmentNumber: 1,
      useType: EntryUseType.LEISURE,
      status: EntryStatus.ACTIVE,
      currentStage: Stage.S7,
      checkInDate: checkInS7,
      checkOutDate: checkOutS7,
      guestCount: 2,
      createdBy: "actor-seed-system",
      version: 1,
      keysIssuedAt: new Date(),
      keysIssuedCount: 2,
      keysIssuedBy: "actor-seed-system",
      registrationCompletedAt: new Date(),
      registrationCompletedBy: "actor-seed-system",
    },
  });

  // Dedicated deterministic S9 test entry (DIRECT_BILL) for S9 write-off + invoice matching.
  const entryS7DirectBill = await prisma.entry.create({
    data: {
      id: "9a9a9a9a-9a9a-4a9a-9a9a-9a9a9a9a9a9a",
      inquiryId: inquiry.id,
      guestProfileId: guestProfileS7.id,
      segmentNumber: 1,
      useType: EntryUseType.GROUP,
      status: EntryStatus.ACTIVE,
      currentStage: Stage.S7,
      checkInDate: checkInS7,
      checkOutDate: checkOutS7,
      guestCount: 10,
      createdBy: "actor-seed-system",
      version: 1,
      keysIssuedAt: new Date(),
      keysIssuedCount: 2,
      keysIssuedBy: "actor-seed-system",
      registrationCompletedAt: new Date(),
      registrationCompletedBy: "actor-seed-system",
    },
  });

  const segS7 = await prisma.segment.create({
    data: { entryId: entryS7.id, segmentNumber: 1 },
  });

  const segS7DirectBill = await prisma.segment.create({
    data: { entryId: entryS7DirectBill.id, segmentNumber: 1 },
  });

  await prisma.cancellationDisclosureRecord.create({
    data: {
      entryId: entryS7.id,
      segmentId: segS7.id,
      noShowTreatmentStatement: "Seeded S7 entry.",
      disclosedTerms: {},
    },
  });

  await prisma.reservation.create({
    data: {
      id: await allocateReadableId(prisma, READABLE_ID_PREFIXES.RESERVATION),
      entryId: entryS7.id,
      segmentId: segS7.id,
      frozenRate: 350,
      frozenRatePlanId: "rp-dlx-weekday",
      frozenInclusions: { dailyFAndBExpected: true },
      frozenCancellationTerms: { sameDayPenaltyAmount: 100 },
      frozenBillingModel: "GUEST_PAY",
      frozenCheckInDate: checkInS7,
      frozenCheckOutDate: checkOutS7,
      frozenGuestCount: 2,
      creditCeilingIfExtended: 5000,
      confirmedAt: new Date(),
      confirmedBy: "actor-seed-res",
      confirmationVoucherSent: true,
    },
  });

  await prisma.reservation.create({
    data: {
      id: await allocateReadableId(prisma, READABLE_ID_PREFIXES.RESERVATION),
      entryId: entryS7DirectBill.id,
      segmentId: segS7DirectBill.id,
      frozenRate: 500,
      frozenRatePlanId: "rp-corp-directbill",
      frozenInclusions: { dailyFAndBExpected: false },
      frozenCancellationTerms: { sameDayPenaltyAmount: 0 },
      frozenBillingModel: "DIRECT_BILL",
      frozenCheckInDate: checkInS7,
      frozenCheckOutDate: checkOutS7,
      frozenGuestCount: 10,
      creditCeilingIfExtended: 5000,
      confirmedAt: new Date(),
      confirmedBy: "actor-seed-res",
      confirmationVoucherSent: true,
    },
  });

  const folioS7 = await prisma.folio.create({
    data: {
      entryId: entryS7.id,
      state: FolioState.LIVE,
      billingModel: "GUEST_PAY",
      createdBy: "actor-seed-system",
      convertedToLiveAt: new Date(),
      convertedBy: "actor-seed-system",
      // Must match sum(folio_lines): 2×350 room + 2×50 F&B (recompute after payment uses lines).
      outstandingBalance: 800,
      advancePaymentReconciliationComplete: true,
    },
  });

  const folioS7DirectBill = await prisma.folio.create({
    data: {
      entryId: entryS7DirectBill.id,
      state: FolioState.LIVE,
      billingModel: "DIRECT_BILL",
      createdBy: "actor-seed-system",
      convertedToLiveAt: new Date(),
      convertedBy: "actor-seed-system",
      outstandingBalance: 1200,
      advancePaymentReconciliationComplete: true,
    },
  });

  await prisma.room.update({
    where: { id: roomClean.id },
    data: { currentClaimState: InventoryClaimState.OCCUPIED },
  });

  await prisma.room.update({
    where: { id: roomS9DirectBill.id },
    data: { currentClaimState: InventoryClaimState.OCCUPIED },
  });

  await prisma.roomAssignment.create({
    data: {
      id: await allocateReadableId(prisma, READABLE_ID_PREFIXES.ROOM_ASSIGNMENT),
      entryId: entryS7.id,
      roomId: roomClean.id,
      assignedBy: "actor-seed-system",
      deficientAtAssignment: false,
    },
  });

  await prisma.roomAssignment.create({
    data: {
      id: await allocateReadableId(prisma, READABLE_ID_PREFIXES.ROOM_ASSIGNMENT),
      entryId: entryS7DirectBill.id,
      roomId: roomS9DirectBill.id,
      assignedBy: "actor-seed-system",
      deficientAtAssignment: false,
    },
  });

  await prisma.handoffRecord.createMany({
    data: [
      {
        id: await allocateReadableId(prisma, READABLE_ID_PREFIXES.HANDOFF),
        entryId: entryS7.id,
        handoffType: HandoffType.H1,
        state: HandoffState.CLOSED,
        fromRole: "RESERVATIONS",
        fromActorId: "actor-seed-res",
        toRole: "FRONT_DESK",
        checklistContent: {},
        createdBy: "actor-seed-system",
        stageContext: Stage.S4,
        acceptedAt: new Date(),
        acceptedBy: "actor-seed-system",
        fulfilledAt: new Date(),
        fulfilledBy: "actor-seed-system",
        closedAt: new Date(),
      },
      {
        id: await allocateReadableId(prisma, READABLE_ID_PREFIXES.HANDOFF),
        entryId: entryS7.id,
        handoffType: HandoffType.H4,
        state: HandoffState.CREATED,
        fromRole: "FRONT_DESK",
        fromActorId: "actor-seed-system",
        toRole: "HOUSEKEEPING",
        checklistContent: { roomNumber: "501", expectedCheckoutDate: checkOutS7.toISOString() },
        createdBy: "actor-seed-system",
        stageContext: Stage.S7,
      },
    ],
  });

  await prisma.handoffRecord.createMany({
    data: [
      {
        id: await allocateReadableId(prisma, READABLE_ID_PREFIXES.HANDOFF),
        entryId: entryS7DirectBill.id,
        handoffType: HandoffType.H1,
        state: HandoffState.CLOSED,
        fromRole: "RESERVATIONS",
        fromActorId: "actor-seed-res",
        toRole: "FRONT_DESK",
        checklistContent: {},
        createdBy: "actor-seed-system",
        stageContext: Stage.S4,
        acceptedAt: new Date(),
        acceptedBy: "actor-seed-system",
        fulfilledAt: new Date(),
        fulfilledBy: "actor-seed-system",
        closedAt: new Date(),
      },
      {
        id: await allocateReadableId(prisma, READABLE_ID_PREFIXES.HANDOFF),
        entryId: entryS7DirectBill.id,
        handoffType: HandoffType.H4,
        state: HandoffState.CREATED,
        fromRole: "FRONT_DESK",
        fromActorId: "actor-seed-system",
        toRole: "HOUSEKEEPING",
        checklistContent: { roomNumber: "503", expectedCheckoutDate: checkOutS7.toISOString() },
        createdBy: "actor-seed-system",
        stageContext: Stage.S7,
      },
    ],
  });

  // Seed one non-room charge to support dispute flows
  await prisma.folioLine.create({
    data: {
      folioId: folioS7.id,
      lineType: FolioLineType.F_AND_B,
      description: "Seeded F&B charge",
      amount: 50,
      currency: "BTN",
      chargeDate: new Date(Date.UTC(2026, 3, 20, 0, 0, 0, 0)),
      stage: Stage.S7,
      postedBy: "actor-seed-system",
    },
  });

  await prisma.folioLine.create({
    data: {
      folioId: folioS7.id,
      lineType: FolioLineType.F_AND_B,
      description: "Seeded F&B charge night 2",
      amount: 50,
      currency: "BTN",
      chargeDate: new Date(Date.UTC(2026, 3, 21, 0, 0, 0, 0)),
      stage: Stage.S7,
      postedBy: "actor-seed-system",
    },
  });

  await prisma.folioLine.createMany({
    data: [
      {
        folioId: folioS7.id,
        lineType: FolioLineType.ROOM_CHARGE,
        description: "Seeded room night 1",
        amount: 350,
        currency: "BTN",
        chargeDate: new Date(Date.UTC(2026, 3, 20, 0, 0, 0, 0)),
        stage: Stage.S7,
        postedBy: "actor-seed-system",
      },
      {
        folioId: folioS7.id,
        lineType: FolioLineType.ROOM_CHARGE,
        description: "Seeded room night 2",
        amount: 350,
        currency: "BTN",
        chargeDate: new Date(Date.UTC(2026, 3, 21, 0, 0, 0, 0)),
        stage: Stage.S7,
        postedBy: "actor-seed-system",
      },
    ],
  });

  await prisma.folioLine.create({
    data: {
      folioId: folioS7DirectBill.id,
      lineType: FolioLineType.SERVICE,
      description: "Seeded direct-bill service charge",
      amount: 200,
      currency: "BTN",
      chargeDate: new Date("2026-04-20T13:00:00.000Z"),
      stage: Stage.S7,
      postedBy: "actor-seed-system",
    },
  });

  await prisma.stageDwellRecord.create({
    data: { entryId: entryS7.id, stage: Stage.S7, enteredAt: new Date() },
  });

  await prisma.stageDwellRecord.create({
    data: { entryId: entryS7DirectBill.id, stage: Stage.S7, enteredAt: new Date() },
  });

  console.log("Seed complete.");
  console.log("Primary S5 test entry id:", entry.id);
  console.log("Guest profile id (verify-identity):", guestProfile.id);
  console.log("Room 501 (clean) id:", roomClean.id);
  console.log("Room 503 (S9 direct-bill) id:", roomS9DirectBill.id);
  console.log("Room 502-DEF (DEFICIENT) id:", deficientRoom.id);
  console.log("Credit Tier-2 scenario entry id:", entryCredit.id, "(needs creditCeilingTier2Ack before S6)");
  console.log("Seeded S7 entry id:", entryS7.id);
  console.log("Seeded S7 DIRECT_BILL entry id (for S9):", entryS7DirectBill.id);
}

main()
  .then(() => prisma.$disconnect())
  .catch((e) => {
    console.error(e);
    prisma.$disconnect();
    // Avoid `process` dependency in environments without Node typings.
    // A non-zero exit is still achieved by allowing the rejection to surface.
    throw e;
  });
