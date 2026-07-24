-- AI draft management + communication nullable entry + admin console (ACIG v1.1)

-- CommunicationType: PRE_ARRIVAL_REMINDER
ALTER TYPE "CommunicationType" ADD VALUE 'PRE_ARRIVAL_REMINDER';

-- communication_records.entryId optional (inquiry-level comms)
ALTER TABLE "communication_records" DROP CONSTRAINT IF EXISTS "communication_records_entryId_fkey";
ALTER TABLE "communication_records" ALTER COLUMN "entryId" DROP NOT NULL;
ALTER TABLE "communication_records" ADD CONSTRAINT "communication_records_entryId_fkey"
  FOREIGN KEY ("entryId") REFERENCES "entries"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Enums
CREATE TYPE "AiDraftStatus" AS ENUM ('PENDING_REVIEW', 'APPROVED', 'REJECTED', 'EXPIRED');
CREATE TYPE "HumanDecisionType" AS ENUM ('APPROVE', 'REJECT', 'ESCALATE');
CREATE TYPE "ModeLifecycleState" AS ENUM ('DRAFT', 'VALIDATED', 'ACTIVE', 'SUPERSEDED');

-- AI draft tables
CREATE TABLE "ai_draft_records" (
    "id" TEXT NOT NULL,
    "communicationId" TEXT NOT NULL,
    "intentCategory" TEXT NOT NULL,
    "confidenceScore" DOUBLE PRECISION NOT NULL,
    "draftContent" TEXT NOT NULL,
    "status" "AiDraftStatus" NOT NULL DEFAULT 'PENDING_REVIEW',
    "reviewTtlExpiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT NOT NULL,
    CONSTRAINT "ai_draft_records_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "human_decision_records" (
    "id" TEXT NOT NULL,
    "aiDraftId" TEXT,
    "communicationId" TEXT,
    "decisionType" "HumanDecisionType" NOT NULL,
    "decisionReason" TEXT,
    "decidedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decidedBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT NOT NULL,
    CONSTRAINT "human_decision_records_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ai_draft_records_communicationId_idx" ON "ai_draft_records"("communicationId");
CREATE INDEX "ai_draft_records_status_reviewTtlExpiresAt_idx" ON "ai_draft_records"("status", "reviewTtlExpiresAt");
CREATE INDEX "human_decision_records_aiDraftId_idx" ON "human_decision_records"("aiDraftId");
CREATE INDEX "human_decision_records_communicationId_idx" ON "human_decision_records"("communicationId");

ALTER TABLE "ai_draft_records" ADD CONSTRAINT "ai_draft_records_communicationId_fkey"
  FOREIGN KEY ("communicationId") REFERENCES "communication_records"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "human_decision_records" ADD CONSTRAINT "human_decision_records_aiDraftId_fkey"
  FOREIGN KEY ("aiDraftId") REFERENCES "ai_draft_records"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "human_decision_records" ADD CONSTRAINT "human_decision_records_communicationId_fkey"
  FOREIGN KEY ("communicationId") REFERENCES "communication_records"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Admin console tables
CREATE TABLE "hotel_profile" (
    "id" TEXT NOT NULL,
    "hotelName" TEXT NOT NULL,
    "registeredAddress" TEXT NOT NULL,
    "tradingAddress" TEXT,
    "contactNumbers" JSONB NOT NULL,
    "primaryEmail" TEXT NOT NULL,
    "operatingHours" JSONB NOT NULL,
    "publicHolidaySchedule" JSONB NOT NULL,
    "timeZone" TEXT NOT NULL,
    "propertyCurrency" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdBy" TEXT NOT NULL,
    CONSTRAINT "hotel_profile_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "departments" (
    "id" TEXT NOT NULL,
    "departmentCode" TEXT NOT NULL,
    "departmentName" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdBy" TEXT NOT NULL,
    CONSTRAINT "departments_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "departments_departmentCode_key" ON "departments"("departmentCode");

CREATE TABLE "roles" (
    "id" TEXT NOT NULL,
    "roleCode" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "actorLevel" "ActorLevel" NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdBy" TEXT NOT NULL,
    CONSTRAINT "roles_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "roles_roleCode_key" ON "roles"("roleCode");

CREATE TABLE "role_permission_mappings" (
    "id" TEXT NOT NULL,
    "roleId" TEXT NOT NULL,
    "permissionId" TEXT NOT NULL,
    "isAllowed" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdBy" TEXT NOT NULL,
    CONSTRAINT "role_permission_mappings_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "role_permission_mappings_roleId_permissionId_key" ON "role_permission_mappings"("roleId", "permissionId");

CREATE TABLE "role_session_configs" (
    "id" TEXT NOT NULL,
    "roleId" TEXT NOT NULL,
    "idleLockTimeoutSeconds" INTEGER NOT NULL,
    "hardLogoutTimeoutSeconds" INTEGER NOT NULL,
    "manualLockAvailable" BOOLEAN NOT NULL DEFAULT true,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdBy" TEXT NOT NULL,
    CONSTRAINT "role_session_configs_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "role_session_configs_roleId_key" ON "role_session_configs"("roleId");

CREATE TABLE "policy_registry" (
    "id" TEXT NOT NULL,
    "policyId" TEXT NOT NULL,
    "policyClass" TEXT NOT NULL,
    "policyDefinition" JSONB NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "effectiveFrom" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "policy_registry_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "policy_registry_policyId_version_key" ON "policy_registry"("policyId", "version");

CREATE TABLE "mode_configurations" (
    "id" TEXT NOT NULL,
    "modeKey" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "description" TEXT,
    "lifecycleState" "ModeLifecycleState" NOT NULL DEFAULT 'DRAFT',
    "isActive" BOOLEAN NOT NULL DEFAULT false,
    "isPredefined" BOOLEAN NOT NULL DEFAULT false,
    "config" JSONB NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdBy" TEXT NOT NULL,
    CONSTRAINT "mode_configurations_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "mode_configurations_modeKey_idx" ON "mode_configurations"("modeKey");

CREATE TABLE "communication_templates" (
    "id" TEXT NOT NULL,
    "templateKey" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "stage" "Stage",
    "templateType" TEXT NOT NULL,
    "subjectTemplate" TEXT,
    "bodyTemplate" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdBy" TEXT NOT NULL,
    CONSTRAINT "communication_templates_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "communication_templates_templateKey_key" ON "communication_templates"("templateKey");

CREATE TABLE "invoice_templates" (
    "id" TEXT NOT NULL,
    "templateKey" TEXT NOT NULL,
    "invoiceType" "InvoiceType" NOT NULL,
    "title" TEXT NOT NULL,
    "bodyTemplate" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdBy" TEXT NOT NULL,
    CONSTRAINT "invoice_templates_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "invoice_templates_templateKey_key" ON "invoice_templates"("templateKey");

CREATE TABLE "feedback_survey_templates" (
    "id" TEXT NOT NULL,
    "templateKey" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "questions" JSONB NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdBy" TEXT NOT NULL,
    CONSTRAINT "feedback_survey_templates_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "feedback_survey_templates_templateKey_key" ON "feedback_survey_templates"("templateKey");

CREATE TABLE "vip_notification_routing_configs" (
    "id" TEXT NOT NULL,
    "vipTier" TEXT NOT NULL,
    "notifyRoles" JSONB NOT NULL,
    "notifyActorIds" JSONB NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdBy" TEXT NOT NULL,
    CONSTRAINT "vip_notification_routing_configs_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "vip_notification_routing_configs_vipTier_idx" ON "vip_notification_routing_configs"("vipTier");

CREATE TABLE "handoff_checklist_templates" (
    "id" TEXT NOT NULL,
    "handoffType" "HandoffType" NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "checklistItems" JSONB NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT NOT NULL,
    CONSTRAINT "handoff_checklist_templates_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "handoff_checklist_templates_handoffType_version_key" ON "handoff_checklist_templates"("handoffType", "version");

CREATE TABLE "work_order_templates" (
    "id" TEXT NOT NULL,
    "templateKey" TEXT NOT NULL,
    "useType" "EntryUseType",
    "title" TEXT NOT NULL,
    "todoItems" JSONB NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdBy" TEXT NOT NULL,
    CONSTRAINT "work_order_templates_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "work_order_templates_templateKey_key" ON "work_order_templates"("templateKey");

ALTER TABLE "role_permission_mappings" ADD CONSTRAINT "role_permission_mappings_roleId_fkey"
  FOREIGN KEY ("roleId") REFERENCES "roles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "role_session_configs" ADD CONSTRAINT "role_session_configs_roleId_fkey"
  FOREIGN KEY ("roleId") REFERENCES "roles"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
