-- SIG-S4 §90/§197 + AC-S4-024/025/026: Reservations become per-segment immutable history.
-- entryId is no longer unique (one entry can have many reservations across segments);
-- segmentId is now unique (one reservation per segment). Entry.currentReservationId points at
-- the latest-confirmed reservation so existing one-to-one reads stay intact.

-- DropIndex (entryId no longer one-per-entry)
DROP INDEX "reservations_entryId_key";

-- AlterTable
ALTER TABLE "entries" ADD COLUMN     "currentReservationId" TEXT;

-- Backfill: point each existing entry at its (currently 1:1) reservation before adding constraints.
UPDATE "entries" e SET "currentReservationId" = r."id" FROM "reservations" r WHERE r."entryId" = e."id";

-- CreateIndex
CREATE UNIQUE INDEX "entries_currentReservationId_key" ON "entries"("currentReservationId");

-- CreateIndex (one reservation per segment)
CREATE UNIQUE INDEX "reservations_segmentId_key" ON "reservations"("segmentId");

-- AddForeignKey
ALTER TABLE "entries" ADD CONSTRAINT "entries_currentReservationId_fkey" FOREIGN KEY ("currentReservationId") REFERENCES "reservations"("id") ON DELETE SET NULL ON UPDATE CASCADE;
