CREATE TABLE "PipelineRun" (
  "id" UUID NOT NULL,
  "client_id" UUID NOT NULL,
  "source" TEXT NOT NULL,
  "campaign_key" TEXT NOT NULL,
  "idempotency_key" TEXT NOT NULL,
  "status" "IntelligenceRunStatus" NOT NULL DEFAULT 'pending',
  "current_stage" TEXT,
  "started_at" TIMESTAMP(3),
  "completed_at" TIMESTAMP(3),
  "heartbeat_at" TIMESTAMP(3),
  "records_discovered" INTEGER NOT NULL DEFAULT 0,
  "records_imported" INTEGER NOT NULL DEFAULT 0,
  "records_updated" INTEGER NOT NULL DEFAULT 0,
  "duplicates" INTEGER NOT NULL DEFAULT 0,
  "enriched" INTEGER NOT NULL DEFAULT 0,
  "scored" INTEGER NOT NULL DEFAULT 0,
  "hot_leads" INTEGER NOT NULL DEFAULT 0,
  "failures" INTEGER NOT NULL DEFAULT 0,
  "error_summaries" JSONB NOT NULL DEFAULT '[]',
  "configuration" JSONB,
  "stage_state" JSONB,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "PipelineRun_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "PipelineRun_client_id_source_idempotency_key_key" ON "PipelineRun"("client_id", "source", "idempotency_key");
CREATE INDEX "PipelineRun_client_id_campaign_key_started_at_idx" ON "PipelineRun"("client_id", "campaign_key", "started_at");
CREATE INDEX "PipelineRun_status_heartbeat_at_idx" ON "PipelineRun"("status", "heartbeat_at");
CREATE INDEX "PipelineRun_source_completed_at_idx" ON "PipelineRun"("source", "completed_at");
ALTER TABLE "PipelineRun" ADD CONSTRAINT "PipelineRun_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;
