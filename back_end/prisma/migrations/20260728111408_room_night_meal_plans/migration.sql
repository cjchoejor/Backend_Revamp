-- CreateTable
CREATE TABLE "room_night_meal_plans" (
    "id" TEXT NOT NULL,
    "roomAssignmentId" TEXT NOT NULL,
    "date" DATE NOT NULL,
    "mealPlanCpCount" INTEGER NOT NULL DEFAULT 0,
    "mealPlanMaplCount" INTEGER NOT NULL DEFAULT 0,
    "mealPlanMapdCount" INTEGER NOT NULL DEFAULT 0,
    "mealPlanApCount" INTEGER NOT NULL DEFAULT 0,
    "mealPlanOthersCount" INTEGER NOT NULL DEFAULT 0,
    "othersBreakfastPax" INTEGER,
    "othersLunchPax" INTEGER,
    "othersDinnerPax" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT NOT NULL,

    CONSTRAINT "room_night_meal_plans_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "room_night_meal_plans_date_idx" ON "room_night_meal_plans"("date");

-- CreateIndex
CREATE UNIQUE INDEX "room_night_meal_plans_roomAssignmentId_date_key" ON "room_night_meal_plans"("roomAssignmentId", "date");

-- AddForeignKey
ALTER TABLE "room_night_meal_plans" ADD CONSTRAINT "room_night_meal_plans_roomAssignmentId_fkey" FOREIGN KEY ("roomAssignmentId") REFERENCES "room_assignments"("id") ON DELETE CASCADE ON UPDATE CASCADE;
