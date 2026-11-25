import { StageGateBlockedError } from "../../lib/errors.js";
import { planRefusal, plansForStay } from "../../lib/apartment-rent.js";

/**
 * Policy 33 — Billing / commercial context (SIG-S1 apartment slice).
 *
 * Rewritten 2026-11-25. It asked for `apartmentDurationNights` and `apartmentRateTierCode`, which no
 * desk screen could fill, so every booking whose kind of stay was Apartment stopped at Inquiry
 * (ENT-20261125-0040 on the hotel's server). Now:
 *   - the nights are the stay's own dates;
 *   - the rate is the apartment package's, so what is asked is HOW the apartment is let: monthly or
 *     weekly for a stay of a week or more, by the night under a week (lib/apartment-rent.ts);
 *   - the rooms picked are whole apartments (a 2 BHK's rooms together), chosen in The house;
 *   - as many apartments as the guest asked for in The stay (2026-11-25, operator: "in the stay it
 *     didn't ask how many rooms the guest wants").
 */
export type ApartmentOfRoom = { label: string; roomIds: string[]; roomNumbers: string[] };

export function enforceApartmentCommercialFieldsForS1Exit(input: {
  useType: string;
  apartmentPlan: string | null | undefined;
  /** How many apartments the guest asked for (Entry.apartmentCount). */
  apartmentCount: number | null | undefined;
  checkInDate: Date | null | undefined;
  checkOutDate: Date | null | undefined;
  /** The rooms the pick holds, with their numbers. */
  pickedRooms: Array<{ roomId: string; roomNumber: string }>;
  /** Each picked room's apartment, when it is in one. */
  apartmentOf: Map<string, ApartmentOfRoom>;
}) {
  if (input.useType !== "APARTMENT") return;
  if (!input.checkInDate || !input.checkOutDate) return;
  const plans = plansForStay(input.checkInDate, input.checkOutDate);
  if (plans.weekly && !input.apartmentPlan) {
    throw new StageGateBlockedError(
      "Say how the apartment is let — monthly or weekly — in The stay",
      "MISSING_APARTMENT_PLAN",
    );
  }
  if (!plans.weekly && input.apartmentPlan) {
    throw new StageGateBlockedError(
      `A stay of ${plans.nights} night${plans.nights === 1 ? "" : "s"} is under a week and is charged by the night — take the monthly or weekly off in The stay`,
      "APARTMENT_PLAN_UNDER_A_WEEK",
    );
  }
  const refusal = planRefusal(input.apartmentPlan, input.checkInDate, input.checkOutDate);
  if (refusal) throw new StageGateBlockedError(refusal, "APARTMENT_PLAN_NOT_FOR_STAY");

  const n = input.apartmentCount ?? null;
  if (n == null) {
    throw new StageGateBlockedError("Say how many apartments the guest wants, in The stay", "MISSING_APARTMENT_COUNT");
  }
  const picked = new Set(input.pickedRooms.map((r) => r.roomId));
  for (const r of input.pickedRooms) {
    const a = input.apartmentOf.get(r.roomId);
    if (!a) {
      throw new StageGateBlockedError(
        `Room ${r.roomNumber} is not one of the apartments — pick the apartments in The house`,
        "ROOM_NOT_AN_APARTMENT",
      );
    }
    const missing = a.roomIds.filter((id) => !picked.has(id));
    if (missing.length) {
      throw new StageGateBlockedError(
        `Apartment ${a.label} is rooms ${a.roomNumbers.join(" + ")}, let together — pick the whole apartment in The house`,
        "APARTMENT_NOT_WHOLE",
      );
    }
  }
  const apartments = new Set(input.pickedRooms.map((r) => input.apartmentOf.get(r.roomId)?.label).filter(Boolean));
  if (apartments.size !== n) {
    throw new StageGateBlockedError(
      `The guest asked for ${n} apartment${n === 1 ? "" : "s"}; ${apartments.size} ${apartments.size === 1 ? "is" : "are"} chosen — choose ${n} in The house, or change the number in The stay`,
      "APARTMENT_COUNT_NOT_MET",
    );
  }
}
