-- A return stay set up "the same as" another: worked in one table at Negotiation (2026-11-09).
ALTER TABLE "entries" ADD COLUMN "sameSetupAs" TEXT;
CREATE INDEX "entries_sameSetupAs_idx" ON "entries"("sameSetupAs");

-- Stays already set up the same, read off the record: the link itself ends once the copying does.
UPDATE "entries" e
SET "sameSetupAs" = s."fromEntryId"
FROM (
  SELECT DISTINCT ON (t."entryId") t."entryId", t."payload"->>'fromEntryId' AS "fromEntryId", t."timestamp" AS "at"
  FROM "trace_events" t
  WHERE t."eventType" = 'ENTRY.FOLLOW_STARTED' AND t."entryId" IS NOT NULL
  ORDER BY t."entryId", t."timestamp" DESC
) s
WHERE e."id" = s."entryId"
  AND s."fromEntryId" IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM "trace_events" x
    WHERE x."entryId" = s."entryId"
      AND x."eventType" = 'ENTRY.FOLLOW_ENDED'
      AND x."payload"->>'cause' = 'SET_ITS_OWN'
      AND x."timestamp" > s."at"
  );
