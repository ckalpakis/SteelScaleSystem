-- Additive rollout: fail promptly on lock contention, atomically preserve existing data.
BEGIN;
SET LOCAL lock_timeout = '5s';

-- AlterTable
ALTER TABLE "Organization" ADD COLUMN     "knowledgeRevision" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "KnowledgeSource" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "reference" TEXT,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "KnowledgeSource_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "KnowledgeDocument" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "sourceId" UUID NOT NULL,
    "filename" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "contentHash" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "KnowledgeDocument_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "KnowledgeEntry" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "sourceId" UUID NOT NULL,
    "documentId" UUID,
    "category" TEXT NOT NULL,
    "audience" TEXT NOT NULL DEFAULT 'internal',
    "active" BOOLEAN NOT NULL DEFAULT false,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "latestVersion" INTEGER NOT NULL DEFAULT 1,
    "approvedVersionId" UUID,
    "approvedBy" TEXT,
    "approvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "KnowledgeEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "KnowledgeVersion" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "entryId" UUID NOT NULL,
    "number" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "question" TEXT,
    "content" TEXT NOT NULL,
    "facts" JSONB NOT NULL,
    "risk" TEXT NOT NULL,
    "createdBy" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "KnowledgeVersion_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "KnowledgeSource_organizationId_id_key" ON "KnowledgeSource"("organizationId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "KnowledgeDocument_organizationId_id_key" ON "KnowledgeDocument"("organizationId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "KnowledgeDocument_organizationId_sourceId_id_key" ON "KnowledgeDocument"("organizationId", "sourceId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "KnowledgeDocument_organizationId_sourceId_contentHash_key" ON "KnowledgeDocument"("organizationId", "sourceId", "contentHash");

-- CreateIndex
CREATE INDEX "KnowledgeEntry_organizationId_active_category_idx" ON "KnowledgeEntry"("organizationId", "active", "category");

-- CreateIndex
CREATE UNIQUE INDEX "KnowledgeEntry_organizationId_id_key" ON "KnowledgeEntry"("organizationId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "KnowledgeVersion_organizationId_id_key" ON "KnowledgeVersion"("organizationId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "KnowledgeVersion_organizationId_entryId_id_key" ON "KnowledgeVersion"("organizationId", "entryId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "KnowledgeVersion_organizationId_entryId_number_key" ON "KnowledgeVersion"("organizationId", "entryId", "number");

-- AddForeignKey
ALTER TABLE "KnowledgeSource" ADD CONSTRAINT "KnowledgeSource_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KnowledgeDocument" ADD CONSTRAINT "KnowledgeDocument_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KnowledgeDocument" ADD CONSTRAINT "KnowledgeDocument_organizationId_sourceId_fkey" FOREIGN KEY ("organizationId", "sourceId") REFERENCES "KnowledgeSource"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KnowledgeEntry" ADD CONSTRAINT "KnowledgeEntry_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KnowledgeEntry" ADD CONSTRAINT "KnowledgeEntry_organizationId_sourceId_fkey" FOREIGN KEY ("organizationId", "sourceId") REFERENCES "KnowledgeSource"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KnowledgeEntry" ADD CONSTRAINT "KnowledgeEntry_organizationId_sourceId_documentId_fkey" FOREIGN KEY ("organizationId", "sourceId", "documentId") REFERENCES "KnowledgeDocument"("organizationId", "sourceId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KnowledgeEntry" ADD CONSTRAINT "KnowledgeEntry_organizationId_id_approvedVersionId_fkey" FOREIGN KEY ("organizationId", "id", "approvedVersionId") REFERENCES "KnowledgeVersion"("organizationId", "entryId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KnowledgeVersion" ADD CONSTRAINT "KnowledgeVersion_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KnowledgeVersion" ADD CONSTRAINT "KnowledgeVersion_organizationId_entryId_fkey" FOREIGN KEY ("organizationId", "entryId") REFERENCES "KnowledgeEntry"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;



ALTER TABLE "KnowledgeSource" ADD CONSTRAINT knowledge_source_revision CHECK (revision > 0);
ALTER TABLE "KnowledgeDocument" ADD CONSTRAINT knowledge_document_revision CHECK (revision > 0 AND length(content) BETWEEN 1 AND 40000);
ALTER TABLE "KnowledgeEntry" ADD CONSTRAINT knowledge_entry_review CHECK (revision > 0 AND "latestVersion" > 0 AND audience IN ('public','internal') AND (NOT active OR ("approvedVersionId" IS NOT NULL AND "approvedAt" IS NOT NULL AND "approvedBy" IS NOT NULL)));
ALTER TABLE "KnowledgeVersion" ADD CONSTRAINT knowledge_version_limits CHECK (number > 0 AND risk IN ('general','restricted') AND length(content) BETWEEN 1 AND 4000);
CREATE FUNCTION knowledge_immutable_version() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Knowledge versions are immutable'; END;
$$;
CREATE TRIGGER knowledge_version_immutable BEFORE UPDATE OR DELETE ON "KnowledgeVersion" FOR EACH ROW EXECUTE FUNCTION knowledge_immutable_version();
CREATE FUNCTION knowledge_document_content_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW."organizationId", NEW."sourceId", NEW.filename, NEW.content, NEW."contentHash", NEW."createdBy", NEW."createdAt") IS DISTINCT FROM ROW(OLD."organizationId", OLD."sourceId", OLD.filename, OLD.content, OLD."contentHash", OLD."createdBy", OLD."createdAt") THEN
    RAISE EXCEPTION 'Document content and provenance are immutable';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER knowledge_document_immutable BEFORE UPDATE ON "KnowledgeDocument" FOR EACH ROW EXECUTE FUNCTION knowledge_document_content_immutable();

COMMIT;
