-- CreateTable
CREATE TABLE "house_tariffs" (
    "id" TEXT NOT NULL,
    "extraBedRate" DECIMAL(10,2),
    "breakfastRate" DECIMAL(10,2),
    "lunchRate" DECIMAL(10,2),
    "dinnerRate" DECIMAL(10,2),
    "cpRate" DECIMAL(10,2),
    "mapLunchRate" DECIMAL(10,2),
    "mapDinnerRate" DECIMAL(10,2),
    "apRate" DECIMAL(10,2),
    "currency" TEXT NOT NULL DEFAULT 'BTN',
    "effectiveFrom" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "effectiveTo" TIMESTAMP(3),
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT NOT NULL,

    CONSTRAINT "house_tariffs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "house_tariffs_effectiveFrom_idx" ON "house_tariffs"("effectiveFrom");

-- CreateIndex
CREATE INDEX "house_tariffs_effectiveTo_idx" ON "house_tariffs"("effectiveTo");
