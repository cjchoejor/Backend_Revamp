-- The reading under way on an ID photo (2026-10-23): the desk draws its progress.
ALTER TABLE "identity_ocr_suggestions" ADD COLUMN "stage" TEXT;
ALTER TABLE "identity_ocr_suggestions" ADD COLUMN "stageAt" TIMESTAMP(3);
ALTER TABLE "identity_ocr_suggestions" ADD COLUMN "readingSince" TIMESTAMP(3);
