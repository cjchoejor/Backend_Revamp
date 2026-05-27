-- Daily sequence counters for human-readable business IDs (INQ-YYYYMMDD-0001, etc.)

CREATE TABLE "readable_id_sequences" (
    "prefix" TEXT NOT NULL,
    "sequence_date" TEXT NOT NULL,
    "last_value" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "readable_id_sequences_pkey" PRIMARY KEY ("prefix", "sequence_date")
);
