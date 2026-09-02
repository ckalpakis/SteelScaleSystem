-- AlterTable
ALTER TABLE "VoiceAgentConfig"
ADD COLUMN "system_prompt" TEXT NOT NULL DEFAULT 'You are the helpful phone agent for {business_name}. Services offered: {services}. Greet the caller, confirm what they need, and collect their full name, callback phone number, service address, requested service, and preferred appointment time. Read the details back for confirmation. Only after the caller confirms, call the create_booking tool. Never claim the booking is confirmed unless the tool returns accepted.';

-- AlterTable
ALTER TABLE "BookingAttempt"
ADD COLUMN "provider_request_id" TEXT,
ADD COLUMN "provider_call_id" TEXT,
ADD COLUMN "request_payload" JSONB NOT NULL DEFAULT '{}';

ALTER TABLE "BookingAttempt" ALTER COLUMN "request_payload" DROP DEFAULT;

-- CreateIndex
CREATE UNIQUE INDEX "BookingAttempt_provider_request_id_key" ON "BookingAttempt"("provider_request_id");

-- CreateIndex
CREATE INDEX "BookingAttempt_provider_call_id_idx" ON "BookingAttempt"("provider_call_id");
