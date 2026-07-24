import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

// Args: <code> [<targetId>]   targetId defaults to <CODE>-<padded creation-order seq>
const codeArg = process.argv[2];
const explicitTarget = process.argv[3];
if (!codeArg) {
  console.error("Usage: tsx scripts/rename-room-type-id.ts <CODE> [<targetId>]");
  console.error("Example: tsx scripts/rename-room-type-id.ts STD STD-0002");
  process.exit(1);
}
const CODE = codeArg.toUpperCase();

const existing = await prisma.roomType.findUnique({ where: { code: CODE } });
if (!existing) {
  console.error(`No room type with code=${CODE} — nothing to rename.`);
  await prisma.$disconnect();
  process.exit(1);
}

// Derive target id from creation order when not supplied: count rows created at or before this
// row's createdAt, padded to 4 digits. Matches the createRoomType service's <CODE>-<global-seq>.
let NEW_ID: string;
if (explicitTarget) {
  NEW_ID = explicitTarget;
} else {
  const seq = await prisma.roomType.count({ where: { createdAt: { lte: existing.createdAt } } });
  NEW_ID = `${CODE}-${String(seq).padStart(4, "0")}`;
}

if (existing.id === NEW_ID) {
  console.log(`Room type ${CODE} already at ${NEW_ID}; nothing to do.`);
  await prisma.$disconnect();
  process.exit(0);
}

console.log(`Renaming room type ${CODE} id: ${existing.id} → ${NEW_ID}`);

await prisma.$transaction(async (tx) => {
  // Park the old row under a temporary code so we can mint the new row with the real code.
  const tmpCode = `${existing.code}__migrating__${Date.now()}`;
  await tx.roomType.update({ where: { id: existing.id }, data: { code: tmpCode } });

  await tx.roomType.create({
    data: { id: NEW_ID, code: existing.code, name: existing.name, createdAt: existing.createdAt },
  });

  const roomsMoved = await tx.room.updateMany({ where: { roomTypeId: existing.id }, data: { roomTypeId: NEW_ID } });
  const holdsMoved = await tx.committedHold.updateMany({ where: { roomTypeId: existing.id }, data: { roomTypeId: NEW_ID } });
  const ratePlansMoved = await tx.ratePlanRegistry.updateMany({ where: { roomTypeId: existing.id }, data: { roomTypeId: NEW_ID } });

  await tx.roomType.delete({ where: { id: existing.id } });

  console.log(`Moved ${roomsMoved.count} room(s), ${holdsMoved.count} committed hold(s), ${ratePlansMoved.count} rate plan binding(s) to ${NEW_ID}.`);
});

const after = await prisma.roomType.findMany({ orderBy: { createdAt: "asc" } });
console.log("Room types now:", after.map((r) => ({ id: r.id, code: r.code, name: r.name })));

await prisma.$disconnect();
