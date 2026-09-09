BEGIN;
SET LOCAL lock_timeout = '5s';
CREATE TABLE "BackgroundTask" (
  "id" UUID NOT NULL, "kind" TEXT NOT NULL, "key" TEXT NOT NULL,
  "payload" JSONB NOT NULL, "payloadHash" TEXT NOT NULL,
  "organizationId" UUID, "clientId" UUID, "correlationId" UUID NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'pending', "attempts" INTEGER NOT NULL DEFAULT 0,
  "availableAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "leaseToken" UUID, "leasedUntil" TIMESTAMP(3), "lastErrorCode" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "completedAt" TIMESTAMP(3),
  CONSTRAINT "BackgroundTask_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "BackgroundTask_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "BackgroundTask_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "Client"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "BackgroundTask_status_check" CHECK ("status" IN ('pending','running','completed','dead','unknown')),
  CONSTRAINT "BackgroundTask_attempts_check" CHECK ("attempts" BETWEEN 0 AND 1),
  CONSTRAINT "BackgroundTask_scope_check" CHECK (
    ("kind" IN ('legacy_sms', 'lead_pipeline') AND "clientId" IS NOT NULL) OR
    ("kind" IN ('daily_summary', 'scheduled_pipelines') AND "clientId" IS NULL AND "organizationId" IS NULL)
  )
);
CREATE UNIQUE INDEX "BackgroundTask_key_key" ON "BackgroundTask"("key");
CREATE INDEX "BackgroundTask_status_availableAt_idx" ON "BackgroundTask"("status", "availableAt");
CREATE INDEX "BackgroundTask_organizationId_createdAt_idx" ON "BackgroundTask"("organizationId", "createdAt");
CREATE INDEX "BackgroundTask_clientId_createdAt_idx" ON "BackgroundTask"("clientId", "createdAt");
COMMIT;
