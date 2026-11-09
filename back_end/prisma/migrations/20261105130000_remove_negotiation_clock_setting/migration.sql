-- The Negotiation clock runs on the rule a quotation's validity follows (2026-11-05): no setting.
DELETE FROM "configuration_entries" WHERE "configKey" = 'expiry.s2.negotiationTtlSeconds';
