-- CreateTable
CREATE TABLE "outreachCampaign" (
    "id" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "senderEmail" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "templates" JSONB NOT NULL,
    "approvedHash" TEXT,
    "approvedAt" TIMESTAMP(3),
    "readiness" JSONB,
    "researchEnabled" BOOLEAN NOT NULL DEFAULT false,
    "researchDueAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "researchLease" TEXT,
    "researchLeaseUntil" TIMESTAMP(3),
    "sendLease" TEXT,
    "sendLeaseUntil" TIMESTAMP(3),
    "lastError" TEXT,
    "lastResearchError" TEXT,
    "lastTickAt" TIMESTAMP(3),
    "lastResearchAt" TIMESTAMP(3),
    "pilotPassedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "outreachCampaign_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "outreachProspect" (
    "id" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "domain" TEXT NOT NULL,
    "email" TEXT,
    "companyId" TEXT,
    "contactId" TEXT,
    "evidence" JSONB NOT NULL,
    "consent" JSONB,
    "status" TEXT NOT NULL DEFAULT 'HELD',
    "manual" BOOLEAN NOT NULL DEFAULT false,
    "pilotSlot" INTEGER,
    "nextStage" INTEGER NOT NULL DEFAULT 0,
    "nextDueAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "initialSentAt" TIMESTAMP(3),
    "lastCheckedAt" TIMESTAMP(3),
    "stopReason" TEXT,
    "replyText" TEXT,
    "replyDraft" TEXT,
    "replyDraftLeaseUntil" TIMESTAMP(3),
    "replyDraftDueAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "stoppedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "outreachProspect_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "outreachDelivery" (
    "id" TEXT NOT NULL,
    "prospectId" TEXT NOT NULL,
    "stage" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'SENDING',
    "rfcMessageId" TEXT NOT NULL,
    "gmailMessageId" TEXT,
    "gmailThreadId" TEXT,
    "subject" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "approvalHash" TEXT NOT NULL,
    "sentAt" TIMESTAMP(3),
    "loggedAt" TIMESTAMP(3),
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "outreachDelivery_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "outreachSuppression" (
    "email" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "outreachSuppression_pkey" PRIMARY KEY ("email")
);

-- CreateTable
CREATE TABLE "outreachBudget" (
    "id" TEXT NOT NULL,
    "reservedMicroUsd" INTEGER NOT NULL DEFAULT 0,
    "actualMicroUsd" INTEGER NOT NULL DEFAULT 0,
    "calls" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "outreachBudget_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "outreachReport" (
    "id" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "week" TIMESTAMP(3) NOT NULL,
    "summary" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "outreachReport_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "outreachProspect_domain_key" ON "outreachProspect"("domain");

-- CreateIndex
CREATE UNIQUE INDEX "outreachProspect_email_key" ON "outreachProspect"("email");

-- CreateIndex
CREATE UNIQUE INDEX "outreachProspect_pilotSlot_key" ON "outreachProspect"("pilotSlot");

-- CreateIndex
CREATE INDEX "outreachProspect_campaignId_status_nextDueAt_idx" ON "outreachProspect"("campaignId", "status", "nextDueAt");

-- CreateIndex
CREATE UNIQUE INDEX "outreachDelivery_rfcMessageId_key" ON "outreachDelivery"("rfcMessageId");

-- CreateIndex
CREATE INDEX "outreachDelivery_status_createdAt_idx" ON "outreachDelivery"("status", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "outreachDelivery_prospectId_stage_key" ON "outreachDelivery"("prospectId", "stage");

-- AddForeignKey
ALTER TABLE "outreachProspect" ADD CONSTRAINT "outreachProspect_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "outreachCampaign"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "outreachDelivery" ADD CONSTRAINT "outreachDelivery_prospectId_fkey" FOREIGN KEY ("prospectId") REFERENCES "outreachProspect"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "outreachReport" ADD CONSTRAINT "outreachReport_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "outreachCampaign"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
