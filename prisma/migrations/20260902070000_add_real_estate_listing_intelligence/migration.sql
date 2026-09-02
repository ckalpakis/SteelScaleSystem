ALTER TABLE "RealEstateListing"
ALTER COLUMN "lead_id" DROP NOT NULL,
ADD COLUMN "agent_id" UUID,
ADD COLUMN "normalized_address" TEXT,
ADD COLUMN "latitude" DECIMAL(10,7),
ADD COLUMN "longitude" DECIMAL(10,7),
ADD COLUMN "bedrooms" DECIMAL(5,2),
ADD COLUMN "bathrooms" DECIMAL(5,2),
ADD COLUMN "square_feet" INTEGER,
ADD COLUMN "listing_images" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
ADD COLUMN "brokerage" TEXT;

CREATE TABLE "RealEstateAgent" (
  "id" UUID NOT NULL,
  "client_id" UUID NOT NULL,
  "lead_id" UUID NOT NULL,
  "first_name" TEXT,
  "last_name" TEXT,
  "full_name" TEXT NOT NULL,
  "normalized_name" TEXT NOT NULL,
  "phone" TEXT,
  "normalized_phone" TEXT,
  "email" TEXT,
  "normalized_email" TEXT,
  "profile_url" TEXT,
  "normalized_profile_url" TEXT,
  "headshot_url" TEXT,
  "website" TEXT,
  "instagram_url" TEXT,
  "facebook_url" TEXT,
  "tiktok_url" TEXT,
  "brokerage" TEXT,
  "license_number" TEXT,
  "first_seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "last_seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "RealEstateAgent_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "RealEstateListingSourceRecord" (
  "id" UUID NOT NULL,
  "client_id" UUID NOT NULL,
  "ingestion_run_id" UUID,
  "listing_id" UUID NOT NULL,
  "agent_id" UUID,
  "provider" TEXT NOT NULL,
  "external_id" TEXT NOT NULL,
  "source_url" TEXT,
  "raw_payload" JSONB NOT NULL,
  "payload_hash" TEXT NOT NULL,
  "first_seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "last_seen_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "RealEstateListingSourceRecord_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "RealEstateListingSourceVersion" (
  "id" UUID NOT NULL,
  "source_record_id" UUID NOT NULL,
  "payload_hash" TEXT NOT NULL,
  "raw_payload" JSONB NOT NULL,
  "observed_at" TIMESTAMP(3) NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "RealEstateListingSourceVersion_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "RealEstateAgent_lead_id_key" ON "RealEstateAgent"("lead_id");
CREATE INDEX "RealEstateAgent_client_id_normalized_email_idx" ON "RealEstateAgent"("client_id", "normalized_email");
CREATE INDEX "RealEstateAgent_client_id_normalized_phone_idx" ON "RealEstateAgent"("client_id", "normalized_phone");
CREATE INDEX "RealEstateAgent_client_id_normalized_profile_url_idx" ON "RealEstateAgent"("client_id", "normalized_profile_url");
CREATE INDEX "RealEstateAgent_client_id_normalized_name_brokerage_idx" ON "RealEstateAgent"("client_id", "normalized_name", "brokerage");
CREATE UNIQUE INDEX "RealEstateListingSourceRecord_client_id_provider_external_id_key" ON "RealEstateListingSourceRecord"("client_id", "provider", "external_id");
CREATE INDEX "RealEstateListingSourceRecord_client_id_listing_id_idx" ON "RealEstateListingSourceRecord"("client_id", "listing_id");
CREATE INDEX "RealEstateListingSourceRecord_client_id_agent_id_idx" ON "RealEstateListingSourceRecord"("client_id", "agent_id");
CREATE INDEX "RealEstateListingSourceRecord_ingestion_run_id_idx" ON "RealEstateListingSourceRecord"("ingestion_run_id");
CREATE UNIQUE INDEX "RealEstateListingSourceVersion_source_record_id_payload_hash_key" ON "RealEstateListingSourceVersion"("source_record_id", "payload_hash");
CREATE INDEX "RealEstateListingSourceVersion_source_record_id_observed_at_idx" ON "RealEstateListingSourceVersion"("source_record_id", "observed_at");
CREATE INDEX "RealEstateListing_client_id_normalized_address_postal_code_idx" ON "RealEstateListing"("client_id", "normalized_address", "postal_code");
CREATE INDEX "RealEstateListing_client_id_agent_id_status_listed_at_idx" ON "RealEstateListing"("client_id", "agent_id", "status", "listed_at");

ALTER TABLE "RealEstateAgent" ADD CONSTRAINT "RealEstateAgent_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "RealEstateAgent" ADD CONSTRAINT "RealEstateAgent_lead_id_fkey" FOREIGN KEY ("lead_id") REFERENCES "Lead"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "RealEstateListing" ADD CONSTRAINT "RealEstateListing_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "RealEstateAgent"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "RealEstateListingSourceRecord" ADD CONSTRAINT "RealEstateListingSourceRecord_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "RealEstateListingSourceRecord" ADD CONSTRAINT "RealEstateListingSourceRecord_ingestion_run_id_fkey" FOREIGN KEY ("ingestion_run_id") REFERENCES "IngestionRun"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "RealEstateListingSourceRecord" ADD CONSTRAINT "RealEstateListingSourceRecord_listing_id_fkey" FOREIGN KEY ("listing_id") REFERENCES "RealEstateListing"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "RealEstateListingSourceRecord" ADD CONSTRAINT "RealEstateListingSourceRecord_agent_id_fkey" FOREIGN KEY ("agent_id") REFERENCES "RealEstateAgent"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "RealEstateListingSourceVersion" ADD CONSTRAINT "RealEstateListingSourceVersion_source_record_id_fkey" FOREIGN KEY ("source_record_id") REFERENCES "RealEstateListingSourceRecord"("id") ON DELETE CASCADE ON UPDATE CASCADE;
