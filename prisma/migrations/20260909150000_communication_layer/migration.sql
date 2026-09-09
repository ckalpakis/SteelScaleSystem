BEGIN;
SET LOCAL lock_timeout = '5s';
-- CreateTable
CREATE TABLE "CommunicationAccount" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "connectionId" UUID NOT NULL,
    "provider" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "sender" TEXT NOT NULL,
    "externalAccountId" TEXT NOT NULL,
    "encryptedCredentials" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CommunicationAccount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CommunicationDelivery" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "messageId" UUID NOT NULL,
    "conversationId" UUID NOT NULL,
    "contactId" UUID NOT NULL,
    "accountId" UUID,
    "connectionId" UUID,
    "recoveryDispatchId" UUID,
    "provider" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "direction" TEXT NOT NULL,
    "actor" TEXT NOT NULL,
    "requestKey" TEXT NOT NULL,
    "payloadHash" TEXT NOT NULL,
    "sender" TEXT,
    "recipient" TEXT,
    "externalId" TEXT,
    "status" TEXT NOT NULL,
    "errorCode" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "availableAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "leaseToken" UUID,
    "leasedUntil" TIMESTAMP(3),
    "acceptedAt" TIMESTAMP(3),
    "deliveredAt" TIMESTAMP(3),
    "statusAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CommunicationDelivery_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CommunicationAttempt" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "deliveryId" UUID NOT NULL,
    "eventKey" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "errorCode" TEXT,
    "externalId" TEXT,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CommunicationAttempt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CommunicationSuppression" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "channel" TEXT NOT NULL,
    "addressHash" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CommunicationSuppression_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CommunicationAccount_connectionId_key" ON "CommunicationAccount"("connectionId");

-- CreateIndex
CREATE UNIQUE INDEX "CommunicationAccount_organizationId_id_key" ON "CommunicationAccount"("organizationId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "CommunicationAccount_organizationId_channel_key" ON "CommunicationAccount"("organizationId", "channel");

-- CreateIndex
CREATE UNIQUE INDEX "CommunicationAccount_organizationId_connectionId_provider_key" ON "CommunicationAccount"("organizationId", "connectionId", "provider");

-- CreateIndex
CREATE UNIQUE INDEX "CommunicationAccount_provider_externalAccountId_sender_key" ON "CommunicationAccount"("provider", "externalAccountId", "sender");

-- CreateIndex
CREATE INDEX "CommunicationDelivery_status_availableAt_idx" ON "CommunicationDelivery"("status", "availableAt");

-- CreateIndex
CREATE UNIQUE INDEX "CommunicationDelivery_organizationId_id_key" ON "CommunicationDelivery"("organizationId", "id");

-- CreateIndex
CREATE UNIQUE INDEX "CommunicationDelivery_organizationId_messageId_key" ON "CommunicationDelivery"("organizationId", "messageId");

-- CreateIndex
CREATE UNIQUE INDEX "CommunicationDelivery_organizationId_messageId_conversation_key" ON "CommunicationDelivery"("organizationId", "messageId", "conversationId");

-- CreateIndex
CREATE UNIQUE INDEX "CommunicationDelivery_organizationId_recoveryDispatchId_key" ON "CommunicationDelivery"("organizationId", "recoveryDispatchId");

-- CreateIndex
CREATE UNIQUE INDEX "CommunicationDelivery_organizationId_requestKey_key" ON "CommunicationDelivery"("organizationId", "requestKey");

-- CreateIndex
CREATE UNIQUE INDEX "CommunicationDelivery_organizationId_provider_connectionId__key" ON "CommunicationDelivery"("organizationId", "provider", "connectionId", "externalId");

-- CreateIndex
CREATE UNIQUE INDEX "CommunicationAttempt_organizationId_deliveryId_eventKey_key" ON "CommunicationAttempt"("organizationId", "deliveryId", "eventKey");

-- CreateIndex
CREATE UNIQUE INDEX "CommunicationSuppression_organizationId_channel_addressHash_key" ON "CommunicationSuppression"("organizationId", "channel", "addressHash");

-- CreateIndex
CREATE UNIQUE INDEX "Conversation_organizationId_id_contactId_key" ON "Conversation"("organizationId", "id", "contactId");

-- CreateIndex
CREATE UNIQUE INDEX "Message_organizationId_id_conversationId_key" ON "Message"("organizationId", "id", "conversationId");

-- AddForeignKey
ALTER TABLE "CommunicationAccount" ADD CONSTRAINT "CommunicationAccount_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CommunicationAccount" ADD CONSTRAINT "CommunicationAccount_organizationId_connectionId_provider_fkey" FOREIGN KEY ("organizationId", "connectionId", "provider") REFERENCES "WorkforceIntegration"("organizationId", "id", "provider") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CommunicationDelivery" ADD CONSTRAINT "CommunicationDelivery_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CommunicationDelivery" ADD CONSTRAINT "CommunicationDelivery_organizationId_messageId_conversatio_fkey" FOREIGN KEY ("organizationId", "messageId", "conversationId") REFERENCES "Message"("organizationId", "id", "conversationId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CommunicationDelivery" ADD CONSTRAINT "CommunicationDelivery_organizationId_conversationId_contac_fkey" FOREIGN KEY ("organizationId", "conversationId", "contactId") REFERENCES "Conversation"("organizationId", "id", "contactId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CommunicationDelivery" ADD CONSTRAINT "CommunicationDelivery_organizationId_contactId_fkey" FOREIGN KEY ("organizationId", "contactId") REFERENCES "WorkforceCustomer"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CommunicationDelivery" ADD CONSTRAINT "CommunicationDelivery_organizationId_accountId_fkey" FOREIGN KEY ("organizationId", "accountId") REFERENCES "CommunicationAccount"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CommunicationDelivery" ADD CONSTRAINT "CommunicationDelivery_organizationId_connectionId_provider_fkey" FOREIGN KEY ("organizationId", "connectionId", "provider") REFERENCES "WorkforceIntegration"("organizationId", "id", "provider") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CommunicationDelivery" ADD CONSTRAINT "CommunicationDelivery_organizationId_recoveryDispatchId_fkey" FOREIGN KEY ("organizationId", "recoveryDispatchId") REFERENCES "RecoveryDispatch"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CommunicationAttempt" ADD CONSTRAINT "CommunicationAttempt_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CommunicationAttempt" ADD CONSTRAINT "CommunicationAttempt_organizationId_deliveryId_fkey" FOREIGN KEY ("organizationId", "deliveryId") REFERENCES "CommunicationDelivery"("organizationId", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CommunicationSuppression" ADD CONSTRAINT "CommunicationSuppression_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


ALTER TABLE "CommunicationAccount" ADD CONSTRAINT communication_account_fields CHECK (channel IN ('sms','email') AND revision > 0);
ALTER TABLE "CommunicationDelivery" ADD CONSTRAINT communication_delivery_fields CHECK (direction IN ('inbound','outbound') AND attempts BETWEEN 0 AND 3 AND status IN ('recorded','received','queued','awaiting_provider','sending','accepted','sent','delivered','failed','unknown','cancelled'));
ALTER TABLE "CommunicationSuppression" ADD CONSTRAINT communication_suppression_channel CHECK (channel IN ('sms','email'));
COMMIT;

