-- Per-room folio charges (2026-08-14, operator request): a charge can belong to ONE room of
-- a multi-room booking. Stamped by the night audit's per-room ROOM_CHARGE posts and by the
-- desk's manual posting; auto tax/service lines and corrections inherit it. NULL = booking-wide.
ALTER TABLE "folio_lines" ADD COLUMN "roomId" TEXT;

ALTER TABLE "folio_lines"
  ADD CONSTRAINT "folio_lines_roomId_fkey" FOREIGN KEY ("roomId")
  REFERENCES "rooms"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX "folio_lines_roomId_idx" ON "folio_lines"("roomId");
