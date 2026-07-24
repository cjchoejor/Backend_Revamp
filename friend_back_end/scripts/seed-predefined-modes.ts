import { ModeLifecycleState, PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

type SeedMode = {
  modeKey: string;
  displayName: string;
  description: string;
  stageRoute: string[];
  autoFulfilmentConditions: { stage: string; condition: string }[];
  featureDependencies: string[];
};

/**
 * ACIG §2.1A.7 — the 8 canonical predefined modes.
 *
 * `stageRoute` is the ordered list of S1–S9 stages the journey passes through.
 * `autoFulfilmentConditions` are the spec's {stage, condition} pairs — places where the system
 *   skips L1 confirmation when a downstream gate is already satisfied.
 * `featureDependencies` lists the services/engines the mode loads at runtime.
 *
 * Conditions and dependency names follow the conventions in SIG-S1..S9; some are intentional
 * placeholders that operational code will pattern-match (e.g. SAME_TEAM_AUTO_FULFIL).
 */
const MODES: SeedMode[] = [
  {
    modeKey: "NEW_BOOKING",
    displayName: "New booking",
    description:
      "Full S1→S9 journey for a fresh inquiry that progresses through availability search, quotation, hold, confirmation, pre-arrival, check-in, in-house, checkout, and post-stay.",
    stageRoute: ["S1", "S2", "S3", "S4", "S5", "S6", "S7", "S8", "S9"],
    autoFulfilmentConditions: [],
    featureDependencies: [
      "AvailabilityEngine",
      "PricingPipelineEngine",
      "RatePlanRegistry",
      "SeasonCalendar",
      "CommunicationConfigService",
      "CancellationPolicyRegistry",
    ],
  },
  {
    modeKey: "ROOM_CHANGE",
    displayName: "Room change",
    description:
      "Mid-stay room change for an entry already in S6 (in-house). Skips S1–S4 because the entry exists; routes through S2 (re-quotation if rate differs) and S3 (re-hold) before returning to S6.",
    stageRoute: ["S2", "S3", "S6"],
    autoFulfilmentConditions: [
      { stage: "S2", condition: "SAME_RATE_AS_FROZEN_RESERVATION" },
    ],
    featureDependencies: ["AvailabilityEngine", "PricingPipelineEngine", "RoomAssignmentService"],
  },
  {
    modeKey: "RATE_REVISION",
    displayName: "Rate revision",
    description:
      "Mid-stay rate adjustment requiring FOM authority. Routes through S2 (re-quotation) only; the frozen rate snapshot on Reservation is replaced via supersession.",
    stageRoute: ["S2"],
    autoFulfilmentConditions: [],
    featureDependencies: ["PricingPipelineEngine", "DiscountAuthorityPolicy"],
  },
  {
    modeKey: "DATE_EXTENSION",
    displayName: "Date extension",
    description:
      "Guest extends their stay. Routes S2→S3 to check availability for additional nights and re-hold; new dates are folded into the existing reservation.",
    stageRoute: ["S2", "S3"],
    autoFulfilmentConditions: [
      { stage: "S3", condition: "INVENTORY_ALREADY_COMMITTED_FOR_NEW_NIGHTS" },
    ],
    featureDependencies: ["AvailabilityEngine", "PricingPipelineEngine", "SeasonCalendar"],
  },
  {
    modeKey: "EARLY_DEPARTURE",
    displayName: "Early departure / cancellation",
    description:
      "Guest cancels or checks out early. Routes through S8 (checkout) with cancellation-policy penalty application; folio settles via S9.",
    stageRoute: ["S8", "S9"],
    autoFulfilmentConditions: [],
    featureDependencies: ["CancellationPolicyRegistry", "FolioSettlementService"],
  },
  {
    modeKey: "BILLING_MODEL_CHANGE",
    displayName: "Billing model change",
    description:
      "Switches a folio's billing mode (e.g. INDIVIDUAL → CORPORATE, ROOM_NIGHT → APARTMENT). Routes through S7 (folio re-keying) only.",
    stageRoute: ["S7"],
    autoFulfilmentConditions: [],
    featureDependencies: ["FolioService", "BillingModelPolicy"],
  },
  {
    modeKey: "GUEST_COMPOSITION_CHANGE",
    displayName: "Guest composition change",
    description:
      "Adds or removes guests from an entry mid-stay. Routes through S2 (re-validate group threshold) and S6 (update in-house roster).",
    stageRoute: ["S2", "S6"],
    autoFulfilmentConditions: [
      { stage: "S2", condition: "WITHIN_ORIGINAL_GROUP_THRESHOLD" },
    ],
    featureDependencies: ["GroupDetectionPolicy", "GuestProfileService"],
  },
  {
    modeKey: "COMPLAINT_RESOLUTION",
    displayName: "Complaint resolution / goodwill",
    description:
      "Goodwill adjustment in response to a guest complaint. Routes through S7 (folio adjustment) with GM authority; may trigger S8 dispute-gate workflow.",
    stageRoute: ["S7", "S8"],
    autoFulfilmentConditions: [],
    featureDependencies: ["DisputeService", "FolioService", "DiscountAuthorityPolicy"],
  },
];

for (const m of MODES) {
  const existing = await prisma.modeConfiguration.findFirst({
    where: { modeKey: m.modeKey },
    orderBy: { version: "desc" },
  });
  if (existing) {
    console.log(`  - ${m.modeKey} already present (v${existing.version}, ${existing.lifecycleState}); skipping.`);
    continue;
  }
  const created = await prisma.modeConfiguration.create({
    data: {
      modeKey: m.modeKey,
      displayName: m.displayName,
      description: m.description,
      lifecycleState: ModeLifecycleState.ACTIVE,
      isActive: true,
      isPredefined: true,
      stageRoute: m.stageRoute,
      autoFulfilmentConditions: m.autoFulfilmentConditions,
      featureDependencies: m.featureDependencies,
      version: 1,
      createdBy: "actor-seed-system",
    },
  });
  console.log(`  + ${m.modeKey} created (v${created.version}, ACTIVE)`);
}

await prisma.$disconnect();
