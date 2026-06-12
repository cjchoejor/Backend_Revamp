-- CreateEnum
CREATE TYPE "ContactMode" AS ENUM ('PHONE', 'EMAIL', 'WHATSAPP', 'IN_PERSON', 'OTHER');

-- CreateEnum
CREATE TYPE "PartyType" AS ENUM ('TRAVEL_AGENT', 'CORPORATE');

-- CreateEnum
CREATE TYPE "MealPlanType" AS ENUM ('CP', 'MAP_LUNCH', 'MAP_DINNER', 'AP');

-- CreateTable
CREATE TABLE "travel_agents" (
    "id" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "contactNumber" TEXT,
    "contactEmail" TEXT,
    "modeOfContact" "ContactMode" NOT NULL DEFAULT 'PHONE',
    "notes" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "travel_agents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "corporate_accounts" (
    "id" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "contactNumber" TEXT,
    "contactEmail" TEXT,
    "modeOfContact" "ContactMode" NOT NULL DEFAULT 'EMAIL',
    "gstNumber" TEXT,
    "billingAddress" TEXT,
    "notes" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "corporate_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rate_cards" (
    "id" TEXT NOT NULL,
    "partyType" "PartyType" NOT NULL,
    "partyId" TEXT NOT NULL,
    "roomBaseRate" DECIMAL(10,2) NOT NULL,
    "extraBedRate" DECIMAL(10,2),
    "cnbPercent" INTEGER,
    "breakfastRate" DECIMAL(10,2),
    "lunchRate" DECIMAL(10,2),
    "dinnerRate" DECIMAL(10,2),
    "cpRate" DECIMAL(10,2),
    "mapLunchRate" DECIMAL(10,2),
    "mapDinnerRate" DECIMAL(10,2),
    "apRate" DECIMAL(10,2),
    "currency" TEXT NOT NULL DEFAULT 'BTN',
    "effectiveFrom" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "effectiveTo" TIMESTAMP(3),
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT NOT NULL,

    CONSTRAINT "rate_cards_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "room_type_rate_overrides" (
    "id" TEXT NOT NULL,
    "rateCardId" TEXT NOT NULL,
    "roomTypeId" TEXT NOT NULL,
    "roomBaseRate" DECIMAL(10,2) NOT NULL,
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT NOT NULL,

    CONSTRAINT "room_type_rate_overrides_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "travel_agents_displayName_idx" ON "travel_agents"("displayName");

-- CreateIndex
CREATE INDEX "travel_agents_isActive_idx" ON "travel_agents"("isActive");

-- CreateIndex
CREATE INDEX "corporate_accounts_displayName_idx" ON "corporate_accounts"("displayName");

-- CreateIndex
CREATE INDEX "corporate_accounts_isActive_idx" ON "corporate_accounts"("isActive");

-- CreateIndex
CREATE INDEX "rate_cards_partyType_partyId_effectiveFrom_idx" ON "rate_cards"("partyType", "partyId", "effectiveFrom");

-- CreateIndex
CREATE INDEX "rate_cards_effectiveTo_idx" ON "rate_cards"("effectiveTo");

-- CreateIndex
CREATE INDEX "room_type_rate_overrides_roomTypeId_idx" ON "room_type_rate_overrides"("roomTypeId");

-- CreateIndex
CREATE UNIQUE INDEX "room_type_rate_overrides_rateCardId_roomTypeId_key" ON "room_type_rate_overrides"("rateCardId", "roomTypeId");

-- AddForeignKey
ALTER TABLE "room_type_rate_overrides" ADD CONSTRAINT "room_type_rate_overrides_rateCardId_fkey" FOREIGN KEY ("rateCardId") REFERENCES "rate_cards"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "room_type_rate_overrides" ADD CONSTRAINT "room_type_rate_overrides_roomTypeId_fkey" FOREIGN KEY ("roomTypeId") REFERENCES "room_types"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
