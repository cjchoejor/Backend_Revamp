-- How long a quotation stands is the hotel's rule from 2026-11-05: until check-in, shorter if the desk
-- says so, in hours when check-in is today. The two settings it replaced go, every version of them.
DELETE FROM "configuration_entries" WHERE "configKey" = 'expiry.s2.quotationValidityDays';
DELETE FROM "policy_registry" WHERE "policyId" = 'registry.quotationValidity.days';
