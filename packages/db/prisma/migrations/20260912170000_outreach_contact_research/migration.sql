CREATE TABLE "outreachContactResearch" (
    "prospectId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "inputHash" TEXT,
    "dueAt" TIMESTAMP(3) DEFAULT CURRENT_TIMESTAMP,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lease" TEXT,
    "leaseUntil" TIMESTAMP(3),
    "candidates" JSONB,
    "submittedCandidates" JSONB,
    "error" TEXT,
    "completedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "outreachContactResearch_pkey" PRIMARY KEY ("prospectId")
);

CREATE INDEX "outreachContactResearch_status_dueAt_idx" ON "outreachContactResearch"("status", "dueAt");

ALTER TABLE "outreachContactResearch" ADD CONSTRAINT "outreachContactResearch_prospectId_fkey" FOREIGN KEY ("prospectId") REFERENCES "outreachProspect"("id") ON DELETE CASCADE ON UPDATE CASCADE;

UPDATE "outreachCampaign" SET "status" = 'PAUSED', "approvedHash" = NULL, "approvedAt" = NULL, "updatedAt" = CURRENT_TIMESTAMP WHERE "id" = 'geotab-wa';
