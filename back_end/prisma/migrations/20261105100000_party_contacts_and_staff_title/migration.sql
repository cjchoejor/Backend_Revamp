-- A booking through an agency or a company can hold several contact persons (2026-11-05): the list,
-- first one first. partyContactName / Phone / Email stay, holding the first.
ALTER TABLE "inquiries" ADD COLUMN "partyContacts" JSONB;

-- The title wherever a name is asked, the staff list included (2026-11-05).
ALTER TABLE "staff_users" ADD COLUMN "title" TEXT;
