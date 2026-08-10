-- Rates move off the party and onto named packages.
--
-- Each negotiated rate variant used to be its own travel-agent row, because agent and rate card
-- were fused one-to-one (136 parties, 136 rate cards). One agency that negotiated a season, an
-- off-season and a premium rate appeared as three agencies, with contact details duplicated
-- across them and free to drift.
--
-- A package belongs to an agency, a company, or to nobody (the house fallback used when a party
-- has no package of its own, so a brand-new agent can be quoted immediately).
--
-- Data migration runs separately in scripts/migrate-rate-cards-to-packages.ts so the grouping
-- decisions are reviewable and re-runnable; this file only makes room for it. RateCard and
-- RoomTypeRateOverride are deliberately left in place for now — they stay readable until
-- pricing is switched over and the backfill verified.

CREATE TYPE "RatePackageScope" AS ENUM ('TRAVEL_AGENT', 'CORPORATE', 'COMMON');

CREATE TABLE "rate_packages" (
    "id"                 TEXT NOT NULL,
    "scope"              "RatePackageScope" NOT NULL,
    "travelAgentId"      TEXT,
    "corporateAccountId" TEXT,
    "name"               TEXT NOT NULL,
    "isDefault"          BOOLEAN NOT NULL DEFAULT false,
    "roomBaseRate"       DECIMAL(10,2) NOT NULL,
    "extraBedRate"       DECIMAL(10,2),
    "cnbPercent"         INTEGER,
    "breakfastRate"      DECIMAL(10,2),
    "lunchRate"          DECIMAL(10,2),
    "dinnerRate"         DECIMAL(10,2),
    "cpRate"             DECIMAL(10,2),
    "mapLunchRate"       DECIMAL(10,2),
    "mapDinnerRate"      DECIMAL(10,2),
    "apRate"             DECIMAL(10,2),
    "currency"           TEXT NOT NULL DEFAULT 'BTN',
    "rateIsTaxInclusive" BOOLEAN NOT NULL DEFAULT false,
    "effectiveFrom"      TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "effectiveTo"        TIMESTAMP(3),
    "notes"              TEXT,
    "createdAt"          TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy"          TEXT NOT NULL,
    CONSTRAINT "rate_packages_pkey" PRIMARY KEY ("id")
);

-- The scope must agree with which FK is populated. A package whose scope says TRAVEL_AGENT but
-- carries a corporateAccountId (or neither, or both) would price the wrong booking silently, so
-- the database refuses it rather than trusting every future caller to get it right.
ALTER TABLE "rate_packages" ADD CONSTRAINT "rate_package_scope_matches_party" CHECK (
  (scope = 'TRAVEL_AGENT' AND "travelAgentId" IS NOT NULL AND "corporateAccountId" IS NULL) OR
  (scope = 'CORPORATE'    AND "corporateAccountId" IS NOT NULL AND "travelAgentId" IS NULL) OR
  (scope = 'COMMON'       AND "travelAgentId" IS NULL AND "corporateAccountId" IS NULL)
);

CREATE INDEX "rate_packages_scope_effectiveTo_idx"              ON "rate_packages"("scope", "effectiveTo");
CREATE INDEX "rate_packages_travelAgentId_effectiveTo_idx"      ON "rate_packages"("travelAgentId", "effectiveTo");
CREATE INDEX "rate_packages_corporateAccountId_effectiveTo_idx" ON "rate_packages"("corporateAccountId", "effectiveTo");

ALTER TABLE "rate_packages" ADD CONSTRAINT "rate_packages_travelAgentId_fkey"
  FOREIGN KEY ("travelAgentId") REFERENCES "travel_agents"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "rate_packages" ADD CONSTRAINT "rate_packages_corporateAccountId_fkey"
  FOREIGN KEY ("corporateAccountId") REFERENCES "corporate_accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Per-room-type room rate override, mirroring the old RoomTypeRateOverride.
CREATE TABLE "room_type_package_overrides" (
    "id"            TEXT NOT NULL,
    "ratePackageId" TEXT NOT NULL,
    "roomTypeId"    TEXT NOT NULL,
    "roomBaseRate"  DECIMAL(10,2) NOT NULL,
    "notes"         TEXT,
    "createdAt"     TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy"     TEXT NOT NULL,
    CONSTRAINT "room_type_package_overrides_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "room_type_package_overrides_ratePackageId_roomTypeId_key"
  ON "room_type_package_overrides"("ratePackageId", "roomTypeId");
CREATE INDEX "room_type_package_overrides_roomTypeId_idx" ON "room_type_package_overrides"("roomTypeId");
ALTER TABLE "room_type_package_overrides" ADD CONSTRAINT "room_type_package_overrides_ratePackageId_fkey"
  FOREIGN KEY ("ratePackageId") REFERENCES "rate_packages"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "room_type_package_overrides" ADD CONSTRAINT "room_type_package_overrides_roomTypeId_fkey"
  FOREIGN KEY ("roomTypeId") REFERENCES "room_types"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Which package the operator chose. Linking to an agency alone no longer says which rate applies.
ALTER TABLE "inquiries" ADD COLUMN "ratePackageId" TEXT;
CREATE INDEX "inquiries_ratePackageId_idx" ON "inquiries"("ratePackageId");
ALTER TABLE "inquiries" ADD CONSTRAINT "inquiries_ratePackageId_fkey"
  FOREIGN KEY ("ratePackageId") REFERENCES "rate_packages"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- An agency usually has more than one number (office, owner, WhatsApp). The single column held
-- one and the rest were lost or buried in notes. Existing values are carried across as the first
-- entry, so nothing is dropped.
ALTER TABLE "travel_agents"      ADD COLUMN "contactNumbers" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "corporate_accounts" ADD COLUMN "contactNumbers" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

UPDATE "travel_agents"
   SET "contactNumbers" = ARRAY["contactNumber"]
 WHERE "contactNumber" IS NOT NULL AND btrim("contactNumber") <> '';
UPDATE "corporate_accounts"
   SET "contactNumbers" = ARRAY["contactNumber"]
 WHERE "contactNumber" IS NOT NULL AND btrim("contactNumber") <> '';

ALTER TABLE "travel_agents"      DROP COLUMN "contactNumber";
ALTER TABLE "corporate_accounts" DROP COLUMN "contactNumber";
