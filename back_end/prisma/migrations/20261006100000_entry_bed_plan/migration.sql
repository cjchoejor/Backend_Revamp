-- Which room this booking wants made up as what: { roomId: bedType }.
-- A plan for the stay, not the room's current state (that is rooms."bedType").
ALTER TABLE "entries" ADD COLUMN "bedPlan" JSONB;
