-- CreateEnum
CREATE TYPE "DestinationType" AS ENUM ('zapier', 'ghl_fallback');

-- CreateEnum
CREATE TYPE "VoiceProvider" AS ENUM ('vapi', 'retell');

-- CreateEnum
CREATE TYPE "CallType" AS ENUM ('missed', 'answered_by_ai', 'answered_live');

-- CreateEnum
CREATE TYPE "CallOutcome" AS ENUM ('booked', 'no_answer', 'not_interested', 'voicemail');

-- CreateEnum
CREATE TYPE "BookingSource" AS ENUM ('voice', 'chatbot');

-- CreateEnum
CREATE TYPE "BookingStatus" AS ENUM ('success', 'failed');

-- CreateEnum
CREATE TYPE "SmsAttemptStatus" AS ENUM ('pending', 'sent', 'failed');

-- CreateTable
CREATE TABLE "Client" (
    "id" UUID NOT NULL,
    "business_name" TEXT NOT NULL,
    "phone_number" TEXT NOT NULL,
    "timezone" TEXT NOT NULL,
    "services" TEXT[],
    "missed_call_sms_template" TEXT NOT NULL DEFAULT 'Hey, sorry we missed your call! This is {business_name} — reply here and we''ll get you booked in.',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Client_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ClientDestination" (
    "id" UUID NOT NULL,
    "client_id" UUID NOT NULL,
    "destination_type" "DestinationType" NOT NULL,
    "zapier_webhook_url" TEXT,
    "ghl_calendar_id" TEXT,

    CONSTRAINT "ClientDestination_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VoiceAgentConfig" (
    "id" UUID NOT NULL,
    "client_id" UUID NOT NULL,
    "provider" "VoiceProvider" NOT NULL,
    "agent_id" TEXT NOT NULL,
    "phone_number_id" TEXT NOT NULL,

    CONSTRAINT "VoiceAgentConfig_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CallLog" (
    "id" UUID NOT NULL,
    "client_id" UUID NOT NULL,
    "provider_call_id" TEXT NOT NULL,
    "caller_number" TEXT NOT NULL,
    "call_type" "CallType" NOT NULL,
    "duration_seconds" INTEGER NOT NULL,
    "outcome" "CallOutcome" NOT NULL,
    "raw_payload" JSONB NOT NULL,
    "sms_attempt_status" "SmsAttemptStatus",
    "outbound_sms_sid" TEXT,
    "sms_error_message" TEXT,
    "sms_attempted_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CallLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BookingAttempt" (
    "id" UUID NOT NULL,
    "client_id" UUID NOT NULL,
    "source" "BookingSource" NOT NULL,
    "status" "BookingStatus" NOT NULL,
    "destination_type" "DestinationType" NOT NULL,
    "error_message" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "BookingAttempt_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Client_phone_number_key" ON "Client"("phone_number");

-- CreateIndex
CREATE UNIQUE INDEX "ClientDestination_client_id_key" ON "ClientDestination"("client_id");

-- CreateIndex
CREATE UNIQUE INDEX "VoiceAgentConfig_client_id_key" ON "VoiceAgentConfig"("client_id");

-- CreateIndex
CREATE UNIQUE INDEX "VoiceAgentConfig_provider_agent_id_key" ON "VoiceAgentConfig"("provider", "agent_id");

-- CreateIndex
CREATE UNIQUE INDEX "VoiceAgentConfig_provider_phone_number_id_key" ON "VoiceAgentConfig"("provider", "phone_number_id");

-- CreateIndex
CREATE UNIQUE INDEX "CallLog_provider_call_id_key" ON "CallLog"("provider_call_id");

-- CreateIndex
CREATE INDEX "CallLog_client_id_created_at_idx" ON "CallLog"("client_id", "created_at");

-- CreateIndex
CREATE INDEX "BookingAttempt_client_id_created_at_idx" ON "BookingAttempt"("client_id", "created_at");

-- AddForeignKey
ALTER TABLE "ClientDestination" ADD CONSTRAINT "ClientDestination_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VoiceAgentConfig" ADD CONSTRAINT "VoiceAgentConfig_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CallLog" ADD CONSTRAINT "CallLog_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BookingAttempt" ADD CONSTRAINT "BookingAttempt_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;
