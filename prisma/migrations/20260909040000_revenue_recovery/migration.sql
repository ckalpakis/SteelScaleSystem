BEGIN;
SET LOCAL lock_timeout = '5s';

ALTER TABLE "AgentVersion" ADD COLUMN     "specialization" JSONB;

ALTER TABLE "Organization" ADD COLUMN     "active" BOOLEAN NOT NULL DEFAULT true;

CREATE TABLE "RecoveryProgram" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "agentId" UUID NOT NULL,
    "runtimeVersionId" UUID NOT NULL,
    "connectionId" UUID,
    "scanCursor" UUID,
    "nextScanAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RecoveryProgram_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "RecoveryCase" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "programId" UUID NOT NULL,
    "opportunityId" UUID NOT NULL,
    "contactId" UUID NOT NULL,
    "conversationId" UUID,
    "pendingRunId" UUID,
    "latestResponseId" UUID,
    "state" TEXT NOT NULL DEFAULT 'monitoring',
    "reason" TEXT,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextDueAt" TIMESTAMP(3),
    "enrolledAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "baselineActivityAt" TIMESTAMP(3) NOT NULL,
    "monitoredValueMinor" INTEGER NOT NULL,
    "currency" VARCHAR(3) NOT NULL,
    "firstDeliveredAt" TIMESTAMP(3),
    "lastDeliveredAt" TIMESTAMP(3),
    "engagedAt" TIMESTAMP(3),
    "employeeActionAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RecoveryCase_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "RecoveryDecision" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "caseId" UUID NOT NULL,
    "runId" UUID NOT NULL,
    "caseRevision" INTEGER NOT NULL,
    "decision" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RecoveryDecision_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "RecoveryHandoff" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "caseId" UUID NOT NULL,
    "assignedMemberId" UUID,
    "status" TEXT NOT NULL DEFAULT 'open',
    "reason" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RecoveryHandoff_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "RecoveryConsent" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "contactId" UUID NOT NULL,
    "channel" TEXT NOT NULL,
    "granted" BOOLEAN NOT NULL DEFAULT false,
    "evidence" TEXT NOT NULL,
    "recordedBy" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RecoveryConsent_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "RecoveryDispatch" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "caseId" UUID NOT NULL,
    "actionId" UUID,
    "requestKey" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "actor" TEXT NOT NULL,
    "caseRevision" INTEGER NOT NULL,
    "runtimeVersionId" UUID NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "transportAttempts" INTEGER NOT NULL DEFAULT 0,
    "availableAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "claimTokenHash" TEXT,
    "claimedUntil" TIMESTAMP(3),
    "providerMessageId" TEXT,
    "receiptHash" TEXT,
    "errorCode" TEXT,
    "deliveredAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RecoveryDispatch_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "RecoveryAttribution" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "caseId" UUID NOT NULL,
    "entityId" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'NOT_ATTRIBUTED',
    "amountMinor" INTEGER NOT NULL DEFAULT 0,
    "currency" VARCHAR(3) NOT NULL,
    "evidence" JSONB NOT NULL,
    "paymentReference" TEXT,
    "reviewedBy" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RecoveryAttribution_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "RecoverySimulation" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "scenarioKey" TEXT,
    "input" JSONB NOT NULL,
    "result" JSONB NOT NULL,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RecoverySimulation_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "RecoveryProgram_organizationId_key" ON "RecoveryProgram"("organizationId");

CREATE UNIQUE INDEX "RecoveryProgram_organizationId_id_key" ON "RecoveryProgram"("organizationId", "id");

CREATE UNIQUE INDEX "RecoveryProgram_organizationId_agentId_key" ON "RecoveryProgram"("organizationId", "agentId");

CREATE INDEX "RecoveryCase_organizationId_state_nextDueAt_idx" ON "RecoveryCase"("organizationId", "state", "nextDueAt");

CREATE INDEX "RecoveryCase_organizationId_contactId_idx" ON "RecoveryCase"("organizationId", "contactId");

CREATE INDEX "RecoveryCase_organizationId_conversationId_idx" ON "RecoveryCase"("organizationId", "conversationId");

CREATE UNIQUE INDEX "RecoveryCase_organizationId_id_key" ON "RecoveryCase"("organizationId", "id");

CREATE UNIQUE INDEX "RecoveryCase_organizationId_opportunityId_key" ON "RecoveryCase"("organizationId", "opportunityId");

CREATE UNIQUE INDEX "RecoveryDecision_organizationId_id_key" ON "RecoveryDecision"("organizationId", "id");

CREATE UNIQUE INDEX "RecoveryDecision_organizationId_runId_key" ON "RecoveryDecision"("organizationId", "runId");

CREATE INDEX "RecoveryHandoff_organizationId_status_updatedAt_idx" ON "RecoveryHandoff"("organizationId", "status", "updatedAt");

CREATE UNIQUE INDEX "RecoveryHandoff_organizationId_id_key" ON "RecoveryHandoff"("organizationId", "id");

CREATE UNIQUE INDEX "RecoveryHandoff_organizationId_caseId_key" ON "RecoveryHandoff"("organizationId", "caseId");

CREATE UNIQUE INDEX "RecoveryConsent_organizationId_contactId_channel_key" ON "RecoveryConsent"("organizationId", "contactId", "channel");

CREATE INDEX "RecoveryDispatch_organizationId_status_availableAt_idx" ON "RecoveryDispatch"("organizationId", "status", "availableAt");

CREATE UNIQUE INDEX "RecoveryDispatch_organizationId_id_key" ON "RecoveryDispatch"("organizationId", "id");

CREATE UNIQUE INDEX "RecoveryDispatch_organizationId_actionId_key" ON "RecoveryDispatch"("organizationId", "actionId");

CREATE UNIQUE INDEX "RecoveryDispatch_organizationId_requestKey_key" ON "RecoveryDispatch"("organizationId", "requestKey");

CREATE UNIQUE INDEX "RecoveryDispatch_organizationId_providerMessageId_key" ON "RecoveryDispatch"("organizationId", "providerMessageId");

CREATE UNIQUE INDEX "RecoveryAttribution_organizationId_id_key" ON "RecoveryAttribution"("organizationId", "id");

CREATE UNIQUE INDEX "RecoveryAttribution_organizationId_kind_entityId_key" ON "RecoveryAttribution"("organizationId", "kind", "entityId");

CREATE UNIQUE INDEX "RecoveryAttribution_organizationId_paymentReference_key" ON "RecoveryAttribution"("organizationId", "paymentReference");

CREATE INDEX "RecoverySimulation_organizationId_createdAt_idx" ON "RecoverySimulation"("organizationId", "createdAt");

ALTER TABLE "RecoveryProgram" ADD CONSTRAINT "RecoveryProgram_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "RecoveryProgram" ADD CONSTRAINT "RecoveryProgram_organizationId_agentId_fkey" FOREIGN KEY ("organizationId", "agentId") REFERENCES "WorkforceAgent"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "RecoveryProgram" ADD CONSTRAINT "RecoveryProgram_organizationId_runtimeVersionId_fkey" FOREIGN KEY ("organizationId", "runtimeVersionId") REFERENCES "AgentVersion"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "RecoveryProgram" ADD CONSTRAINT "RecoveryProgram_organizationId_connectionId_fkey" FOREIGN KEY ("organizationId", "connectionId") REFERENCES "WorkforceIntegration"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "RecoveryCase" ADD CONSTRAINT "RecoveryCase_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "RecoveryCase" ADD CONSTRAINT "RecoveryCase_organizationId_programId_fkey" FOREIGN KEY ("organizationId", "programId") REFERENCES "RecoveryProgram"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "RecoveryCase" ADD CONSTRAINT "RecoveryCase_organizationId_opportunityId_fkey" FOREIGN KEY ("organizationId", "opportunityId") REFERENCES "WorkforceOpportunity"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "RecoveryCase" ADD CONSTRAINT "RecoveryCase_organizationId_contactId_fkey" FOREIGN KEY ("organizationId", "contactId") REFERENCES "WorkforceCustomer"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "RecoveryCase" ADD CONSTRAINT "RecoveryCase_organizationId_conversationId_fkey" FOREIGN KEY ("organizationId", "conversationId") REFERENCES "Conversation"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "RecoveryCase" ADD CONSTRAINT "RecoveryCase_organizationId_pendingRunId_fkey" FOREIGN KEY ("organizationId", "pendingRunId") REFERENCES "AgentRun"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "RecoveryCase" ADD CONSTRAINT "RecoveryCase_organizationId_latestResponseId_fkey" FOREIGN KEY ("organizationId", "latestResponseId") REFERENCES "Message"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "RecoveryDecision" ADD CONSTRAINT "RecoveryDecision_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "RecoveryDecision" ADD CONSTRAINT "RecoveryDecision_organizationId_caseId_fkey" FOREIGN KEY ("organizationId", "caseId") REFERENCES "RecoveryCase"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "RecoveryDecision" ADD CONSTRAINT "RecoveryDecision_organizationId_runId_fkey" FOREIGN KEY ("organizationId", "runId") REFERENCES "AgentRun"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "RecoveryHandoff" ADD CONSTRAINT "RecoveryHandoff_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "RecoveryHandoff" ADD CONSTRAINT "RecoveryHandoff_organizationId_caseId_fkey" FOREIGN KEY ("organizationId", "caseId") REFERENCES "RecoveryCase"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "RecoveryHandoff" ADD CONSTRAINT "RecoveryHandoff_organizationId_assignedMemberId_fkey" FOREIGN KEY ("organizationId", "assignedMemberId") REFERENCES "OrganizationMembership"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "RecoveryConsent" ADD CONSTRAINT "RecoveryConsent_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "RecoveryConsent" ADD CONSTRAINT "RecoveryConsent_organizationId_contactId_fkey" FOREIGN KEY ("organizationId", "contactId") REFERENCES "WorkforceCustomer"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "RecoveryDispatch" ADD CONSTRAINT "RecoveryDispatch_organizationId_runtimeVersionId_fkey" FOREIGN KEY ("organizationId", "runtimeVersionId") REFERENCES "AgentVersion"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "RecoveryDispatch" ADD CONSTRAINT "RecoveryDispatch_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "RecoveryDispatch" ADD CONSTRAINT "RecoveryDispatch_organizationId_caseId_fkey" FOREIGN KEY ("organizationId", "caseId") REFERENCES "RecoveryCase"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "RecoveryDispatch" ADD CONSTRAINT "RecoveryDispatch_organizationId_actionId_fkey" FOREIGN KEY ("organizationId", "actionId") REFERENCES "AgentAction"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "RecoveryAttribution" ADD CONSTRAINT "RecoveryAttribution_organizationId_entityId_fkey" FOREIGN KEY ("organizationId", "entityId") REFERENCES "CrmRecord"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "RecoveryAttribution" ADD CONSTRAINT "RecoveryAttribution_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "RecoveryAttribution" ADD CONSTRAINT "RecoveryAttribution_organizationId_caseId_fkey" FOREIGN KEY ("organizationId", "caseId") REFERENCES "RecoveryCase"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "RecoverySimulation" ADD CONSTRAINT "RecoverySimulation_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE UNIQUE INDEX "RecoveryDispatch_one_unresolved_case" ON "RecoveryDispatch" ("organizationId","caseId") WHERE status IN ('pending','dispatching','unknown');

ALTER TABLE "RecoveryCase" ADD CONSTRAINT "RecoveryCase_limits" CHECK (attempts BETWEEN 0 AND 20 AND revision > 0 AND "monitoredValueMinor" >= 0), ADD CONSTRAINT "RecoveryCase_state" CHECK (state IN ('monitoring','working','awaiting_classification','handoff','human_owned','engaged','declined','opted_out','exhausted','ineligible','won','lost','appointment_booked','closed'));

ALTER TABLE "RecoveryDispatch" ADD CONSTRAINT "RecoveryDispatch_state" CHECK (status IN ('pending','dispatching','delivered','unknown','failed','cancelled')), ADD CONSTRAINT "RecoveryDispatch_limits" CHECK ("transportAttempts" BETWEEN 0 AND 3 AND "caseRevision" > 0 AND channel IN ('sms','email'));

ALTER TABLE "RecoveryConsent" ADD CONSTRAINT "RecoveryConsent_channel" CHECK (channel IN ('sms','email'));

ALTER TABLE "RecoveryHandoff" ADD CONSTRAINT "RecoveryHandoff_status" CHECK (status IN ('open','owned','returned','closed') AND revision > 0);

ALTER TABLE "RecoveryAttribution" ADD CONSTRAINT "RecoveryAttribution_status" CHECK (status IN ('AI_ASSISTED','AI_RECOVERED','UNCERTAIN','NOT_ATTRIBUTED') AND kind IN ('opportunity','appointment') AND "amountMinor" >= 0 AND (status='AI_RECOVERED' OR "amountMinor"=0));
COMMIT;

