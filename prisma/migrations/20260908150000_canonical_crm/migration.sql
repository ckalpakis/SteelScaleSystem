-- Canonical CRM expansion. Existing tables and record IDs are preserved.
BEGIN;
SET LOCAL lock_timeout = '5s';
-- CreateEnum
CREATE TYPE "CrmEntityType" AS ENUM ('contact', 'company', 'opportunity', 'pipeline', 'pipeline_stage', 'estimate', 'appointment', 'task', 'note', 'conversation', 'message', 'tag');

-- CreateEnum
CREATE TYPE "StageOutcome" AS ENUM ('open', 'won', 'lost');

-- CreateEnum
CREATE TYPE "EstimateStatus" AS ENUM ('draft', 'sent', 'accepted', 'declined', 'expired');

-- CreateEnum
CREATE TYPE "AppointmentStatus" AS ENUM ('scheduled', 'completed', 'cancelled', 'no_show');

-- CreateEnum
CREATE TYPE "TaskStatus" AS ENUM ('open', 'in_progress', 'completed', 'cancelled');

-- CreateEnum
CREATE TYPE "TaskPriority" AS ENUM ('low', 'normal', 'high', 'urgent');

-- CreateEnum
CREATE TYPE "ConversationChannel" AS ENUM ('email', 'sms', 'phone', 'web', 'other');

-- CreateEnum
CREATE TYPE "ConversationStatus" AS ENUM ('open', 'closed');

-- CreateEnum
CREATE TYPE "MessageDirection" AS ENUM ('inbound', 'outbound', 'internal');

-- CreateEnum
CREATE TYPE "MessageStatus" AS ENUM ('recorded', 'draft', 'sent', 'delivered', 'failed');

-- CreateEnum
CREATE TYPE "CustomFieldType" AS ENUM ('text', 'number', 'boolean', 'date', 'single_select', 'multi_select');

-- AlterTable
ALTER TABLE "Organization" ADD COLUMN     "defaultCurrency" VARCHAR(3) NOT NULL DEFAULT 'USD',
ADD COLUMN     "timezone" TEXT NOT NULL DEFAULT 'UTC';

-- AlterTable
ALTER TABLE "OrganizationMembership" ADD COLUMN     "displayName" TEXT,
ADD COLUMN     "userId" UUID;

-- AlterTable
ALTER TABLE "WorkforceIntegration" ALTER COLUMN "provider" TYPE TEXT USING "provider"::text;

-- AlterTable
ALTER TABLE "WorkforceCustomer" ADD COLUMN     "companyId" UUID,
ADD COLUMN     "entityType" "CrmEntityType" NOT NULL DEFAULT 'contact',
ADD COLUMN     "firstName" TEXT,
ADD COLUMN     "lastName" TEXT,
ALTER COLUMN "source" DROP NOT NULL,
ALTER COLUMN "externalId" DROP NOT NULL,
ALTER COLUMN "sourceOccurredAt" DROP NOT NULL;

-- AlterTable
ALTER TABLE "WorkforceOpportunity" ADD COLUMN     "companyId" UUID,
ADD COLUMN     "entityType" "CrmEntityType" NOT NULL DEFAULT 'opportunity',
ADD COLUMN     "pipelineId" UUID,
ADD COLUMN     "stageId" UUID,
ALTER COLUMN "source" DROP NOT NULL,
ALTER COLUMN "externalId" DROP NOT NULL,
ALTER COLUMN "sourceOccurredAt" DROP NOT NULL;

-- CreateTable
CREATE TABLE "Company" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "entityType" "CrmEntityType" NOT NULL DEFAULT 'company',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "name" TEXT NOT NULL,
    "domain" TEXT,
    "email" TEXT,
    "phone" TEXT,

    CONSTRAINT "Company_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Pipeline" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "entityType" "CrmEntityType" NOT NULL DEFAULT 'pipeline',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,

    CONSTRAINT "Pipeline_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PipelineStage" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "entityType" "CrmEntityType" NOT NULL DEFAULT 'pipeline_stage',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "pipelineId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "outcome" "StageOutcome" NOT NULL DEFAULT 'open',

    CONSTRAINT "PipelineStage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Estimate" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "entityType" "CrmEntityType" NOT NULL DEFAULT 'estimate',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "opportunityId" UUID NOT NULL,
    "number" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "status" "EstimateStatus" NOT NULL DEFAULT 'draft',
    "amountMinor" INTEGER NOT NULL,
    "currency" VARCHAR(3) NOT NULL,
    "issuedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),
    "acceptedAt" TIMESTAMP(3),

    CONSTRAINT "Estimate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Appointment" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "entityType" "CrmEntityType" NOT NULL DEFAULT 'appointment',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "contactId" UUID NOT NULL,
    "opportunityId" UUID,
    "title" TEXT NOT NULL,
    "startsAt" TIMESTAMP(3) NOT NULL,
    "endsAt" TIMESTAMP(3) NOT NULL,
    "timezone" TEXT NOT NULL,
    "location" TEXT,
    "status" "AppointmentStatus" NOT NULL DEFAULT 'scheduled',

    CONSTRAINT "Appointment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Task" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "entityType" "CrmEntityType" NOT NULL DEFAULT 'task',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "status" "TaskStatus" NOT NULL DEFAULT 'open',
    "priority" "TaskPriority" NOT NULL DEFAULT 'normal',
    "dueAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "relatedRecordId" UUID,

    CONSTRAINT "Task_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Note" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "entityType" "CrmEntityType" NOT NULL DEFAULT 'note',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "body" TEXT NOT NULL,
    "relatedRecordId" UUID NOT NULL,

    CONSTRAINT "Note_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Conversation" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "entityType" "CrmEntityType" NOT NULL DEFAULT 'conversation',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "contactId" UUID NOT NULL,
    "subject" TEXT NOT NULL,
    "channel" "ConversationChannel" NOT NULL,
    "status" "ConversationStatus" NOT NULL DEFAULT 'open',

    CONSTRAINT "Conversation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Message" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "entityType" "CrmEntityType" NOT NULL DEFAULT 'message',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "conversationId" UUID NOT NULL,
    "direction" "MessageDirection" NOT NULL,
    "body" TEXT NOT NULL,
    "status" "MessageStatus" NOT NULL DEFAULT 'recorded',
    "occurredAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Message_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Tag" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "entityType" "CrmEntityType" NOT NULL DEFAULT 'tag',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "name" TEXT NOT NULL,
    "color" TEXT NOT NULL DEFAULT '#526174',

    CONSTRAINT "Tag_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "User" (
    "id" UUID NOT NULL,
    "externalSubject" TEXT NOT NULL,
    "name" TEXT,
    "email" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CrmRecord" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "entityType" "CrmEntityType" NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "archivedAt" TIMESTAMP(3),
    "assignedMemberId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CrmRecord_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExternalRecordMapping" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "connectionId" UUID NOT NULL,
    "provider" TEXT NOT NULL,
    "externalRecordType" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "internalEntityType" "CrmEntityType" NOT NULL,
    "internalEntityId" UUID NOT NULL,
    "sourceUpdatedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ExternalRecordMapping_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CustomFieldDefinition" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "entityType" "CrmEntityType" NOT NULL,
    "key" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "fieldType" "CustomFieldType" NOT NULL,
    "required" BOOLEAN NOT NULL DEFAULT false,
    "options" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "archivedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CustomFieldDefinition_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CustomFieldValue" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "definitionId" UUID NOT NULL,
    "recordId" UUID NOT NULL,
    "entityType" "CrmEntityType" NOT NULL,
    "fieldType" "CustomFieldType" NOT NULL,
    "value" JSONB NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CustomFieldValue_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RecordTag" (
    "organizationId" UUID NOT NULL,
    "recordId" UUID NOT NULL,
    "tagId" UUID NOT NULL,

    CONSTRAINT "RecordTag_pkey" PRIMARY KEY ("organizationId","recordId","tagId")
);

-- CreateTable
CREATE TABLE "BusinessEventLink" (
    "organizationId" UUID NOT NULL,
    "eventId" UUID NOT NULL,
    "recordId" UUID NOT NULL,

    CONSTRAINT "BusinessEventLink_pkey" PRIMARY KEY ("organizationId","eventId","recordId")
);

-- CreateIndex
CREATE UNIQUE INDEX "Company_organizationId_id_key" ON "Company"("organizationId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "Company_organizationId_id_entityType_key" ON "Company"("organizationId", "id", "entityType");

-- CreateIndex
CREATE UNIQUE INDEX "Pipeline_organizationId_id_key" ON "Pipeline"("organizationId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "Pipeline_organizationId_id_entityType_key" ON "Pipeline"("organizationId", "id", "entityType");

-- CreateIndex
CREATE UNIQUE INDEX "PipelineStage_organizationId_pipelineId_id_key" ON "PipelineStage"("organizationId", "pipelineId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "PipelineStage_organizationId_pipelineId_position_key" ON "PipelineStage"("organizationId", "pipelineId", "position");

-- CreateIndex
CREATE UNIQUE INDEX "PipelineStage_organizationId_id_key" ON "PipelineStage"("organizationId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "PipelineStage_organizationId_id_entityType_key" ON "PipelineStage"("organizationId", "id", "entityType");

-- CreateIndex
CREATE UNIQUE INDEX "Estimate_organizationId_number_key" ON "Estimate"("organizationId", "number");

-- CreateIndex
CREATE UNIQUE INDEX "Estimate_organizationId_id_key" ON "Estimate"("organizationId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "Estimate_organizationId_id_entityType_key" ON "Estimate"("organizationId", "id", "entityType");

-- CreateIndex
CREATE INDEX "Appointment_organizationId_startsAt_idx" ON "Appointment"("organizationId", "startsAt");

-- CreateIndex
CREATE UNIQUE INDEX "Appointment_organizationId_id_key" ON "Appointment"("organizationId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "Appointment_organizationId_id_entityType_key" ON "Appointment"("organizationId", "id", "entityType");

-- CreateIndex
CREATE INDEX "Task_organizationId_status_dueAt_idx" ON "Task"("organizationId", "status", "dueAt");

-- CreateIndex
CREATE UNIQUE INDEX "Task_organizationId_id_key" ON "Task"("organizationId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "Task_organizationId_id_entityType_key" ON "Task"("organizationId", "id", "entityType");

-- CreateIndex
CREATE UNIQUE INDEX "Note_organizationId_id_key" ON "Note"("organizationId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "Note_organizationId_id_entityType_key" ON "Note"("organizationId", "id", "entityType");

-- CreateIndex
CREATE UNIQUE INDEX "Conversation_organizationId_id_key" ON "Conversation"("organizationId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "Conversation_organizationId_id_entityType_key" ON "Conversation"("organizationId", "id", "entityType");

-- CreateIndex
CREATE INDEX "Message_organizationId_conversationId_occurredAt_idx" ON "Message"("organizationId", "conversationId", "occurredAt");

-- CreateIndex
CREATE UNIQUE INDEX "Message_organizationId_id_key" ON "Message"("organizationId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "Message_organizationId_id_entityType_key" ON "Message"("organizationId", "id", "entityType");

-- CreateIndex
CREATE UNIQUE INDEX "Tag_organizationId_name_key" ON "Tag"("organizationId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "Tag_organizationId_id_key" ON "Tag"("organizationId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "Tag_organizationId_id_entityType_key" ON "Tag"("organizationId", "id", "entityType");

-- CreateIndex
CREATE UNIQUE INDEX "User_externalSubject_key" ON "User"("externalSubject");

-- CreateIndex
CREATE INDEX "CrmRecord_organizationId_entityType_archivedAt_id_idx" ON "CrmRecord"("organizationId", "entityType", "archivedAt", "id");

-- CreateIndex
CREATE INDEX "CrmRecord_organizationId_assignedMemberId_idx" ON "CrmRecord"("organizationId", "assignedMemberId");

-- CreateIndex
CREATE UNIQUE INDEX "CrmRecord_organizationId_id_key" ON "CrmRecord"("organizationId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "CrmRecord_organizationId_id_entityType_key" ON "CrmRecord"("organizationId", "id", "entityType");

-- CreateIndex
CREATE INDEX "ExternalRecordMapping_organizationId_internalEntityType_int_idx" ON "ExternalRecordMapping"("organizationId", "internalEntityType", "internalEntityId");

-- CreateIndex
CREATE UNIQUE INDEX "ExternalRecordMapping_organizationId_connectionId_externalR_key" ON "ExternalRecordMapping"("organizationId", "connectionId", "externalRecordType", "externalId");

-- CreateIndex
CREATE UNIQUE INDEX "CustomFieldDefinition_organizationId_entityType_key_key" ON "CustomFieldDefinition"("organizationId", "entityType", "key");

-- CreateIndex
CREATE UNIQUE INDEX "CustomFieldDefinition_organizationId_id_entityType_fieldTyp_key" ON "CustomFieldDefinition"("organizationId", "id", "entityType", "fieldType");

-- CreateIndex
CREATE INDEX "CustomFieldValue_organizationId_recordId_idx" ON "CustomFieldValue"("organizationId", "recordId");

-- CreateIndex
CREATE UNIQUE INDEX "CustomFieldValue_organizationId_definitionId_recordId_key" ON "CustomFieldValue"("organizationId", "definitionId", "recordId");

-- CreateIndex
CREATE INDEX "BusinessEventLink_organizationId_recordId_eventId_idx" ON "BusinessEventLink"("organizationId", "recordId", "eventId");

-- CreateIndex
CREATE UNIQUE INDEX "OrganizationMembership_organizationId_userId_key" ON "OrganizationMembership"("organizationId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "WorkforceIntegration_organizationId_id_provider_key" ON "WorkforceIntegration"("organizationId", "id", "provider");

-- CreateIndex
CREATE UNIQUE INDEX "WorkforceCustomer_organizationId_id_entityType_key" ON "WorkforceCustomer"("organizationId", "id", "entityType");

-- CreateIndex
CREATE INDEX "WorkforceOpportunity_organizationId_pipelineId_stageId_idx" ON "WorkforceOpportunity"("organizationId", "pipelineId", "stageId");

-- CreateIndex
CREATE UNIQUE INDEX "WorkforceOpportunity_organizationId_id_entityType_key" ON "WorkforceOpportunity"("organizationId", "id", "entityType");


-- Preserve existing IDs. Populate identity rows before enforcing their foreign keys.
INSERT INTO "CrmRecord" ("id", "organizationId", "entityType", "createdAt", "updatedAt")
SELECT id, "organizationId", 'contact'::"CrmEntityType", "createdAt", "updatedAt" FROM "WorkforceCustomer";
INSERT INTO "CrmRecord" ("id", "organizationId", "entityType", "createdAt", "updatedAt")
SELECT id, "organizationId", 'opportunity'::"CrmEntityType", "createdAt", "updatedAt" FROM "WorkforceOpportunity";

INSERT INTO "User" (id, "externalSubject", "createdAt", "updatedAt")
SELECT md5('crm-user:' || subject)::uuid, subject, min("createdAt"), CURRENT_TIMESTAMP
FROM "OrganizationMembership" GROUP BY subject;
UPDATE "OrganizationMembership" m SET "userId" = u.id FROM "User" u WHERE u."externalSubject" = m.subject AND m."userId" IS NULL;

-- Retain old source keys as provenance. Synthetic connections describe legacy intake;
-- actual existing integration IDs are reused whenever present.
INSERT INTO "WorkforceIntegration" (id, "organizationId", name, provider, enabled, "createdAt")
SELECT md5('crm-source:' || s."organizationId"::text || ':' || s.source)::uuid,
       s."organizationId", 'Legacy source: ' || s.source, 'steel_scale_legacy', true, CURRENT_TIMESTAMP
FROM (
  SELECT "organizationId", source FROM "WorkforceCustomer" WHERE source IS NOT NULL
  UNION SELECT "organizationId", source FROM "WorkforceOpportunity" WHERE source IS NOT NULL
) s
WHERE NOT EXISTS (SELECT 1 FROM "WorkforceIntegration" c WHERE c."organizationId" = s."organizationId" AND c.id::text = s.source);

INSERT INTO "ExternalRecordMapping" (id, "organizationId", "connectionId", provider,
  "externalRecordType", "externalId", "internalEntityType", "internalEntityId", "sourceUpdatedAt", "createdAt", "updatedAt")
SELECT md5('crm-contact-map:' || c.id::text)::uuid, c."organizationId", x.id, x.provider,
  'customer', c."externalId", 'contact', c.id, c."sourceOccurredAt", CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM "WorkforceCustomer" c JOIN "WorkforceIntegration" x ON x."organizationId" = c."organizationId"
  AND x.id = COALESCE((SELECT i.id FROM "WorkforceIntegration" i WHERE i."organizationId" = c."organizationId" AND i.id::text = c.source),
    md5('crm-source:' || c."organizationId"::text || ':' || c.source)::uuid)
WHERE c.source IS NOT NULL AND c."externalId" IS NOT NULL;

INSERT INTO "ExternalRecordMapping" (id, "organizationId", "connectionId", provider,
  "externalRecordType", "externalId", "internalEntityType", "internalEntityId", "sourceUpdatedAt", "createdAt", "updatedAt")
SELECT md5('crm-opportunity-map:' || c.id::text)::uuid, c."organizationId", x.id, x.provider,
  'opportunity', c."externalId", 'opportunity', c.id, c."sourceOccurredAt", CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM "WorkforceOpportunity" c JOIN "WorkforceIntegration" x ON x."organizationId" = c."organizationId"
  AND x.id = COALESCE((SELECT i.id FROM "WorkforceIntegration" i WHERE i."organizationId" = c."organizationId" AND i.id::text = c.source),
    md5('crm-source:' || c."organizationId"::text || ':' || c.source)::uuid)
WHERE c.source IS NOT NULL AND c."externalId" IS NOT NULL;

INSERT INTO "BusinessEventLink" ("organizationId", "eventId", "recordId")
SELECT e."organizationId", e.id, c.id FROM "WorkforceEvent" e JOIN "WorkforceCustomer" c
  ON c."organizationId" = e."organizationId" AND c.source = e.source AND c."externalId" = e.payload->'data'->>'externalId'
WHERE e.type = 'customer.upserted'
UNION
SELECT e."organizationId", e.id, o.id FROM "WorkforceEvent" e JOIN "WorkforceOpportunity" o
  ON o."organizationId" = e."organizationId" AND o.source = e.source AND o."externalId" = e.payload->'data'->>'externalId'
WHERE e.type = 'opportunity.upserted'
UNION
SELECT e."organizationId", e.id, o."customerId" FROM "WorkforceEvent" e JOIN "WorkforceOpportunity" o
  ON o."organizationId" = e."organizationId" AND o.source = e.source AND o."externalId" = e.payload->'data'->>'externalId'
WHERE e.type = 'opportunity.upserted';

-- AddForeignKey
ALTER TABLE "OrganizationMembership" ADD CONSTRAINT "OrganizationMembership_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkforceCustomer" ADD CONSTRAINT "WorkforceCustomer_organizationId_companyId_fkey" FOREIGN KEY ("organizationId", "companyId") REFERENCES "Company"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkforceCustomer" ADD CONSTRAINT "WorkforceCustomer_organizationId_id_entityType_fkey" FOREIGN KEY ("organizationId", "id", "entityType") REFERENCES "CrmRecord"("organizationId", "id", "entityType") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkforceOpportunity" ADD CONSTRAINT "WorkforceOpportunity_organizationId_companyId_fkey" FOREIGN KEY ("organizationId", "companyId") REFERENCES "Company"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkforceOpportunity" ADD CONSTRAINT "WorkforceOpportunity_organizationId_pipelineId_stageId_fkey" FOREIGN KEY ("organizationId", "pipelineId", "stageId") REFERENCES "PipelineStage"("organizationId", "pipelineId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkforceOpportunity" ADD CONSTRAINT "WorkforceOpportunity_organizationId_id_entityType_fkey" FOREIGN KEY ("organizationId", "id", "entityType") REFERENCES "CrmRecord"("organizationId", "id", "entityType") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Company" ADD CONSTRAINT "Company_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Company" ADD CONSTRAINT "Company_organizationId_id_entityType_fkey" FOREIGN KEY ("organizationId", "id", "entityType") REFERENCES "CrmRecord"("organizationId", "id", "entityType") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Pipeline" ADD CONSTRAINT "Pipeline_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Pipeline" ADD CONSTRAINT "Pipeline_organizationId_id_entityType_fkey" FOREIGN KEY ("organizationId", "id", "entityType") REFERENCES "CrmRecord"("organizationId", "id", "entityType") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PipelineStage" ADD CONSTRAINT "PipelineStage_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PipelineStage" ADD CONSTRAINT "PipelineStage_organizationId_id_entityType_fkey" FOREIGN KEY ("organizationId", "id", "entityType") REFERENCES "CrmRecord"("organizationId", "id", "entityType") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PipelineStage" ADD CONSTRAINT "PipelineStage_organizationId_pipelineId_fkey" FOREIGN KEY ("organizationId", "pipelineId") REFERENCES "Pipeline"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Estimate" ADD CONSTRAINT "Estimate_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Estimate" ADD CONSTRAINT "Estimate_organizationId_id_entityType_fkey" FOREIGN KEY ("organizationId", "id", "entityType") REFERENCES "CrmRecord"("organizationId", "id", "entityType") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Estimate" ADD CONSTRAINT "Estimate_organizationId_opportunityId_fkey" FOREIGN KEY ("organizationId", "opportunityId") REFERENCES "WorkforceOpportunity"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Appointment" ADD CONSTRAINT "Appointment_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Appointment" ADD CONSTRAINT "Appointment_organizationId_id_entityType_fkey" FOREIGN KEY ("organizationId", "id", "entityType") REFERENCES "CrmRecord"("organizationId", "id", "entityType") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Appointment" ADD CONSTRAINT "Appointment_organizationId_contactId_fkey" FOREIGN KEY ("organizationId", "contactId") REFERENCES "WorkforceCustomer"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Appointment" ADD CONSTRAINT "Appointment_organizationId_opportunityId_fkey" FOREIGN KEY ("organizationId", "opportunityId") REFERENCES "WorkforceOpportunity"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Task" ADD CONSTRAINT "Task_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Task" ADD CONSTRAINT "Task_organizationId_id_entityType_fkey" FOREIGN KEY ("organizationId", "id", "entityType") REFERENCES "CrmRecord"("organizationId", "id", "entityType") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Task" ADD CONSTRAINT "Task_organizationId_relatedRecordId_fkey" FOREIGN KEY ("organizationId", "relatedRecordId") REFERENCES "CrmRecord"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Note" ADD CONSTRAINT "Note_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Note" ADD CONSTRAINT "Note_organizationId_id_entityType_fkey" FOREIGN KEY ("organizationId", "id", "entityType") REFERENCES "CrmRecord"("organizationId", "id", "entityType") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Note" ADD CONSTRAINT "Note_organizationId_relatedRecordId_fkey" FOREIGN KEY ("organizationId", "relatedRecordId") REFERENCES "CrmRecord"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Conversation" ADD CONSTRAINT "Conversation_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Conversation" ADD CONSTRAINT "Conversation_organizationId_id_entityType_fkey" FOREIGN KEY ("organizationId", "id", "entityType") REFERENCES "CrmRecord"("organizationId", "id", "entityType") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Conversation" ADD CONSTRAINT "Conversation_organizationId_contactId_fkey" FOREIGN KEY ("organizationId", "contactId") REFERENCES "WorkforceCustomer"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Message" ADD CONSTRAINT "Message_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Message" ADD CONSTRAINT "Message_organizationId_id_entityType_fkey" FOREIGN KEY ("organizationId", "id", "entityType") REFERENCES "CrmRecord"("organizationId", "id", "entityType") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Message" ADD CONSTRAINT "Message_organizationId_conversationId_fkey" FOREIGN KEY ("organizationId", "conversationId") REFERENCES "Conversation"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Tag" ADD CONSTRAINT "Tag_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Tag" ADD CONSTRAINT "Tag_organizationId_id_entityType_fkey" FOREIGN KEY ("organizationId", "id", "entityType") REFERENCES "CrmRecord"("organizationId", "id", "entityType") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CrmRecord" ADD CONSTRAINT "CrmRecord_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CrmRecord" ADD CONSTRAINT "CrmRecord_organizationId_assignedMemberId_fkey" FOREIGN KEY ("organizationId", "assignedMemberId") REFERENCES "OrganizationMembership"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExternalRecordMapping" ADD CONSTRAINT "ExternalRecordMapping_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExternalRecordMapping" ADD CONSTRAINT "ExternalRecordMapping_organizationId_connectionId_provider_fkey" FOREIGN KEY ("organizationId", "connectionId", "provider") REFERENCES "WorkforceIntegration"("organizationId", "id", "provider") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExternalRecordMapping" ADD CONSTRAINT "ExternalRecordMapping_organizationId_internalEntityId_inte_fkey" FOREIGN KEY ("organizationId", "internalEntityId", "internalEntityType") REFERENCES "CrmRecord"("organizationId", "id", "entityType") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CustomFieldDefinition" ADD CONSTRAINT "CustomFieldDefinition_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CustomFieldValue" ADD CONSTRAINT "CustomFieldValue_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CustomFieldValue" ADD CONSTRAINT "CustomFieldValue_organizationId_definitionId_entityType_fi_fkey" FOREIGN KEY ("organizationId", "definitionId", "entityType", "fieldType") REFERENCES "CustomFieldDefinition"("organizationId", "id", "entityType", "fieldType") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CustomFieldValue" ADD CONSTRAINT "CustomFieldValue_organizationId_recordId_entityType_fkey" FOREIGN KEY ("organizationId", "recordId", "entityType") REFERENCES "CrmRecord"("organizationId", "id", "entityType") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecordTag" ADD CONSTRAINT "RecordTag_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecordTag" ADD CONSTRAINT "RecordTag_organizationId_recordId_fkey" FOREIGN KEY ("organizationId", "recordId") REFERENCES "CrmRecord"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RecordTag" ADD CONSTRAINT "RecordTag_organizationId_tagId_fkey" FOREIGN KEY ("organizationId", "tagId") REFERENCES "Tag"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BusinessEventLink" ADD CONSTRAINT "BusinessEventLink_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BusinessEventLink" ADD CONSTRAINT "BusinessEventLink_organizationId_eventId_fkey" FOREIGN KEY ("organizationId", "eventId") REFERENCES "WorkforceEvent"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BusinessEventLink" ADD CONSTRAINT "BusinessEventLink_organizationId_recordId_fkey" FOREIGN KEY ("organizationId", "recordId") REFERENCES "CrmRecord"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Registry ownership/type is immutable. DB triggers cover legacy and new write paths.
CREATE FUNCTION crm_sync_record() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    INSERT INTO "CrmRecord" (id, "organizationId", "entityType", "createdAt", "updatedAt")
      VALUES (NEW.id, NEW."organizationId", NEW."entityType", NEW."createdAt", NEW."updatedAt");
  ELSE
    IF NEW.id <> OLD.id OR NEW."organizationId" <> OLD."organizationId" OR NEW."entityType" <> OLD."entityType" THEN
      RAISE EXCEPTION 'CRM identity is immutable' USING ERRCODE = '23514';
    END IF;
    UPDATE "CrmRecord" SET version = version + 1, "updatedAt" = CURRENT_TIMESTAMP
      WHERE id = NEW.id AND "organizationId" = NEW."organizationId";
  END IF;
  RETURN NEW;
END;
$$;

ALTER TABLE "WorkforceCustomer" ADD CONSTRAINT "crm_contact_type" CHECK ("entityType" = 'contact');
CREATE TRIGGER "crm_contact_identity" BEFORE INSERT OR UPDATE ON "WorkforceCustomer" FOR EACH ROW EXECUTE FUNCTION crm_sync_record();

ALTER TABLE "WorkforceOpportunity" ADD CONSTRAINT "crm_opportunity_type" CHECK ("entityType" = 'opportunity');
CREATE TRIGGER "crm_opportunity_identity" BEFORE INSERT OR UPDATE ON "WorkforceOpportunity" FOR EACH ROW EXECUTE FUNCTION crm_sync_record();

ALTER TABLE "Company" ADD CONSTRAINT "crm_company_type" CHECK ("entityType" = 'company');
CREATE TRIGGER "crm_company_identity" BEFORE INSERT OR UPDATE ON "Company" FOR EACH ROW EXECUTE FUNCTION crm_sync_record();

ALTER TABLE "Pipeline" ADD CONSTRAINT "crm_pipeline_type" CHECK ("entityType" = 'pipeline');
CREATE TRIGGER "crm_pipeline_identity" BEFORE INSERT OR UPDATE ON "Pipeline" FOR EACH ROW EXECUTE FUNCTION crm_sync_record();

ALTER TABLE "PipelineStage" ADD CONSTRAINT "crm_pipeline_stage_type" CHECK ("entityType" = 'pipeline_stage');
CREATE TRIGGER "crm_pipeline_stage_identity" BEFORE INSERT OR UPDATE ON "PipelineStage" FOR EACH ROW EXECUTE FUNCTION crm_sync_record();

ALTER TABLE "Estimate" ADD CONSTRAINT "crm_estimate_type" CHECK ("entityType" = 'estimate');
CREATE TRIGGER "crm_estimate_identity" BEFORE INSERT OR UPDATE ON "Estimate" FOR EACH ROW EXECUTE FUNCTION crm_sync_record();

ALTER TABLE "Appointment" ADD CONSTRAINT "crm_appointment_type" CHECK ("entityType" = 'appointment');
CREATE TRIGGER "crm_appointment_identity" BEFORE INSERT OR UPDATE ON "Appointment" FOR EACH ROW EXECUTE FUNCTION crm_sync_record();

ALTER TABLE "Task" ADD CONSTRAINT "crm_task_type" CHECK ("entityType" = 'task');
CREATE TRIGGER "crm_task_identity" BEFORE INSERT OR UPDATE ON "Task" FOR EACH ROW EXECUTE FUNCTION crm_sync_record();

ALTER TABLE "Note" ADD CONSTRAINT "crm_note_type" CHECK ("entityType" = 'note');
CREATE TRIGGER "crm_note_identity" BEFORE INSERT OR UPDATE ON "Note" FOR EACH ROW EXECUTE FUNCTION crm_sync_record();

ALTER TABLE "Conversation" ADD CONSTRAINT "crm_conversation_type" CHECK ("entityType" = 'conversation');
CREATE TRIGGER "crm_conversation_identity" BEFORE INSERT OR UPDATE ON "Conversation" FOR EACH ROW EXECUTE FUNCTION crm_sync_record();

ALTER TABLE "Message" ADD CONSTRAINT "crm_message_type" CHECK ("entityType" = 'message');
CREATE TRIGGER "crm_message_identity" BEFORE INSERT OR UPDATE ON "Message" FOR EACH ROW EXECUTE FUNCTION crm_sync_record();

ALTER TABLE "Tag" ADD CONSTRAINT "crm_tag_type" CHECK ("entityType" = 'tag');
CREATE TRIGGER "crm_tag_identity" BEFORE INSERT OR UPDATE ON "Tag" FOR EACH ROW EXECUTE FUNCTION crm_sync_record();

ALTER TABLE "WorkforceOpportunity" ADD CONSTRAINT crm_opportunity_stage_pair CHECK (("pipelineId" IS NULL) = ("stageId" IS NULL));
ALTER TABLE "Estimate" ADD CONSTRAINT crm_estimate_money CHECK ("amountMinor" >= 0 AND currency ~ '^[A-Z]{3}$');
ALTER TABLE "Estimate" ADD CONSTRAINT crm_estimate_dates CHECK ("issuedAt" IS NULL OR "expiresAt" IS NULL OR "expiresAt" > "issuedAt");
ALTER TABLE "Appointment" ADD CONSTRAINT crm_appointment_dates CHECK ("endsAt" > "startsAt");
ALTER TABLE "PipelineStage" ADD CONSTRAINT crm_stage_position CHECK (position >= 0);
ALTER TABLE "CrmRecord" ADD CONSTRAINT crm_record_version CHECK (version > 0);
ALTER TABLE "CustomFieldValue" ADD CONSTRAINT crm_custom_value_type CHECK (
  ("fieldType" IN ('text', 'date', 'single_select') AND jsonb_typeof(value) = 'string') OR
  ("fieldType" = 'number' AND jsonb_typeof(value) = 'number') OR
  ("fieldType" = 'boolean' AND jsonb_typeof(value) = 'boolean') OR
  ("fieldType" = 'multi_select' AND jsonb_typeof(value) = 'array')
);

COMMIT;
