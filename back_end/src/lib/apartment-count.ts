/**
 * How many apartments a guest may ask for (2026-11-25, operator: "in the stay it didn't ask how many
 * rooms the guest wants, due to that in the third section of inquiry, i can choose any numbers of
 * rooms"). An apartment stay asks for a number of APARTMENTS — a 2 BHK is one, its two rooms let
 * together — and The house then takes exactly that many.
 *
 * The count is judged against the apartments the hotel offers (active packages), at their best: N
 * apartments can sleep at most what the N largest sleep together. Whether those are free on the
 * nights is The house's to answer, as with rooms. One rule for the desk's list and the intake's check.
 */
import type { PrismaClient } from "@prisma/client";

export type ApartmentCountChoice = { count: number; sleeps: number; fits: boolean };

export function apartmentCountChoices(sizes: number[], guests: number) {
  const largestFirst = [...sizes].filter((n) => n > 0).sort((a, b) => b - a);
  let sum = 0;
  const choices: ApartmentCountChoice[] = largestFirst.map((n, i) => {
    sum += n;
    return { count: i + 1, sleeps: sum, fits: guests <= sum };
  });
  const fewest = choices.find((c) => c.fits)?.count ?? null;
  return { offered: choices.length, fewest, choices };
}

/** The most guests each apartment offered can take — every apartment of every active package. */
export async function offeredApartmentSizes(prisma: PrismaClient): Promise<number[]> {
  const units = await prisma.apartmentUnit.findMany({
    where: { package: { isActive: true } },
    select: { maxOccupants: true },
  });
  return units.map((u) => u.maxOccupants);
}

/** The refusal, in words, for an apartment count that cannot stand; null when it can. */
export function apartmentCountRefusal(count: number, sizes: number[], guests: number): string | null {
  const { offered, choices } = apartmentCountChoices(sizes, guests);
  if (!Number.isInteger(count) || count < 1) return "Say how many apartments the guest wants";
  if (offered === 0) return "No apartment is offered at the moment — add them under Rates and limits › Apartments";
  if (count > offered) return `The hotel lets ${offered} apartment${offered === 1 ? "" : "s"} — ask for ${offered} at most`;
  const c = choices[count - 1]!;
  if (!c.fits) {
    return `${count === 1 ? "1 apartment takes" : `${count} apartments take`} at most ${c.sleeps} guest${c.sleeps === 1 ? "" : "s"}; this booking has ${guests} — ask for more apartments`;
  }
  return null;
}
