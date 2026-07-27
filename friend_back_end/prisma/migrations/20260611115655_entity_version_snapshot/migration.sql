-- CreateTable
CREATE TABLE "entity_version_snapshots" (
    "id" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "rowJson" JSONB NOT NULL,
    "changedBy" TEXT NOT NULL,
    "changedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "changeNote" TEXT,

    CONSTRAINT "entity_version_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "entity_version_snapshots_entityType_entityId_idx" ON "entity_version_snapshots"("entityType", "entityId");

-- CreateIndex
CREATE INDEX "entity_version_snapshots_changedAt_idx" ON "entity_version_snapshots"("changedAt");

-- CreateIndex
CREATE UNIQUE INDEX "entity_version_snapshots_entityType_entityId_version_key" ON "entity_version_snapshots"("entityType", "entityId", "version");
