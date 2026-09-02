-- CreateEnum
CREATE TYPE "LeadLifecycleStatus" AS ENUM ('new', 'qualified', 'disqualified', 'contacted', 'converted', 'archived');

-- CreateEnum
CREATE TYPE "IntelligenceRunStatus" AS ENUM ('pending', 'running', 'completed', 'failed', 'partially_completed');

-- CreateEnum
CREATE TYPE "IntelligenceOffer" AS ENUM ('VOICE_AI', 'REAL_ESTATE_VIDEO', 'WEBSITE', 'SEO_RANKING', 'REVIEWS');

-- CreateEnum
CREATE TYPE "OutreachDisposition" AS ENUM ('not_contacted', 'ready', 'paused', 'contacted', 'replied', 'qualified', 'converted', 'do_not_contact', 'invalid');

-- CreateEnum
CREATE TYPE "OutreachChannel" AS ENUM ('phone', 'sms', 'email', 'social', 'other');

-- CreateEnum
CREATE TYPE "OutreachDirection" AS ENUM ('outbound', 'inbound');

-- CreateTable
CREATE TABLE "ProspectBusiness" (
    "id" UUID NOT NULL,
    "client_id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "normalized_name" TEXT NOT NULL,
    "website" TEXT,
    "normalized_domain" TEXT,
    "phone" TEXT,
    "normalized_phone" TEXT,
    "address_line_1" TEXT,
    "address_line_2" TEXT,
    "city" TEXT,
    "state" TEXT,
    "normalized_city" TEXT,
    "normalized_state" TEXT,
    "postal_code" TEXT,
    "country_code" TEXT,
    "latitude" DECIMAL(10,7),
    "longitude" DECIMAL(10,7),
    "google_place_id" TEXT,
    "google_cid" TEXT,
    "category" TEXT,
    "niche" TEXT,
    "source_created_at" TIMESTAMP(3),
    "first_seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProspectBusiness_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProspectContact" (
    "id" UUID NOT NULL,
    "client_id" UUID NOT NULL,
    "business_id" UUID,
    "first_name" TEXT,
    "last_name" TEXT,
    "full_name" TEXT,
    "normalized_name" TEXT,
    "title" TEXT,
    "relationship" TEXT,
    "phone" TEXT,
    "phone_type" TEXT,
    "normalized_phone" TEXT,
    "email" TEXT,
    "normalized_email" TEXT,
    "linkedin_url" TEXT,
    "instagram_url" TEXT,
    "facebook_url" TEXT,
    "tiktok_url" TEXT,
    "source_created_at" TIMESTAMP(3),
    "first_seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProspectContact_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Lead" (
    "id" UUID NOT NULL,
    "client_id" UUID NOT NULL,
    "business_id" UUID,
    "primary_contact_id" UUID,
    "lifecycle_status" "LeadLifecycleStatus" NOT NULL DEFAULT 'new',
    "source_created_at" TIMESTAMP(3),
    "first_seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Lead_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IngestionRun" (
    "id" UUID NOT NULL,
    "client_id" UUID NOT NULL,
    "provider" TEXT NOT NULL,
    "idempotency_key" TEXT NOT NULL,
    "status" "IntelligenceRunStatus" NOT NULL DEFAULT 'pending',
    "source_reference" TEXT,
    "records_received" INTEGER NOT NULL DEFAULT 0,
    "records_created" INTEGER NOT NULL DEFAULT 0,
    "records_updated" INTEGER NOT NULL DEFAULT 0,
    "records_rejected" INTEGER NOT NULL DEFAULT 0,
    "error_message" TEXT,
    "metadata" JSONB,
    "started_at" TIMESTAMP(3),
    "completed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "IngestionRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LeadSourceRecord" (
    "id" UUID NOT NULL,
    "client_id" UUID NOT NULL,
    "ingestion_run_id" UUID,
    "lead_id" UUID,
    "business_id" UUID,
    "contact_id" UUID,
    "provider" TEXT NOT NULL,
    "record_key" TEXT NOT NULL,
    "external_id" TEXT,
    "source_url" TEXT,
    "raw_payload" JSONB NOT NULL,
    "payload_hash" TEXT,
    "source_created_at" TIMESTAMP(3),
    "first_seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LeadSourceRecord_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LeadSignal" (
    "id" UUID NOT NULL,
    "client_id" UUID NOT NULL,
    "lead_id" UUID NOT NULL,
    "source_record_id" UUID,
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "boolean_value" BOOLEAN,
    "number_value" DECIMAL(20,6),
    "text_value" TEXT,
    "date_value" TIMESTAMP(3),
    "provider" TEXT NOT NULL,
    "confidence" DECIMAL(5,4),
    "observed_at" TIMESTAMP(3) NOT NULL,
    "expires_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LeadSignal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ScoreSnapshot" (
    "id" UUID NOT NULL,
    "client_id" UUID NOT NULL,
    "lead_id" UUID NOT NULL,
    "offer" "IntelligenceOffer" NOT NULL,
    "score" INTEGER NOT NULL,
    "ruleset_version" TEXT NOT NULL,
    "input_as_of" TIMESTAMP(3) NOT NULL,
    "explanation" JSONB,
    "calculated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ScoreSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ScoreFactor" (
    "id" UUID NOT NULL,
    "score_snapshot_id" UUID NOT NULL,
    "signal_id" UUID,
    "key" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "points" INTEGER NOT NULL,
    "observed_value" JSONB,
    "rule_version" TEXT NOT NULL,
    "position" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ScoreFactor_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OfferRecommendation" (
    "id" UUID NOT NULL,
    "client_id" UUID NOT NULL,
    "lead_id" UUID NOT NULL,
    "score_snapshot_id" UUID,
    "offer" "IntelligenceOffer" NOT NULL,
    "rank" INTEGER NOT NULL,
    "recommended" BOOLEAN NOT NULL DEFAULT true,
    "recommendation_version" TEXT NOT NULL,
    "reason" JSONB NOT NULL,
    "generated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OfferRecommendation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EnrichmentRun" (
    "id" UUID NOT NULL,
    "client_id" UUID NOT NULL,
    "lead_id" UUID NOT NULL,
    "source_record_id" UUID,
    "provider" TEXT NOT NULL,
    "idempotency_key" TEXT NOT NULL,
    "status" "IntelligenceRunStatus" NOT NULL DEFAULT 'pending',
    "raw_response" JSONB,
    "error_message" TEXT,
    "started_at" TIMESTAMP(3),
    "completed_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EnrichmentRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WebsiteAudit" (
    "id" UUID NOT NULL,
    "client_id" UUID NOT NULL,
    "lead_id" UUID NOT NULL,
    "business_id" UUID,
    "source_record_id" UUID,
    "provider" TEXT NOT NULL,
    "audited_url" TEXT NOT NULL,
    "normalized_domain" TEXT NOT NULL,
    "status_code" INTEGER,
    "raw_result" JSONB NOT NULL,
    "observed_at" TIMESTAMP(3) NOT NULL,
    "expires_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WebsiteAudit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RealEstateListing" (
    "id" UUID NOT NULL,
    "client_id" UUID NOT NULL,
    "lead_id" UUID NOT NULL,
    "business_id" UUID,
    "source_record_id" UUID,
    "provider" TEXT NOT NULL,
    "external_id" TEXT NOT NULL,
    "listing_url" TEXT,
    "status" TEXT,
    "address" TEXT,
    "city" TEXT,
    "state" TEXT,
    "postal_code" TEXT,
    "price" DECIMAL(14,2),
    "listed_at" TIMESTAMP(3),
    "has_agent_headshot" BOOLEAN,
    "raw_payload" JSONB NOT NULL,
    "first_seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "RealEstateListing_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LeadOutreachState" (
    "id" UUID NOT NULL,
    "lead_id" UUID NOT NULL,
    "disposition" "OutreachDisposition" NOT NULL DEFAULT 'not_contacted',
    "contactable" BOOLEAN NOT NULL DEFAULT true,
    "do_not_contact_reason" TEXT,
    "last_contacted_at" TIMESTAMP(3),
    "next_contact_at" TIMESTAMP(3),
    "contact_attempt_count" INTEGER NOT NULL DEFAULT 0,
    "last_channel" "OutreachChannel",
    "last_outcome" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LeadOutreachState_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OutreachActivity" (
    "id" UUID NOT NULL,
    "client_id" UUID NOT NULL,
    "lead_id" UUID NOT NULL,
    "channel" "OutreachChannel" NOT NULL,
    "direction" "OutreachDirection" NOT NULL,
    "provider" TEXT,
    "external_id" TEXT,
    "outcome" TEXT,
    "occurred_at" TIMESTAMP(3) NOT NULL,
    "metadata" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OutreachActivity_pkey" PRIMARY KEY ("id")
);

-- Domain invariants that Prisma cannot currently express.
ALTER TABLE "ProspectBusiness"
ADD CONSTRAINT "ProspectBusiness_latitude_check" CHECK ("latitude" IS NULL OR "latitude" BETWEEN -90 AND 90),
ADD CONSTRAINT "ProspectBusiness_longitude_check" CHECK ("longitude" IS NULL OR "longitude" BETWEEN -180 AND 180);

ALTER TABLE "IngestionRun"
ADD CONSTRAINT "IngestionRun_record_counts_check" CHECK (
  "records_received" >= 0 AND
  "records_created" >= 0 AND
  "records_updated" >= 0 AND
  "records_rejected" >= 0
);

ALTER TABLE "LeadSignal"
ADD CONSTRAINT "LeadSignal_confidence_check" CHECK ("confidence" IS NULL OR "confidence" BETWEEN 0 AND 1);

ALTER TABLE "ScoreSnapshot"
ADD CONSTRAINT "ScoreSnapshot_score_check" CHECK ("score" BETWEEN 0 AND 100);

ALTER TABLE "OfferRecommendation"
ADD CONSTRAINT "OfferRecommendation_rank_check" CHECK ("rank" > 0);

ALTER TABLE "LeadOutreachState"
ADD CONSTRAINT "LeadOutreachState_attempt_count_check" CHECK ("contact_attempt_count" >= 0);

-- CreateIndex
CREATE INDEX "ProspectBusiness_client_id_normalized_domain_idx" ON "ProspectBusiness"("client_id", "normalized_domain");

-- CreateIndex
CREATE INDEX "ProspectBusiness_client_id_normalized_phone_idx" ON "ProspectBusiness"("client_id", "normalized_phone");

-- CreateIndex
CREATE INDEX "ProspectBusiness_client_id_normalized_name_normalized_city__idx" ON "ProspectBusiness"("client_id", "normalized_name", "normalized_city", "normalized_state");

-- CreateIndex
CREATE INDEX "ProspectBusiness_client_id_category_idx" ON "ProspectBusiness"("client_id", "category");

-- CreateIndex
CREATE INDEX "ProspectBusiness_client_id_niche_idx" ON "ProspectBusiness"("client_id", "niche");

-- CreateIndex
CREATE INDEX "ProspectBusiness_client_id_last_seen_at_idx" ON "ProspectBusiness"("client_id", "last_seen_at");

-- CreateIndex
CREATE UNIQUE INDEX "ProspectBusiness_client_id_google_place_id_key" ON "ProspectBusiness"("client_id", "google_place_id");

-- CreateIndex
CREATE UNIQUE INDEX "ProspectBusiness_client_id_google_cid_key" ON "ProspectBusiness"("client_id", "google_cid");

-- CreateIndex
CREATE INDEX "ProspectContact_client_id_business_id_idx" ON "ProspectContact"("client_id", "business_id");

-- CreateIndex
CREATE INDEX "ProspectContact_client_id_normalized_phone_idx" ON "ProspectContact"("client_id", "normalized_phone");

-- CreateIndex
CREATE INDEX "ProspectContact_client_id_normalized_email_idx" ON "ProspectContact"("client_id", "normalized_email");

-- CreateIndex
CREATE INDEX "ProspectContact_client_id_normalized_name_idx" ON "ProspectContact"("client_id", "normalized_name");

-- CreateIndex
CREATE INDEX "ProspectContact_client_id_last_seen_at_idx" ON "ProspectContact"("client_id", "last_seen_at");

-- CreateIndex
CREATE INDEX "Lead_client_id_lifecycle_status_updated_at_idx" ON "Lead"("client_id", "lifecycle_status", "updated_at");

-- CreateIndex
CREATE INDEX "Lead_client_id_primary_contact_id_idx" ON "Lead"("client_id", "primary_contact_id");

-- CreateIndex
CREATE INDEX "Lead_client_id_last_seen_at_idx" ON "Lead"("client_id", "last_seen_at");

-- CreateIndex
CREATE UNIQUE INDEX "Lead_client_id_business_id_key" ON "Lead"("client_id", "business_id");

-- CreateIndex
CREATE INDEX "IngestionRun_client_id_status_created_at_idx" ON "IngestionRun"("client_id", "status", "created_at");

-- CreateIndex
CREATE INDEX "IngestionRun_provider_created_at_idx" ON "IngestionRun"("provider", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "IngestionRun_client_id_provider_idempotency_key_key" ON "IngestionRun"("client_id", "provider", "idempotency_key");

-- CreateIndex
CREATE INDEX "LeadSourceRecord_client_id_provider_external_id_idx" ON "LeadSourceRecord"("client_id", "provider", "external_id");

-- CreateIndex
CREATE INDEX "LeadSourceRecord_client_id_lead_id_last_seen_at_idx" ON "LeadSourceRecord"("client_id", "lead_id", "last_seen_at");

-- CreateIndex
CREATE INDEX "LeadSourceRecord_client_id_business_id_idx" ON "LeadSourceRecord"("client_id", "business_id");

-- CreateIndex
CREATE INDEX "LeadSourceRecord_client_id_contact_id_idx" ON "LeadSourceRecord"("client_id", "contact_id");

-- CreateIndex
CREATE INDEX "LeadSourceRecord_ingestion_run_id_idx" ON "LeadSourceRecord"("ingestion_run_id");

-- CreateIndex
CREATE UNIQUE INDEX "LeadSourceRecord_client_id_provider_record_key_key" ON "LeadSourceRecord"("client_id", "provider", "record_key");

-- CreateIndex
CREATE INDEX "LeadSignal_client_id_lead_id_key_observed_at_idx" ON "LeadSignal"("client_id", "lead_id", "key", "observed_at");

-- CreateIndex
CREATE INDEX "LeadSignal_client_id_key_boolean_value_idx" ON "LeadSignal"("client_id", "key", "boolean_value");

-- CreateIndex
CREATE INDEX "LeadSignal_client_id_key_number_value_idx" ON "LeadSignal"("client_id", "key", "number_value");

-- CreateIndex
CREATE INDEX "LeadSignal_client_id_expires_at_idx" ON "LeadSignal"("client_id", "expires_at");

-- CreateIndex
CREATE INDEX "LeadSignal_source_record_id_idx" ON "LeadSignal"("source_record_id");

-- CreateIndex
CREATE INDEX "ScoreSnapshot_client_id_offer_score_idx" ON "ScoreSnapshot"("client_id", "offer", "score");

-- CreateIndex
CREATE INDEX "ScoreSnapshot_client_id_lead_id_offer_calculated_at_idx" ON "ScoreSnapshot"("client_id", "lead_id", "offer", "calculated_at");

-- CreateIndex
CREATE INDEX "ScoreSnapshot_ruleset_version_calculated_at_idx" ON "ScoreSnapshot"("ruleset_version", "calculated_at");

-- CreateIndex
CREATE INDEX "ScoreFactor_score_snapshot_id_position_idx" ON "ScoreFactor"("score_snapshot_id", "position");

-- CreateIndex
CREATE INDEX "ScoreFactor_signal_id_idx" ON "ScoreFactor"("signal_id");

-- CreateIndex
CREATE INDEX "OfferRecommendation_client_id_lead_id_generated_at_idx" ON "OfferRecommendation"("client_id", "lead_id", "generated_at");

-- CreateIndex
CREATE INDEX "OfferRecommendation_client_id_offer_recommended_rank_idx" ON "OfferRecommendation"("client_id", "offer", "recommended", "rank");

-- CreateIndex
CREATE INDEX "OfferRecommendation_score_snapshot_id_idx" ON "OfferRecommendation"("score_snapshot_id");

-- CreateIndex
CREATE INDEX "EnrichmentRun_client_id_status_created_at_idx" ON "EnrichmentRun"("client_id", "status", "created_at");

-- CreateIndex
CREATE INDEX "EnrichmentRun_client_id_lead_id_provider_created_at_idx" ON "EnrichmentRun"("client_id", "lead_id", "provider", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "EnrichmentRun_client_id_provider_idempotency_key_key" ON "EnrichmentRun"("client_id", "provider", "idempotency_key");

-- CreateIndex
CREATE INDEX "WebsiteAudit_client_id_lead_id_observed_at_idx" ON "WebsiteAudit"("client_id", "lead_id", "observed_at");

-- CreateIndex
CREATE INDEX "WebsiteAudit_client_id_normalized_domain_observed_at_idx" ON "WebsiteAudit"("client_id", "normalized_domain", "observed_at");

-- CreateIndex
CREATE INDEX "WebsiteAudit_source_record_id_idx" ON "WebsiteAudit"("source_record_id");

-- CreateIndex
CREATE INDEX "RealEstateListing_client_id_lead_id_listed_at_idx" ON "RealEstateListing"("client_id", "lead_id", "listed_at");

-- CreateIndex
CREATE INDEX "RealEstateListing_client_id_status_listed_at_idx" ON "RealEstateListing"("client_id", "status", "listed_at");

-- CreateIndex
CREATE INDEX "RealEstateListing_client_id_price_idx" ON "RealEstateListing"("client_id", "price");

-- CreateIndex
CREATE INDEX "RealEstateListing_source_record_id_idx" ON "RealEstateListing"("source_record_id");

-- CreateIndex
CREATE UNIQUE INDEX "RealEstateListing_client_id_provider_external_id_key" ON "RealEstateListing"("client_id", "provider", "external_id");

-- CreateIndex
CREATE UNIQUE INDEX "LeadOutreachState_lead_id_key" ON "LeadOutreachState"("lead_id");

-- CreateIndex
CREATE INDEX "LeadOutreachState_disposition_next_contact_at_idx" ON "LeadOutreachState"("disposition", "next_contact_at");

-- CreateIndex
CREATE INDEX "LeadOutreachState_contactable_next_contact_at_idx" ON "LeadOutreachState"("contactable", "next_contact_at");

-- CreateIndex
CREATE INDEX "OutreachActivity_client_id_lead_id_occurred_at_idx" ON "OutreachActivity"("client_id", "lead_id", "occurred_at");

-- CreateIndex
CREATE INDEX "OutreachActivity_client_id_channel_occurred_at_idx" ON "OutreachActivity"("client_id", "channel", "occurred_at");

-- CreateIndex
CREATE UNIQUE INDEX "OutreachActivity_client_id_provider_external_id_key" ON "OutreachActivity"("client_id", "provider", "external_id");

-- AddForeignKey
ALTER TABLE "ProspectBusiness" ADD CONSTRAINT "ProspectBusiness_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProspectContact" ADD CONSTRAINT "ProspectContact_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProspectContact" ADD CONSTRAINT "ProspectContact_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "ProspectBusiness"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Lead" ADD CONSTRAINT "Lead_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Lead" ADD CONSTRAINT "Lead_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "ProspectBusiness"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Lead" ADD CONSTRAINT "Lead_primary_contact_id_fkey" FOREIGN KEY ("primary_contact_id") REFERENCES "ProspectContact"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IngestionRun" ADD CONSTRAINT "IngestionRun_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LeadSourceRecord" ADD CONSTRAINT "LeadSourceRecord_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LeadSourceRecord" ADD CONSTRAINT "LeadSourceRecord_ingestion_run_id_fkey" FOREIGN KEY ("ingestion_run_id") REFERENCES "IngestionRun"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LeadSourceRecord" ADD CONSTRAINT "LeadSourceRecord_lead_id_fkey" FOREIGN KEY ("lead_id") REFERENCES "Lead"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LeadSourceRecord" ADD CONSTRAINT "LeadSourceRecord_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "ProspectBusiness"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LeadSourceRecord" ADD CONSTRAINT "LeadSourceRecord_contact_id_fkey" FOREIGN KEY ("contact_id") REFERENCES "ProspectContact"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LeadSignal" ADD CONSTRAINT "LeadSignal_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LeadSignal" ADD CONSTRAINT "LeadSignal_lead_id_fkey" FOREIGN KEY ("lead_id") REFERENCES "Lead"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LeadSignal" ADD CONSTRAINT "LeadSignal_source_record_id_fkey" FOREIGN KEY ("source_record_id") REFERENCES "LeadSourceRecord"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ScoreSnapshot" ADD CONSTRAINT "ScoreSnapshot_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ScoreSnapshot" ADD CONSTRAINT "ScoreSnapshot_lead_id_fkey" FOREIGN KEY ("lead_id") REFERENCES "Lead"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ScoreFactor" ADD CONSTRAINT "ScoreFactor_score_snapshot_id_fkey" FOREIGN KEY ("score_snapshot_id") REFERENCES "ScoreSnapshot"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ScoreFactor" ADD CONSTRAINT "ScoreFactor_signal_id_fkey" FOREIGN KEY ("signal_id") REFERENCES "LeadSignal"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OfferRecommendation" ADD CONSTRAINT "OfferRecommendation_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OfferRecommendation" ADD CONSTRAINT "OfferRecommendation_lead_id_fkey" FOREIGN KEY ("lead_id") REFERENCES "Lead"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OfferRecommendation" ADD CONSTRAINT "OfferRecommendation_score_snapshot_id_fkey" FOREIGN KEY ("score_snapshot_id") REFERENCES "ScoreSnapshot"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EnrichmentRun" ADD CONSTRAINT "EnrichmentRun_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EnrichmentRun" ADD CONSTRAINT "EnrichmentRun_lead_id_fkey" FOREIGN KEY ("lead_id") REFERENCES "Lead"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EnrichmentRun" ADD CONSTRAINT "EnrichmentRun_source_record_id_fkey" FOREIGN KEY ("source_record_id") REFERENCES "LeadSourceRecord"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WebsiteAudit" ADD CONSTRAINT "WebsiteAudit_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WebsiteAudit" ADD CONSTRAINT "WebsiteAudit_lead_id_fkey" FOREIGN KEY ("lead_id") REFERENCES "Lead"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WebsiteAudit" ADD CONSTRAINT "WebsiteAudit_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "ProspectBusiness"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WebsiteAudit" ADD CONSTRAINT "WebsiteAudit_source_record_id_fkey" FOREIGN KEY ("source_record_id") REFERENCES "LeadSourceRecord"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RealEstateListing" ADD CONSTRAINT "RealEstateListing_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RealEstateListing" ADD CONSTRAINT "RealEstateListing_lead_id_fkey" FOREIGN KEY ("lead_id") REFERENCES "Lead"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RealEstateListing" ADD CONSTRAINT "RealEstateListing_business_id_fkey" FOREIGN KEY ("business_id") REFERENCES "ProspectBusiness"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RealEstateListing" ADD CONSTRAINT "RealEstateListing_source_record_id_fkey" FOREIGN KEY ("source_record_id") REFERENCES "LeadSourceRecord"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LeadOutreachState" ADD CONSTRAINT "LeadOutreachState_lead_id_fkey" FOREIGN KEY ("lead_id") REFERENCES "Lead"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OutreachActivity" ADD CONSTRAINT "OutreachActivity_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OutreachActivity" ADD CONSTRAINT "OutreachActivity_lead_id_fkey" FOREIGN KEY ("lead_id") REFERENCES "Lead"("id") ON DELETE CASCADE ON UPDATE CASCADE;
