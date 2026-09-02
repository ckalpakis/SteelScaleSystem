CREATE TYPE "ProspectCallStatus" AS ENUM ('not_called','no_answer','gatekeeper','owner_reached','interested','follow_up','demo_booked','not_interested','bad_fit','do_not_contact');
CREATE TABLE "CallQueueEntry" (
  "id" UUID NOT NULL, "client_id" UUID NOT NULL, "lead_id" UUID NOT NULL, "campaign_id" UUID NOT NULL,
  "delivery_record_id" UUID NOT NULL, "status" "ProspectCallStatus" NOT NULL DEFAULT 'not_called',
  "manual_priority" INTEGER NOT NULL DEFAULT 0, "cooldown_until" TIMESTAMP(3), "next_follow_up_at" TIMESTAMP(3),
  "latest_note" TEXT, "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "CallQueueEntry_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "CallAttempt" (
  "id" UUID NOT NULL, "client_id" UUID NOT NULL, "lead_id" UUID NOT NULL, "queue_entry_id" UUID NOT NULL,
  "status" "ProspectCallStatus" NOT NULL, "pitch_angle" TEXT NOT NULL, "score_at_attempt" INTEGER,
  "score_band" TEXT, "niche" TEXT, "notes" TEXT, "next_follow_up_at" TIMESTAMP(3),
  "occurred_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "CallAttempt_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "CallQueueEntry_delivery_record_id_key" ON "CallQueueEntry"("delivery_record_id");
CREATE UNIQUE INDEX "CallQueueEntry_campaign_id_lead_id_key" ON "CallQueueEntry"("campaign_id", "lead_id");
CREATE INDEX "CallQueueEntry_client_id_status_next_follow_up_at_idx" ON "CallQueueEntry"("client_id", "status", "next_follow_up_at");
CREATE INDEX "CallQueueEntry_client_id_cooldown_until_manual_priority_idx" ON "CallQueueEntry"("client_id", "cooldown_until", "manual_priority");
CREATE INDEX "CallAttempt_client_id_occurred_at_idx" ON "CallAttempt"("client_id", "occurred_at");
CREATE INDEX "CallAttempt_client_id_status_occurred_at_idx" ON "CallAttempt"("client_id", "status", "occurred_at");
CREATE INDEX "CallAttempt_client_id_niche_occurred_at_idx" ON "CallAttempt"("client_id", "niche", "occurred_at");
CREATE INDEX "CallAttempt_client_id_score_band_occurred_at_idx" ON "CallAttempt"("client_id", "score_band", "occurred_at");
CREATE INDEX "CallAttempt_client_id_pitch_angle_occurred_at_idx" ON "CallAttempt"("client_id", "pitch_angle", "occurred_at");
CREATE INDEX "CallAttempt_lead_id_occurred_at_idx" ON "CallAttempt"("lead_id", "occurred_at");
ALTER TABLE "CallQueueEntry" ADD CONSTRAINT "CallQueueEntry_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CallQueueEntry" ADD CONSTRAINT "CallQueueEntry_lead_id_fkey" FOREIGN KEY ("lead_id") REFERENCES "Lead"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CallQueueEntry" ADD CONSTRAINT "CallQueueEntry_campaign_id_fkey" FOREIGN KEY ("campaign_id") REFERENCES "DeliveryCampaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CallQueueEntry" ADD CONSTRAINT "CallQueueEntry_delivery_record_id_fkey" FOREIGN KEY ("delivery_record_id") REFERENCES "DeliveryRecord"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CallAttempt" ADD CONSTRAINT "CallAttempt_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CallAttempt" ADD CONSTRAINT "CallAttempt_lead_id_fkey" FOREIGN KEY ("lead_id") REFERENCES "Lead"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "CallAttempt" ADD CONSTRAINT "CallAttempt_queue_entry_id_fkey" FOREIGN KEY ("queue_entry_id") REFERENCES "CallQueueEntry"("id") ON DELETE CASCADE ON UPDATE CASCADE;
