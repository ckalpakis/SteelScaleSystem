ALTER TABLE "VoiceAgentConfig"
ADD COLUMN "owner_transfer_number" TEXT,
ADD COLUMN "owner_transfer_mode" TEXT NOT NULL DEFAULT 'blind-transfer';
