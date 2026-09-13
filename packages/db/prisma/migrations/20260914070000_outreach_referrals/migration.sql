ALTER TABLE "outreachProspect" ADD COLUMN "referredFromId" TEXT,
ADD COLUMN "referralDepth" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "outreachProspect" ADD COLUMN "eligibilityDueAt" TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN "eligibilityLease" TEXT,
ADD COLUMN "eligibilityLeaseUntil" TIMESTAMP(3),
ADD COLUMN "eligibilityError" TEXT,
ADD COLUMN "eligibilityAssessment" JSONB;
ALTER TABLE "outreachProspect" ADD COLUMN "replyReceivedAt" TIMESTAMP(3);
CREATE INDEX "outreachProspect_eligibilityDueAt_idx" ON "outreachProspect"("eligibilityDueAt");

DROP INDEX "outreachProspect_domain_key";
CREATE UNIQUE INDEX "outreachProspect_domain_key" ON "outreachProspect"("domain") WHERE "referredFromId" IS NULL;
CREATE UNIQUE INDEX "outreachProspect_referredFromId_key" ON "outreachProspect"("referredFromId");
ALTER TABLE "outreachProspect" ADD CONSTRAINT "outreachProspect_referredFromId_fkey" FOREIGN KEY ("referredFromId") REFERENCES "outreachProspect"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "outreachInbound" (
  "id" TEXT NOT NULL,
  "prospectId" TEXT NOT NULL,
  "messageId" TEXT NOT NULL,
  "message" JSONB NOT NULL,
  "classification" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "outreachInbound_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "outreachInbound_prospectId_messageId_key" ON "outreachInbound"("prospectId", "messageId");
ALTER TABLE "outreachInbound" ADD CONSTRAINT "outreachInbound_prospectId_fkey" FOREIGN KEY ("prospectId") REFERENCES "outreachProspect"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "outreachReferral" (
  "id" TEXT NOT NULL,
  "prospectId" TEXT NOT NULL,
  "messageId" TEXT NOT NULL,
  "message" JSONB NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'PENDING',
  "dueAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "lease" TEXT,
  "leaseUntil" TIMESTAMP(3),
  "decision" JSONB,
  "error" TEXT,
  "completedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "outreachReferral_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "outreachReferral_prospectId_messageId_key" ON "outreachReferral"("prospectId", "messageId");
CREATE INDEX "outreachReferral_status_dueAt_idx" ON "outreachReferral"("status", "dueAt");
ALTER TABLE "outreachReferral" ADD CONSTRAINT "outreachReferral_prospectId_fkey" FOREIGN KEY ("prospectId") REFERENCES "outreachProspect"("id") ON DELETE CASCADE ON UPDATE CASCADE;

UPDATE "outreachCampaign" SET "status" = 'PAUSED', "approvedHash" = NULL, "approvedAt" = NULL,
"lastError" = 'Review the automated qualification and referral rules before launch.';
UPDATE "outreachProspect" SET "emailDraftStatus" = 'STALE', "emailDraftHash" = NULL,
"emailDraftReviewedHash" = NULL, "emailDraftReviewedAt" = NULL,
"emailDraftDueAt" = CURRENT_TIMESTAMP, "emailDraftAttempts" = 0
WHERE "initialSentAt" IS NULL;
