/**
 * One-off repair (2026-08-03, operator ruling): turn GST on at 5% and seed the missing
 * service-charge rate on an EXISTING database.
 *
 * Why: `billing.salesTaxRate` was seeded 0 ("disables automatic tax lines") and
 * `billing.serviceChargeRate` was never seeded at all. Every pricing engine already computes
 * GST compound on (net value + service charge) — room-composition, compute-stay-charges,
 * S7/S8 charge posting, invoice rendering — so the only change needed is the configured rates:
 *   - billing.salesTaxRate      → 0.05  (superseded append-only; prior row keeps its history)
 *   - billing.serviceChargeRate → 0.10  (created; skipped if a live row already exists)
 *
 * Dry-run by default; pass --commit to write. Idempotent: values already correct are skipped.
 */
import { prisma } from "../src/db.js";
import { supersedeConfigurationEntry } from "../src/lib/admin/supersede-configuration.js";

const COMMIT = process.argv.includes("--commit");
const ACTOR = "actor-seed-system";

const TARGETS: { key: string; value: number; notes: string }[] = [
  {
    key: "billing.salesTaxRate",
    value: 0.05,
    notes: "GST 5% — compound, applied to (net value + service charge) everywhere (quotes, charge posting, invoices).",
  },
  {
    key: "billing.serviceChargeRate",
    value: 0.1,
    notes: "Service charge 10% of net value. GST is computed on top of (net + this).",
  },
];

for (const t of TARGETS) {
  const active = await prisma.configurationEntry.findFirst({
    where: { configKey: t.key, effectiveTo: null },
    orderBy: { effectiveFrom: "desc" },
  });
  const current = active?.configValue;
  if (current === t.value) {
    console.log(`  = ${t.key} already ${t.value}; skipping.`);
    continue;
  }
  console.log(`  ${active ? "~" : "+"} ${t.key}: ${JSON.stringify(current ?? null)} -> ${t.value}${COMMIT ? "" : " (dry run)"}`);
  if (!COMMIT) continue;
  await prisma.$transaction(async (tx) => {
    await supersedeConfigurationEntry(tx, {
      configKey: t.key,
      configValue: t.value,
      actorId: ACTOR,
      notes: t.notes,
    });
  });
}

console.log(COMMIT ? "Done." : "Dry run complete — re-run with --commit to write.");
await prisma.$disconnect();
