-- AlterEnum
ALTER TYPE "BookingStatus" ADD VALUE 'pending' BEFORE 'success';

-- AlterTable
ALTER TABLE "BookingAttempt"
ALTER COLUMN "destination_type" DROP NOT NULL,
ADD COLUMN "delivered_destination_type" "DestinationType",
ADD COLUMN "primary_attempt_count" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "fallback_used" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "manual_follow_up_required" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "external_booking_id" TEXT,
ADD COLUMN "completed_at" TIMESTAMP(3);

-- Existing successful rows predate delivery tracking and are considered complete.
UPDATE "BookingAttempt"
SET "delivered_destination_type" = "destination_type",
    "primary_attempt_count" = 1,
    "completed_at" = "created_at"
WHERE "status" = 'success';
