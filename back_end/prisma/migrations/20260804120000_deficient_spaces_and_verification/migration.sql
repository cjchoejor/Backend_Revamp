-- Deficient conditions: support spaces, and add a verification step.
--
-- Front desk (L1) can now report a fault directly instead of waiting for an L4 admin, so
-- reports need confirming: an L1 report arrives PENDING_VERIFICATION and an L2+ either verifies
-- or rejects it. A report raised by an L2+ is VERIFIED immediately — they are the verifying
-- authority. The flagged target leaves service on report, before verification, so a broken room
-- can never stay sellable overnight; a rejected report returns it to service.

-- 1. Verification status.
CREATE TYPE "DeficientVerificationStatus" AS ENUM ('PENDING_VERIFICATION', 'VERIFIED', 'REJECTED');

ALTER TABLE "deficient_condition_records"
  ADD COLUMN "verificationStatus" "DeficientVerificationStatus" NOT NULL DEFAULT 'PENDING_VERIFICATION',
  ADD COLUMN "verifiedAt"         TIMESTAMP(3),
  ADD COLUMN "verifiedBy"         TEXT,
  ADD COLUMN "verificationNotes"  TEXT;

-- Existing rows were all created through the L4-only admin route, i.e. by the verifying
-- authority itself. Backfilling them as VERIFIED keeps history truthful; leaving them pending
-- would put every historical fault into a supervisor's review queue for no reason.
UPDATE "deficient_condition_records" SET "verificationStatus" = 'VERIFIED';

-- 2. Spaces become reportable. roomId becomes nullable and spaceId joins it.
ALTER TABLE "deficient_condition_records" ALTER COLUMN "roomId" DROP NOT NULL;
ALTER TABLE "deficient_condition_records" ADD COLUMN "spaceId" TEXT;

ALTER TABLE "deficient_condition_records"
  ADD CONSTRAINT "deficient_condition_records_spaceId_fkey"
  FOREIGN KEY ("spaceId") REFERENCES "spaces"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Exactly one target. A record pointing at neither (or both) would silently vanish from every
-- per-target query, so this is enforced by the database rather than trusted to callers.
ALTER TABLE "deficient_condition_records"
  ADD CONSTRAINT "deficient_target_xor"
  CHECK (("roomId" IS NOT NULL AND "spaceId" IS NULL) OR ("roomId" IS NULL AND "spaceId" IS NOT NULL));

CREATE INDEX "deficient_condition_records_roomId_status_idx"  ON "deficient_condition_records"("roomId", "status");
CREATE INDEX "deficient_condition_records_spaceId_status_idx" ON "deficient_condition_records"("spaceId", "status");
CREATE INDEX "deficient_condition_records_verificationStatus_idx" ON "deficient_condition_records"("verificationStatus");

-- 3. Spaces carry the same out-of-service flag rooms do.
ALTER TABLE "spaces" ADD COLUMN "isDeficient" BOOLEAN NOT NULL DEFAULT false;
