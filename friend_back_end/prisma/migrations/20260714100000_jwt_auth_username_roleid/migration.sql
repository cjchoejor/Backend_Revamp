-- Expand-backfill-contract: add `username` + `roleId` to staff_users without dropping existing rows.
-- Runs in one transaction; if any step fails the whole thing rolls back.

BEGIN;

-- 1. EXPAND: add columns nullable so existing rows survive the initial ADD.
ALTER TABLE "staff_users" ADD COLUMN "username" TEXT;
ALTER TABLE "staff_users" ADD COLUMN "roleId"   TEXT;

-- 2. BACKFILL usernames.
-- Seed rows first (canonical role codes → nice short usernames). Uses ORDER BY createdAt LIMIT 1
-- so if two rows share a role code, only the earliest gets the short name and the rest fall
-- through to the slug branch below. Prevents unique-index collisions.
UPDATE "staff_users" SET "username" = 'frontdesk'
  WHERE id = (SELECT id FROM "staff_users" WHERE "role" = 'FRONT_DESK' AND "username" IS NULL ORDER BY "createdAt" ASC LIMIT 1);
UPDATE "staff_users" SET "username" = 'fom'
  WHERE id = (SELECT id FROM "staff_users" WHERE "role" = 'FOM' AND "username" IS NULL ORDER BY "createdAt" ASC LIMIT 1);
UPDATE "staff_users" SET "username" = 'gm'
  WHERE id = (SELECT id FROM "staff_users" WHERE "role" = 'GM' AND "username" IS NULL ORDER BY "createdAt" ASC LIMIT 1);
UPDATE "staff_users" SET "username" = 'admin'
  WHERE id = (SELECT id FROM "staff_users" WHERE "role" = 'ADMIN' AND "username" IS NULL ORDER BY "createdAt" ASC LIMIT 1);

-- Everyone else: derive a username from `fullName` (lowercased, non-alnum → `.`) with the first
-- 6 chars of `id` appended so duplicates from same name don't collide. Trim edge dots.
UPDATE "staff_users"
SET "username" = REGEXP_REPLACE(
  LOWER(REGEXP_REPLACE("fullName", '[^a-zA-Z0-9]+', '.', 'g')) || '.' || SUBSTRING(id, 1, 6),
  '^\.+|\.+$', '', 'g'
)
WHERE "username" IS NULL;

-- Safety net: any row that STILL has NULL (e.g. fullName was empty) gets `user.<id-suffix>`.
UPDATE "staff_users"
SET "username" = 'user.' || SUBSTRING(id, 1, 8)
WHERE "username" IS NULL OR "username" = '';

-- 3. BACKFILL roleId by matching the legacy `role` text against Role.roleCode.
-- Any role that doesn't match a Role row stays NULL (roleId is nullable in the schema during the
-- transition; the admin service enforces it going forward).
UPDATE "staff_users" s
SET "roleId" = r.id
FROM "roles" r
WHERE r."roleCode" = s."role" AND s."roleId" IS NULL;

-- 4. CONTRACT: enforce NOT NULL + unique on username; add the FK for roleId.
ALTER TABLE "staff_users" ALTER COLUMN "username" SET NOT NULL;
CREATE UNIQUE INDEX "staff_users_username_key" ON "staff_users"("username");
ALTER TABLE "staff_users"
  ADD CONSTRAINT "staff_users_roleId_fkey"
  FOREIGN KEY ("roleId") REFERENCES "roles"("id") ON DELETE SET NULL ON UPDATE CASCADE;

COMMIT;
