/*
  Warnings:

  - A unique constraint covering the columns `[entryId,taskType]` on the table `pre_arrival_tasks` will be added. If there are existing duplicate values, this will fail.

*/
-- CreateIndex
CREATE UNIQUE INDEX "pre_arrival_tasks_entryId_taskType_key" ON "pre_arrival_tasks"("entryId", "taskType");
