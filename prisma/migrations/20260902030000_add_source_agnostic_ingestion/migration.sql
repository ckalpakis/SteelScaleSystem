-- Extend ingestion runs with source-agnostic pipeline metrics.
ALTER TABLE "IngestionRun" ADD COLUMN "duplicates" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "new_businesses" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "new_contacts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "records_failed" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "records_invalid" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "records_valid" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "updated_businesses" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "updated_contacts" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "IngestionRun" ADD CONSTRAINT "IngestionRun_phase_2_counts_nonnegative_check"
CHECK (
  "records_valid" >= 0 AND "records_invalid" >= 0 AND
  "new_businesses" >= 0 AND "updated_businesses" >= 0 AND
  "new_contacts" >= 0 AND "updated_contacts" >= 0 AND
  "duplicates" >= 0 AND "records_failed" >= 0
);

ALTER TABLE "LeadSignal" ADD COLUMN "source_record_version_id" UUID;

-- Every changed provider payload is retained; identical retries reuse a version.
CREATE TABLE "LeadSourceRecordVersion" (
    "id" UUID NOT NULL,
    "source_record_id" UUID NOT NULL,
    "ingestion_run_id" UUID NOT NULL,
    "payload_hash" TEXT NOT NULL,
    "raw_payload" JSONB NOT NULL,
    "observed_at" TIMESTAMP(3) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "LeadSourceRecordVersion_pkey" PRIMARY KEY ("id")
);

-- Validation and processing failures remain queryable without polluting canonical entities.
CREATE TABLE "IngestionError" (
    "id" UUID NOT NULL,
    "ingestion_run_id" UUID NOT NULL,
    "source_record_id" UUID,
    "record_index" INTEGER NOT NULL,
    "stage" TEXT NOT NULL,
    "message" TEXT NOT NULL,
    "details" JSONB,
    "raw_payload" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "IngestionError_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "LeadSourceRecordVersion_source_record_id_observed_at_idx" ON "LeadSourceRecordVersion"("source_record_id", "observed_at");
CREATE INDEX "LeadSourceRecordVersion_ingestion_run_id_idx" ON "LeadSourceRecordVersion"("ingestion_run_id");
CREATE UNIQUE INDEX "LeadSourceRecordVersion_source_record_id_ingestion_run_id_p_key" ON "LeadSourceRecordVersion"("source_record_id", "ingestion_run_id", "payload_hash");
CREATE INDEX "IngestionError_ingestion_run_id_record_index_idx" ON "IngestionError"("ingestion_run_id", "record_index");
CREATE INDEX "IngestionError_source_record_id_idx" ON "IngestionError"("source_record_id");
CREATE INDEX "LeadSignal_source_record_version_id_idx" ON "LeadSignal"("source_record_version_id");
CREATE UNIQUE INDEX "LeadSignal_lead_id_key_source_record_version_id_key" ON "LeadSignal"("lead_id", "key", "source_record_version_id");

ALTER TABLE "LeadSourceRecordVersion" ADD CONSTRAINT "LeadSourceRecordVersion_source_record_id_fkey" FOREIGN KEY ("source_record_id") REFERENCES "LeadSourceRecord"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "LeadSourceRecordVersion" ADD CONSTRAINT "LeadSourceRecordVersion_ingestion_run_id_fkey" FOREIGN KEY ("ingestion_run_id") REFERENCES "IngestionRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "IngestionError" ADD CONSTRAINT "IngestionError_ingestion_run_id_fkey" FOREIGN KEY ("ingestion_run_id") REFERENCES "IngestionRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "IngestionError" ADD CONSTRAINT "IngestionError_source_record_id_fkey" FOREIGN KEY ("source_record_id") REFERENCES "LeadSourceRecord"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "LeadSignal" ADD CONSTRAINT "LeadSignal_source_record_version_id_fkey" FOREIGN KEY ("source_record_version_id") REFERENCES "LeadSourceRecordVersion"("id") ON DELETE SET NULL ON UPDATE CASCADE;
