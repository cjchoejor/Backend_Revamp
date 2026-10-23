-- A room move's leg may move the stay to other dates too (2026-10-19, operator: two bookings on
-- different dates "should have swapped both date and room"). `newCheckInDate` is the leg's new
-- first night; `toNights` the nights it lands on, which its claim covers while the move runs.
ALTER TABLE "room_move_legs" ADD COLUMN "newCheckInDate" TIMESTAMP(3);
ALTER TABLE "room_move_legs" ADD COLUMN "toNights" JSONB;
