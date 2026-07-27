-- ACIG §2.1A.7 — expand ModeConfiguration with the spec's three typed JSON columns
-- (stageRoute, autoFulfilmentConditions, featureDependencies) and effectiveFrom timestamp.
-- The legacy `config` column is dropped (table is empty in this environment, so no data loss).
-- A unique constraint on (modeKey, version) is added per spec.

ALTER TABLE "mode_configurations" DROP COLUMN "config";

ALTER TABLE "mode_configurations"
  ADD COLUMN "stageRoute" JSONB NOT NULL DEFAULT '[]',
  ADD COLUMN "autoFulfilmentConditions" JSONB NOT NULL DEFAULT '[]',
  ADD COLUMN "featureDependencies" JSONB NOT NULL DEFAULT '[]',
  ADD COLUMN "effectiveFrom" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

CREATE UNIQUE INDEX "mode_configurations_modeKey_version_key"
  ON "mode_configurations"("modeKey", "version");
