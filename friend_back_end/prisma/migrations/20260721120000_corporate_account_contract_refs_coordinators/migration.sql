-- Corporate commercial context on the standing account (spec-aligned with
-- CorporateProfile.contractRefs / coordinators, DEV-SPEC-001-Part2 §2.6.2).
-- A booking inherits these at S1 intake (Policy 17) instead of re-typing per inquiry.
ALTER TABLE "corporate_accounts" ADD COLUMN "contractRefs" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "corporate_accounts" ADD COLUMN "coordinators" JSONB;
