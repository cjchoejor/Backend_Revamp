/**
 * The guest's name as a paper prints it — the title, then the first and last name (2026-10-28,
 * operator: "include the title which was saved in stage one, like Mr, Mrs, on the papers").
 * "Ms pema lhaden wangchuk". Empty when there is no name; each caller says what stands in.
 */
export function guestDisplayName(
  g: { title?: string | null; firstName?: string | null; lastName?: string | null } | null | undefined,
): string {
  return [g?.title, g?.firstName, g?.lastName]
    .map((v) => v?.trim())
    .filter(Boolean)
    .join(" ");
}
