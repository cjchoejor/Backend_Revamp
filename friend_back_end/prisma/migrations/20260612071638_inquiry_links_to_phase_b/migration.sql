-- AlterTable
ALTER TABLE "inquiries" ADD COLUMN     "corporateAccountId" TEXT,
ADD COLUMN     "travelAgentId" TEXT;

-- CreateIndex
CREATE INDEX "inquiries_travelAgentId_idx" ON "inquiries"("travelAgentId");

-- CreateIndex
CREATE INDEX "inquiries_corporateAccountId_idx" ON "inquiries"("corporateAccountId");

-- AddForeignKey
ALTER TABLE "inquiries" ADD CONSTRAINT "inquiries_travelAgentId_fkey" FOREIGN KEY ("travelAgentId") REFERENCES "travel_agents"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inquiries" ADD CONSTRAINT "inquiries_corporateAccountId_fkey" FOREIGN KEY ("corporateAccountId") REFERENCES "corporate_accounts"("id") ON DELETE SET NULL ON UPDATE CASCADE;
