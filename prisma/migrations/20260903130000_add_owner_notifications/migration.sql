ALTER TABLE "Client"
ADD COLUMN "owner_notification_number" TEXT,
ADD COLUMN "notify_booking_sms" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN "notify_missed_call_sms" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN "notify_unbooked_call_sms" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN "notify_failed_booking_sms" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN "notify_transfer_failure_sms" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN "daily_summary_sms" BOOLEAN NOT NULL DEFAULT true;

CREATE TABLE "OwnerNotification" (
    "id" UUID NOT NULL,
    "client_id" UUID NOT NULL,
    "notification_type" TEXT NOT NULL,
    "event_key" TEXT NOT NULL,
    "recipient" TEXT NOT NULL,
    "status" "SmsAttemptStatus" NOT NULL,
    "outbound_sms_sid" TEXT,
    "error_message" TEXT,
    "attempted_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "OwnerNotification_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "OwnerNotification_client_id_notification_type_event_key_key"
ON "OwnerNotification"("client_id", "notification_type", "event_key");

CREATE INDEX "OwnerNotification_client_id_created_at_idx"
ON "OwnerNotification"("client_id", "created_at");

ALTER TABLE "OwnerNotification"
ADD CONSTRAINT "OwnerNotification_client_id_fkey"
FOREIGN KEY ("client_id") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;
