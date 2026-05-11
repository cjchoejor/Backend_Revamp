import { StageGateBlockedError } from "../../lib/errors.js";

/**
 * Policy 33 — Billing / commercial context (SIG-S1 apartment slice).
 */
export function enforceApartmentCommercialFieldsForS1Exit(input: {
  useType: string;
  apartmentDurationNights: number | null | undefined;
  apartmentRateTierCode: string | null | undefined;
}) {
  if (input.useType !== "APARTMENT") return;
  if (input.apartmentDurationNights == null || input.apartmentDurationNights < 1) {
    throw new StageGateBlockedError("Apartment duration (nights) required", "MISSING_APARTMENT_DURATION");
  }
  if (!String(input.apartmentRateTierCode ?? "").trim()) {
    throw new StageGateBlockedError("Apartment rate tier code required", "MISSING_APARTMENT_RATE_TIER");
  }
}
