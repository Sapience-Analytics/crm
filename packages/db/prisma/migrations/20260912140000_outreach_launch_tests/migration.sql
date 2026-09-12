-- CreateTable
CREATE TABLE "outreachLaunchTest" (
    "id" TEXT NOT NULL,
    "batchId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "recipientEmail" TEXT NOT NULL,
    "contactId" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'SENDING',
    "rfcMessageId" TEXT NOT NULL,
    "gmailMessageId" TEXT,
    "gmailThreadId" TEXT,
    "sentAt" TIMESTAMP(3),
    "loggedAt" TIMESTAMP(3),
    "responseMessageId" TEXT,
    "responseStatus" TEXT,
    "responseAt" TIMESTAMP(3),
    "responseLoggedAt" TIMESTAMP(3),
    "recipientAuth" JSONB,
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "outreachLaunchTest_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "outreachLaunchTest_rfcMessageId_key" ON "outreachLaunchTest"("rfcMessageId");

-- CreateIndex
CREATE INDEX "outreachLaunchTest_ownerId_createdAt_idx" ON "outreachLaunchTest"("ownerId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "outreachLaunchTest_batchId_kind_key" ON "outreachLaunchTest"("batchId", "kind");
