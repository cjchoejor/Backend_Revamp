-- Folio lines get a readable id that names their folio (2026-09-09, operator request):
-- `FOL-20260908-0001-L03` instead of a uuid nobody can place. The desk prints this id on the
-- correction row that adjusts a charge, so the parent has to be readable from the id itself.

-- The sequence behind the "-L<nn>" suffix. Not a live count: a deleted line never frees its
-- number, and the atomic `UPDATE … RETURNING` on this column is what stops two charges posted
-- at the same instant from both claiming L03.
ALTER TABLE "folios" ADD COLUMN "lineSequence" INTEGER NOT NULL DEFAULT 0;

-- No uuid default any more — every writer allocates through `allocateFolioLineId`, so a caller
-- that forgets fails loudly at insert rather than quietly writing an opaque id.
ALTER TABLE "folio_lines" ALTER COLUMN "id" DROP DEFAULT;

-- Existing ids are rewritten by scripts/backfill-folio-line-ids.ts (dry-run default), which
-- also seeds each folio's lineSequence. The FK from billing_model_transition_records is
-- already ON UPDATE CASCADE, so the rename carries.
