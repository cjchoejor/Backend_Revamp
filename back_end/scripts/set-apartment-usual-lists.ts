/**
 * Put what the apartments hold now on each package's usual list (2026-11-27, operator: "right now they
 * add these in the apartment" — Rice pot 1, Curry pot 1, Tea pot 1, Oven 1, Induction 1, Chopping board
 * 1, Knife holder 1, Spatula 4, Plate 2, Cup 2, Small bowl 2, Spoon 2, Fork 2, Knife 2, Water glass 2,
 * Frying pan 1, Dustbin, Broom & dust collector — the last two with no count given, taken as 1).
 *
 *   npx tsx scripts/set-apartment-usual-lists.ts            # dry run
 *   npx tsx scripts/set-apartment-usual-lists.ts --commit   # writes
 *   npx tsx scripts/set-apartment-usual-lists.ts --commit --overwrite   # also replaces a list already set
 *
 * A package that already has a usual list is left as it is unless --overwrite. Each write is audited as
 * an admin save is (`ADMIN.APARTMENT_PACKAGE_UPDATED`, the list before and after). The packages'
 * apartments and rates are not touched. A booking keeps its own list once the desk saves one.
 */
import { Prisma } from "@prisma/client";
import { prisma } from "../src/db.js";
import { writeAdminAuditEvent } from "../src/lib/admin/write-admin-audit.js";
import { cleanAmenityItems } from "../src/lib/apartment-amenities.js";

const COMMIT = process.argv.includes("--commit");
const OVERWRITE = process.argv.includes("--overwrite");
const ACTOR = "SYSTEM_SEED";

const LIST = cleanAmenityItems(
  [
    ["Rice pot", 1],
    ["Curry pot", 1],
    ["Tea pot", 1],
    ["Oven", 1],
    ["Induction", 1],
    ["Chopping board", 1],
    ["Knife holder", 1],
    ["Spatula", 4],
    ["Plate", 2],
    ["Cup", 2],
    ["Small bowl", 2],
    ["Spoon", 2],
    ["Fork", 2],
    ["Knife", 2],
    ["Water glass", 2],
    ["Frying pan", 1],
    ["Dustbin", 1],
    ["Broom & dust collector", 1],
  ].map(([name, count]) => ({ name, count })),
  "the operator's list",
);

async function main() {
  const packages = await prisma.apartmentPackage.findMany({ select: { id: true, name: true, amenityKit: true }, orderBy: [{ sortOrder: "asc" }, { name: "asc" }] });
  let wrote = 0;
  for (const p of packages) {
    const has = Array.isArray(p.amenityKit) && (p.amenityKit as unknown[]).length > 0;
    if (has && !OVERWRITE) {
      console.log(`keep   ${p.name} — has a usual list of ${(p.amenityKit as unknown[]).length} items (--overwrite to replace)`);
      continue;
    }
    console.log(`${COMMIT ? "set   " : "would "} ${p.name} — ${LIST.length} items`);
    if (!COMMIT) continue;
    await prisma.$transaction(async (tx) => {
      await tx.apartmentPackage.update({ where: { id: p.id }, data: { amenityKit: LIST as unknown as Prisma.InputJsonValue, updatedBy: ACTOR } });
      await writeAdminAuditEvent(tx, {
        actorId: ACTOR,
        eventType: "ADMIN.APARTMENT_PACKAGE_UPDATED",
        entityType: "ApartmentPackage",
        entityId: p.id,
        operation: "UPDATE",
        payload: { before: { amenityKit: p.amenityKit }, after: { amenityKit: LIST }, cause: "set-apartment-usual-lists" },
      });
    });
    wrote++;
  }
  console.log(COMMIT ? `done — ${wrote} package(s) set` : "dry run — nothing written (--commit to write)");
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
