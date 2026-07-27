-- Add Message-ID anchor on Entry so the email service can thread every email for the same
-- guest journey (S1..S9) into a single Gmail conversation via In-Reply-To / References headers.

ALTER TABLE "entries"
  ADD COLUMN "emailThreadRootMessageId" TEXT;
