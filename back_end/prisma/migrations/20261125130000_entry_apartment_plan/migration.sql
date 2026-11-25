-- How an apartment is let: by the month or by the week (2026-11-25).
ALTER TABLE "entries" ADD COLUMN "apartmentPlan" TEXT;
ALTER TABLE "entries" ADD CONSTRAINT "entries_apartment_plan_known" CHECK ("apartmentPlan" IS NULL OR "apartmentPlan" IN ('MONTHLY', 'WEEKLY'));
