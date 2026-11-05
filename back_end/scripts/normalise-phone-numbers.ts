/**
 * Every stored phone number in the one form, "+975 17882104" (2026-11-05, operator: "in admin console,
 * there are numbers already, identify the country code if given and separate them, if not identify
 * the number pattern and assign the country code").
 *
 *   npx tsx scripts/normalise-phone-numbers.ts            dry run: says what it would do, writes nothing
 *   npx tsx scripts/normalise-phone-numbers.ts --commit   writes
 *
 * Reads: agencies' and companies' numbers and contact persons, the hotel's own numbers, guests,
 * callers, the enquiry's contact person, who is arriving. A number that says its code keeps it; one
 * with no code takes it from its pattern (eight digits is Bhutan, ten starting 6 to 9 is India). A
 * number that fits neither is LEFT AS IT IS and listed: a person has to look at it, and it shows in
 * red on its screen until they do. A title typed into a contact person's name moves to its own field.
 * Re-runnable: a number already in the stored form is not touched.
 */
import { PrismaClient, type Prisma } from "@prisma/client";
import { formatPhone, parsePhone } from "../src/lib/phone-numbers.js";
import { normalizeCoordinators, type CoordinatorContact } from "../src/lib/admin/contact-list.js";
import { splitTitle } from "../src/lib/person-name.js";

const prisma = new PrismaClient();
const commit = process.argv.includes("--commit");

type Row = { where: string; was: string; now: string };
const changed: Row[] = [];
const guessed: Row[] = [];
const unclear: Array<{ where: string; was: string; note: string }> = [];
const titles: Array<{ where: string; was: string; now: string }> = [];

function fix(raw: string | null | undefined, where: string): string | null | undefined {
  const v = raw?.trim();
  if (!v) return raw;
  const p = parsePhone(v);
  if (!p || p.sure === "UNCLEAR") {
    unclear.push({ where, was: v, note: p?.note ?? "it does not read as a number" });
    return v;
  }
  const now = formatPhone(p.code, p.number);
  if (now !== v) {
    changed.push({ where, was: v, now });
    if (p.sure === "GUESSED") guessed.push({ where, was: v, now });
  }
  return now;
}

async function parties() {
  const agents = await prisma.travelAgent.findMany({ select: { id: true, displayName: true, contactNumbers: true, coordinators: true } });
  const companies = await prisma.corporateAccount.findMany({ select: { id: true, displayName: true, contactNumbers: true, coordinators: true } });
  for (const [kind, rows] of [["agent", agents], ["company", companies]] as const) {
    for (const r of rows) {
      const where = `${kind} ${r.displayName}`;
      const numbers = [...new Set(r.contactNumbers.map((n) => fix(n, where) ?? n))];
      // Contact persons keep every one they had: a person here with a number nobody can read stays.
      const before = (Array.isArray(r.coordinators) ? r.coordinators : []) as unknown as CoordinatorContact[];
      for (const c of before) {
        fix(c?.phone, `${where}, ${c?.name}`);
        const typed = splitTitle(c?.name);
        if (typed.title && !c?.title) titles.push({ where, was: String(c.name), now: `${typed.title} · ${typed.name}` });
      }
      const after = normalizeCoordinators(before);
      const same = JSON.stringify(numbers) === JSON.stringify(r.contactNumbers) && JSON.stringify(after) === JSON.stringify(before);
      if (same || !commit) continue;
      const data = { contactNumbers: numbers, coordinators: after as unknown as Prisma.InputJsonValue };
      if (kind === "agent") await prisma.travelAgent.update({ where: { id: r.id }, data });
      else await prisma.corporateAccount.update({ where: { id: r.id }, data });
    }
  }
}

async function hotel() {
  const rows = await prisma.hotelProfile.findMany({ select: { id: true, contactNumbers: true } });
  for (const r of rows) {
    const list = Array.isArray(r.contactNumbers) ? (r.contactNumbers as Array<{ label?: string; value?: string }>) : [];
    const after = list.map((c) => ({ ...c, value: fix(c.value, `hotel, ${c.label ?? "number"}`) ?? c.value }));
    if (commit && JSON.stringify(after) !== JSON.stringify(list)) {
      await prisma.hotelProfile.update({ where: { id: r.id }, data: { contactNumbers: after as unknown as Prisma.InputJsonValue } });
    }
  }
}

async function people() {
  const guests = await prisma.guestProfile.findMany({ where: { phone: { not: null } }, select: { id: true, phone: true, firstName: true } });
  for (const g of guests) {
    const now = fix(g.phone, `guest ${g.firstName}`);
    if (commit && now !== g.phone) await prisma.guestProfile.update({ where: { id: g.id }, data: { phone: now } });
  }
  const enquiries = await prisma.inquiry.findMany({
    where: { OR: [{ callerPhone: { not: null } }, { partyContactPhone: { not: null } }] },
    select: { id: true, callerPhone: true, partyContactPhone: true },
  });
  for (const q of enquiries) {
    const caller = fix(q.callerPhone, `${q.id} caller`);
    const party = fix(q.partyContactPhone, `${q.id} contact person`);
    if (commit && (caller !== q.callerPhone || party !== q.partyContactPhone)) {
      await prisma.inquiry.update({ where: { id: q.id }, data: { callerPhone: caller, partyContactPhone: party } });
    }
  }
  const entries = await prisma.entry.findMany({ where: { contactPersonPhone: { not: null } }, select: { id: true, contactPersonPhone: true } });
  for (const e of entries) {
    const now = fix(e.contactPersonPhone, `${e.id} arriving`);
    if (commit && now !== e.contactPersonPhone) await prisma.entry.update({ where: { id: e.id }, data: { contactPersonPhone: now } });
  }
}

async function main() {
  await parties();
  await hotel();
  await people();
  console.log(commit ? "COMMITTED\n" : "DRY RUN — nothing written. Add --commit to write.\n");
  console.log(`${changed.length} numbers ${commit ? "rewritten" : "would be rewritten"}, ${guessed.length} of them with a code taken from their pattern.`);
  console.log(`${titles.length} titles ${commit ? "moved" : "would move"} out of contact persons' names.`);
  for (const t of titles) console.log(`  title   ${t.where}: "${t.was}" → ${t.now}`);
  console.log(`\n${unclear.length} numbers need a person — left as they are:`);
  for (const u of unclear) console.log(`  ${u.where}: "${u.was}" (${u.note})`);
  if (!commit) {
    console.log("\nA sample of the rewrites:");
    for (const c of changed.slice(0, 15)) console.log(`  ${c.where}: "${c.was}" → "${c.now}"`);
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
