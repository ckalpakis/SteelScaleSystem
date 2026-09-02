ALTER TABLE "IngestionRun"
ADD COLUMN "signals_created" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "signals_updated" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "IngestionRun" ADD CONSTRAINT "IngestionRun_signal_counts_nonnegative_check"
CHECK ("signals_created" >= 0 AND "signals_updated" >= 0);

ALTER TABLE "LeadSignal" ADD COLUMN "evidence" JSONB;
