import { prisma } from "../src/db.js";

async function main() {
  const roles = await prisma.role.findMany({
    select: { id: true, roleCode: true, displayName: true, actorLevel: true },
    orderBy: { actorLevel: "asc" },
  });
  const staff = await prisma.staffUser.findMany({
    select: {
      id: true,
      fullName: true,
      username: true,
      actorLevel: true,
      role: true,
      roleId: true,
      roleRef: { select: { roleCode: true, displayName: true, actorLevel: true } },
    },
    orderBy: { createdAt: "asc" },
  });
  console.log("=== ROLES ===");
  console.table(roles);
  console.log("\n=== STAFF_USERS ===");
  for (const s of staff) {
    console.log({
      id: s.id,
      fullName: s.fullName,
      username: s.username,
      "staff.actorLevel": s.actorLevel,
      "staff.role (text)": s.role,
      roleId: s.roleId,
      "linkedRole.roleCode": s.roleRef?.roleCode ?? null,
      "linkedRole.actorLevel": s.roleRef?.actorLevel ?? null,
    });
  }
  await prisma.$disconnect();
}
void main();
