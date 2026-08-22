-- Mid-stay payment reminder (2026-08-22, operator request: "need a timer for a reminder to get
-- that mid-stay payment"). Every interim bill carries the moment the money is expected
-- (`dueBy` — default from config `interimPayment.reminder`, operator-settable) and the W41
-- reminder clock fires there: still unpaid → a reminder is raised (trace + notification) and the
-- clock re-arms every N hours up to a cap. Cancelled on pay / withdraw / lapse.
ALTER TABLE "interim_payment_requests"
  ADD COLUMN "dueBy" TIMESTAMP(3),
  ADD COLUMN "reminderTimerRecordId" TEXT,
  ADD COLUMN "remindersSent" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "lastReminderAt" TIMESTAMP(3);
