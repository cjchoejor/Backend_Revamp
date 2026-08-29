/**
 * Add the AGENT source to `billingModel.availablePerSource`.
 *
 * WHY
 * ---
 * Policy 30 flattens this config into an allowlist and rejects any billing model outside it.
 * The seeded value covered LEISURE / CORPORATE / GOVERNMENT only, so TOUR_OPERATOR_VOUCHER was
 * not allowed anywhere — the desk offered "Tour-operator voucher" at S3 and the backend threw
 * BILLING_MODEL_NOT_ALLOWED. That is why zero folios carry it.
 *
 * Adds AGENT -> [TOUR_OPERATOR_VOUCHER, GUEST_PAY, DIRECT_BILL]: a voucher settlement is the
 * norm, but an agent booking can legitimately be guest-settled (guest pays extras directly) or
 * invoiced to the agency account, and the allowlist is flattened so every listed model becomes
 * selectable regardless of source anyway.
 *
 * Append-only via supersedeConfigurationEntry — the prior version is closed, not edited.
 *
 * Dry run by default; --commit to write.
 */
import { prisma } from "../src/db.js";
import { supersedeConfigurationEntry } from "../src/lib/admin/supersede-configuration.js";

const COMMIT = process.argv.includes("--commit");
const ACTOR = "billing-model-agent-source-migration";

async function main() {
  const current = await prisma.configurationEntry.findFirst({
    where: { configKey: "billingModel.availablePerSource", effectiveTo: null },
    orderBy: { effectiveFrom: "desc" },
  });
  const value = (current?.configValue ?? {}) as Record<string, string[]>;

  console.log(`${COMMIT ? "COMMIT" : "DRY RUN"}`);
  console.log(`current: ${JSON.stringify(value)}`);
  console.log(`flattened allowlist today: ${[...new Set(Object.values(value).flat())].join(", ")}\n`);

  const next: Record<string, string[]> = {
    ...value,
    AGENT: ["TOUR_OPERATOR_VOUCHER", "GUEST_PAY", "DIRECT_BILL"],
  };
  const flat = [...new Set(Object.values(next).flat())];
  console.log(`proposed: ${JSON.stringify(next)}`);
  console.log(`flattened allowlist after: ${flat.join(", ")}`);
  console.log(`TOUR_OPERATOR_VOUCHER selectable: ${flat.includes("TOUR_OPERATOR_VOUCHER") ? "YES" : "no"}`);

  if (!COMMIT) {
    console.log(`\nDry run — nothing written. Re-run with --commit to apply.`);
    return;
  }

  await prisma.$transaction(async (tx) => {
    await supersedeConfigurationEntry(tx, {
      configKey: "billingModel.availablePerSource",
      configValue: next,
      actorId: ACTOR,
      notes: "Added AGENT source so TOUR_OPERATOR_VOUCHER is selectable at S3; it was offered by the desk but rejected by Policy 30.",
    });
  });
  console.log(`\nWritten. Previous version closed, new version active.`);
}

main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => prisma.$disconnect());
