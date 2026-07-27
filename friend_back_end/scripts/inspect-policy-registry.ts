import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();
const rows = await prisma.policyRegistry.findMany({ orderBy: { policyId: "asc" } });
console.log(`Found ${rows.length} policy_registry row(s):`);
for (const r of rows) {
  console.log(`  - ${r.policyId} v${r.version} ${r.isActive ? "[active]" : "[inactive]"}  def=${JSON.stringify(r.policyDefinition)}`);
}
await prisma.$disconnect();
