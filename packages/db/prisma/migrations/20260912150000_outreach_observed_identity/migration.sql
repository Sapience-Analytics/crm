ALTER TABLE "outreachDelivery" ADD COLUMN "observedRfcMessageId" TEXT;
ALTER TABLE "outreachLaunchTest" ADD COLUMN "observedRfcMessageId" TEXT;
CREATE UNIQUE INDEX "outreachDelivery_observedRfcMessageId_key" ON "outreachDelivery"("observedRfcMessageId");
CREATE UNIQUE INDEX "outreachLaunchTest_observedRfcMessageId_key" ON "outreachLaunchTest"("observedRfcMessageId");
