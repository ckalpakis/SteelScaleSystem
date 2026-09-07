-- REVIEW CANDIDATE ONLY. Generate/compare against the actual Prisma 6 schema in development.
-- The installer does not copy this into migrations or execute it.
CREATE TYPE "SalesDemoStatus" AS ENUM ('draft', 'published', 'archived');
CREATE TABLE "SalesDemo" (
  "id" UUID NOT NULL,
  "creationRequestId" UUID NOT NULL,
  "shareToken" TEXT NOT NULL,
  "businessName" TEXT NOT NULL,
  "prospectBusinessId" UUID,
  "inputs" JSONB NOT NULL,
  "presentation" JSONB NOT NULL,
  "status" "SalesDemoStatus" NOT NULL DEFAULT 'draft',
  "version" INTEGER NOT NULL DEFAULT 1,
  "eventCount" INTEGER NOT NULL DEFAULT 0,
  "reviewedAt" TIMESTAMP(3),
  "publishedAt" TIMESTAMP(3),
  "expiresAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "SalesDemo_pkey" PRIMARY KEY ("id")
);
CREATE TABLE "SalesDemoEvent" (
  "id" UUID NOT NULL, "demoId" UUID NOT NULL, "sessionKey" UUID NOT NULL,
  "kind" TEXT NOT NULL, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "SalesDemoEvent_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "SalesDemo_creationRequestId_key" ON "SalesDemo"("creationRequestId");
CREATE UNIQUE INDEX "SalesDemo_shareToken_key" ON "SalesDemo"("shareToken");
CREATE INDEX "SalesDemo_prospectBusinessId_idx" ON "SalesDemo"("prospectBusinessId");
CREATE INDEX "SalesDemo_status_expiresAt_idx" ON "SalesDemo"("status", "expiresAt");
CREATE INDEX "SalesDemo_updatedAt_idx" ON "SalesDemo"("updatedAt");
CREATE UNIQUE INDEX "SalesDemoEvent_demoId_sessionKey_kind_key" ON "SalesDemoEvent"("demoId", "sessionKey", "kind");
CREATE INDEX "SalesDemoEvent_demoId_createdAt_idx" ON "SalesDemoEvent"("demoId", "createdAt");
ALTER TABLE "SalesDemo" ADD CONSTRAINT "SalesDemo_prospectBusinessId_fkey" FOREIGN KEY ("prospectBusinessId") REFERENCES "ProspectBusiness"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "SalesDemoEvent" ADD CONSTRAINT "SalesDemoEvent_demoId_fkey" FOREIGN KEY ("demoId") REFERENCES "SalesDemo"("id") ON DELETE CASCADE ON UPDATE CASCADE;
