BEGIN;
SET LOCAL lock_timeout = '5s';

-- CreateTable
CREATE TABLE "AgentVersion" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "agentId" UUID NOT NULL,
    "number" INTEGER NOT NULL,
    "definition" JSONB NOT NULL,
    "definitionHash" TEXT NOT NULL,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AgentVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgentGoal" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "versionId" UUID NOT NULL,
    "objective" TEXT NOT NULL,
    "successCriteria" JSONB NOT NULL,

    CONSTRAINT "AgentGoal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgentTrigger" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "versionId" UUID NOT NULL,
    "eventType" TEXT NOT NULL,

    CONSTRAINT "AgentTrigger_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgentPolicy" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "versionId" UUID NOT NULL,
    "rules" JSONB NOT NULL,

    CONSTRAINT "AgentPolicy_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgentToolPermission" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "versionId" UUID NOT NULL,
    "tool" TEXT NOT NULL,
    "automatic" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "AgentToolPermission_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgentEscalationRule" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "versionId" UUID NOT NULL,
    "condition" TEXT NOT NULL,
    "outcome" TEXT NOT NULL,

    CONSTRAINT "AgentEscalationRule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgentRun" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "agentId" UUID NOT NULL,
    "versionId" UUID NOT NULL,
    "eventId" UUID,
    "subjectId" UUID NOT NULL,
    "triggerKey" TEXT NOT NULL,
    "trigger" JSONB NOT NULL,
    "correlationId" UUID NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "stepCount" INTEGER NOT NULL DEFAULT 0,
    "actionCount" INTEGER NOT NULL DEFAULT 0,
    "availableAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "leaseToken" UUID,
    "leasedUntil" TIMESTAMP(3),
    "startedAt" TIMESTAMP(3),
    "deadlineAt" TIMESTAMP(3) NOT NULL,
    "completedAt" TIMESTAMP(3),
    "errorCode" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AgentRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgentStep" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "runId" UUID NOT NULL,
    "sequence" INTEGER NOT NULL,
    "context" JSONB NOT NULL,
    "decision" JSONB,
    "policyResult" JSONB,
    "result" JSONB,
    "provider" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'planning',
    "errorCode" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "AgentStep_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgentAction" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "agentId" UUID NOT NULL,
    "runId" UUID NOT NULL,
    "sequence" INTEGER NOT NULL,
    "tool" TEXT NOT NULL,
    "input" JSONB NOT NULL,
    "deduplicationKey" TEXT NOT NULL,
    "subjectVersion" INTEGER NOT NULL,
    "contextFingerprint" TEXT NOT NULL,
    "policyResult" JSONB NOT NULL,
    "status" TEXT NOT NULL,
    "result" JSONB,
    "errorCode" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "AgentAction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HumanApproval" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "actionId" UUID NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "decidedAt" TIMESTAMP(3),
    "decidedBy" TEXT,
    "reason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "HumanApproval_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgentResult" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "runId" UUID NOT NULL,
    "outcome" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "evidence" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AgentResult_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgentSchedule" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "agentId" UUID NOT NULL,
    "subjectId" UUID NOT NULL,
    "nextRunAt" TIMESTAMP(3) NOT NULL,
    "intervalMinutes" INTEGER,
    "remainingRuns" INTEGER NOT NULL DEFAULT 1,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AgentSchedule_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AgentVersion_organizationId_id_key" ON "AgentVersion"("organizationId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "AgentVersion_organizationId_agentId_number_key" ON "AgentVersion"("organizationId", "agentId", "number");

-- CreateIndex
CREATE UNIQUE INDEX "AgentVersion_organizationId_agentId_id_key" ON "AgentVersion"("organizationId", "agentId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "AgentTrigger_organizationId_versionId_eventType_key" ON "AgentTrigger"("organizationId", "versionId", "eventType");

-- CreateIndex
CREATE UNIQUE INDEX "AgentPolicy_organizationId_versionId_key" ON "AgentPolicy"("organizationId", "versionId");

-- CreateIndex
CREATE UNIQUE INDEX "AgentToolPermission_organizationId_versionId_tool_key" ON "AgentToolPermission"("organizationId", "versionId", "tool");

-- CreateIndex
CREATE UNIQUE INDEX "AgentEscalationRule_organizationId_versionId_condition_key" ON "AgentEscalationRule"("organizationId", "versionId", "condition");

-- CreateIndex
CREATE INDEX "AgentRun_status_availableAt_leasedUntil_idx" ON "AgentRun"("status", "availableAt", "leasedUntil");

-- CreateIndex
CREATE INDEX "AgentRun_organizationId_agentId_createdAt_idx" ON "AgentRun"("organizationId", "agentId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "AgentRun_organizationId_id_key" ON "AgentRun"("organizationId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "AgentRun_organizationId_agentId_triggerKey_key" ON "AgentRun"("organizationId", "agentId", "triggerKey");

-- CreateIndex
CREATE UNIQUE INDEX "AgentStep_organizationId_runId_sequence_key" ON "AgentStep"("organizationId", "runId", "sequence");

-- CreateIndex
CREATE INDEX "AgentAction_organizationId_status_createdAt_idx" ON "AgentAction"("organizationId", "status", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "AgentAction_organizationId_id_key" ON "AgentAction"("organizationId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "AgentAction_organizationId_agentId_deduplicationKey_key" ON "AgentAction"("organizationId", "agentId", "deduplicationKey");

-- CreateIndex
CREATE UNIQUE INDEX "AgentAction_organizationId_runId_sequence_key" ON "AgentAction"("organizationId", "runId", "sequence");

-- CreateIndex
CREATE INDEX "HumanApproval_organizationId_status_expiresAt_idx" ON "HumanApproval"("organizationId", "status", "expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "HumanApproval_organizationId_id_key" ON "HumanApproval"("organizationId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "HumanApproval_organizationId_actionId_key" ON "HumanApproval"("organizationId", "actionId");

-- CreateIndex
CREATE UNIQUE INDEX "AgentResult_organizationId_runId_key" ON "AgentResult"("organizationId", "runId");

-- CreateIndex
CREATE INDEX "AgentSchedule_enabled_nextRunAt_idx" ON "AgentSchedule"("enabled", "nextRunAt");

-- CreateIndex
CREATE UNIQUE INDEX "AgentSchedule_organizationId_id_key" ON "AgentSchedule"("organizationId", "id");

-- AddForeignKey
ALTER TABLE "AgentVersion" ADD CONSTRAINT "AgentVersion_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentVersion" ADD CONSTRAINT "AgentVersion_organizationId_agentId_fkey" FOREIGN KEY ("organizationId", "agentId") REFERENCES "WorkforceAgent"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentGoal" ADD CONSTRAINT "AgentGoal_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentGoal" ADD CONSTRAINT "AgentGoal_organizationId_versionId_fkey" FOREIGN KEY ("organizationId", "versionId") REFERENCES "AgentVersion"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentTrigger" ADD CONSTRAINT "AgentTrigger_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentTrigger" ADD CONSTRAINT "AgentTrigger_organizationId_versionId_fkey" FOREIGN KEY ("organizationId", "versionId") REFERENCES "AgentVersion"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentPolicy" ADD CONSTRAINT "AgentPolicy_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentPolicy" ADD CONSTRAINT "AgentPolicy_organizationId_versionId_fkey" FOREIGN KEY ("organizationId", "versionId") REFERENCES "AgentVersion"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentToolPermission" ADD CONSTRAINT "AgentToolPermission_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentToolPermission" ADD CONSTRAINT "AgentToolPermission_organizationId_versionId_fkey" FOREIGN KEY ("organizationId", "versionId") REFERENCES "AgentVersion"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentEscalationRule" ADD CONSTRAINT "AgentEscalationRule_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentEscalationRule" ADD CONSTRAINT "AgentEscalationRule_organizationId_versionId_fkey" FOREIGN KEY ("organizationId", "versionId") REFERENCES "AgentVersion"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentRun" ADD CONSTRAINT "AgentRun_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentRun" ADD CONSTRAINT "AgentRun_organizationId_agentId_fkey" FOREIGN KEY ("organizationId", "agentId") REFERENCES "WorkforceAgent"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentRun" ADD CONSTRAINT "AgentRun_organizationId_agentId_versionId_fkey" FOREIGN KEY ("organizationId", "agentId", "versionId") REFERENCES "AgentVersion"("organizationId", "agentId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentRun" ADD CONSTRAINT "AgentRun_organizationId_eventId_fkey" FOREIGN KEY ("organizationId", "eventId") REFERENCES "WorkforceEvent"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentRun" ADD CONSTRAINT "AgentRun_organizationId_subjectId_fkey" FOREIGN KEY ("organizationId", "subjectId") REFERENCES "CrmRecord"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentStep" ADD CONSTRAINT "AgentStep_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentStep" ADD CONSTRAINT "AgentStep_organizationId_runId_fkey" FOREIGN KEY ("organizationId", "runId") REFERENCES "AgentRun"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentAction" ADD CONSTRAINT "AgentAction_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentAction" ADD CONSTRAINT "AgentAction_organizationId_agentId_fkey" FOREIGN KEY ("organizationId", "agentId") REFERENCES "WorkforceAgent"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentAction" ADD CONSTRAINT "AgentAction_organizationId_runId_fkey" FOREIGN KEY ("organizationId", "runId") REFERENCES "AgentRun"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HumanApproval" ADD CONSTRAINT "HumanApproval_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HumanApproval" ADD CONSTRAINT "HumanApproval_organizationId_actionId_fkey" FOREIGN KEY ("organizationId", "actionId") REFERENCES "AgentAction"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentResult" ADD CONSTRAINT "AgentResult_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentResult" ADD CONSTRAINT "AgentResult_organizationId_runId_fkey" FOREIGN KEY ("organizationId", "runId") REFERENCES "AgentRun"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentSchedule" ADD CONSTRAINT "AgentSchedule_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentSchedule" ADD CONSTRAINT "AgentSchedule_organizationId_agentId_fkey" FOREIGN KEY ("organizationId", "agentId") REFERENCES "WorkforceAgent"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentSchedule" ADD CONSTRAINT "AgentSchedule_organizationId_subjectId_fkey" FOREIGN KEY ("organizationId", "subjectId") REFERENCES "CrmRecord"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "AgentVersion" ADD CONSTRAINT "AgentVersion_number_check" CHECK ("number" > 0);
ALTER TABLE "AgentRun" ADD CONSTRAINT "AgentRun_state_check" CHECK (status IN ('pending','running','waiting_approval','completed','failed','stopped','skipped')),
 ADD CONSTRAINT "AgentRun_budget_check" CHECK ("stepCount" BETWEEN 0 AND 12 AND "actionCount" BETWEEN 0 AND 6),
 ADD CONSTRAINT "AgentRun_lease_check" CHECK ((status = 'running') = ("leaseToken" IS NOT NULL AND "leasedUntil" IS NOT NULL));
ALTER TABLE "AgentAction" ADD CONSTRAINT "AgentAction_state_check" CHECK (status IN ('pending_approval','completed','blocked','recommended','rejected'));
ALTER TABLE "HumanApproval" ADD CONSTRAINT "HumanApproval_state_check" CHECK (status IN ('pending','approved','rejected','expired'));
ALTER TABLE "AgentSchedule" ADD CONSTRAINT "AgentSchedule_bounds_check" CHECK ("remainingRuns" BETWEEN 0 AND 20 AND ("intervalMinutes" IS NULL OR "intervalMinutes" BETWEEN 15 AND 525600));
COMMIT;
