ALTER TABLE "outreachProspect"
ADD COLUMN "replyDraftAttempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "sourceVerificationAttempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "sourceVerificationDueAt" TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN "sourceVerificationLease" TEXT,
ADD COLUMN "sourceVerificationLeaseUntil" TIMESTAMP(3),
ADD COLUMN "emailDrafts" JSONB,
ADD COLUMN "emailDraftHash" TEXT,
ADD COLUMN "emailDraftStatus" TEXT NOT NULL DEFAULT 'PENDING',
ADD COLUMN "emailDraftAttempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "emailDraftDueAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN "emailDraftLease" TEXT,
ADD COLUMN "emailDraftLeaseUntil" TIMESTAMP(3),
ADD COLUMN "emailDraftError" TEXT,
ADD COLUMN "emailDraftModel" TEXT,
ADD COLUMN "emailDraftGeneratedAt" TIMESTAMP(3),
ADD COLUMN "emailDraftReviewedHash" TEXT,
ADD COLUMN "emailDraftReviewedAt" TIMESTAMP(3);
CREATE INDEX "outreachProspect_emailDraftStatus_emailDraftDueAt_idx" ON "outreachProspect"("emailDraftStatus", "emailDraftDueAt");
ALTER TABLE "outreachCampaign" ADD COLUMN "aiPausedReason" TEXT;
UPDATE "outreachCampaign" SET status = 'PAUSED', "approvedHash" = NULL, "approvedAt" = NULL WHERE id = 'geotab-wa';
