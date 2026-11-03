-- The agency's or company's own person on an enquiry (2026-11-03). Who is arriving becomes the guest
-- once one is named, on every booking, so that person is kept here rather than lost.
ALTER TABLE "inquiries" ADD COLUMN "partyContactName" TEXT;
ALTER TABLE "inquiries" ADD COLUMN "partyContactPhone" TEXT;
ALTER TABLE "inquiries" ADD COLUMN "partyContactEmail" TEXT;
