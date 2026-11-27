/**
 * What an apartment holds — a list of items with counts, never priced (2026-11-27, operator: "we need
 * the option to add amenities and their counts but they are not priced ... a field to add it and
 * choose number, and also others option, where they can type something new and add their number").
 * One rule for the hotel's list, a package's usual list and a booking's own.
 */
import { ValidationError } from "./errors.js";

/** The hotel's own list, as the operator gave it — until an admin keeps another. */
export const DEFAULT_AMENITY_ITEMS = [
  "Rice pot",
  "Curry pot",
  "Tea pot",
  "Oven",
  "Induction",
  "Chopping board",
  "Knife holder",
  "Spatula",
  "Plate",
  "Cup",
  "Small bowl",
  "Spoon",
  "Fork",
  "Knife",
  "Water glass",
  "Frying pan",
  "Dustbin",
  "Broom & dust collector",
];

export type AmenityItem = { name: string; count: number };

/** A list of items with counts, checked and tidied; refused in words. */
export function cleanAmenityItems(raw: unknown, where: string): AmenityItem[] {
  if (raw == null) return [];
  if (!Array.isArray(raw)) throw new ValidationError(`${where}: the list must be a list of items`);
  const out: AmenityItem[] = [];
  const seen = new Set<string>();
  for (const r of raw) {
    const name = String((r as { name?: unknown })?.name ?? "").replace(/\s+/g, " ").trim();
    const count = Number((r as { count?: unknown })?.count);
    if (!name) throw new ValidationError(`${where}: an item has no name`);
    if (name.length > 60) throw new ValidationError(`${where}: "${name.slice(0, 30)}…" is longer than 60 letters`);
    if (!Number.isInteger(count) || count < 0 || count > 99) throw new ValidationError(`${where}: ${name}'s count must be a whole number from 0 to 99`);
    const key = name.toLowerCase();
    if (seen.has(key)) throw new ValidationError(`${where}: ${name} is listed twice`);
    seen.add(key);
    out.push({ name, count });
  }
  return out;
}

/** The hotel's list of names, checked: none twice, at least one. */
export function cleanAmenityItemNames(raw: unknown): string[] {
  if (!Array.isArray(raw)) throw new ValidationError("The list of items must be a list of names");
  const out: string[] = [];
  const seen = new Set<string>();
  for (const r of raw) {
    const n = String(r ?? "").replace(/\s+/g, " ").trim();
    if (!n) continue;
    if (n.length > 60) throw new ValidationError(`"${n.slice(0, 30)}…" is longer than 60 letters`);
    if (seen.has(n.toLowerCase())) throw new ValidationError(`${n} is listed twice`);
    seen.add(n.toLowerCase());
    out.push(n);
  }
  if (!out.length) throw new ValidationError("Keep at least one item on the list");
  return out;
}

/** "Rice pot 1 · Curry pot 1 · Spatula 4" — how a paper names a list; nothing when empty. */
export function amenityWords(items: AmenityItem[]): string {
  return items
    .filter((i) => i.count > 0)
    .map((i) => `${i.name} ${i.count}`)
    .join(" · ");
}
