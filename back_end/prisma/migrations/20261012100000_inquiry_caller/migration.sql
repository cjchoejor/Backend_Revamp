-- The caller is recorded on the enquiry; the guest staying is named later (2026-10-12).
ALTER TABLE "inquiries" ALTER COLUMN "guestProfileId" DROP NOT NULL;
ALTER TABLE "inquiries" ADD COLUMN "callerTitle" TEXT;
ALTER TABLE "inquiries" ADD COLUMN "callerFirstName" TEXT;
ALTER TABLE "inquiries" ADD COLUMN "callerLastName" TEXT;
ALTER TABLE "inquiries" ADD COLUMN "callerPhone" TEXT;
ALTER TABLE "inquiries" ADD COLUMN "callerEmail" TEXT;
ALTER TABLE "inquiries" ADD COLUMN "callerOnWhatsApp" BOOLEAN;
