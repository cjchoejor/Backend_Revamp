-- An enquiry's email conversation: their first email, what we sent, their replies (2026-11-12).
CREATE TABLE "inquiry_emails" (
    "id" TEXT NOT NULL,
    "inquiryId" TEXT NOT NULL,
    "entryId" TEXT,
    "kind" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "fromAddress" TEXT,
    "fromName" TEXT,
    "toAddresses" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "subject" TEXT NOT NULL,
    "snippet" TEXT NOT NULL DEFAULT '',
    "at" TIMESTAMP(3) NOT NULL,
    "paperKind" TEXT,
    "attachmentNames" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "inReplyTo" TEXT,
    "answersKind" TEXT,
    "seenAt" TIMESTAMP(3),
    "seenBy" TEXT,
    "answeredCommunicationId" TEXT,
    "answeredAt" TIMESTAMP(3),
    "answeredBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "inquiry_emails_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "inquiry_emails_kind_check" CHECK ("kind" IN ('FIRST', 'SENT', 'REPLY'))
);
CREATE UNIQUE INDEX "inquiry_emails_inquiryId_messageId_key" ON "inquiry_emails"("inquiryId", "messageId");
CREATE INDEX "inquiry_emails_inquiryId_at_idx" ON "inquiry_emails"("inquiryId", "at");
CREATE INDEX "inquiry_emails_kind_seenAt_idx" ON "inquiry_emails"("kind", "seenAt");
ALTER TABLE "inquiry_emails" ADD CONSTRAINT "inquiry_emails_inquiryId_fkey" FOREIGN KEY ("inquiryId") REFERENCES "inquiries"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
