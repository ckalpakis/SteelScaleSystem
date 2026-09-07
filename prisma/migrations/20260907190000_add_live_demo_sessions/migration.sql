CREATE TABLE "SalesDemoSession" (
    "id" UUID NOT NULL,
    "demoId" UUID NOT NULL,
    "demoVersion" INTEGER NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "preview" BOOLEAN NOT NULL DEFAULT false,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "endedAt" TIMESTAMP(3),
    "busyUntil" TIMESTAMP(3),
    "turns" INTEGER NOT NULL DEFAULT 0,
    "messages" JSONB NOT NULL DEFAULT '[]',
    "booking" JSONB,
    "providerCallId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "SalesDemoSession_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "SalesDemoSession_tokenHash_key" ON "SalesDemoSession"("tokenHash");
CREATE UNIQUE INDEX "SalesDemoSession_providerCallId_key" ON "SalesDemoSession"("providerCallId");
CREATE INDEX "SalesDemoSession_demoId_createdAt_idx" ON "SalesDemoSession"("demoId", "createdAt");
CREATE INDEX "SalesDemoSession_channel_endedAt_expiresAt_idx" ON "SalesDemoSession"("channel", "endedAt", "expiresAt");
CREATE INDEX "SalesDemoSession_createdAt_idx" ON "SalesDemoSession"("createdAt");
ALTER TABLE "SalesDemoSession" ADD CONSTRAINT "SalesDemoSession_demoId_fkey" FOREIGN KEY ("demoId") REFERENCES "SalesDemo"("id") ON DELETE CASCADE ON UPDATE CASCADE;
