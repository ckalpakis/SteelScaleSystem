-- CreateEnum
CREATE TYPE "ChatRole" AS ENUM ('user', 'assistant', 'tool');

-- CreateEnum
CREATE TYPE "ChatSessionStatus" AS ENUM ('active', 'booked');

-- CreateTable
CREATE TABLE "ChatSession" (
    "id" UUID NOT NULL,
    "client_id" UUID NOT NULL,
    "session_key" TEXT NOT NULL,
    "status" "ChatSessionStatus" NOT NULL DEFAULT 'active',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ChatSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ChatMessage" (
    "id" UUID NOT NULL,
    "chat_session_id" UUID NOT NULL,
    "role" "ChatRole" NOT NULL,
    "content" TEXT NOT NULL,
    "tool_call_id" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ChatMessage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ChatSession_client_id_session_key_key" ON "ChatSession"("client_id", "session_key");

-- CreateIndex
CREATE INDEX "ChatSession_updated_at_idx" ON "ChatSession"("updated_at");

-- CreateIndex
CREATE INDEX "ChatMessage_chat_session_id_created_at_idx" ON "ChatMessage"("chat_session_id", "created_at");

-- AddForeignKey
ALTER TABLE "ChatSession" ADD CONSTRAINT "ChatSession_client_id_fkey" FOREIGN KEY ("client_id") REFERENCES "Client"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChatMessage" ADD CONSTRAINT "ChatMessage_chat_session_id_fkey" FOREIGN KEY ("chat_session_id") REFERENCES "ChatSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;
