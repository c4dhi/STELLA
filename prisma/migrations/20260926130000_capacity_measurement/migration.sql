-- Measured voice capacity: one row per run of the load test (scripts/load-test),
-- shown in the admin dashboard with the GPU it was measured on and the date.
CREATE TABLE IF NOT EXISTS "CapacityMeasurement" (
    "id" TEXT NOT NULL,
    "measuredAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "gpuName" TEXT NOT NULL,
    "gpuMemoryMb" INTEGER,
    "environment" TEXT NOT NULL,
    "sttProvider" TEXT,
    "ttsProvider" TEXT,
    "gitRevision" TEXT,
    "maxSessions" INTEGER NOT NULL,
    "limitedBy" TEXT[],
    "reachedTopLevel" BOOLEAN NOT NULL,
    "durationSeconds" INTEGER NOT NULL,
    "criteria" JSONB NOT NULL,
    "levels" JSONB NOT NULL,

    CONSTRAINT "CapacityMeasurement_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "CapacityMeasurement_environment_gpuName_measuredAt_idx"
    ON "CapacityMeasurement"("environment", "gpuName", "measuredAt");
