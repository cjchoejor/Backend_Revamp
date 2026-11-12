-- The guest's own email an enquiry came in by; papers reply inside that conversation (2026-11-12).
ALTER TABLE "inquiries" ADD COLUMN "emailThreadMessageId" TEXT;
ALTER TABLE "inquiries" ADD COLUMN "emailThreadSubject" TEXT;
ALTER TABLE "inquiries" ADD COLUMN "emailThreadFrom" TEXT;
ALTER TABLE "inquiries" ADD COLUMN "emailThreadFromName" TEXT;
ALTER TABLE "inquiries" ADD COLUMN "emailThreadReferences" TEXT;
ALTER TABLE "inquiries" ADD COLUMN "emailThreadReceivedAt" TIMESTAMP(3);
ALTER TABLE "inquiries" ADD COLUMN "emailThreadLinkedAt" TIMESTAMP(3);
ALTER TABLE "inquiries" ADD COLUMN "emailThreadLinkedBy" TEXT;
ALTER TABLE "inquiries" ADD COLUMN "emailThreadLastSentId" TEXT;
CREATE INDEX "inquiries_emailThreadMessageId_idx" ON "inquiries"("emailThreadMessageId");
