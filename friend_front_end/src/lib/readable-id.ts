const READABLE_ID_PATTERN = /^[A-Z]{2,4}-\d{8}-\d{4}$/;

export function isReadableBusinessId(id: string): boolean {
  return READABLE_ID_PATTERN.test(id);
}

/** Full readable ID, or shortened UUID for legacy rows. */
export function formatListId(id: string): string {
  if (isReadableBusinessId(id)) return id;
  return id.length > 16 ? `${id.slice(0, 16)}…` : id;
}
