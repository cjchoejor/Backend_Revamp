/**
 * Atlas Cat 05 §4.4 — TaxEngine (`calculate(input): TaxResult`).
 * SIGs defer detailed tax rules to configuration; this slice has no production tax pipeline yet.
 * Callers should treat results as indicative until hotel tax rules are wired.
 */
export type TaxInput = {
  /** Pre-tax amount in smallest currency unit or major unit per caller convention. */
  taxableAmount: number;
  /** Optional rate as decimal (e.g. 0.05 for 5%). */
  rate?: number;
};

export type TaxResult = {
  taxAmount: number;
  totalWithTax: number;
};

export function calculateTax(input: TaxInput): TaxResult {
  const rate = typeof input.rate === "number" && Number.isFinite(input.rate) ? input.rate : 0;
  const taxAmount = input.taxableAmount * rate;
  return { taxAmount, totalWithTax: input.taxableAmount + taxAmount };
}
