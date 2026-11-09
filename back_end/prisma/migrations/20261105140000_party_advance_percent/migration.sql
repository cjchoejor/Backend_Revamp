-- The advance is each travel agent's and company's own percentage of the stay from 2026-11-05, or
-- what the desk sets on the booking. Every percentage starts not set. The hotel-wide amount and the
-- group multiplier that only multiplied it go, every version of them.
ALTER TABLE "travel_agents" ADD COLUMN "advancePercent" DECIMAL(5,2);
ALTER TABLE "corporate_accounts" ADD COLUMN "advancePercent" DECIMAL(5,2);
ALTER TABLE "travel_agents" ADD CONSTRAINT "travel_agent_advance_percent_range"
  CHECK ("advancePercent" IS NULL OR ("advancePercent" > 0 AND "advancePercent" <= 100));
ALTER TABLE "corporate_accounts" ADD CONSTRAINT "corporate_account_advance_percent_range"
  CHECK ("advancePercent" IS NULL OR ("advancePercent" > 0 AND "advancePercent" <= 100));
DELETE FROM "configuration_entries" WHERE "configKey" = 'advancePayment.thresholds';
DELETE FROM "policy_registry" WHERE "policyId" = 'registry.groupBooking.advancePaymentBoost';
