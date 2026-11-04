/**
 * Travel agents from the old PMS's public.package_rate (2026-11-04, operator: "put all 207 in
 * travel agents list ... the rows with similar name to be put as packages under one travel agent,
 * if same contact numbers are repeating due to that, throw one and keep just one"; "the rates in
 * the old database are with service charge and gst included ... room rate in old database was
 * 1920, in the new it should be imported as 1662.34").
 *
 * Usage:
 *   npx tsx scripts/import-data/import-package-rates.ts            # dry run: the plan, nothing written
 *   npx tsx scripts/import-data/import-package-rates.ts --commit   # needs an empty travel agent list
 *
 * The old database is opened read-only (OLD_PMS_DB, default beta_legphel, on the same server).
 *
 * EVERY ROW BECOMES ONE PACKAGE, so the package count always equals the row count. Rows are grouped
 * by the name left once a trailing "(Season)", "(Rooms)" or the like is taken off, ignoring case and
 * punctuation. The old list's typos and near-spellings cannot be told apart by rule, so ALIASES names
 * them; all 207 rows were read by eye to write it. When unsure, rows stay separate agencies: an extra
 * row in the list costs less than an agency's name disappearing inside another.
 *
 * RATES go through workOutPackageRates, the same sum the admin console's "with service charge and
 * GST in them" tick uses. A rate of 0 in the old list means nothing was agreed, stored empty as the
 * earlier importer did. Only the room rate is required.
 *
 * Numbers: one agency's rows are joined and a number repeated across them is kept once, compared by
 * its last eight digits, so 17792453 and 97517792453 are one number. The spelling with the most
 * digits stays, since it carries the country code.
 */
import pgPkg from "pg";
import { ContactMode, Prisma, PrismaClient } from "@prisma/client";
import { createTravelAgent } from "../../src/services/admin/travel-agent-admin-service.js";
import { savePackage, workOutPackageRates } from "../../src/services/admin/rate-package-admin-service.js";

const COMMIT = process.argv.includes("--commit");
const OLD_DB = process.env.OLD_PMS_DB ?? "beta_legphel";
const ACTOR_ID = "old-pms-package-rate-import";
const prisma = new PrismaClient();

/** A trailing "(...)" that names a rate rather than part of the agency's name: "(Jaigoan)" stays in the name. */
const VARIANT = /season|premium|room|apartment|standard|deluxe|executive|suite|map|\bep\b|\bcp\b|\bap\b|rate|\d|backpacker|bhk|group/i;

const key = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

/** Rows too untidy for the rule, by their exact old name (lower case). */
const ROW_OVERRIDES: Record<string, { base: string; pkg: string }> = {
  "bhutan online off season & above 5 room": { base: "Bhutan Online Booking Travel", pkg: "Off season & above 5 rooms" },
  "bhutan dmc (yatra guruji)_rooms": { base: "Bhutan DMC (Yatra guruji)", pkg: "Rooms" },
  "trp global connect(traveller paradise)room": { base: "TRP Global connect (Traveller paradise)", pkg: "Rooms" },
  "time traveller holiday experts (premium": { base: "Time Traveller Holiday Experts", pkg: "Premium" },
  "pathik trips (off season)_2026": { base: "Pathik Trips", pkg: "Off season 2026" },
  "pathik trips (season)_room": { base: "Pathik Trips", pkg: "Season" },
  "pathfinder adventures (ff season)": { base: "Pathfinder Adventures", pkg: "Off season" },
  "territory tour (group_1)": { base: "Territory Tours & Travel", pkg: "Group 1" },
};

/** Names that differ only by a typo or a word, and the one spelling the agency takes. */
const ALIASES: Record<string, string> = {
  attour: "A.T Tour Maker",
  attourmaker: "A.T Tour Maker",
  bhutanfrontline: "Bhutan Frontline Travel",
  bhutanfrontlinetravel: "Bhutan Frontline Travel",
  byd: "BYD Thimphu",
  bydthimphu: "BYD Thimphu",
  bhutanradhakrishnaholidays: "Radha Krishna Holidays",
  radhakrishnaholidays: "Radha Krishna Holidays",
  clubsidetourstavels: "Clubside Tours & Travels",
  clubsidetourstravel: "Clubside Tours & Travels",
  dooarsbhutantourtravels: "Dooars Bhutan Tours & Travels",
  dooarsbhutantourstravel: "Dooars Bhutan Tours & Travels",
  gakilingtourstravel: "Gakiling Tours & Travels",
  gakilingtourstravels: "Gakiling Tours & Travels",
  ganeshtourtravel: "Ganesh Tour & Travels",
  ganeshtourtravels: "Ganesh Tour & Travels",
  hotelsheavenlybhutan: "Hotels Heavenly Bhutan",
  htelsheavenlybhutan: "Hotels Heavenly Bhutan",
  idealleisure: "Ideal Leisure Holiday",
  idealleisureholiday: "Ideal Leisure Holiday",
  picovoyagetravel: "Pico Voyage Travel",
  rstravel: "R S Travels",
  rstravels: "R S Travels",
  roamcrafttourism: "Roamcraft Tourism",
  roamcraftstourism: "Roamcraft Tourism",
  travellersparadise: "Travellers Paradise",
  travellersmparadise: "Travellers Paradise",
  vitogopvtltd: "Vitogo Pvt Ltd",
  wegoauthentic: "WegoAuthentic",
};

/** Merged on the name alone, with different numbers: said in the report so the desk can overrule them. */
const JUDGEMENT = new Set(["A.T Tour Maker", "Bhutan Frontline Travel", "Radha Krishna Holidays", "R S Travels"]);

/** The old mode_of_contact sometimes names a person instead. By old row id. */
const CONTACT_PERSON_IN_MODE: Record<number, string> = {
  3610: "Pritesh Paul",
  3611: "Dipakchhetri",
  3612: "Mr.Chirag",
  3613: "RK Gupta",
  3624: "Lobzang Drakpa",
};

function tidyPackage(raw: string): string {
  const v = raw.trim().replace(/\s+/g, " ");
  const low = v.toLowerCase();
  const exact: Record<string, string> = {
    room: "Rooms",
    rooms: "Rooms",
    "off-season": "Off season",
    "off season": "Off season",
    season: "Season",
    premium: "Premium",
    "5rooms & less": "5 rooms & less",
    "5rooms & more": "5 rooms & more",
    "5 rooms & less": "5 rooms & less",
    "5 rooms & more": "5 rooms & more",
    "season 5 rooms & less": "Season, 5 rooms & less",
    "premium_season": "Premium season",
    "room_off season": "Rooms, off season",
    "rooms_off season": "Rooms, off season",
    "rooms_season": "Rooms, season",
    "apartment off season": "Apartment, off season",
    "apartment-season": "Apartment, season",
    "standard,deluxe,executive rooms": "Standard, Deluxe, Executive rooms",
  };
  if (exact[low]) return exact[low];
  return v.charAt(0).toUpperCase() + v.slice(1);
}

function parseName(raw: string): { base: string; pkg: string | null } {
  const name = raw.trim().replace(/\s+/g, " ");
  const forced = ROW_OVERRIDES[name.toLowerCase()];
  if (forced) return forced;
  const m = name.match(/^(.*?)\s*\(([^)]*)\)\s*$/);
  if (m && m[1]!.trim() && VARIANT.test(m[2] ?? "")) return { base: m[1]!.trim(), pkg: tidyPackage(m[2]!) };
  return { base: name, pkg: null };
}

/** "Excursion to Himalaya:" and "R S Travels!!" lose the stray ending; nothing else is respelled. */
const tidyBase = (s: string) => s.replace(/[:!]+$/, "").trim();

function normalizeMode(raw: string | null): ContactMode {
  const s = (raw ?? "").toLowerCase();
  if (s.includes("whatsapp") || s.includes("watsapp") || s.includes("whats app") || s.includes("whatsaap")) return ContactMode.WHATSAPP;
  if (s.includes("mail")) return ContactMode.EMAIL;
  if (s.includes("phone")) return ContactMode.PHONE;
  if (s.includes("person")) return ContactMode.IN_PERSON;
  return ContactMode.OTHER;
}

function splitNumbers(raw: string | null): string[] {
  const s = (raw ?? "").trim();
  if (!s || /^na$/i.test(s)) return [];
  return s
    .split(/[/,;]/)
    .map((p) => p.trim().replace(/[.\s]+$/, "").replace(/^\+\+/, "+").replace(/^\(\+(\d+)\)\s*/, "+$1 "))
    .filter((p) => (p.match(/\d/g)?.length ?? 0) >= 3);
}

const digitsOf = (n: string) => n.replace(/\D/g, "");
const numberIdentity = (n: string) => digitsOf(n).slice(-8);
const looksMadeUp = (n: string) => /^1?(\d)\1{3,}$/.test(digitsOf(n));

/** Which package the desk's picker starts on: the ordinary one, never the dear or the off-season one. */
function defaultRank(name: string): number {
  if (/^standard/i.test(name)) return 0;
  if (/^rooms$/i.test(name)) return 1;
  if (/^season/i.test(name)) return 2;
  if (/premium|apartment|bhk|off season/i.test(name)) return 9;
  return 5;
}

type OldRow = {
  id: number;
  travel_agent_name: string;
  contact_number: string | null;
  mode_of_contact: string | null;
  room_base_rate: string;
  extra_bed_rate: string | null;
  breakfast_rate: string | null;
  lunch_rate: string | null;
  dinner_rate: string | null;
  cp_rate: string | null;
  map_lunch_rate: string | null;
  map_dinner_rate: string | null;
  ap_rate: string | null;
  cnb_percent: number | null;
};

const RATE_COLUMNS = {
  roomBaseRate: "room_base_rate",
  extraBedRate: "extra_bed_rate",
  breakfastRate: "breakfast_rate",
  lunchRate: "lunch_rate",
  dinnerRate: "dinner_rate",
  cpRate: "cp_rate",
  mapLunchRate: "map_lunch_rate",
  mapDinnerRate: "map_dinner_rate",
  apRate: "ap_rate",
} as const;
type RateField = keyof typeof RATE_COLUMNS;

async function readOldRows(): Promise<OldRow[]> {
  const url = new URL(process.env.DATABASE_URL!);
  url.pathname = `/${OLD_DB}`;
  url.search = "";
  const client = new pgPkg.Client({ connectionString: url.toString(), options: "-c default_transaction_read_only=on" });
  await client.connect();
  try {
    const { rows } = await client.query<OldRow>(`SELECT * FROM public.package_rate ORDER BY id`);
    return rows;
  } finally {
    await client.end();
  }
}

type PlannedPackage = {
  row: OldRow;
  name: string;
  isDefault: boolean;
  rates: Record<RateField, string | null>;
  /** A rate that comes back a paisa off the old figure once its taxes are added. */
  misses: string[];
};
type PlannedAgency = {
  displayName: string;
  numbers: string[];
  numbersDropped: string[];
  mode: ContactMode;
  coordinators: { name: string; phone?: string }[];
  packages: PlannedPackage[];
};

async function plan(rows: OldRow[]): Promise<PlannedAgency[]> {
  const groups = new Map<string, { displayName: string; members: { row: OldRow; pkg: string | null }[] }>();
  for (const row of rows) {
    const { base, pkg } = parseName(row.travel_agent_name);
    const clean = tidyBase(base);
    const k = key(clean);
    const alias = ALIASES[k];
    const groupKey = alias ? key(alias) : k;
    if (!groups.has(groupKey)) groups.set(groupKey, { displayName: alias ?? clean, members: [] });
    groups.get(groupKey)!.members.push({ row, pkg });
  }

  const agencies: PlannedAgency[] = [];
  for (const g of groups.values()) {
    // Numbers: first seen in row order, the fullest spelling of each.
    const kept = new Map<string, string>();
    const dropped: string[] = [];
    for (const { row } of g.members) {
      for (const n of splitNumbers(row.contact_number)) {
        const id = numberIdentity(n);
        const have = kept.get(id);
        if (!have) kept.set(id, n);
        else {
          if (digitsOf(n).length > digitsOf(have).length) kept.set(id, n);
          dropped.push(n);
        }
      }
    }

    // Package names unique inside the agency: the same name twice would read as a new version of it.
    const used = new Map<string, number>();
    const packages: PlannedPackage[] = [];
    for (const { row, pkg } of g.members) {
      const base = pkg ?? "Standard";
      const seen = (used.get(base.toLowerCase()) ?? 0) + 1;
      used.set(base.toLowerCase(), seen);
      const name = seen === 1 ? base : `${base} ${seen}`;

      const withTaxes: Record<string, string> = {};
      for (const [field, column] of Object.entries(RATE_COLUMNS)) {
        const v = row[column];
        if (v != null && !new Prisma.Decimal(v).isZero()) withTaxes[field] = String(v);
      }
      if (!withTaxes.roomBaseRate) throw new Error(`Old row ${row.id} (${row.travel_agent_name}) has no room rate`);
      const worked = await workOutPackageRates(prisma, { withTaxes });
      const rates = {} as Record<RateField, string | null>;
      const misses: string[] = [];
      for (const field of Object.keys(RATE_COLUMNS) as RateField[]) {
        rates[field] = worked.withoutTaxes[field] ?? null;
        if (withTaxes[field] && !new Prisma.Decimal(worked.comesTo[field]!).eq(withTaxes[field]!)) {
          misses.push(`${field} ${withTaxes[field]} -> ${worked.withoutTaxes[field]} comes to ${worked.comesTo[field]}`);
        }
      }
      packages.push({ row, name, isDefault: false, rates, misses });
    }
    const best = [...packages].sort((a, b) => defaultRank(a.name) - defaultRank(b.name) || a.row.id - b.row.id)[0]!;
    best.isDefault = true;

    const coordinators: { name: string; phone?: string }[] = [];
    for (const { row } of g.members) {
      const person = CONTACT_PERSON_IN_MODE[row.id];
      if (person) coordinators.push({ name: person, phone: splitNumbers(row.contact_number)[0] });
    }

    agencies.push({
      displayName: g.displayName,
      numbers: [...kept.values()],
      numbersDropped: dropped,
      mode: normalizeMode(g.members.map((m) => m.row.mode_of_contact).find((m) => normalizeMode(m) !== ContactMode.OTHER) ?? null),
      coordinators,
      packages,
    });
  }
  return agencies.sort((a, b) => a.displayName.localeCompare(b.displayName));
}

function report(rows: OldRow[], agencies: PlannedAgency[]) {
  const packages = agencies.flatMap((a) => a.packages);
  console.log(`${COMMIT ? "COMMIT" : "DRY RUN"} · old list ${OLD_DB}.public.package_rate`);
  console.log(`rows ${rows.length} -> ${agencies.length} travel agents, ${packages.length} packages`);
  if (packages.length !== rows.length) throw new Error("Every row must become one package");

  console.log(`\n=== AGENTS WITH MORE THAN ONE PACKAGE (${agencies.filter((a) => a.packages.length > 1).length}) ===`);
  for (const a of agencies.filter((x) => x.packages.length > 1)) {
    console.log(`\n${a.displayName}${JUDGEMENT.has(a.displayName) ? "   [merged on the name, numbers differ]" : ""}`);
    console.log(`   numbers: ${a.numbers.join("  |  ") || "none"}${a.numbersDropped.length ? `   (repeat thrown: ${a.numbersDropped.join("  |  ")})` : ""}`);
    for (const p of a.packages) {
      console.log(`   ${p.isDefault ? "*" : " "} ${p.name.padEnd(34)} room ${p.rates.roomBaseRate}  <- #${p.row.id} ${p.row.travel_agent_name.trim()} (room ${p.row.room_base_rate})`);
    }
  }

  console.log(`\n=== PACKAGE NAMES ON SINGLE-PACKAGE AGENTS ===`);
  const names = new Map<string, number>();
  for (const a of agencies.filter((x) => x.packages.length === 1)) names.set(a.packages[0]!.name, (names.get(a.packages[0]!.name) ?? 0) + 1);
  console.log([...names].map(([n, c]) => `${n} (${c})`).join(" · "));

  const editDistance = (x: string, y: string) => {
    let prev = Array.from({ length: y.length + 1 }, (_, i) => i);
    for (let i = 1; i <= x.length; i++) {
      const cur = [i];
      for (let j = 1; j <= y.length; j++) cur[j] = Math.min(prev[j]! + 1, cur[j - 1]! + 1, prev[j - 1]! + (x[i - 1] === y[j - 1] ? 0 : 1));
      prev = cur;
    }
    return prev[y.length]!;
  };
  const firstWord = (n: string) => n.toLowerCase().split(/[^a-z0-9]+/).filter((w) => !['the', 'a', 'bhutan', 'druk', 'travel', 'travels', 'trip', 'tour', 'tours'].includes(w))[0] ?? '';
  console.log(`\n=== NAMES THAT LOOK ALIKE, KEPT SEPARATE ===`);
  for (let i = 0; i < agencies.length; i++) {
    for (let j = i + 1; j < agencies.length; j++) {
      const [x, y] = [agencies[i]!.displayName, agencies[j]!.displayName];
      const [kx, ky] = [key(x), key(y)];
      const near = editDistance(kx, ky) <= Math.max(3, Math.floor(Math.min(kx.length, ky.length) / 4));
      const sameWord = firstWord(x).length >= 4 && firstWord(x) === firstWord(y);
      if (near || sameWord) console.log(x + '  ~  ' + y);
    }
  }

  const identical = agencies.flatMap((a) =>
    a.packages.filter((p) => a.packages.some((q) => q !== p && q.row.id < p.row.id && JSON.stringify(q.rates) === JSON.stringify(p.rates) && key(q.row.travel_agent_name) === key(p.row.travel_agent_name))).map((p) => `${a.displayName}: ${p.name}`),
  );
  console.log(`\n=== ROWS THAT REPEAT ANOTHER ROW EXACTLY (kept, so the count stays 207) ===\n${identical.join("\n") || "none"}`);

  const madeUp = agencies.flatMap((a) => a.numbers.filter(looksMadeUp).map((n) => `${a.displayName}: ${n}`));
  console.log(`\n=== NUMBERS THAT LOOK MADE UP (kept as the old list has them) ===\n${madeUp.join("\n") || "none"}`);

  const byNumber = new Map<string, string[]>();
  for (const a of agencies) for (const n of a.numbers) byNumber.set(numberIdentity(n), [...(byNumber.get(numberIdentity(n)) ?? []), a.displayName]);
  console.log(`\n=== ONE NUMBER ON SEVERAL AGENTS (kept on each) ===`);
  for (const [n, who] of [...byNumber].filter(([, w]) => w.length > 1).sort((a, b) => b[1].length - a[1].length)) console.log(`${n}: ${who.join(" · ")}`);

  console.log(`\n=== NO NUMBER ===\n${agencies.filter((a) => a.numbers.length === 0).map((a) => a.displayName).join(", ") || "none"}`);
  console.log(`\n=== CONTACT PERSONS READ FROM THE OLD MODE COLUMN ===`);
  for (const a of agencies.filter((x) => x.coordinators.length)) console.log(`${a.displayName}: ${a.coordinators.map((c) => `${c.name} ${c.phone ?? ""}`).join(", ")}`);

  const misses = packages.flatMap((p) => p.misses.map((m) => `#${p.row.id} ${p.row.travel_agent_name.trim()}: ${m}`));
  console.log(`\n=== RATES THAT COME BACK A PAISA OFF WITH TAXES ADDED (${misses.length}) ===\n${misses.join("\n") || "none"}`);
  const r1920 = packages.find((p) => String(p.row.room_base_rate) === "1920.00");
  console.log(`\nOperator's example: room 1920.00 -> ${r1920?.rates.roomBaseRate}`);
}

async function write(agencies: PlannedAgency[]) {
  const existing = await prisma.travelAgent.count();
  if (existing) throw new Error(`${existing} travel agents are already on file: wipe them first. Nothing was written.`);
  for (const a of agencies) {
    const created = await createTravelAgent(
      prisma,
      {
        displayName: a.displayName,
        contactNumbers: a.numbers,
        modeOfContact: a.mode,
        coordinators: a.coordinators,
        notes: `From the old system's package list: ${a.packages.map((p) => `#${p.row.id} ${p.row.travel_agent_name.trim()}${p.row.mode_of_contact ? ` (${p.row.mode_of_contact.trim()})` : ""}`).join("; ")}`,
      },
      ACTOR_ID,
    );
    for (const p of a.packages) {
      await savePackage(
        prisma,
        { travelAgentId: created.id },
        {
          name: p.name,
          isDefault: p.isDefault,
          ...p.rates,
          roomBaseRate: p.rates.roomBaseRate!,
          cnbPercent: p.row.cnb_percent,
          notes: `Old system row #${p.row.id} "${p.row.travel_agent_name.trim()}". Its rates included service charge and GST (room ${p.row.room_base_rate}); these are without them.`,
        },
        ACTOR_ID,
      );
    }
  }
  const [agents, packages, corporates] = await Promise.all([
    prisma.travelAgent.count(),
    prisma.ratePackage.count({ where: { scope: "TRAVEL_AGENT", effectiveTo: null } }),
    prisma.corporateAccount.count(),
  ]);
  console.log(`\nWritten: ${agents} travel agents, ${packages} packages. Companies on file: ${corporates}.`);
}

const rows = await readOldRows();
const agencies = await plan(rows);
report(rows, agencies);
if (COMMIT) await write(agencies);
else console.log(`\nDry run: nothing written. Re-run with --commit to apply.`);
await prisma.$disconnect();
