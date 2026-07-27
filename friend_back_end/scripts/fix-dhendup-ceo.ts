/**
 * One-shot: clean up misnamed Role rows, create a proper CEO role, reassign Dhendup Cheten.
 *
 * Dry-run by default — prints what it will do without touching anything. Pass `--commit` to
 * actually apply. Wrapped in a transaction so partial failure rolls back cleanly.
 *
 * Steps:
 *   1. Find the two misnamed role rows (roleCode looks like a job description with a person's
 *      display name, e.g. `Chief Executive Officer` / Dhendup Cheten).
 *   2. If any staff_users point to those roles, null out their roleId first (FK is ON DELETE
 *      SET NULL so this would happen anyway; doing it explicitly makes the audit trail clear).
 *   3. Delete any RolePermissionMapping + RoleSessionConfig rows tied to them (RESTRICT FK).
 *   4. Delete the misnamed Role rows.
 *   5. Create a proper CEO role (roleCode=CEO, displayName=Chief Executive Officer, L4).
 *   6. Update Dhendup Cheten's staff row: actorLevel=L4, role=CEO, roleId=<new CEO id>.
 */
import { prisma } from "../src/db.js";
import { allocateReadableId } from "../src/lib/readable-id.js";

const COMMIT = process.argv.includes("--commit");
const MISNAMED_ROLE_CODES = ["Chief Executive Officer", "General Manager"];
// The FOUR canonical seed role codes we must NEVER touch — they're the real role definitions.
const CANONICAL_ROLE_CODES = new Set(["FRONT_DESK", "FOM", "GM", "ADMIN"]);

async function main() {
  console.log(COMMIT ? "🚨 COMMIT mode — changes will be persisted" : "🔍 DRY RUN — nothing will be written (pass --commit to apply)");
  console.log("");

  // 1. Find misnamed rows. Filter by the reported roleCode strings AND exclude any that happen
  //    to match a canonical role code (defensive — we NEVER want to accidentally delete FRONT_DESK).
  const misnamed = await prisma.role.findMany({
    where: {
      roleCode: { in: MISNAMED_ROLE_CODES },
      NOT: { roleCode: { in: [...CANONICAL_ROLE_CODES] } },
    },
    select: { id: true, roleCode: true, displayName: true, actorLevel: true },
  });
  console.log(`Found ${misnamed.length} misnamed role row(s) to delete:`);
  for (const r of misnamed) console.log(`  - ${r.roleCode} · displayName="${r.displayName}" · ${r.actorLevel} · ${r.id}`);
  console.log("");

  const dhendup = await prisma.staffUser.findFirst({
    where: { fullName: "Dhendup Cheten" },
    select: { id: true, fullName: true, username: true, actorLevel: true, role: true, roleId: true },
  });
  if (!dhendup) throw new Error("Dhendup Cheten not found in staff_users — check the spelling / run show-staff-roles.ts first");
  console.log(`Dhendup's CURRENT staff row:`);
  console.log(`  id=${dhendup.id} username=${dhendup.username} actorLevel=${dhendup.actorLevel} role=${dhendup.role} roleId=${dhendup.roleId}`);
  console.log("");

  // Sanity — verify a CEO role doesn't already exist so we don't create a duplicate.
  const existingCeo = await prisma.role.findFirst({ where: { roleCode: "CEO" } });
  console.log(existingCeo
    ? `An existing CEO role was found (${existingCeo.id}). Will reuse it instead of creating a new one.`
    : `No existing CEO role. Will create one.`);
  console.log("");

  if (!COMMIT) {
    console.log("Plan preview:");
    console.log("  1. For each misnamed role: null out staff_users.roleId, delete RolePermissionMapping + RoleSessionConfig, delete the Role.");
    console.log("  2. Create a CEO role (or reuse the existing one).");
    console.log("  3. Set Dhendup: actorLevel=L4, role='CEO', roleId=<CEO id>.");
    console.log("");
    console.log("Re-run with --commit to apply.");
    await prisma.$disconnect();
    return;
  }

  await prisma.$transaction(async (tx) => {
    for (const r of misnamed) {
      const nulledCount = await tx.staffUser.updateMany({ where: { roleId: r.id }, data: { roleId: null } });
      if (nulledCount.count > 0) console.log(`  Nulled roleId on ${nulledCount.count} staff_user row(s) that pointed to ${r.roleCode}.`);

      const delMappings = await tx.rolePermissionMapping.deleteMany({ where: { roleId: r.id } });
      if (delMappings.count > 0) console.log(`  Deleted ${delMappings.count} RolePermissionMapping row(s) for ${r.roleCode}.`);

      const delCfg = await tx.roleSessionConfig.deleteMany({ where: { roleId: r.id } });
      if (delCfg.count > 0) console.log(`  Deleted ${delCfg.count} RoleSessionConfig row(s) for ${r.roleCode}.`);

      await tx.role.delete({ where: { id: r.id } });
      console.log(`  Deleted Role ${r.roleCode} (${r.id}).`);
    }

    // 2. Create or reuse CEO role.
    let ceo = existingCeo;
    if (!ceo) {
      const ceoId = await allocateReadableId(tx, "ROLE" as const);
      ceo = await tx.role.create({
        data: {
          id: ceoId,
          roleCode: "CEO",
          displayName: "Chief Executive Officer",
          actorLevel: "L4",
          isActive: true,
          createdBy: "system-cleanup-script",
        },
      });
      console.log(`  Created CEO role: ${ceo.id}`);
    }

    // 3. Reassign Dhendup.
    await tx.staffUser.update({
      where: { id: dhendup.id },
      data: {
        actorLevel: "L4",
        role: "CEO",
        roleId: ceo.id,
      },
    });
    console.log(`  Updated ${dhendup.fullName}: actorLevel=L4, role=CEO, roleId=${ceo.id}`);
  });

  console.log("");
  console.log("✅ Done. Re-run scripts/show-staff-roles.ts to verify.");
  await prisma.$disconnect();
}

void main().catch(async (e) => {
  console.error("Script failed:", e);
  await prisma.$disconnect();
  process.exit(1);
});
