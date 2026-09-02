ALTER TABLE "ProspectBusiness"
ADD COLUMN "website_last_audited_at" TIMESTAMP(3);

ALTER TABLE "WebsiteAudit"
ADD COLUMN "enrichment_run_id" UUID;

CREATE UNIQUE INDEX "WebsiteAudit_enrichment_run_id_key"
ON "WebsiteAudit"("enrichment_run_id");

CREATE INDEX "ProspectBusiness_client_id_website_last_audited_at_idx"
ON "ProspectBusiness"("client_id", "website_last_audited_at");

ALTER TABLE "WebsiteAudit"
ADD CONSTRAINT "WebsiteAudit_enrichment_run_id_fkey"
FOREIGN KEY ("enrichment_run_id") REFERENCES "EnrichmentRun"("id")
ON DELETE SET NULL ON UPDATE CASCADE;
