ALTER TABLE "WebsiteAudit"
ADD COLUMN "status" TEXT,
ADD COLUMN "error_message" TEXT,
ADD COLUMN "final_url" TEXT,
ADD COLUMN "pages_crawled" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "duration_ms" INTEGER;

UPDATE "WebsiteAudit"
SET "status" = CASE
  WHEN "status_code" BETWEEN 200 AND 399 THEN 'completed'
  ELSE 'failed'
END
WHERE "status" IS NULL;

ALTER TABLE "WebsiteAudit"
ALTER COLUMN "status" SET NOT NULL;
