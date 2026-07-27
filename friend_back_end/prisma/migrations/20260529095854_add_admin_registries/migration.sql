-- AlterTable
ALTER TABLE "agent_profiles" ADD COLUMN     "commissionEffectiveFrom" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "rate_plan_registry" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "roomTypeId" TEXT,
    "baseRate" DECIMAL(15,2) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'BTN',
    "overrideMargin" DECIMAL(5,4),
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdBy" TEXT NOT NULL,

    CONSTRAINT "rate_plan_registry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "season_calendar" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "startDate" TIMESTAMP(3) NOT NULL,
    "endDate" TIMESTAMP(3) NOT NULL,
    "rateMultiplier" DECIMAL(6,4),
    "priority" INTEGER NOT NULL DEFAULT 0,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdBy" TEXT NOT NULL,

    CONSTRAINT "season_calendar_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "package_registry" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "inclusions" JSONB NOT NULL,
    "priceAdjustment" DECIMAL(15,2),
    "currency" TEXT NOT NULL DEFAULT 'BTN',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdBy" TEXT NOT NULL,

    CONSTRAINT "package_registry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cancellation_policy_registry" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "penaltyTiers" JSONB NOT NULL,
    "noShowTreatment" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdBy" TEXT NOT NULL,

    CONSTRAINT "cancellation_policy_registry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ai_actor_identity" (
    "id" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "actorType" "ActorLevel" NOT NULL DEFAULT 'SYSTEM',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdBy" TEXT NOT NULL,

    CONSTRAINT "ai_actor_identity_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "rate_plan_registry_name_key" ON "rate_plan_registry"("name");

-- CreateIndex
CREATE UNIQUE INDEX "season_calendar_name_key" ON "season_calendar"("name");

-- CreateIndex
CREATE UNIQUE INDEX "package_registry_name_key" ON "package_registry"("name");

-- CreateIndex
CREATE UNIQUE INDEX "cancellation_policy_registry_name_key" ON "cancellation_policy_registry"("name");
