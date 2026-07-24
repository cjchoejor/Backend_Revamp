const { PrismaClient } = require("@prisma/client");

async function main() {
  const prisma = new PrismaClient();
  const q = await prisma.quotation.findFirst({ orderBy: { createdAt: "desc" } });
  console.log("quotation", q?.id, q?.state);
  if (!q) return;
  const timers = await prisma.timerRecord.findMany({
    where: { entityType: "Quotation", entityId: q.id },
    orderBy: { createdAt: "asc" },
  });
  console.log(
    timers.map((t) => ({
      id: t.id,
      timerType: t.timerType,
      status: t.status,
      pgBossJobId: t.pgBossJobId,
    })),
  );
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});

