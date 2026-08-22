-- The guest's promise on a mid-stay bill (2026-08-22, operator request: "before sending the
-- interim bill, put the option to put when they are going to pay — a promised time like S3's
-- advance"). NOW = paying at the desk; BY_DATE = `promisedBy`, which becomes the bill's `dueBy`
-- so the W41 reminder fires at the guest's own time. Printed on the interim invoice + email.
ALTER TABLE "interim_payment_requests"
  ADD COLUMN "promiseKind" TEXT,
  ADD COLUMN "promisedBy" TIMESTAMP(3),
  ADD COLUMN "promiseNote" TEXT,
  ADD COLUMN "promiseRecordedAt" TIMESTAMP(3),
  ADD COLUMN "promiseRecordedBy" TEXT;
