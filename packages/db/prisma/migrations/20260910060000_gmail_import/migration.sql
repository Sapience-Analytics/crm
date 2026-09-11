CREATE TABLE "gmailImport" (
  "id" TEXT NOT NULL,
  "mailboxId" TEXT NOT NULL,
  "after" TIMESTAMP(3) NOT NULL,
  "before" TIMESTAMP(3) NOT NULL,
  "phase" TEXT NOT NULL DEFAULT 'sent',
  "pageToken" TEXT,
  "pendingIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
  "pageLoaded" BOOLEAN NOT NULL DEFAULT false,
  "reviewed" INTEGER NOT NULL DEFAULT 0,
  "imported" INTEGER NOT NULL DEFAULT 0,
  "skipped" INTEGER NOT NULL DEFAULT 0,
  "lastError" TEXT,
  "retryAfter" TIMESTAMP(3),
  "leaseToken" TEXT,
  "leaseUntil" TIMESTAMP(3),
  "completedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "gmailImport_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "gmailImport_mailboxId_key" ON "gmailImport"("mailboxId");
ALTER TABLE "gmailImport" ADD CONSTRAINT "gmailImport_mailboxId_fkey" FOREIGN KEY ("mailboxId") REFERENCES "mailboxSync"("id") ON DELETE CASCADE ON UPDATE CASCADE;
