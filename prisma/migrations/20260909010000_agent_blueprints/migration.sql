BEGIN;
SET LOCAL lock_timeout = '5s';

-- CreateTable
CREATE TABLE "AgentBlueprint" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "currentVersion" INTEGER NOT NULL DEFAULT 1,
    "agentId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AgentBlueprint_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgentBlueprintVersion" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "blueprintId" UUID NOT NULL,
    "number" INTEGER NOT NULL,
    "specification" JSONB NOT NULL,
    "specificationHash" TEXT NOT NULL,
    "sourceText" TEXT,
    "origin" TEXT NOT NULL,
    "provider" TEXT,
    "model" TEXT,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "activatedAt" TIMESTAMP(3),
    "activatedBy" TEXT,
    "runtimeVersionId" UUID,

    CONSTRAINT "AgentBlueprintVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgentBlueprintTest" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "versionId" UUID NOT NULL,
    "compilerVersion" TEXT NOT NULL,
    "specificationHash" TEXT NOT NULL,
    "scenario" JSONB NOT NULL,
    "report" JSONB NOT NULL,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AgentBlueprintTest_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgentBlueprintGeneration" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "requestKey" TEXT NOT NULL,
    "requestHash" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'running',
    "errorCode" TEXT,
    "versionId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "AgentBlueprintGeneration_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AgentBlueprint_organizationId_id_key" ON "AgentBlueprint"("organizationId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "AgentBlueprint_organizationId_agentId_key" ON "AgentBlueprint"("organizationId", "agentId");

-- CreateIndex
CREATE UNIQUE INDEX "AgentBlueprintVersion_organizationId_id_key" ON "AgentBlueprintVersion"("organizationId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "AgentBlueprintVersion_organizationId_blueprintId_number_key" ON "AgentBlueprintVersion"("organizationId", "blueprintId", "number");

-- CreateIndex
CREATE INDEX "AgentBlueprintTest_organizationId_versionId_createdAt_idx" ON "AgentBlueprintTest"("organizationId", "versionId", "createdAt");

-- CreateIndex
CREATE INDEX "AgentBlueprintGeneration_organizationId_createdAt_idx" ON "AgentBlueprintGeneration"("organizationId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "AgentBlueprintGeneration_organizationId_requestKey_key" ON "AgentBlueprintGeneration"("organizationId", "requestKey");

-- AddForeignKey
ALTER TABLE "AgentBlueprint" ADD CONSTRAINT "AgentBlueprint_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentBlueprint" ADD CONSTRAINT "AgentBlueprint_organizationId_agentId_fkey" FOREIGN KEY ("organizationId", "agentId") REFERENCES "WorkforceAgent"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentBlueprintVersion" ADD CONSTRAINT "AgentBlueprintVersion_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentBlueprintVersion" ADD CONSTRAINT "AgentBlueprintVersion_organizationId_blueprintId_fkey" FOREIGN KEY ("organizationId", "blueprintId") REFERENCES "AgentBlueprint"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentBlueprintVersion" ADD CONSTRAINT "AgentBlueprintVersion_organizationId_runtimeVersionId_fkey" FOREIGN KEY ("organizationId", "runtimeVersionId") REFERENCES "AgentVersion"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentBlueprintTest" ADD CONSTRAINT "AgentBlueprintTest_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentBlueprintTest" ADD CONSTRAINT "AgentBlueprintTest_organizationId_versionId_fkey" FOREIGN KEY ("organizationId", "versionId") REFERENCES "AgentBlueprintVersion"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentBlueprintGeneration" ADD CONSTRAINT "AgentBlueprintGeneration_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentBlueprintGeneration" ADD CONSTRAINT "AgentBlueprintGeneration_organizationId_versionId_fkey" FOREIGN KEY ("organizationId", "versionId") REFERENCES "AgentBlueprintVersion"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "AgentBlueprint" ADD CONSTRAINT "AgentBlueprint_version_check" CHECK ("currentVersion" BETWEEN 1 AND 100);
ALTER TABLE "AgentBlueprintVersion" ADD CONSTRAINT "AgentBlueprintVersion_number_check" CHECK ("number" BETWEEN 1 AND 100),
 ADD CONSTRAINT "AgentBlueprintVersion_origin_check" CHECK ("origin" IN ('manual','ai')),
 ADD CONSTRAINT "AgentBlueprintVersion_activation_check" CHECK (("activatedAt" IS NULL AND "activatedBy" IS NULL AND "runtimeVersionId" IS NULL) OR ("activatedAt" IS NOT NULL AND "activatedBy" IS NOT NULL AND "runtimeVersionId" IS NOT NULL));
ALTER TABLE "AgentBlueprintGeneration" ADD CONSTRAINT "AgentBlueprintGeneration_status_check" CHECK ("status" IN ('running','completed','failed'));
COMMIT;
