-- The guest's stated payment plan for the advance (2026-08-07): FULL / PARTIAL /
-- INSTALLMENTS + when the remainder is promised (BEFORE_CHECKIN with a date, AT_CHECKIN,
-- AT_CHECKOUT). Advisory JSON — gates still run on money received + credit extension.
ALTER TABLE "folios" ADD COLUMN "advancePaymentPlan" JSONB;
