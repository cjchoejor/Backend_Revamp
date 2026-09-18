-- The guest's own expected arrival time, "HH:MM" hotel-local on the check-in day (2026-09-18).
-- Null = the hotel's standard check-in time (config checkIn.standardTime). The no-show cut-off counts from it.
ALTER TABLE "entries" ADD COLUMN "expectedArrivalTime" TEXT;
