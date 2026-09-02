CREATE TYPE "DeliveryDestination" AS ENUM ('GHL', 'ZAPIER_WEBHOOK', 'CSV_EXPORT', 'CALL_QUEUE');
CREATE TYPE "DeliveryStatus" AS ENUM ('pending', 'processing', 'delivered', 'failed');
CREATE TYPE "ConsentStatus" AS ENUM ('unknown', 'granted', 'denied', 'opted_out');

CREATE TABLE "LeadContactPermission" (
  "id" UUID NOT NULL, "lead_id" UUID NOT NULL, "contactable_prospect" BOOLEAN NOT NULL DEFAULT true,
  "manual_call_candidate" BOOLEAN NOT NULL DEFAULT false, "sms_consent" "ConsentStatus" NOT NULL DEFAULT 'unknown',
  "sms_eligible" BOOLEAN NOT NULL DEFAULT false, "do_not_contact" BOOLEAN NOT NULL DEFAULT false,
  "suppressed" BOOLEAN NOT NULL DEFAULT false, "consent_source" TEXT, "consent_recorded_at" TIMESTAMP(3),
  "opted_out_at" TIMESTAMP(3), "updated_by" TEXT, "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL, CONSTRAINT "LeadContactPermission_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "LeadContactPermission_lead_id_key" ON "LeadContactPermission"("lead_id");
CREATE INDEX "LeadContactPermission_contactable_prospect_manual_call_candidate_idx" ON "LeadContactPermission"("contactable_prospect", "manual_call_candidate");
CREATE INDEX "LeadContactPermission_sms_consent_sms_eligible_idx" ON "LeadContactPermission"("sms_consent", "sms_eligible");
CREATE INDEX "LeadContactPermission_do_not_contact_suppressed_idx" ON "LeadContactPermission"("do_not_contact", "suppressed");

CREATE TABLE "DeliveryCampaign" (
  "id" UUID NOT NULL, "client_id" UUID NOT NULL, "campaign_key" TEXT NOT NULL, "name" TEXT NOT NULL,
  "offer" "IntelligenceOffer" NOT NULL, "destination" "DeliveryDestination" NOT NULL, "criteria" JSONB NOT NULL,
  "destination_config" JSONB, "payload_version" TEXT NOT NULL, "enabled" BOOLEAN NOT NULL DEFAULT true,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "DeliveryCampaign_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "DeliveryCampaign_client_id_campaign_key_key" ON "DeliveryCampaign"("client_id", "campaign_key");
CREATE INDEX "DeliveryCampaign_client_id_offer_enabled_idx" ON "DeliveryCampaign"("client_id", "offer", "enabled");

CREATE TABLE "DeliveryRecord" (
  "id" UUID NOT NULL, "client_id" UUID NOT NULL, "lead_id" UUID NOT NULL, "campaign_id" UUID NOT NULL,
  "destination" "DeliveryDestination" NOT NULL, "status" "DeliveryStatus" NOT NULL DEFAULT 'pending',
  "external_id" TEXT, "payload_version" TEXT NOT NULL, "payload" JSONB NOT NULL, "error" TEXT,
  "retry_count" INTEGER NOT NULL DEFAULT 0, "delivered_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "DeliveryRecord_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "DeliveryRecord_campaign_id_lead_id_key" ON "DeliveryRecord"("campaign_id", "lead_id");
CREATE INDEX "DeliveryRecord_client_id_destination_status_created_at_idx" ON "DeliveryRecord"("client_id", "destination", "status", "created_at");
CREATE INDEX "DeliveryRecord_campaign_id_status_idx" ON "DeliveryRecord"("campaign_id", "status");
CREATE INDEX "DeliveryRecord_lead_id_delivered_at_idx" ON "DeliveryRecord"("lead_id", "delivered_at");

ALTER TABLE "LeadContactPermission" ADD CONSTRAINT "LeadContactPermission_lead_id_fkey" FOREIGN KEY ("lead_id") REFERENCES "Lead"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "DeliveryCampaign" ADD CONSTRAINT "DeliveryCampaign_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "DeliveryRecord" ADD CONSTRAINT "DeliveryRecord_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "DeliveryRecord" ADD CONSTRAINT "DeliveryRecord_lead_id_fkey" FOREIGN KEY ("lead_id") REFERENCES "Lead"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "DeliveryRecord" ADD CONSTRAINT "DeliveryRecord_campaign_id_fkey" FOREIGN KEY ("campaign_id") REFERENCES "DeliveryCampaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;
