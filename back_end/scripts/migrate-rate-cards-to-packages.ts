/**
 * Move rates off parties and onto named packages, merging the agent rows that were only ever
 * different rate variants of the same agency.
 *
 * WHY
 * ---
 * Agent and rate card were fused one-to-one, so "Bhutan INC (Off season)", "(Season)" and
 * "(premium)" were three separate agencies. This collapses them into one agency with three
 * packages, and repoints every inquiry at the surviving agency PLUS the package it was actually
 * quoted on — without that second pointer, merging would lose which rate a past booking used.
 *
 * GROUPING RULES (agreed with the operator 2026-08-04)
 *   - Group by base name, CASE-INSENSITIVELY. "WeGOauthentic (off season)" and
 *     "WegoAuthentic(Season)" are one agency despite the spelling drift; both are live.
 *   - A trailing "(...)" becomes a package name ONLY if it reads like a rate variant — season,
 *     premium, room count, room type, meal plan. Anything else (a place like "(Jaigoan)", or
 *     "(Hotel Gumar)") is part of the agency's NAME and is kept.
 *   - An agency with one rate gets a single package named "Standard".
 *   - The surviving agency row is the one with the most inquiries, then the oldest id — so the
 *     id most referenced elsewhere is the one that stays.
 *
 * Dry run by default; --commit to write.
 */
import { Prisma, RatePackageScope } from "@prisma/client";
import { prisma } from "../src/db.js";

const COMMIT = process.argv.includes("--commit");

/** A trailing parenthetical that names a rate variant rather than part of the agency name. */
const VARIANT = /season|premium|room|apartment|standard|deluxe|executive|suite|map|\bep\b|\bcp\b|\bap\b|rate|\d/i;

function splitName(raw: string): { base: string; variant: string | null } {
  const m = raw.match(/^(.*?)\s*\(([^)]*)\)\s*$/);
  if (!m) return { base: raw.trim(), variant: null };
  const [, head, qualifier] = m;
  // "SVR TRAVELS INDIA (P) LTD." — a parenthetical mid-name is not a trailing qualifier, and the
  // regex above only matches trailing ones, so head keeps it. Guard the empty-head case anyway.
  if (!head?.trim()) return { base: raw.trim(), variant: null };
  if (!VARIANT.test(qualifier ?? "")) return { base: raw.trim(), variant: null }; // e.g. (Jaigoan)
  return { base: head.trim(), variant: (qualifier ?? "").trim() };
}

/** Normalise for grouping only — never for display. */
const key = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

/** "Off season" / "off season" / "OFF-SEASON" should read the same in the picker. */
function tidyVariant(v: string): string {
  const t = v.trim().replace(/\s+/g, " ");
  return t.charAt(0).toUpperCase() + t.slice(1);
}

async function main() {
  const [agents, corps, cards, inquiryCounts] = await Promise.all([
    prisma.travelAgent.findMany({ select: { id: true, displayName: true, contactNumbers: true, contactEmail: true, modeOfContact: true, notes: true, isActive: true, createdBy: true } }),
    prisma.corporateAccount.findMany({ select: { id: true, displayName: true } }),
    prisma.rateCard.findMany(),
    prisma.inquiry.groupBy({ by: ["travelAgentId"], where: { travelAgentId: { not: null } }, _count: { _all: true } }),
  ]);

  const inqCount = new Map(inquiryCounts.map((c) => [c.travelAgentId!, c._count._all]));
  const cardByParty = new Map(cards.map((c) => [`${c.partyType}:${c.partyId}`, c]));

  // --- group agents -------------------------------------------------------
  type Member = { id: string; displayName: string; variant: string | null; inquiries: number };
  const groups = new Map<string, { base: string; members: Member[] }>();

  for (const a of agents) {
    const { base, variant } = splitName(a.displayName);
    const k = key(base);
    if (!groups.has(k)) groups.set(k, { base, members: [] });
    const g = groups.get(k)!;
    // Keep the longest spelling of the base as the display name — usually the most complete.
    if (base.length > g.base.length) g.base = base;
    g.members.push({ id: a.id, displayName: a.displayName, variant, inquiries: inqCount.get(a.id) ?? 0 });
  }

  const merges = [...groups.values()].filter((g) => g.members.length > 1);
  console.log(`${COMMIT ? "COMMIT" : "DRY RUN"}`);
  console.log(`travel agents: ${agents.length} rows -> ${groups.size} agencies (${merges.length} merges)\n`);

  console.log("=== MERGES ===");
  for (const g of merges) {
    const survivor = [...g.members].sort((a, b) => b.inquiries - a.inquiries || a.id.localeCompare(b.id))[0]!;
    console.log(`\n"${g.base}"  keeps ${survivor.id}`);
    for (const m of g.members) {
      const c = cardByParty.get(`TRAVEL_AGENT:${m.id}`);
      const pkg = m.variant ? tidyVariant(m.variant) : "Standard";
      console.log(`   ${m.id}  inq=${String(m.inquiries).padStart(2)}  package="${pkg}"  room=${c?.roomBaseRate ?? "NO CARD"}  ${m.id === survivor.id ? "<- survivor" : "(merged away)"}`);
    }
  }

  const noCard = agents.filter((a) => !cardByParty.has(`TRAVEL_AGENT:${a.id}`));
  console.log(`\nAgents with no rate card (no package will be created): ${noCard.length}`);
  for (const a of noCard) console.log(`   ${a.displayName}`);

  console.log(`\nCorporate accounts: ${corps.length}, each gets one "Standard" package from its card.`);
  console.log(`Common fallback package: created from the MEDIAN agent room rate (see below).`);

  const roomRates = cards.filter((c) => c.partyType === "TRAVEL_AGENT").map((c) => Number(c.roomBaseRate)).sort((a, b) => a - b);
  const median = roomRates[Math.floor(roomRates.length / 2)] ?? 0;
  console.log(`   median agent room rate = ${median} (from ${roomRates.length} cards)`);

  if (!COMMIT) {
    console.log(`\nDry run — nothing written. Re-run with --commit to apply.`);
    return;
  }

  // --- write --------------------------------------------------------------
  let packagesCreated = 0;
  let agentsRemoved = 0;
  let inquiriesRepointed = 0;

  await prisma.$transaction(async (tx) => {
    for (const g of groups.values()) {
      const survivor = [...g.members].sort((a, b) => b.inquiries - a.inquiries || a.id.localeCompare(b.id))[0]!;

      // The surviving row carries the merged agency name (qualifier stripped when it was a variant).
      await tx.travelAgent.update({ where: { id: survivor.id }, data: { displayName: g.base } });

      for (const m of g.members) {
        const card = cardByParty.get(`TRAVEL_AGENT:${m.id}`);
        if (!card) continue;
        const pkgName = m.variant ? tidyVariant(m.variant) : "Standard";
        const pkg = await tx.ratePackage.create({
          data: {
            scope: RatePackageScope.TRAVEL_AGENT,
            travelAgentId: survivor.id,
            name: pkgName,
            // With one package it is trivially the default; with several the operator picks, so
            // the survivor's own package is preselected.
            isDefault: g.members.length === 1 || m.id === survivor.id,
            roomBaseRate: card.roomBaseRate,
            extraBedRate: card.extraBedRate,
            cnbPercent: card.cnbPercent,
            breakfastRate: card.breakfastRate,
            lunchRate: card.lunchRate,
            dinnerRate: card.dinnerRate,
            cpRate: card.cpRate,
            mapLunchRate: card.mapLunchRate,
            mapDinnerRate: card.mapDinnerRate,
            apRate: card.apRate,
            currency: card.currency,
            rateIsTaxInclusive: card.rateIsTaxInclusive,
            notes: m.id === survivor.id ? card.notes : `Migrated from agent row ${m.id} ("${m.displayName}")`,
            createdBy: "rate-package-migration",
          },
        });
        packagesCreated++;

        // Copy this card's room-type overrides onto the package.
        const overrides = await tx.roomTypeRateOverride.findMany({ where: { rateCardId: card.id } });
        for (const o of overrides) {
          await tx.roomTypePackageOverride.create({
            data: { ratePackageId: pkg.id, roomTypeId: o.roomTypeId, roomBaseRate: o.roomBaseRate, notes: o.notes, createdBy: "rate-package-migration" },
          });
        }

        // Point this row's bookings at the survivor AND at the package they were quoted on.
        const res = await tx.inquiry.updateMany({
          where: { travelAgentId: m.id },
          data: { travelAgentId: survivor.id, ratePackageId: pkg.id },
        });
        inquiriesRepointed += res.count;
      }

      // Retire the merged-away rows. Not deleted — an id may be referenced somewhere we haven't
      // looked, and a deactivated row is recoverable while a deleted one is not.
      for (const m of g.members) {
        if (m.id === survivor.id) continue;
        await tx.travelAgent.update({
          where: { id: m.id },
          data: { isActive: false, notes: `Merged into ${survivor.id} ("${g.base}") on 2026-08-04. Its rate became the "${m.variant ? tidyVariant(m.variant) : "Standard"}" package.` },
        });
        agentsRemoved++;
      }
    }

    for (const c of corps) {
      const card = cardByParty.get(`CORPORATE:${c.id}`);
      if (!card) continue;
      const pkg = await tx.ratePackage.create({
        data: {
          scope: RatePackageScope.CORPORATE,
          corporateAccountId: c.id,
          name: "Standard",
          isDefault: true,
          roomBaseRate: card.roomBaseRate, extraBedRate: card.extraBedRate, cnbPercent: card.cnbPercent,
          breakfastRate: card.breakfastRate, lunchRate: card.lunchRate, dinnerRate: card.dinnerRate,
          cpRate: card.cpRate, mapLunchRate: card.mapLunchRate, mapDinnerRate: card.mapDinnerRate, apRate: card.apRate,
          currency: card.currency, rateIsTaxInclusive: card.rateIsTaxInclusive, notes: card.notes,
          createdBy: "rate-package-migration",
        },
      });
      packagesCreated++;
      const overrides = await tx.roomTypeRateOverride.findMany({ where: { rateCardId: card.id } });
      for (const o of overrides) {
        await tx.roomTypePackageOverride.create({
          data: { ratePackageId: pkg.id, roomTypeId: o.roomTypeId, roomBaseRate: o.roomBaseRate, notes: o.notes, createdBy: "rate-package-migration" },
        });
      }
      const res = await tx.inquiry.updateMany({ where: { corporateAccountId: c.id }, data: { ratePackageId: pkg.id } });
      inquiriesRepointed += res.count;
    }

    // The house fallback. Seeded from the median agent room rate so a new agency gets a
    // plausible starting point rather than zero; the operator edits it in the admin console.
    const existingCommon = await tx.ratePackage.findFirst({ where: { scope: RatePackageScope.COMMON, effectiveTo: null } });
    if (!existingCommon) {
      await tx.ratePackage.create({
        data: {
          scope: RatePackageScope.COMMON,
          name: "Common agent rate",
          isDefault: true,
          roomBaseRate: new Prisma.Decimal(median),
          notes: "Fallback used when a travel agent or corporate account has no package of its own. Seeded from the median negotiated room rate at migration; review and adjust.",
          createdBy: "rate-package-migration",
        },
      });
      packagesCreated++;
    }
  }, { timeout: 120_000 });

  console.log(`\npackages created      : ${packagesCreated}`);
  console.log(`agent rows deactivated: ${agentsRemoved}`);
  console.log(`inquiries repointed   : ${inquiriesRepointed}`);
}

main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => prisma.$disconnect());
