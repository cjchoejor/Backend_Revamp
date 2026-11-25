/**
 * Put the hotel's service apartments on the admin console, from "Service Apartment Rates - 2026"
 * (docs/Service Apartment Rates - 2026.pdf; 2026-11-25, operator: "also seed the values from the pdf
 * to the admin console").
 *
 *   npx tsx scripts/seed-apartment-packages.ts             # dry run: says what it would do
 *   npx tsx scripts/seed-apartment-packages.ts --commit    # writes
 *   npx tsx scripts/seed-apartment-packages.ts --commit --overwrite   # also puts back a package already there
 *
 * The sheet's rates have service charge and GST in them, so they go in as typed with both; the rate
 * kept is without them (Nu 48,000 → Nu 41,558.44, billed Nu 47,999.99 — operator's choice, strict 5%).
 * The 2 BHK is one apartment of two rooms let together (505 = rooms 5051 + 5052; operator's choice,
 * the same day). A package already on the console is left as it is unless --overwrite.
 * Written through the admin service, so each package is audited as any admin save is.
 */
import { prisma } from "../src/db.js";
import {
  createApartmentPackage,
  listApartmentPackages,
  updateApartmentPackage,
  type ApartmentPackageInput,
} from "../src/services/admin/apartment-admin-service.js";
import { workOutApartmentRates } from "../src/services/admin/apartment-admin-service.js";

const COMMIT = process.argv.includes("--commit");
const OVERWRITE = process.argv.includes("--overwrite");
const ACTOR = "SYSTEM_SEED";

type Sheet = Omit<ApartmentPackageInput, "units" | "ratesWithTaxes"> & { units: Array<{ label: string; maxOccupants: number; rooms: string[] }> };

const SHEET: Sheet[] = [
  {
    name: "Premium Suite",
    carpetAreaSqft: 850,
    amenities: [
      "Bedroom: 1 bedroom (king sized bed)",
      "1 living room with dining table",
      "1 attached master bathroom with bathtub, shower cubicle and vanity mirror",
      "1 common bathroom",
      "Kitchen: modular kitchen",
      "Furnishings and amenities: sofa set, shoe rack, study table set, wardrobe, double door fridge",
    ].join("\n"),
    weeklyRate: "22400",
    monthlyRate: "48000",
    sortOrder: 1,
    units: [
      { label: "503", maxOccupants: 3, rooms: ["503"] },
      { label: "504", maxOccupants: 3, rooms: ["504"] },
    ],
  },
  {
    name: "Executive Apartment",
    carpetAreaSqft: 820,
    amenities: [
      "1 bedroom (king sized bed)",
      "1 living room with dining table",
      "1 attached master bathroom with bathtub",
      "1 common bathroom",
      "Kitchen: modular kitchen",
      "Furnishings and amenities: sofa set, shoe rack, study table set, wardrobe, vanity mirror, double door fridge",
    ].join("\n"),
    weeklyRate: "19600",
    monthlyRate: "42000",
    sortOrder: 2,
    units: [
      { label: "502", maxOccupants: 3, rooms: ["502"] },
      { label: "602", maxOccupants: 3, rooms: ["602"] },
      { label: "702", maxOccupants: 3, rooms: ["702"] },
    ],
  },
  {
    name: "Deluxe Studio Apartment",
    carpetAreaSqft: 660,
    amenities: [
      "1 bedroom (king sized bed)",
      "1 living room with dining table",
      "1 attached bathroom with bathtub",
      "Kitchen: modular kitchen",
      "Furnishings and amenities: sofa set, shoe rack, study table set, wardrobe, double door fridge",
    ].join("\n"),
    weeklyRate: "17500",
    monthlyRate: "37500",
    sortOrder: 3,
    units: [
      { label: "501", maxOccupants: 3, rooms: ["501"] },
      { label: "601", maxOccupants: 3, rooms: ["601"] },
      { label: "701", maxOccupants: 3, rooms: ["701"] },
    ],
  },
  {
    name: "Family Apartment (2 BHK)",
    carpetAreaSqft: 1385,
    amenities: [
      "2 bedrooms: 1 with a king sized bed, 1 with twin (2) beds",
      "1 living room with dining table",
      "Bathrooms: an attached master bathroom for each bedroom, 1 common bathroom with bathtub",
      "Kitchen: modular kitchen",
      "Furnishings and amenities: sofa set, shoe rack, study table set, wardrobe, vanity mirror, double door fridge",
    ].join("\n"),
    weeklyRate: "28000",
    monthlyRate: "60000",
    sortOrder: 4,
    units: [
      { label: "505", maxOccupants: 5, rooms: ["5051", "5052"] },
      { label: "603", maxOccupants: 5, rooms: ["6031", "6032"] },
      { label: "703", maxOccupants: 5, rooms: ["7031", "7032"] },
    ],
  },
];

async function main() {
  const db = process.env.DATABASE_URL?.match(/\/([^/?]+)\?/)?.[1] ?? "?";
  console.log(`Database: ${db} · ${COMMIT ? "WRITING" : "dry run"}${OVERWRITE ? " · overwrite" : ""}`);
  const rooms = await prisma.room.findMany({ select: { id: true, roomNumber: true } });
  const roomId = new Map(rooms.map((r) => [r.roomNumber, r.id]));
  const existing = new Map((await listApartmentPackages(prisma)).packages.map((p) => [p.name.toLowerCase(), p]));

  let missingRooms = 0;
  for (const p of SHEET) {
    const units = p.units.map((u) => {
      const ids = u.rooms.map((n) => roomId.get(n));
      const missing = u.rooms.filter((_, i) => !ids[i]);
      if (missing.length) {
        missingRooms += missing.length;
        console.log(`  ! ${p.name} · apartment ${u.label}: room ${missing.join(", ")} is not on this database`);
      }
      return { label: u.label, maxOccupants: u.maxOccupants, roomIds: ids.filter((x): x is string => !!x) };
    });
    const input: ApartmentPackageInput = { ...p, ratesWithTaxes: true, units: units.filter((u) => u.roomIds.length) };
    const figures = await workOutApartmentRates(prisma, { weekly: p.weeklyRate, monthly: p.monthlyRate, withTaxes: true });
    const weekly = figures.weekly!;
    const monthly = figures.monthly!;
    const have = existing.get(p.name.toLowerCase());
    const what = have ? (OVERWRITE ? "put back" : "already there, left as it is") : "add";
    console.log(
      `${what.padEnd(28)} ${p.name} · ${p.carpetAreaSqft} sq ft · ${p.units.map((u) => `${u.label}${u.rooms.length > 1 ? ` (${u.rooms.join(" + ")})` : ""} up to ${u.maxOccupants}`).join(", ")}`,
    );
    console.log(`    weekly  typed ${p.weeklyRate} → rate ${weekly.rate} + SC ${weekly.serviceCharge} + GST ${weekly.gst} = ${weekly.total}`);
    console.log(`    monthly typed ${p.monthlyRate} → rate ${monthly.rate} + SC ${monthly.serviceCharge} + GST ${monthly.gst} = ${monthly.total}`);
    if (!COMMIT) continue;
    if (have && !OVERWRITE) continue;
    if (have) await updateApartmentPackage(prisma, have.id, input, ACTOR);
    else await createApartmentPackage(prisma, input, ACTOR);
  }
  if (missingRooms) console.log(`${missingRooms} room(s) not found; those apartments were written without them.`);
  console.log(COMMIT ? "Done." : "Dry run: nothing written. Add --commit to write.");
}

main()
  .catch((e) => {
    console.error(e?.body?.message ?? e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
