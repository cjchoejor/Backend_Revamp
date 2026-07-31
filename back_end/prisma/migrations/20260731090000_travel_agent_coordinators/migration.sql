-- TravelAgent gains a contact-person list, mirroring CorporateAccount.coordinators.
-- Shape: [{ name: string, phone?: string|null, email?: string|null }]
-- One agency routinely has several people who ring in bookings; the desk picks from this list at
-- S1 intake to fill Entry.contactPerson* instead of retyping a number, and can append a new
-- contact person mid-call (L1) so it is there for the next booking.
ALTER TABLE "travel_agents" ADD COLUMN "coordinators" JSONB;
