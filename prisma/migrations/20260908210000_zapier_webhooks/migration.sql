BEGIN;
SET LOCAL lock_timeout = '5s';

-- AlterTable
ALTER TABLE "WorkforceIntegration" ADD COLUMN     "webhookMapping" JSONB;

-- CreateTable
CREATE TABLE "WebhookEndpoint" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "host" TEXT NOT NULL,
    "encryptedUrl" TEXT NOT NULL,
    "encryptedSecret" TEXT NOT NULL,
    "events" TEXT[],
    "includeExternal" BOOLEAN NOT NULL DEFAULT false,
    "includeContactData" BOOLEAN NOT NULL DEFAULT false,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WebhookEndpoint_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OutboundDelivery" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "endpointId" UUID NOT NULL,
    "eventId" UUID,
    "deduplicationKey" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "attemptsAllowed" INTEGER NOT NULL DEFAULT 8,
    "availableAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "leaseToken" UUID,
    "leasedUntil" TIMESTAMP(3),
    "lastErrorCode" TEXT,
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OutboundDelivery_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OutboundAttempt" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "deliveryId" UUID NOT NULL,
    "attempt" INTEGER NOT NULL,
    "statusCode" INTEGER,
    "errorCode" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OutboundAttempt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IntegrationActivity" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "connectionId" UUID NOT NULL,
    "payloadHash" TEXT NOT NULL,
    "summary" JSONB NOT NULL,
    "statusCode" INTEGER NOT NULL,
    "code" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "IntegrationActivity_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrganizationWebhookLimit" (
    "organizationId" UUID NOT NULL,
    "window" TIMESTAMP(3) NOT NULL,
    "count" INTEGER NOT NULL,

    CONSTRAINT "OrganizationWebhookLimit_pkey" PRIMARY KEY ("organizationId")
);

-- CreateIndex
CREATE UNIQUE INDEX "WebhookEndpoint_organizationId_id_key" ON "WebhookEndpoint"("organizationId", "id");

-- CreateIndex
CREATE INDEX "OutboundDelivery_status_availableAt_idx" ON "OutboundDelivery"("status", "availableAt");

-- CreateIndex
CREATE INDEX "OutboundDelivery_organizationId_createdAt_idx" ON "OutboundDelivery"("organizationId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "OutboundDelivery_organizationId_id_key" ON "OutboundDelivery"("organizationId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "OutboundDelivery_organizationId_endpointId_deduplicationKey_key" ON "OutboundDelivery"("organizationId", "endpointId", "deduplicationKey");

-- CreateIndex
CREATE UNIQUE INDEX "OutboundAttempt_organizationId_deliveryId_attempt_key" ON "OutboundAttempt"("organizationId", "deliveryId", "attempt");

-- CreateIndex
CREATE INDEX "IntegrationActivity_organizationId_createdAt_idx" ON "IntegrationActivity"("organizationId", "createdAt");

-- AddForeignKey
ALTER TABLE "WebhookEndpoint" ADD CONSTRAINT "WebhookEndpoint_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OutboundDelivery" ADD CONSTRAINT "OutboundDelivery_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OutboundDelivery" ADD CONSTRAINT "OutboundDelivery_organizationId_endpointId_fkey" FOREIGN KEY ("organizationId", "endpointId") REFERENCES "WebhookEndpoint"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OutboundDelivery" ADD CONSTRAINT "OutboundDelivery_organizationId_eventId_fkey" FOREIGN KEY ("organizationId", "eventId") REFERENCES "WorkforceEvent"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OutboundAttempt" ADD CONSTRAINT "OutboundAttempt_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OutboundAttempt" ADD CONSTRAINT "OutboundAttempt_organizationId_deliveryId_fkey" FOREIGN KEY ("organizationId", "deliveryId") REFERENCES "OutboundDelivery"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IntegrationActivity" ADD CONSTRAINT "IntegrationActivity_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IntegrationActivity" ADD CONSTRAINT "IntegrationActivity_organizationId_connectionId_fkey" FOREIGN KEY ("organizationId", "connectionId") REFERENCES "WorkforceIntegration"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrganizationWebhookLimit" ADD CONSTRAINT "OrganizationWebhookLimit_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


ALTER TABLE "OutboundDelivery" ADD CONSTRAINT outbound_state CHECK (status IN ('pending','running','succeeded','dead') AND attempts >= 0 AND "attemptsAllowed" >= 1);
ALTER TABLE "OutboundDelivery" ADD CONSTRAINT outbound_lease CHECK ((status = 'running') = ("leaseToken" IS NOT NULL AND "leasedUntil" IS NOT NULL));
ALTER TABLE "OutboundAttempt" ADD CONSTRAINT outbound_attempt_positive CHECK (attempt > 0);
COMMIT;

