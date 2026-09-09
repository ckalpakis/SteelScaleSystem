-- Additive only. No legacy row updates or backfill. Bound waits on production table locks.
BEGIN;
SET LOCAL lock_timeout = '5s';
-- CreateEnum
CREATE TYPE "OrganizationRole" AS ENUM ('owner', 'admin', 'member', 'viewer');

-- CreateEnum
CREATE TYPE "WorkforceIntegrationProvider" AS ENUM ('zapier', 'generic_webhook', 'ghl');

-- CreateEnum
CREATE TYPE "WorkforceOpportunityStatus" AS ENUM ('open', 'estimate_sent', 'won', 'lost');

-- CreateEnum
CREATE TYPE "WorkforceJobStatus" AS ENUM ('pending', 'running', 'completed', 'dead');

-- CreateEnum
CREATE TYPE "WorkforceActionStatus" AS ENUM ('pending_approval', 'rejected', 'completed', 'blocked');

-- CreateEnum
CREATE TYPE "WorkforceApprovalStatus" AS ENUM ('pending', 'approved', 'rejected', 'expired');

-- CreateTable
CREATE TABLE "Organization" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "legacyClientId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Organization_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrganizationMembership" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "subject" TEXT NOT NULL,
    "role" "OrganizationRole" NOT NULL DEFAULT 'viewer',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OrganizationMembership_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkforceCredential" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "membershipId" UUID,
    "integrationId" UUID,
    "tokenHash" TEXT NOT NULL,
    "scopes" TEXT[],
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WorkforceCredential_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkforceIntegration" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "provider" "WorkforceIntegrationProvider" NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WorkforceIntegration_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkforceCustomer" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "source" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT,
    "phone" TEXT,
    "doNotContact" BOOLEAN NOT NULL DEFAULT false,
    "sourceOccurredAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WorkforceCustomer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkforceOpportunity" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "customerId" UUID NOT NULL,
    "source" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "status" "WorkforceOpportunityStatus" NOT NULL DEFAULT 'open',
    "amountMinor" INTEGER NOT NULL,
    "currency" VARCHAR(3) NOT NULL,
    "lastActivityAt" TIMESTAMP(3) NOT NULL,
    "sourceOccurredAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WorkforceOpportunity_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkforceEvent" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "source" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "payload" JSONB NOT NULL,
    "payloadHash" TEXT NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WorkforceEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkforceJob" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "eventId" UUID NOT NULL,
    "status" "WorkforceJobStatus" NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "availableAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "leaseToken" UUID,
    "leasedUntil" TIMESTAMP(3),
    "lastErrorCode" TEXT,
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WorkforceJob_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkforceAgent" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'revenue_recovery',
    "description" TEXT NOT NULL,
    "config" JSONB NOT NULL,
    "configVersion" INTEGER NOT NULL DEFAULT 1,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WorkforceAgent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkforceRun" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "agentId" UUID NOT NULL,
    "eventId" UUID NOT NULL,
    "configVersion" INTEGER NOT NULL,
    "configSnapshot" JSONB NOT NULL,
    "decision" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WorkforceRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkforceAction" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "runId" UUID NOT NULL,
    "opportunityId" UUID NOT NULL,
    "tool" TEXT NOT NULL,
    "input" JSONB NOT NULL,
    "result" JSONB,
    "policyDecision" JSONB NOT NULL,
    "status" "WorkforceActionStatus" NOT NULL DEFAULT 'pending_approval',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "WorkforceAction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkforceApproval" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "actionId" UUID NOT NULL,
    "status" "WorkforceApprovalStatus" NOT NULL DEFAULT 'pending',
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "decidedBy" TEXT,
    "reason" TEXT,
    "decidedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WorkforceApproval_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkforceAudit" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "actor" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "subjectId" TEXT NOT NULL,
    "details" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WorkforceAudit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WorkforceRevenue" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "opportunityId" UUID NOT NULL,
    "actionId" UUID NOT NULL,
    "externalPaymentId" TEXT NOT NULL,
    "amountMinor" INTEGER NOT NULL,
    "currency" VARCHAR(3) NOT NULL,
    "evidence" TEXT NOT NULL,
    "recordedBy" TEXT NOT NULL,
    "paidAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WorkforceRevenue_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Organization_legacyClientId_key" ON "Organization"("legacyClientId");

-- CreateIndex
CREATE UNIQUE INDEX "OrganizationMembership_organizationId_id_key" ON "OrganizationMembership"("organizationId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "OrganizationMembership_organizationId_subject_key" ON "OrganizationMembership"("organizationId", "subject");

-- CreateIndex
CREATE UNIQUE INDEX "WorkforceCredential_tokenHash_key" ON "WorkforceCredential"("tokenHash");

-- CreateIndex
CREATE INDEX "WorkforceCredential_organizationId_idx" ON "WorkforceCredential"("organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "WorkforceIntegration_organizationId_id_key" ON "WorkforceIntegration"("organizationId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "WorkforceCustomer_organizationId_id_key" ON "WorkforceCustomer"("organizationId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "WorkforceCustomer_organizationId_source_externalId_key" ON "WorkforceCustomer"("organizationId", "source", "externalId");

-- CreateIndex
CREATE INDEX "WorkforceOpportunity_organizationId_status_lastActivityAt_idx" ON "WorkforceOpportunity"("organizationId", "status", "lastActivityAt");

-- CreateIndex
CREATE UNIQUE INDEX "WorkforceOpportunity_organizationId_id_key" ON "WorkforceOpportunity"("organizationId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "WorkforceOpportunity_organizationId_source_externalId_key" ON "WorkforceOpportunity"("organizationId", "source", "externalId");

-- CreateIndex
CREATE INDEX "WorkforceEvent_organizationId_type_occurredAt_idx" ON "WorkforceEvent"("organizationId", "type", "occurredAt");

-- CreateIndex
CREATE UNIQUE INDEX "WorkforceEvent_organizationId_id_key" ON "WorkforceEvent"("organizationId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "WorkforceEvent_organizationId_source_externalId_key" ON "WorkforceEvent"("organizationId", "source", "externalId");

-- CreateIndex
CREATE INDEX "WorkforceJob_status_availableAt_leasedUntil_idx" ON "WorkforceJob"("status", "availableAt", "leasedUntil");

-- CreateIndex
CREATE UNIQUE INDEX "WorkforceJob_organizationId_eventId_key" ON "WorkforceJob"("organizationId", "eventId");

-- CreateIndex
CREATE INDEX "WorkforceAgent_organizationId_enabled_idx" ON "WorkforceAgent"("organizationId", "enabled");

-- CreateIndex
CREATE UNIQUE INDEX "WorkforceAgent_organizationId_id_key" ON "WorkforceAgent"("organizationId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "WorkforceRun_organizationId_id_key" ON "WorkforceRun"("organizationId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "WorkforceRun_organizationId_agentId_eventId_key" ON "WorkforceRun"("organizationId", "agentId", "eventId");

-- CreateIndex
CREATE INDEX "WorkforceAction_organizationId_opportunityId_createdAt_idx" ON "WorkforceAction"("organizationId", "opportunityId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "WorkforceAction_organizationId_id_key" ON "WorkforceAction"("organizationId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "WorkforceAction_organizationId_runId_opportunityId_tool_key" ON "WorkforceAction"("organizationId", "runId", "opportunityId", "tool");

-- CreateIndex
CREATE INDEX "WorkforceApproval_organizationId_status_expiresAt_idx" ON "WorkforceApproval"("organizationId", "status", "expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "WorkforceApproval_organizationId_id_key" ON "WorkforceApproval"("organizationId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "WorkforceApproval_organizationId_actionId_key" ON "WorkforceApproval"("organizationId", "actionId");

-- CreateIndex
CREATE INDEX "WorkforceAudit_organizationId_createdAt_idx" ON "WorkforceAudit"("organizationId", "createdAt");

-- CreateIndex
CREATE INDEX "WorkforceRevenue_organizationId_currency_paidAt_idx" ON "WorkforceRevenue"("organizationId", "currency", "paidAt");

-- CreateIndex
CREATE UNIQUE INDEX "WorkforceRevenue_organizationId_externalPaymentId_key" ON "WorkforceRevenue"("organizationId", "externalPaymentId");

-- AddForeignKey
ALTER TABLE "Organization" ADD CONSTRAINT "Organization_legacyClientId_fkey" FOREIGN KEY ("legacyClientId") REFERENCES "Client"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrganizationMembership" ADD CONSTRAINT "OrganizationMembership_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkforceCredential" ADD CONSTRAINT "WorkforceCredential_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkforceCredential" ADD CONSTRAINT "WorkforceCredential_organizationId_membershipId_fkey" FOREIGN KEY ("organizationId", "membershipId") REFERENCES "OrganizationMembership"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkforceCredential" ADD CONSTRAINT "WorkforceCredential_organizationId_integrationId_fkey" FOREIGN KEY ("organizationId", "integrationId") REFERENCES "WorkforceIntegration"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkforceIntegration" ADD CONSTRAINT "WorkforceIntegration_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkforceCustomer" ADD CONSTRAINT "WorkforceCustomer_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkforceOpportunity" ADD CONSTRAINT "WorkforceOpportunity_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkforceOpportunity" ADD CONSTRAINT "WorkforceOpportunity_organizationId_customerId_fkey" FOREIGN KEY ("organizationId", "customerId") REFERENCES "WorkforceCustomer"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkforceEvent" ADD CONSTRAINT "WorkforceEvent_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkforceJob" ADD CONSTRAINT "WorkforceJob_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkforceJob" ADD CONSTRAINT "WorkforceJob_organizationId_eventId_fkey" FOREIGN KEY ("organizationId", "eventId") REFERENCES "WorkforceEvent"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkforceAgent" ADD CONSTRAINT "WorkforceAgent_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkforceRun" ADD CONSTRAINT "WorkforceRun_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkforceRun" ADD CONSTRAINT "WorkforceRun_organizationId_agentId_fkey" FOREIGN KEY ("organizationId", "agentId") REFERENCES "WorkforceAgent"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkforceRun" ADD CONSTRAINT "WorkforceRun_organizationId_eventId_fkey" FOREIGN KEY ("organizationId", "eventId") REFERENCES "WorkforceEvent"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkforceAction" ADD CONSTRAINT "WorkforceAction_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkforceAction" ADD CONSTRAINT "WorkforceAction_organizationId_runId_fkey" FOREIGN KEY ("organizationId", "runId") REFERENCES "WorkforceRun"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkforceAction" ADD CONSTRAINT "WorkforceAction_organizationId_opportunityId_fkey" FOREIGN KEY ("organizationId", "opportunityId") REFERENCES "WorkforceOpportunity"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkforceApproval" ADD CONSTRAINT "WorkforceApproval_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkforceApproval" ADD CONSTRAINT "WorkforceApproval_organizationId_actionId_fkey" FOREIGN KEY ("organizationId", "actionId") REFERENCES "WorkforceAction"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkforceAudit" ADD CONSTRAINT "WorkforceAudit_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkforceRevenue" ADD CONSTRAINT "WorkforceRevenue_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkforceRevenue" ADD CONSTRAINT "WorkforceRevenue_organizationId_opportunityId_fkey" FOREIGN KEY ("organizationId", "opportunityId") REFERENCES "WorkforceOpportunity"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkforceRevenue" ADD CONSTRAINT "WorkforceRevenue_organizationId_actionId_fkey" FOREIGN KEY ("organizationId", "actionId") REFERENCES "WorkforceAction"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Prisma does not represent these CHECK constraints in its schema language.
ALTER TABLE "WorkforceCredential" ADD CONSTRAINT "workforce_credential_one_owner"
  CHECK (("membershipId" IS NOT NULL) <> ("integrationId" IS NOT NULL));
ALTER TABLE "WorkforceOpportunity" ADD CONSTRAINT "workforce_opportunity_money"
  CHECK ("amountMinor" >= 0 AND currency ~ '^[A-Z]{3}$');
ALTER TABLE "WorkforceRevenue" ADD CONSTRAINT "workforce_revenue_money"
  CHECK ("amountMinor" > 0 AND currency ~ '^[A-Z]{3}$');
COMMIT;
