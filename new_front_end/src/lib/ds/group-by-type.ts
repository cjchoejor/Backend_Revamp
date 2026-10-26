/**
 * Rooms grouped by their room type (2026-10-26, operator: "show rooms here in room types
 * category"), each type in the order of its lowest room number — the order the chart uses.
 * The items keep their own order inside a group.
 */
export function groupByRoomType<T>(items: readonly T[], typeOf: (item: T) => string | null | undefined, numberOf: (item: T) => string) {
  const sorted = [...items].sort((a, b) => numberOf(a).localeCompare(numberOf(b), "en", { numeric: true }));
  const groups = new Map<string, T[]>();
  for (const it of sorted) {
    const name = typeOf(it)?.trim() || "Other rooms";
    groups.set(name, [...(groups.get(name) ?? []), it]);
  }
  return [...groups].map(([name, rooms]) => ({ name, rooms }));
}
