-- CreateEnum
CREATE TYPE "Stage" AS ENUM ('S1', 'S2', 'S3', 'S4', 'S5', 'S6', 'S7', 'S8', 'S9', 'TERMINAL');

-- CreateEnum
CREATE TYPE "EntryStatus" AS ENUM ('ACTIVE', 'PARKED', 'CANCELLED', 'CLOSED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "EntryUseType" AS ENUM ('LEISURE', 'CORPORATE', 'CONFERENCE', 'GROUP', 'APARTMENT', 'CATERING', 'ACCOMMODATION');

-- CreateEnum
CREATE TYPE "GroupBillingMode" AS ENUM ('GROUP_MASTER', 'INDIVIDUAL_FOLIO');

-- CreateEnum
CREATE TYPE "HoldState" AS ENUM ('PLACED', 'CONFIRMED', 'RELEASED', 'UPGRADED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "QuotationState" AS ENUM ('DRAFT', 'SENT', 'ACCEPTED', 'SUPERSEDED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "InventoryClaimState" AS ENUM ('FREE', 'SPECULATIVELY_HELD', 'COMMITTED_HELD', 'CONFIRMED', 'OCCUPIED', 'DEPARTED_DIRTY', 'DEPARTED_CLEAN');

-- CreateEnum
CREATE TYPE "HandoffType" AS ENUM ('H1', 'H2', 'H3', 'H4', 'H5');

-- CreateEnum
CREATE TYPE "HandoffState" AS ENUM ('CREATED', 'ACCEPTED', 'FULFILLED', 'REJECTED', 'ESCALATED', 'CANCELLED', 'CLOSED');

-- CreateEnum
CREATE TYPE "FolioState" AS ENUM ('PROVISIONAL', 'LIVE', 'NO_SHOW_CLOSED', 'SETTLED', 'OUTSTANDING', 'WRITTEN_OFF');

-- CreateEnum
CREATE TYPE "InvoiceType" AS ENUM ('PROFORMA', 'FINAL');

-- CreateEnum
CREATE TYPE "InvoiceState" AS ENUM ('DRAFT', 'DISPATCHED', 'PAYMENT_TRACKED', 'RECONCILED', 'SUPERSEDED');

-- CreateEnum
CREATE TYPE "TimerStatus" AS ENUM ('SCHEDULED', 'FIRED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "OverbookingTriggerType" AS ENUM ('DELIBERATE', 'OTA_CONFLICT');

-- CreateEnum
CREATE TYPE "FolioLineType" AS ENUM ('ROOM_CHARGE', 'F_AND_B', 'SERVICE', 'OTHER', 'CREDIT_NOTE');

-- CreateEnum
CREATE TYPE "FollowUpTaskStatus" AS ENUM ('PENDING', 'COMPLETED');

-- CreateEnum
CREATE TYPE "CommunicationChannel" AS ENUM ('EMAIL', 'WHATSAPP');

-- CreateEnum
CREATE TYPE "CommunicationType" AS ENUM ('FEEDBACK_SOLICITATION', 'POST_STAY_CHARGE_NOTICE', 'CONFIRMATION_VOUCHER', 'INVOICE_SUPERSEDED_NOTICE');

-- CreateEnum
CREATE TYPE "NightAuditRunStatus" AS ENUM ('COMPLETE', 'PARTIAL', 'FAILED');

-- CreateEnum
CREATE TYPE "NightAuditAnomalyType" AS ENUM ('MISSING_EXPECTED_CHARGE', 'AUDIT_EXCEPTION');

-- CreateEnum
CREATE TYPE "DisputeStatus" AS ENUM ('OPEN', 'IN_PROGRESS', 'RESOLVED', 'CLOSED', 'REOPENED');

-- CreateEnum
CREATE TYPE "AmendmentPath" AS ENUM ('PATH_1', 'PATH_2', 'PATH_3');

-- CreateEnum
CREATE TYPE "WorkOrderToDoStatus" AS ENUM ('PENDING', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "TaskStatus" AS ENUM ('PENDING', 'COMPLETE', 'WAIVED');

-- CreateEnum
CREATE TYPE "PreArrivalTaskType" AS ENUM ('PAYMENT_RECONCILIATION', 'CREDIT_CEILING_CHECK', 'NIGHT_AUDIT_TIMER_REGISTRATION', 'BED_CONFIGURATION_CHANGE', 'PRE_ARRIVAL_COMMUNICATION', 'SPECIAL_REQUEST_FULFILMENT', 'LATE_ARRIVAL_MEAL_COORDINATION', 'SITE_VISIT', 'UNIT_READINESS_VERIFICATION');

-- CreateEnum
CREATE TYPE "TaskCategory" AS ENUM ('ADMINISTRATIVE', 'OPERATIONAL', 'COMMUNICATION');

-- CreateEnum
CREATE TYPE "RoomPhysicalState" AS ENUM ('AVAILABLE_CLEAN', 'AVAILABLE_INSPECTED', 'DIRTY', 'UNDER_MAINTENANCE');

-- CreateEnum
CREATE TYPE "DeficientConditionCategory" AS ENUM ('HOUSEKEEPING', 'MAINTENANCE', 'SOFT_FURNISHING', 'OTHER');

-- CreateEnum
CREATE TYPE "PaymentDirection" AS ENUM ('IN', 'OUT');

-- CreateEnum
CREATE TYPE "ActorLevel" AS ENUM ('L1', 'L2', 'L3', 'L4', 'SYSTEM');

-- CreateEnum
CREATE TYPE "SessionStatus" AS ENUM ('ACTIVE', 'IDLE_LOCKED', 'MANUALLY_LOCKED', 'HARD_LOGGED_OUT');

-- CreateEnum
CREATE TYPE "SessionEventType" AS ENUM ('LOGIN', 'PIN_SWITCH', 'IDLE_AUTO_LOCK', 'MANUAL_LOCK', 'HARD_LOGOUT');

-- CreateEnum
CREATE TYPE "StageDwellMode" AS ENUM ('ACTIVE', 'IDLE', 'PARKED');

-- CreateEnum
CREATE TYPE "DuplicateFlagStatus" AS ENUM ('OPEN', 'RESOLVED');

-- CreateEnum
CREATE TYPE "DuplicateResolutionType" AS ENUM ('MERGE', 'ACKNOWLEDGE', 'DISMISS');

-- CreateEnum
CREATE TYPE "CommissionBasis" AS ENUM ('NET_ROOM_RATE', 'GROSS_ROOM_RATE', 'TOTAL_FOLIO');

-- CreateEnum
CREATE TYPE "CommissionDueStatus" AS ENUM ('PENDING', 'RATE_MISSING', 'SETTLED');

-- CreateEnum
CREATE TYPE "ProcessingLockStatus" AS ENUM ('ACTIVE', 'EXPIRED', 'RELEASED');

-- CreateEnum
CREATE TYPE "SpaceAllocationState" AS ENUM ('QUOTED', 'HELD', 'CONFIRMED', 'RELEASED');

-- CreateTable
CREATE TABLE "ota_conflict_overbooking_records" (
    "id" TEXT NOT NULL,
    "entryId" TEXT NOT NULL,
    "triggerType" "OverbookingTriggerType" NOT NULL,
    "otaNotificationStatus" TEXT NOT NULL DEFAULT 'OPEN',
    "otaNotificationClosedAt" TIMESTAMP(3),
    "mitigationPlanStatus" TEXT NOT NULL DEFAULT 'OPEN',
    "mitigationPlanClosedAt" TIMESTAMP(3),
    "gmApprovalActorId" TEXT NOT NULL,
    "gmApprovalAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT NOT NULL,

    CONSTRAINT "ota_conflict_overbooking_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "configuration_entries" (
    "id" TEXT NOT NULL,
    "configKey" TEXT NOT NULL,
    "configValue" JSONB NOT NULL,
    "effectiveFrom" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "effectiveTo" TIMESTAMP(3),
    "setBy" TEXT NOT NULL DEFAULT 'actor-seed-system',
    "setAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "configuration_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "staff_users" (
    "id" TEXT NOT NULL,
    "fullName" TEXT NOT NULL,
    "email" TEXT,
    "actorLevel" "ActorLevel" NOT NULL,
    "pinHash" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "idleThresholdSeconds" INTEGER NOT NULL DEFAULT 600,
    "hardLogoutThresholdSeconds" INTEGER NOT NULL DEFAULT 28800,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "staff_users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "session_records" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "terminalId" TEXT NOT NULL,
    "status" "SessionStatus" NOT NULL DEFAULT 'ACTIVE',
    "authenticatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "idleLockedAt" TIMESTAMP(3),
    "manuallyLockedAt" TIMESTAMP(3),
    "hardLoggedOutAt" TIMESTAMP(3),
    "lastActiveAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "jwtToken" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "session_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "session_event_records" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "eventType" "SessionEventType" NOT NULL,
    "outgoingActorId" TEXT,
    "incomingActorId" TEXT,
    "terminalId" TEXT NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "session_event_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "guest_profiles" (
    "id" TEXT NOT NULL,
    "firstName" TEXT NOT NULL,
    "lastName" TEXT NOT NULL,
    "email" TEXT,
    "phone" TEXT,
    "nationality" TEXT,
    "vipTier" TEXT,
    "clientTier" TEXT DEFAULT 'STANDARD',
    "preferences" JSONB,
    "behaviouralFlags" JSONB,
    "observationQueue" JSONB,
    "stayHistorySummary" JSONB,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "identityVerifiedAt" TIMESTAMP(3),
    "identityVerifiedBy" TEXT,
    "identityVerificationPath" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdBy" TEXT NOT NULL DEFAULT 'actor-seed-system',

    CONSTRAINT "guest_profiles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "guest_identity_documents" (
    "id" TEXT NOT NULL,
    "guestProfileId" TEXT NOT NULL,
    "documentType" TEXT NOT NULL,
    "documentNumber" TEXT NOT NULL,
    "issuingCountry" TEXT,
    "expiryDate" TIMESTAMP(3),
    "capturedAt" TIMESTAMP(3) NOT NULL,
    "capturedBy" TEXT NOT NULL,
    "retentionPeriod" INTEGER NOT NULL,
    "retentionExpiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "guest_identity_documents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vip_arrival_notification_events" (
    "id" TEXT NOT NULL,
    "entryId" TEXT NOT NULL,
    "guestProfileId" TEXT NOT NULL,
    "roomNumber" TEXT NOT NULL,
    "vipTier" TEXT NOT NULL,
    "preferences" JSONB,
    "specialNotes" TEXT,
    "checkInInitiatedAt" TIMESTAMP(3) NOT NULL,
    "recipientRoles" JSONB NOT NULL,
    "notificationDispatchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT NOT NULL,

    CONSTRAINT "vip_arrival_notification_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "inquiries" (
    "id" TEXT NOT NULL,
    "referenceNumber" TEXT NOT NULL,
    "guestProfileId" TEXT NOT NULL,
    "agentProfileId" TEXT,
    "sourceChannel" TEXT NOT NULL DEFAULT 'DIRECT',
    "defaultCustodianId" TEXT NOT NULL,
    "notes" TEXT,
    "corporateClientRef" TEXT,
    "corporateCoordinator" TEXT,
    "corporateContextCapturedAt" TIMESTAMP(3),
    "corporateContextCapturedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdBy" TEXT NOT NULL DEFAULT 'actor-seed-system',
    "parkedAt" TIMESTAMP(3),
    "parkedBy" TEXT,

    CONSTRAINT "inquiries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "duplicate_detection_flags" (
    "id" TEXT NOT NULL,
    "inquiryId" TEXT NOT NULL,
    "status" "DuplicateFlagStatus" NOT NULL DEFAULT 'OPEN',
    "resolutionType" "DuplicateResolutionType",
    "resolutionReason" TEXT,
    "mergedIntoInquiryId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT NOT NULL,
    "resolvedAt" TIMESTAMP(3),
    "resolvedBy" TEXT,

    CONSTRAINT "duplicate_detection_flags_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "entries" (
    "id" TEXT NOT NULL,
    "inquiryId" TEXT NOT NULL,
    "guestProfileId" TEXT,
    "segmentNumber" INTEGER NOT NULL DEFAULT 1,
    "useType" "EntryUseType" NOT NULL DEFAULT 'LEISURE',
    "status" "EntryStatus" NOT NULL DEFAULT 'ACTIVE',
    "currentStage" "Stage" NOT NULL DEFAULT 'S1',
    "walkInCompressed" BOOLEAN NOT NULL DEFAULT false,
    "checkInDate" TIMESTAMP(3),
    "checkOutDate" TIMESTAMP(3),
    "guestCount" INTEGER,
    "otaSource" BOOLEAN NOT NULL DEFAULT false,
    "otaReference" TEXT,
    "groupBillingMode" "GroupBillingMode",
    "parkedAt" TIMESTAMP(3),
    "parkedBy" TEXT,
    "parkedIndividually" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdBy" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "closedAt" TIMESTAMP(3),
    "closedBy" TEXT,
    "noShowCutoffReachedAt" TIMESTAMP(3),
    "creditCeilingTier2AcknowledgedAt" TIMESTAMP(3),
    "creditCeilingTier2AcknowledgedBy" TEXT,
    "awaitingWrittenConfirmationActive" BOOLEAN NOT NULL DEFAULT false,
    "keysIssuedAt" TIMESTAMP(3),
    "keysIssuedCount" INTEGER,
    "keysIssuedBy" TEXT,
    "registrationCompletedAt" TIMESTAMP(3),
    "registrationCompletedBy" TEXT,
    "apartmentDurationNights" INTEGER,
    "apartmentRateTierCode" TEXT,

    CONSTRAINT "entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agent_profiles" (
    "id" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "commissionRate" DECIMAL(5,4),
    "commissionBasis" "CommissionBasis",
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT NOT NULL,

    CONSTRAINT "agent_profiles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "commission_due_records" (
    "id" TEXT NOT NULL,
    "entryId" TEXT NOT NULL,
    "agentProfileId" TEXT NOT NULL,
    "commissionRate" DECIMAL(5,4) NOT NULL,
    "commissionBasis" "CommissionBasis",
    "calculatedAmount" DECIMAL(15,2),
    "currency" TEXT NOT NULL DEFAULT 'BTN',
    "status" "CommissionDueStatus" NOT NULL DEFAULT 'PENDING',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT NOT NULL,

    CONSTRAINT "commission_due_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "equipment_allocations" (
    "id" TEXT NOT NULL,
    "entryId" TEXT NOT NULL,
    "equipmentCode" TEXT NOT NULL,
    "allocatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "allocatedBy" TEXT NOT NULL,
    "returnDeadlineAt" TIMESTAMP(3) NOT NULL,
    "returnConfirmedAt" TIMESTAMP(3),
    "returnConfirmedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "equipment_allocations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "segments" (
    "id" TEXT NOT NULL,
    "entryId" TEXT NOT NULL,
    "segmentNumber" INTEGER NOT NULL,
    "stage" "Stage" NOT NULL DEFAULT 'S1',
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sealedAt" TIMESTAMP(3),
    "sealedBy" TEXT,
    "notes" TEXT,
    "createdBy" TEXT NOT NULL DEFAULT 'actor-seed-system',

    CONSTRAINT "segments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "availability_configurations" (
    "id" TEXT NOT NULL,
    "entryId" TEXT NOT NULL,
    "segmentId" TEXT,
    "searchCriteria" JSONB NOT NULL,
    "resultSet" JSONB NOT NULL,
    "optionSelected" JSONB,
    "isStale" BOOLEAN NOT NULL DEFAULT false,
    "stalenessAt" TIMESTAMP(3),
    "deficientAcknowledgements" JSONB,
    "sealedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT NOT NULL,

    CONSTRAINT "availability_configurations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "processing_lock_records" (
    "id" TEXT NOT NULL,
    "actorId" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "inventoryReference" TEXT NOT NULL,
    "entryId" TEXT,
    "segmentId" TEXT,
    "placedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ttlSeconds" INTEGER NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "status" "ProcessingLockStatus" NOT NULL DEFAULT 'ACTIVE',
    "expiredAt" TIMESTAMP(3),
    "releasedAt" TIMESTAMP(3),
    "revalidationCount" INTEGER NOT NULL DEFAULT 0,
    "pgBossJobId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "processing_lock_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "revalidation_delta_records" (
    "id" TEXT NOT NULL,
    "processingLockId" TEXT NOT NULL,
    "availabilityChanged" BOOLEAN NOT NULL DEFAULT false,
    "deficientStatusChanged" BOOLEAN NOT NULL DEFAULT false,
    "pricingChanged" BOOLEAN NOT NULL DEFAULT false,
    "availabilityDelta" JSONB,
    "deficientDelta" JSONB,
    "pricingDelta" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT NOT NULL,

    CONSTRAINT "revalidation_delta_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "trace_events" (
    "id" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "actorId" TEXT NOT NULL DEFAULT 'actor-seed-system',
    "actorLevel" "ActorLevel" NOT NULL DEFAULT 'L1',
    "entityType" TEXT NOT NULL DEFAULT 'Entry',
    "entityId" TEXT NOT NULL DEFAULT '',
    "operation" TEXT NOT NULL DEFAULT 'UPDATE',
    "payload" JSONB NOT NULL DEFAULT '{}',
    "timestamp" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "stageContext" "Stage",
    "segmentContext" TEXT,
    "correlationId" TEXT,
    "inquiryId" TEXT,
    "entryId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT NOT NULL DEFAULT 'actor-seed-system',

    CONSTRAINT "trace_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "spaces" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "spaceType" TEXT NOT NULL DEFAULT 'HALL',
    "defaultCapacity" INTEGER NOT NULL DEFAULT 0,
    "capacity" INTEGER NOT NULL DEFAULT 0,
    "seatingConfigurations" JSONB NOT NULL DEFAULT '[]',
    "expansionLinks" JSONB,
    "isAvailable" BOOLEAN NOT NULL DEFAULT true,
    "isEventInProgress" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "spaces_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "space_allocations" (
    "id" TEXT NOT NULL,
    "spaceId" TEXT NOT NULL,
    "entryId" TEXT NOT NULL,
    "segmentId" TEXT,
    "state" "SpaceAllocationState" NOT NULL DEFAULT 'QUOTED',
    "eventBlock" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT NOT NULL,

    CONSTRAINT "space_allocations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "room_types" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "room_types_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rooms" (
    "id" TEXT NOT NULL,
    "roomNumber" TEXT NOT NULL,
    "roomTypeId" TEXT NOT NULL,
    "floorNumber" INTEGER,
    "capacity" INTEGER NOT NULL DEFAULT 2,
    "currentClaimState" "InventoryClaimState" NOT NULL DEFAULT 'FREE',
    "physicalState" "RoomPhysicalState" NOT NULL DEFAULT 'AVAILABLE_CLEAN',
    "expectedReadyAt" TIMESTAMP(3),
    "isShadowInventory" BOOLEAN NOT NULL DEFAULT false,
    "isDeficient" BOOLEAN NOT NULL DEFAULT false,
    "deficientConditionCategory" "DeficientConditionCategory",
    "deficientSince" TIMESTAMP(3),
    "deficientDeadline" TIMESTAMP(3),
    "isUnderMaintenance" BOOLEAN NOT NULL DEFAULT false,
    "maintenanceDeadline" TIMESTAMP(3),
    "cleansingRitualCompleted" BOOLEAN NOT NULL DEFAULT false,
    "isBlocked" BOOLEAN NOT NULL DEFAULT false,
    "blockedReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "rooms_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "room_claim_state_events" (
    "id" TEXT NOT NULL,
    "roomId" TEXT NOT NULL,
    "entryId" TEXT,
    "fromState" "InventoryClaimState" NOT NULL,
    "toState" "InventoryClaimState" NOT NULL,
    "actorId" TEXT NOT NULL,
    "reason" TEXT,
    "effectiveFrom" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "effectiveTo" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "room_claim_state_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "deficient_condition_records" (
    "id" TEXT NOT NULL,
    "roomId" TEXT NOT NULL,
    "category" "DeficientConditionCategory" NOT NULL,
    "description" TEXT NOT NULL,
    "detectedAt" TIMESTAMP(3) NOT NULL,
    "detectedBy" TEXT NOT NULL,
    "resolutionDeadline" TIMESTAMP(3) NOT NULL,
    "resolvedAt" TIMESTAMP(3),
    "resolvedBy" TEXT,
    "resolutionNotes" TEXT,
    "status" TEXT NOT NULL DEFAULT 'UNRESOLVED',

    CONSTRAINT "deficient_condition_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "quotations" (
    "id" TEXT NOT NULL,
    "entryId" TEXT NOT NULL,
    "segmentId" TEXT NOT NULL,
    "versionNumber" INTEGER NOT NULL DEFAULT 1,
    "referenceNumber" TEXT NOT NULL,
    "state" "QuotationState" NOT NULL DEFAULT 'DRAFT',
    "commercialTerms" JSONB NOT NULL,
    "totalAmount" DECIMAL(15,2) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'BTN',
    "validUntil" TIMESTAMP(3),
    "sentAt" TIMESTAMP(3),
    "sentTo" TEXT,
    "communicationRecordId" TEXT,
    "supersededById" TEXT,
    "supersededAt" TIMESTAMP(3),
    "expiredAt" TIMESTAMP(3),
    "acceptedAt" TIMESTAMP(3),
    "acceptedBy" TEXT,
    "folioId" TEXT,
    "sealedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT NOT NULL,

    CONSTRAINT "quotations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "speculative_holds" (
    "id" TEXT NOT NULL,
    "entryId" TEXT NOT NULL,
    "segmentId" TEXT NOT NULL,
    "roomId" TEXT,
    "spaceId" TEXT,
    "state" "HoldState" NOT NULL DEFAULT 'PLACED',
    "placedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "placedBy" TEXT NOT NULL,
    "ttlSeconds" INTEGER NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "releasedAt" TIMESTAMP(3),
    "releasedBy" TEXT,
    "releaseReason" TEXT,
    "upgradedToId" TEXT,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "speculative_holds_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "committed_holds" (
    "id" TEXT NOT NULL,
    "entryId" TEXT NOT NULL,
    "segmentId" TEXT NOT NULL,
    "roomId" TEXT,
    "spaceId" TEXT,
    "roomTypeId" TEXT NOT NULL,
    "state" "HoldState" NOT NULL DEFAULT 'PLACED',
    "placedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "placedBy" TEXT NOT NULL,
    "confirmedAt" TIMESTAMP(3),
    "confirmedBy" TEXT,
    "releasedAt" TIMESTAMP(3),
    "releasedBy" TEXT,
    "releaseReason" TEXT,
    "commercialJustification" TEXT NOT NULL DEFAULT 'seed',
    "ttlSeconds" INTEGER NOT NULL DEFAULT 86400,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "committed_holds_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reservations" (
    "id" TEXT NOT NULL,
    "entryId" TEXT NOT NULL,
    "segmentId" TEXT NOT NULL,
    "frozenRate" DECIMAL(15,2) NOT NULL,
    "frozenRatePlanId" TEXT NOT NULL,
    "frozenInclusions" JSONB NOT NULL DEFAULT '{}',
    "frozenCancellationTerms" JSONB NOT NULL DEFAULT '{}',
    "frozenBillingModel" TEXT NOT NULL,
    "frozenCheckInDate" TIMESTAMP(3) NOT NULL,
    "frozenCheckOutDate" TIMESTAMP(3) NOT NULL,
    "frozenGuestCount" INTEGER NOT NULL,
    "creditCeilingIfExtended" DECIMAL(15,2),
    "confirmedAt" TIMESTAMP(3) NOT NULL,
    "confirmedBy" TEXT NOT NULL,
    "confirmationVoucherSent" BOOLEAN NOT NULL DEFAULT false,
    "sealedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "reservations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cancellation_disclosure_records" (
    "id" TEXT NOT NULL,
    "entryId" TEXT NOT NULL,
    "segmentId" TEXT NOT NULL,
    "noShowTreatmentStatement" TEXT NOT NULL,
    "disclosedTerms" JSONB NOT NULL DEFAULT '{}',
    "disclosedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "disclosedBy" TEXT NOT NULL DEFAULT 'actor-seed-system',

    CONSTRAINT "cancellation_disclosure_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "billing_model_transition_records" (
    "id" TEXT NOT NULL,
    "folioId" TEXT NOT NULL,
    "segmentId" TEXT NOT NULL,
    "fromModel" TEXT,
    "toModel" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT NOT NULL,

    CONSTRAINT "billing_model_transition_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "folios" (
    "id" TEXT NOT NULL,
    "entryId" TEXT NOT NULL,
    "state" "FolioState" NOT NULL DEFAULT 'PROVISIONAL',
    "billingModel" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT NOT NULL,
    "convertedToLiveAt" TIMESTAMP(3),
    "convertedBy" TEXT,
    "closedAt" TIMESTAMP(3),
    "closedBy" TEXT,
    "noShowPenaltyAmount" DECIMAL(15,2),
    "noShowAdvancePaymentAmount" DECIMAL(15,2),
    "noShowNetPosition" DECIMAL(15,2),
    "noShowFomDetermination" TEXT,
    "outstandingBalance" DECIMAL(15,2) NOT NULL DEFAULT 0,
    "advancePaymentReconciliationComplete" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "folios_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invoices" (
    "id" TEXT NOT NULL,
    "folioId" TEXT NOT NULL,
    "entryId" TEXT NOT NULL,
    "invoiceType" "InvoiceType" NOT NULL,
    "state" "InvoiceState" NOT NULL DEFAULT 'DRAFT',
    "invoiceNumber" TEXT,
    "totalAmount" DECIMAL(15,2),
    "templateKey" TEXT,
    "issuedAt" TIMESTAMP(3),
    "issuedBy" TEXT,
    "dispatchedAt" TIMESTAMP(3),
    "dispatchedBy" TEXT,
    "dispatchedTo" TEXT,
    "supersededById" TEXT,
    "versionNumber" INTEGER NOT NULL DEFAULT 1,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "invoices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "folio_lines" (
    "id" TEXT NOT NULL,
    "folioId" TEXT NOT NULL,
    "lineType" "FolioLineType" NOT NULL,
    "description" TEXT NOT NULL,
    "amount" DECIMAL(15,2) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'BTN',
    "chargeDate" TIMESTAMP(3) NOT NULL,
    "stage" "Stage" NOT NULL,
    "postedBy" TEXT NOT NULL,
    "nightAuditRecordId" TEXT,
    "isPostStay" BOOLEAN NOT NULL DEFAULT false,
    "postedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "folio_lines_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "write_off_records" (
    "id" TEXT NOT NULL,
    "folioId" TEXT NOT NULL,
    "entryId" TEXT NOT NULL,
    "writtenOffAmount" DECIMAL(15,2) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'BTN',
    "reason" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT NOT NULL,

    CONSTRAINT "write_off_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "payment_records" (
    "id" TEXT NOT NULL,
    "folioId" TEXT NOT NULL,
    "invoiceId" TEXT,
    "entryId" TEXT,
    "amount" DECIMAL(15,2) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'BTN',
    "foreignCurrencyAmount" DECIMAL(15,2),
    "btnEquivalent" DECIMAL(15,2),
    "exchangeRate" DECIMAL(10,6),
    "paymentMethod" TEXT DEFAULT 'CASH',
    "paymentDirection" "PaymentDirection" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "receivedAt" TIMESTAMP(3),
    "recordedBy" TEXT,
    "stage" "Stage",
    "notes" TEXT,

    CONSTRAINT "payment_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "credit_extension_ceiling_records" (
    "id" TEXT NOT NULL,
    "folioId" TEXT NOT NULL,
    "entryId" TEXT NOT NULL,
    "ceilingAmount" DECIMAL(15,2) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'BTN',
    "approvedBy" TEXT NOT NULL,
    "approvedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reason" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "credit_extension_ceiling_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "handoff_records" (
    "id" TEXT NOT NULL,
    "entryId" TEXT NOT NULL,
    "handoffType" "HandoffType" NOT NULL,
    "state" "HandoffState" NOT NULL DEFAULT 'CREATED',
    "fromRole" TEXT NOT NULL,
    "fromActorId" TEXT NOT NULL,
    "toRole" TEXT NOT NULL,
    "toActorId" TEXT,
    "checklistContent" JSONB NOT NULL DEFAULT '{}',
    "deficientConditionStatus" TEXT,
    "fulfilmentEvidence" JSONB,
    "assignedAt" TIMESTAMP(3),
    "acceptedAt" TIMESTAMP(3),
    "acceptedBy" TEXT,
    "fulfilledAt" TIMESTAMP(3),
    "fulfilledBy" TEXT,
    "closedAt" TIMESTAMP(3),
    "rejectedAt" TIMESTAMP(3),
    "rejectedBy" TEXT,
    "rejectionReason" TEXT,
    "escalatedAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "cancelledBy" TEXT,
    "cancelledReason" TEXT,
    "slaDeadlineAt" TIMESTAMP(3),
    "isAutoFulfilled" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT NOT NULL,
    "stageContext" "Stage" NOT NULL,

    CONSTRAINT "handoff_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pre_arrival_tasks" (
    "id" TEXT NOT NULL,
    "entryId" TEXT NOT NULL,
    "taskType" "PreArrivalTaskType" NOT NULL,
    "category" "TaskCategory" NOT NULL DEFAULT 'ADMINISTRATIVE',
    "targetDate" TIMESTAMP(3),
    "status" "TaskStatus" NOT NULL DEFAULT 'PENDING',
    "assignedTo" TEXT,
    "assignedDepartment" TEXT,
    "completedAt" TIMESTAMP(3),
    "completedBy" TEXT,
    "waivedReason" TEXT,
    "waivedBy" TEXT,
    "sourceRecordType" TEXT,
    "sourceRecordId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT NOT NULL,

    CONSTRAINT "pre_arrival_tasks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "room_assignments" (
    "id" TEXT NOT NULL,
    "entryId" TEXT NOT NULL,
    "roomId" TEXT NOT NULL,
    "assignedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "assignedBy" TEXT NOT NULL,
    "deficientAtAssignment" BOOLEAN NOT NULL DEFAULT false,
    "deficientConditionRecordId" TEXT,
    "acknowledgementActorId" TEXT,
    "acknowledgementAt" TIMESTAMP(3),
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "room_assignments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "no_show_determination_records" (
    "id" TEXT NOT NULL,
    "entryId" TEXT NOT NULL,
    "determinationPath" TEXT NOT NULL,
    "fomActorId" TEXT NOT NULL,
    "contactAttemptLog" JSONB NOT NULL,
    "decisionReason" TEXT NOT NULL,
    "otaNotificationRequired" BOOLEAN NOT NULL DEFAULT false,
    "otaNotificationStatus" TEXT,
    "determinedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT NOT NULL,

    CONSTRAINT "no_show_determination_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "room_inspection_records" (
    "id" TEXT NOT NULL,
    "entryId" TEXT NOT NULL,
    "roomId" TEXT NOT NULL,
    "segmentId" TEXT NOT NULL,
    "inspectedBy" TEXT NOT NULL,
    "inspectedAt" TIMESTAMP(3) NOT NULL,
    "isDeferred" BOOLEAN NOT NULL DEFAULT false,
    "deficientFlagStatus" TEXT NOT NULL,
    "deficientConditionId" TEXT,
    "inspectorAssessment" TEXT,
    "damageFound" BOOLEAN NOT NULL DEFAULT false,
    "damageNotes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "room_inspection_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "key_return_records" (
    "id" TEXT NOT NULL,
    "entryId" TEXT NOT NULL,
    "roomId" TEXT NOT NULL,
    "receivedBy" TEXT NOT NULL,
    "returnedAt" TIMESTAMP(3) NOT NULL,
    "keyCountIssued" INTEGER NOT NULL,
    "keyCountReturned" INTEGER NOT NULL,
    "countReconciled" BOOLEAN NOT NULL,
    "reconciliationNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "key_return_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "timer_records" (
    "id" TEXT NOT NULL,
    "entryId" TEXT,
    "entityType" TEXT NOT NULL DEFAULT 'Entry',
    "entityId" TEXT NOT NULL DEFAULT '',
    "timerType" TEXT NOT NULL,
    "timerCode" TEXT NOT NULL DEFAULT '',
    "stageContext" "Stage",
    "firesAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "dueAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "warningAt" TIMESTAMP(3),
    "criticalAt" TIMESTAMP(3),
    "status" "TimerStatus" NOT NULL DEFAULT 'SCHEDULED',
    "payload" JSONB,
    "pgBossJobId" TEXT,
    "cancelledAt" TIMESTAMP(3),
    "cancelledBy" TEXT,
    "cancelledReason" TEXT,
    "firedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT NOT NULL,

    CONSTRAINT "timer_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stage_dwell_records" (
    "id" TEXT NOT NULL,
    "entryId" TEXT NOT NULL,
    "stage" "Stage" NOT NULL,
    "enteredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastActiveAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "exitedAt" TIMESTAMP(3),
    "dwellSeconds" INTEGER,
    "mode" "StageDwellMode" NOT NULL DEFAULT 'ACTIVE',
    "warningFiredAt" TIMESTAMP(3),
    "criticalFiredAt" TIMESTAMP(3),
    "escalatedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "stage_dwell_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "credit_ceiling_threshold_events" (
    "id" TEXT NOT NULL,
    "entryId" TEXT NOT NULL,
    "folioId" TEXT NOT NULL,
    "ceilingAmount" DECIMAL(15,2) NOT NULL,
    "outstandingBalance" DECIMAL(15,2) NOT NULL,
    "thresholdPercent" INTEGER NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT NOT NULL,

    CONSTRAINT "credit_ceiling_threshold_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "night_audit_records" (
    "id" TEXT NOT NULL,
    "operatingDate" TIMESTAMP(3) NOT NULL,
    "runStatus" "NightAuditRunStatus" NOT NULL,
    "entriesProcessedCount" INTEGER NOT NULL DEFAULT 0,
    "entriesNotProcessed" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT NOT NULL,

    CONSTRAINT "night_audit_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "night_audit_anomalies" (
    "id" TEXT NOT NULL,
    "nightAuditRecordId" TEXT NOT NULL,
    "entryId" TEXT,
    "anomalyType" "NightAuditAnomalyType" NOT NULL,
    "description" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),
    "resolvedBy" TEXT,

    CONSTRAINT "night_audit_anomalies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "work_orders" (
    "id" TEXT NOT NULL,
    "entryId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT NOT NULL,

    CONSTRAINT "work_orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "work_order_todo_items" (
    "id" TEXT NOT NULL,
    "workOrderId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "status" "WorkOrderToDoStatus" NOT NULL DEFAULT 'PENDING',
    "dueAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedBy" TEXT,
    "cancelReason" TEXT,

    CONSTRAINT "work_order_todo_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "work_order_consumption_records" (
    "id" TEXT NOT NULL,
    "workOrderId" TEXT NOT NULL,
    "itemCode" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "notes" TEXT,
    "isOverAllocation" BOOLEAN NOT NULL DEFAULT false,
    "overAllocationAcknowledgedBy" TEXT,
    "overAllocationAcknowledgedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT NOT NULL,

    CONSTRAINT "work_order_consumption_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "work_order_amendment_events" (
    "id" TEXT NOT NULL,
    "workOrderId" TEXT NOT NULL,
    "amendmentType" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "payload" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT NOT NULL,

    CONSTRAINT "work_order_amendment_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "dispute_records" (
    "id" TEXT NOT NULL,
    "entryId" TEXT NOT NULL,
    "folioId" TEXT NOT NULL,
    "status" "DisputeStatus" NOT NULL DEFAULT 'OPEN',
    "title" TEXT NOT NULL,
    "description" TEXT,
    "openedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "openedBy" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "updatedBy" TEXT,
    "closedAt" TIMESTAMP(3),
    "closedBy" TEXT,
    "closureReason" TEXT,

    CONSTRAINT "dispute_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "dispute_gate_override_records" (
    "id" TEXT NOT NULL,
    "disputeId" TEXT NOT NULL,
    "targetStage" "Stage" NOT NULL,
    "freeTextReason" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT NOT NULL,

    CONSTRAINT "dispute_gate_override_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "amendment_event_records" (
    "id" TEXT NOT NULL,
    "entryId" TEXT NOT NULL,
    "segmentId" TEXT NOT NULL,
    "amendmentPath" "AmendmentPath" NOT NULL,
    "amendmentType" TEXT NOT NULL,
    "requestedBy" TEXT NOT NULL,
    "authorisedBy" TEXT NOT NULL,
    "authorityBasis" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "priorTermsRef" TEXT,
    "newTermsSummary" TEXT NOT NULL,
    "folioLineId" TEXT,
    "stageAtAmendment" "Stage" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "amendment_event_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "follow_up_task_records" (
    "id" TEXT NOT NULL,
    "entryId" TEXT NOT NULL,
    "status" "FollowUpTaskStatus" NOT NULL DEFAULT 'PENDING',
    "assignedTo" TEXT,
    "dueAt" TIMESTAMP(3) NOT NULL,
    "completedAt" TIMESTAMP(3),
    "completedBy" TEXT,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT NOT NULL,

    CONSTRAINT "follow_up_task_records_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "communication_records" (
    "id" TEXT NOT NULL,
    "entryId" TEXT NOT NULL,
    "channel" "CommunicationChannel" NOT NULL,
    "commType" "CommunicationType" NOT NULL,
    "stageContext" "Stage",
    "direction" TEXT DEFAULT 'OUTBOUND',
    "messageId" TEXT,
    "sendStatus" TEXT DEFAULT 'PENDING',
    "acknowledgementStatus" TEXT DEFAULT 'PENDING',
    "acknowledgementReceivedAt" TIMESTAMP(3),
    "acknowledgementTimeoutAt" TIMESTAMP(3),
    "threadId" TEXT,
    "inReplyToId" TEXT,
    "contentSummary" TEXT,
    "actorId" TEXT,
    "payload" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT NOT NULL,

    CONSTRAINT "communication_records_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ota_conflict_overbooking_records_entryId_key" ON "ota_conflict_overbooking_records"("entryId");

-- CreateIndex
CREATE INDEX "configuration_entries_configKey_effectiveFrom_idx" ON "configuration_entries"("configKey", "effectiveFrom");

-- CreateIndex
CREATE UNIQUE INDEX "staff_users_email_key" ON "staff_users"("email");

-- CreateIndex
CREATE INDEX "session_records_userId_status_idx" ON "session_records"("userId", "status");

-- CreateIndex
CREATE INDEX "session_event_records_sessionId_eventType_idx" ON "session_event_records"("sessionId", "eventType");

-- CreateIndex
CREATE UNIQUE INDEX "inquiries_referenceNumber_key" ON "inquiries"("referenceNumber");

-- CreateIndex
CREATE INDEX "inquiries_guestProfileId_idx" ON "inquiries"("guestProfileId");

-- CreateIndex
CREATE INDEX "duplicate_detection_flags_inquiryId_status_idx" ON "duplicate_detection_flags"("inquiryId", "status");

-- CreateIndex
CREATE INDEX "entries_inquiryId_idx" ON "entries"("inquiryId");

-- CreateIndex
CREATE INDEX "entries_currentStage_status_idx" ON "entries"("currentStage", "status");

-- CreateIndex
CREATE INDEX "commission_due_records_entryId_idx" ON "commission_due_records"("entryId");

-- CreateIndex
CREATE INDEX "commission_due_records_agentProfileId_idx" ON "commission_due_records"("agentProfileId");

-- CreateIndex
CREATE INDEX "equipment_allocations_entryId_idx" ON "equipment_allocations"("entryId");

-- CreateIndex
CREATE UNIQUE INDEX "segments_entryId_segmentNumber_key" ON "segments"("entryId", "segmentNumber");

-- CreateIndex
CREATE INDEX "availability_configurations_entryId_segmentId_idx" ON "availability_configurations"("entryId", "segmentId");

-- CreateIndex
CREATE INDEX "processing_lock_records_inventoryReference_status_idx" ON "processing_lock_records"("inventoryReference", "status");

-- CreateIndex
CREATE INDEX "processing_lock_records_status_expiresAt_idx" ON "processing_lock_records"("status", "expiresAt");

-- CreateIndex
CREATE INDEX "trace_events_entityType_entityId_idx" ON "trace_events"("entityType", "entityId");

-- CreateIndex
CREATE INDEX "trace_events_correlationId_idx" ON "trace_events"("correlationId");

-- CreateIndex
CREATE INDEX "trace_events_actorId_idx" ON "trace_events"("actorId");

-- CreateIndex
CREATE INDEX "trace_events_timestamp_idx" ON "trace_events"("timestamp");

-- CreateIndex
CREATE INDEX "trace_events_inquiryId_idx" ON "trace_events"("inquiryId");

-- CreateIndex
CREATE INDEX "trace_events_entryId_eventType_idx" ON "trace_events"("entryId", "eventType");

-- CreateIndex
CREATE UNIQUE INDEX "spaces_code_key" ON "spaces"("code");

-- CreateIndex
CREATE INDEX "space_allocations_spaceId_state_idx" ON "space_allocations"("spaceId", "state");

-- CreateIndex
CREATE UNIQUE INDEX "room_types_code_key" ON "room_types"("code");

-- CreateIndex
CREATE UNIQUE INDEX "rooms_roomNumber_key" ON "rooms"("roomNumber");

-- CreateIndex
CREATE INDEX "quotations_entryId_segmentId_state_idx" ON "quotations"("entryId", "segmentId", "state");

-- CreateIndex
CREATE INDEX "speculative_holds_entryId_segmentId_state_idx" ON "speculative_holds"("entryId", "segmentId", "state");

-- CreateIndex
CREATE UNIQUE INDEX "committed_holds_entryId_key" ON "committed_holds"("entryId");

-- CreateIndex
CREATE UNIQUE INDEX "reservations_entryId_key" ON "reservations"("entryId");

-- CreateIndex
CREATE UNIQUE INDEX "cancellation_disclosure_records_entryId_key" ON "cancellation_disclosure_records"("entryId");

-- CreateIndex
CREATE INDEX "billing_model_transition_records_folioId_segmentId_idx" ON "billing_model_transition_records"("folioId", "segmentId");

-- CreateIndex
CREATE UNIQUE INDEX "folios_entryId_key" ON "folios"("entryId");

-- CreateIndex
CREATE UNIQUE INDEX "invoices_invoiceNumber_key" ON "invoices"("invoiceNumber");

-- CreateIndex
CREATE UNIQUE INDEX "credit_extension_ceiling_records_folioId_key" ON "credit_extension_ceiling_records"("folioId");

-- CreateIndex
CREATE UNIQUE INDEX "no_show_determination_records_entryId_key" ON "no_show_determination_records"("entryId");

-- CreateIndex
CREATE INDEX "timer_records_timerType_status_firesAt_idx" ON "timer_records"("timerType", "status", "firesAt");

-- CreateIndex
CREATE INDEX "timer_records_timerCode_status_dueAt_idx" ON "timer_records"("timerCode", "status", "dueAt");

-- CreateIndex
CREATE INDEX "timer_records_entityType_entityId_idx" ON "timer_records"("entityType", "entityId");

-- CreateIndex
CREATE INDEX "stage_dwell_records_entryId_stage_idx" ON "stage_dwell_records"("entryId", "stage");

-- CreateIndex
CREATE UNIQUE INDEX "night_audit_records_operatingDate_key" ON "night_audit_records"("operatingDate");

-- CreateIndex
CREATE UNIQUE INDEX "communication_records_messageId_key" ON "communication_records"("messageId");

-- CreateIndex
CREATE INDEX "communication_records_entryId_commType_channel_idx" ON "communication_records"("entryId", "commType", "channel");

-- AddForeignKey
ALTER TABLE "session_records" ADD CONSTRAINT "session_records_userId_fkey" FOREIGN KEY ("userId") REFERENCES "staff_users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "session_event_records" ADD CONSTRAINT "session_event_records_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "session_records"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "guest_identity_documents" ADD CONSTRAINT "guest_identity_documents_guestProfileId_fkey" FOREIGN KEY ("guestProfileId") REFERENCES "guest_profiles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vip_arrival_notification_events" ADD CONSTRAINT "vip_arrival_notification_events_entryId_fkey" FOREIGN KEY ("entryId") REFERENCES "entries"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vip_arrival_notification_events" ADD CONSTRAINT "vip_arrival_notification_events_guestProfileId_fkey" FOREIGN KEY ("guestProfileId") REFERENCES "guest_profiles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inquiries" ADD CONSTRAINT "inquiries_guestProfileId_fkey" FOREIGN KEY ("guestProfileId") REFERENCES "guest_profiles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inquiries" ADD CONSTRAINT "inquiries_agentProfileId_fkey" FOREIGN KEY ("agentProfileId") REFERENCES "agent_profiles"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "duplicate_detection_flags" ADD CONSTRAINT "duplicate_detection_flags_inquiryId_fkey" FOREIGN KEY ("inquiryId") REFERENCES "inquiries"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "entries" ADD CONSTRAINT "entries_inquiryId_fkey" FOREIGN KEY ("inquiryId") REFERENCES "inquiries"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "entries" ADD CONSTRAINT "entries_guestProfileId_fkey" FOREIGN KEY ("guestProfileId") REFERENCES "guest_profiles"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "commission_due_records" ADD CONSTRAINT "commission_due_records_entryId_fkey" FOREIGN KEY ("entryId") REFERENCES "entries"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "commission_due_records" ADD CONSTRAINT "commission_due_records_agentProfileId_fkey" FOREIGN KEY ("agentProfileId") REFERENCES "agent_profiles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "equipment_allocations" ADD CONSTRAINT "equipment_allocations_entryId_fkey" FOREIGN KEY ("entryId") REFERENCES "entries"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "segments" ADD CONSTRAINT "segments_entryId_fkey" FOREIGN KEY ("entryId") REFERENCES "entries"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "availability_configurations" ADD CONSTRAINT "availability_configurations_entryId_fkey" FOREIGN KEY ("entryId") REFERENCES "entries"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "processing_lock_records" ADD CONSTRAINT "processing_lock_records_entryId_fkey" FOREIGN KEY ("entryId") REFERENCES "entries"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "revalidation_delta_records" ADD CONSTRAINT "revalidation_delta_records_processingLockId_fkey" FOREIGN KEY ("processingLockId") REFERENCES "processing_lock_records"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "trace_events" ADD CONSTRAINT "trace_events_entryId_fkey" FOREIGN KEY ("entryId") REFERENCES "entries"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "space_allocations" ADD CONSTRAINT "space_allocations_spaceId_fkey" FOREIGN KEY ("spaceId") REFERENCES "spaces"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "space_allocations" ADD CONSTRAINT "space_allocations_entryId_fkey" FOREIGN KEY ("entryId") REFERENCES "entries"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rooms" ADD CONSTRAINT "rooms_roomTypeId_fkey" FOREIGN KEY ("roomTypeId") REFERENCES "room_types"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "room_claim_state_events" ADD CONSTRAINT "room_claim_state_events_roomId_fkey" FOREIGN KEY ("roomId") REFERENCES "rooms"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "deficient_condition_records" ADD CONSTRAINT "deficient_condition_records_roomId_fkey" FOREIGN KEY ("roomId") REFERENCES "rooms"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quotations" ADD CONSTRAINT "quotations_entryId_fkey" FOREIGN KEY ("entryId") REFERENCES "entries"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quotations" ADD CONSTRAINT "quotations_segmentId_fkey" FOREIGN KEY ("segmentId") REFERENCES "segments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "speculative_holds" ADD CONSTRAINT "speculative_holds_entryId_fkey" FOREIGN KEY ("entryId") REFERENCES "entries"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "speculative_holds" ADD CONSTRAINT "speculative_holds_segmentId_fkey" FOREIGN KEY ("segmentId") REFERENCES "segments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "speculative_holds" ADD CONSTRAINT "speculative_holds_roomId_fkey" FOREIGN KEY ("roomId") REFERENCES "rooms"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "speculative_holds" ADD CONSTRAINT "speculative_holds_spaceId_fkey" FOREIGN KEY ("spaceId") REFERENCES "spaces"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "committed_holds" ADD CONSTRAINT "committed_holds_entryId_fkey" FOREIGN KEY ("entryId") REFERENCES "entries"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "committed_holds" ADD CONSTRAINT "committed_holds_roomTypeId_fkey" FOREIGN KEY ("roomTypeId") REFERENCES "room_types"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reservations" ADD CONSTRAINT "reservations_entryId_fkey" FOREIGN KEY ("entryId") REFERENCES "entries"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cancellation_disclosure_records" ADD CONSTRAINT "cancellation_disclosure_records_entryId_fkey" FOREIGN KEY ("entryId") REFERENCES "entries"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing_model_transition_records" ADD CONSTRAINT "billing_model_transition_records_folioId_fkey" FOREIGN KEY ("folioId") REFERENCES "folios"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing_model_transition_records" ADD CONSTRAINT "billing_model_transition_records_segmentId_fkey" FOREIGN KEY ("segmentId") REFERENCES "segments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "folios" ADD CONSTRAINT "folios_entryId_fkey" FOREIGN KEY ("entryId") REFERENCES "entries"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_folioId_fkey" FOREIGN KEY ("folioId") REFERENCES "folios"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_entryId_fkey" FOREIGN KEY ("entryId") REFERENCES "entries"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "folio_lines" ADD CONSTRAINT "folio_lines_folioId_fkey" FOREIGN KEY ("folioId") REFERENCES "folios"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "folio_lines" ADD CONSTRAINT "folio_lines_nightAuditRecordId_fkey" FOREIGN KEY ("nightAuditRecordId") REFERENCES "night_audit_records"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "write_off_records" ADD CONSTRAINT "write_off_records_folioId_fkey" FOREIGN KEY ("folioId") REFERENCES "folios"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "write_off_records" ADD CONSTRAINT "write_off_records_entryId_fkey" FOREIGN KEY ("entryId") REFERENCES "entries"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payment_records" ADD CONSTRAINT "payment_records_folioId_fkey" FOREIGN KEY ("folioId") REFERENCES "folios"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "handoff_records" ADD CONSTRAINT "handoff_records_entryId_fkey" FOREIGN KEY ("entryId") REFERENCES "entries"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pre_arrival_tasks" ADD CONSTRAINT "pre_arrival_tasks_entryId_fkey" FOREIGN KEY ("entryId") REFERENCES "entries"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "room_assignments" ADD CONSTRAINT "room_assignments_entryId_fkey" FOREIGN KEY ("entryId") REFERENCES "entries"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "room_assignments" ADD CONSTRAINT "room_assignments_roomId_fkey" FOREIGN KEY ("roomId") REFERENCES "rooms"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "no_show_determination_records" ADD CONSTRAINT "no_show_determination_records_entryId_fkey" FOREIGN KEY ("entryId") REFERENCES "entries"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "room_inspection_records" ADD CONSTRAINT "room_inspection_records_entryId_fkey" FOREIGN KEY ("entryId") REFERENCES "entries"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "room_inspection_records" ADD CONSTRAINT "room_inspection_records_roomId_fkey" FOREIGN KEY ("roomId") REFERENCES "rooms"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "key_return_records" ADD CONSTRAINT "key_return_records_entryId_fkey" FOREIGN KEY ("entryId") REFERENCES "entries"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "key_return_records" ADD CONSTRAINT "key_return_records_roomId_fkey" FOREIGN KEY ("roomId") REFERENCES "rooms"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "timer_records" ADD CONSTRAINT "timer_records_entryId_fkey" FOREIGN KEY ("entryId") REFERENCES "entries"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stage_dwell_records" ADD CONSTRAINT "stage_dwell_records_entryId_fkey" FOREIGN KEY ("entryId") REFERENCES "entries"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "night_audit_anomalies" ADD CONSTRAINT "night_audit_anomalies_nightAuditRecordId_fkey" FOREIGN KEY ("nightAuditRecordId") REFERENCES "night_audit_records"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "work_order_todo_items" ADD CONSTRAINT "work_order_todo_items_workOrderId_fkey" FOREIGN KEY ("workOrderId") REFERENCES "work_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "work_order_consumption_records" ADD CONSTRAINT "work_order_consumption_records_workOrderId_fkey" FOREIGN KEY ("workOrderId") REFERENCES "work_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "work_order_amendment_events" ADD CONSTRAINT "work_order_amendment_events_workOrderId_fkey" FOREIGN KEY ("workOrderId") REFERENCES "work_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dispute_records" ADD CONSTRAINT "dispute_records_entryId_fkey" FOREIGN KEY ("entryId") REFERENCES "entries"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dispute_records" ADD CONSTRAINT "dispute_records_folioId_fkey" FOREIGN KEY ("folioId") REFERENCES "folios"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "dispute_gate_override_records" ADD CONSTRAINT "dispute_gate_override_records_disputeId_fkey" FOREIGN KEY ("disputeId") REFERENCES "dispute_records"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "amendment_event_records" ADD CONSTRAINT "amendment_event_records_entryId_fkey" FOREIGN KEY ("entryId") REFERENCES "entries"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "amendment_event_records" ADD CONSTRAINT "amendment_event_records_segmentId_fkey" FOREIGN KEY ("segmentId") REFERENCES "segments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "follow_up_task_records" ADD CONSTRAINT "follow_up_task_records_entryId_fkey" FOREIGN KEY ("entryId") REFERENCES "entries"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "communication_records" ADD CONSTRAINT "communication_records_entryId_fkey" FOREIGN KEY ("entryId") REFERENCES "entries"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
