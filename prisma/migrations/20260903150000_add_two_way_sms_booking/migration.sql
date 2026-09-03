ALTER TYPE "BookingSource" ADD VALUE IF NOT EXISTS 'sms';

CREATE TYPE "SmsConversationStatus" AS ENUM ('active', 'booked', 'opted_out');
CREATE TYPE "SmsDirection" AS ENUM ('inbound', 'outbound');

ALTER TABLE "Client"
ADD COLUMN "no_booking_sms_template" TEXT NOT NULL DEFAULT 'Thanks for calling {business_name}. Would you like to schedule your appointment by text? Reply here and I can help. Reply STOP to opt out.',
ADD COLUMN "sms_booking_enabled" BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE "SmsConversation" (
  "id" UUID NOT NULL,
  "client_id" UUID NOT NULL,
  "customer_number" TEXT NOT NULL,
  "status" "SmsConversationStatus" NOT NULL DEFAULT 'active',
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "SmsConversation_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "SmsMessage" (
  "id" UUID NOT NULL,
  "sms_conversation_id" UUID NOT NULL,
  "direction" "SmsDirection" NOT NULL,
  "body" TEXT NOT NULL,
  "provider_message_id" TEXT,
  "dedupe_key" TEXT,
  "booking_attempt_id" UUID,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "SmsMessage_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "SmsConversation_client_id_customer_number_key"
ON "SmsConversation"("client_id", "customer_number");
CREATE INDEX "SmsConversation_updated_at_idx" ON "SmsConversation"("updated_at");
CREATE UNIQUE INDEX "SmsMessage_provider_message_id_key" ON "SmsMessage"("provider_message_id");
CREATE UNIQUE INDEX "SmsMessage_dedupe_key_key" ON "SmsMessage"("dedupe_key");
CREATE INDEX "SmsMessage_sms_conversation_id_created_at_idx"
ON "SmsMessage"("sms_conversation_id", "created_at");

ALTER TABLE "SmsConversation"
ADD CONSTRAINT "SmsConversation_client_id_fkey"
FOREIGN KEY ("client_id") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "SmsMessage"
ADD CONSTRAINT "SmsMessage_sms_conversation_id_fkey"
FOREIGN KEY ("sms_conversation_id") REFERENCES "SmsConversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
