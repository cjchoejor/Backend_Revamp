-- Papers to an agency or a company go without room types (2026-11-13). Whether they may go WITH
-- them, and who may send them so, is this setting: off until an admin turns it on under Channels and
-- replies. Added once; a row already there is left as it is.
INSERT INTO "configuration_entries" ("id", "configKey", "configValue", "setBy", "notes")
SELECT gen_random_uuid()::text,
       'papers.roomTypesForParties',
       '{"enabled": false, "levels": ["L2", "L3", "L4"]}'::jsonb,
       'actor-seed-system',
       'Whether papers to an agency or a company may go with room types, and who may send them so'
WHERE NOT EXISTS (SELECT 1 FROM "configuration_entries" WHERE "configKey" = 'papers.roomTypesForParties');
