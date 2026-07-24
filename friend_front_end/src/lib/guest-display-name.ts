export type GuestNameFields = {
  displayName?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  email?: string | null;
  phone?: string | null;
};

/** Prefer full name, then email/phone; never show raw UUIDs as a "name". */
export function formatGuestName(guest?: GuestNameFields | null, fallback = "—"): string {
  if (!guest) return fallback;

  const display = guest.displayName?.trim();
  if (display) return display;

  const full = [guest.firstName, guest.lastName].filter(Boolean).join(" ").trim();
  if (full) return full;

  const email = guest.email?.trim();
  if (email) return email;

  const phone = guest.phone?.trim();
  if (phone) return phone;

  return fallback;
}

export function entryListGuestName(entry: {
  guestProfile?: GuestNameFields | null;
  inquiry?: { guestProfile?: GuestNameFields | null } | null;
}): string {
  return formatGuestName(entry.guestProfile ?? entry.inquiry?.guestProfile);
}

export function guestNameSearchText(guest?: GuestNameFields | null): string {
  return [
    guest?.displayName,
    guest?.firstName,
    guest?.lastName,
    guest?.email,
    guest?.phone,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}
