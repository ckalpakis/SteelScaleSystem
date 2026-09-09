BEGIN;
SET LOCAL lock_timeout = '5s';

-- AlterTable
ALTER TABLE "WorkforceIntegration" ADD COLUMN     "externalAccountId" TEXT;

-- AlterTable
ALTER TABLE "WorkforceEvent" ADD COLUMN     "actor" TEXT,
ADD COLUMN     "causationId" UUID,
ADD COLUMN     "connectionId" UUID,
ADD COLUMN     "correlationId" UUID,
ADD COLUMN     "entityId" UUID,
ADD COLUMN     "entityType" TEXT,
ADD COLUMN     "externalRecordId" TEXT,
ADD COLUMN     "externalRecordType" TEXT,
ADD COLUMN     "metadata" JSONB,
ADD COLUMN     "provider" TEXT,
ADD COLUMN     "recordId" UUID,
ADD COLUMN     "recordType" "CrmEntityType";

-- CreateTable
CREATE TABLE "EventDelivery" (
    "organizationId" UUID NOT NULL,
    "eventId" UUID NOT NULL,
    "handlerId" TEXT NOT NULL,
    "processedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EventDelivery_pkey" PRIMARY KEY ("organizationId","eventId","handlerId")
);

-- CreateTable
CREATE TABLE "EventIntake" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "source" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "payloadHash" TEXT NOT NULL,
    "connectionId" UUID,
    "eventId" UUID,
    "result" JSONB NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EventIntake_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "EventIntake_organizationId_source_externalId_key" ON "EventIntake"("organizationId", "source", "externalId");

-- CreateIndex
CREATE INDEX "WorkforceEvent_organizationId_correlationId_receivedAt_idx" ON "WorkforceEvent"("organizationId", "correlationId", "receivedAt");

-- CreateIndex
CREATE INDEX "WorkforceEvent_organizationId_entityType_entityId_occurredA_idx" ON "WorkforceEvent"("organizationId", "entityType", "entityId", "occurredAt");

-- AddForeignKey
ALTER TABLE "WorkforceEvent" ADD CONSTRAINT "WorkforceEvent_organizationId_connectionId_fkey" FOREIGN KEY ("organizationId", "connectionId") REFERENCES "WorkforceIntegration"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkforceEvent" ADD CONSTRAINT "WorkforceEvent_organizationId_recordId_recordType_fkey" FOREIGN KEY ("organizationId", "recordId", "recordType") REFERENCES "CrmRecord"("organizationId", "id", "entityType") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkforceEvent" ADD CONSTRAINT "WorkforceEvent_organizationId_causationId_fkey" FOREIGN KEY ("organizationId", "causationId") REFERENCES "WorkforceEvent"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EventDelivery" ADD CONSTRAINT "EventDelivery_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EventDelivery" ADD CONSTRAINT "EventDelivery_organizationId_eventId_fkey" FOREIGN KEY ("organizationId", "eventId") REFERENCES "WorkforceEvent"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EventIntake" ADD CONSTRAINT "EventIntake_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EventIntake" ADD CONSTRAINT "EventIntake_organizationId_connectionId_fkey" FOREIGN KEY ("organizationId", "connectionId") REFERENCES "WorkforceIntegration"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EventIntake" ADD CONSTRAINT "EventIntake_organizationId_eventId_fkey" FOREIGN KEY ("organizationId", "eventId") REFERENCES "WorkforceEvent"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Nullable metadata preserves historical v1 rows. V2 publishers must provide context.
ALTER TABLE "WorkforceEvent" ADD CONSTRAINT event_v2_context CHECK (
  version <> 2 OR (provider IS NOT NULL AND "entityType" IS NOT NULL AND
  "correlationId" IS NOT NULL AND actor IS NOT NULL AND metadata IS NOT NULL)
);
ALTER TABLE "WorkforceEvent" ADD CONSTRAINT event_record_identity CHECK (
  ("recordId" IS NULL AND "recordType" IS NULL) OR
  ("recordId" IS NOT NULL AND "recordType" IS NOT NULL AND "entityId" IS NOT NULL AND "entityType" IS NOT NULL AND "recordId" = "entityId" AND "recordType"::text = "entityType")
);
ALTER TABLE "WorkforceEvent" ADD CONSTRAINT event_external_identity CHECK (
  ("externalRecordId" IS NULL) = ("externalRecordType" IS NULL)
);
COMMIT;
