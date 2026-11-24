-- A package version names the version that replaced it (2026-11-24), so a package can be renamed:
-- the versions were found by name, and a new name would have started a second package.
ALTER TABLE "rate_packages" ADD COLUMN "supersededById" TEXT;

-- Existing chains: a save closes the prior version at the very moment the next one starts.
UPDATE "rate_packages" p
SET "supersededById" = n.id
FROM "rate_packages" n
WHERE p."effectiveTo" IS NOT NULL
  AND n.id <> p.id
  AND n.scope = p.scope
  AND n."travelAgentId" IS NOT DISTINCT FROM p."travelAgentId"
  AND n."corporateAccountId" IS NOT DISTINCT FROM p."corporateAccountId"
  AND n.name = p.name
  AND n."effectiveFrom" = p."effectiveTo";

CREATE INDEX "rate_packages_supersededById_idx" ON "rate_packages"("supersededById");
