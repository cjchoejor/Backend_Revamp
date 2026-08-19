/**
 * One-off repair (2026-08-12, operator request): widen the accepted identity document types
 * on an EXISTING database to Passport · CID · Aadhaar card · Voter card · Birth certificate.
 *
 * The vocabulary lives backend-side by design — `identity.documentTypes` drives the p16
 * acceptance allowlist AND every desk dropdown (guest-detail table S5/S6, S6 verification
 * select, phone-capture flows read the same list off the API), so this supersede is the whole
 * change: no frontend edit, both frontends move on their next fetch. `identity.retentionPeriodDays`
 * gains explicit entries for the new codes (same 7-year figure the DEFAULT already gave them).
 *
 * Dry-run by default; pass --commit to write. Idempotent: values already correct are skipped.
 * Prior rows keep their history (append-only supersede).
 */
import { prisma } from "../src/db.js";
import { supersedeConfigurationEntry } from "../src/lib/admin/supersede-configuration.js";

const COMMIT = process.argv.includes("--commit");
const ACTOR = "actor-seed-system";

const TARGETS: { key: string; value: unknown; notes: string }[] = [
  {
    key: "identity.documentTypes",
    value: [
      { documentTypeCode: "PASSPORT", documentTypeName: "Passport", isActive: true },
      { documentTypeCode: "CID", documentTypeName: "CID (National ID)", isActive: true },
      { documentTypeCode: "AADHAAR_CARD", documentTypeName: "Aadhaar card", isActive: true },
      { documentTypeCode: "VOTER_CARD", documentTypeName: "Voter card", isActive: true },
      { documentTypeCode: "BIRTH_CERTIFICATE", documentTypeName: "Birth certificate", isActive: true },
      { documentTypeCode: "WORK_PERMIT", documentTypeName: "Work permit", isActive: true },
    ],
    notes:
      "Accepted guest identity documents (2026-08-12 widening + 2026-08-17 work permit): Passport, CID, Aadhaar card, Voter card, Birth certificate, Work permit.",
  },
  {
    key: "identity.retentionPeriodDays",
    value: {
      PASSPORT: 2555,
      CID: 2555,
      AADHAAR_CARD: 2555,
      VOTER_CARD: 2555,
      BIRTH_CERTIFICATE: 2555,
      WORK_PERMIT: 2555,
      DEFAULT: 2555,
    },
    notes: "Per-docType ID retention (~7y); explicit entries for the accepted document types.",
  },
];

for (const t of TARGETS) {
  const active = await prisma.configurationEntry.findFirst({
    where: { configKey: t.key, effectiveTo: null },
    orderBy: { effectiveFrom: "desc" },
  });
  const current = active?.configValue;
  if (JSON.stringify(current) === JSON.stringify(t.value)) {
    console.log(`  = ${t.key} already up to date; skipping.`);
    continue;
  }
  console.log(`  ${active ? "~" : "+"} ${t.key}:`);
  console.log(`      from ${JSON.stringify(current ?? null)}`);
  console.log(`      to   ${JSON.stringify(t.value)}${COMMIT ? "" : " (dry run)"}`);
  if (!COMMIT) continue;
  await prisma.$transaction(async (tx) => {
    await supersedeConfigurationEntry(tx, {
      configKey: t.key,
      configValue: t.value as never,
      actorId: ACTOR,
      notes: t.notes,
    });
  });
}

console.log(COMMIT ? "Done." : "Dry run complete — re-run with --commit to write.");
await prisma.$disconnect();
