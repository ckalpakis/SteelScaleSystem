ALTER TABLE "ClientDestination"
ADD COLUMN "zapier_availability_webhook_url" TEXT;

CREATE TABLE "AvailabilityCheck" (
  "id" UUID NOT NULL,
  "client_id" UUID NOT NULL,
  "request_id" UUID NOT NULL,
  "callback_token_hash" TEXT NOT NULL,
  "requested_time" TIMESTAMP(3) NOT NULL,
  "timezone" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'pending',
  "response" JSONB,
  "error_message" TEXT,
  "expires_at" TIMESTAMP(3) NOT NULL,
  "completed_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "AvailabilityCheck_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "AvailabilityCheck_request_id_key" ON "AvailabilityCheck"("request_id");
CREATE INDEX "AvailabilityCheck_client_id_created_at_idx" ON "AvailabilityCheck"("client_id", "created_at");
CREATE INDEX "AvailabilityCheck_status_expires_at_idx" ON "AvailabilityCheck"("status", "expires_at");

ALTER TABLE "AvailabilityCheck"
ADD CONSTRAINT "AvailabilityCheck_client_id_fkey"
FOREIGN KEY ("client_id") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;
