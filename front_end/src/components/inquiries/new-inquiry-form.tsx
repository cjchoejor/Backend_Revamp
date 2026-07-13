"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Search, UserPlus, Users } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { createGuestProfile, guestDisplayName, searchGuestProfiles, type GuestProfileSummary } from "@/lib/api/guest-profiles";
import { getChildPolicy, getAllowedRoomCounts } from "@/lib/api/child-policy";
import { listRooms } from "@/lib/api/rooms";
import { createInquiry } from "@/lib/api/inquiries";
import { createEntry, updateEntryIntake } from "@/lib/api/entries";
// NOTE: chargeable-occupants math is now backend-authoritative via
// GET /api/lookups/allowed-room-counts (see getAllowedRoomCounts in lib/api/child-policy).
// The old local mirror in lib/chargeable-occupants.ts has been removed — this frontend calls
// the backend so the friend's real UI can consume the same computation identically.
import { useSession } from "@/hooks/use-session";
import { ApiError } from "@/lib/api/client";
import { AgentCorporatePicker, type AgentCorporateSelection } from "@/components/inquiries/agent-corporate-picker";

const SOURCE_CHANNELS = ["WALK_IN", "DIRECT", "OTA", "CORPORATE", "AGENT"] as const;

type IntakeMode = "new" | "returning";

export type NewInquiryFormProps = {
  /**
   * Optional — when supplied, the form does NOT navigate after a successful create. Instead it
   * calls this callback with the created entry. Used by the unified booking flow page
   * (BookingFlow) to advance to the next step inline.
   */
  onCreated?: (entry: { id: string }) => void;
  /** When true, hides the page header (used inside the booking flow stepper which has its own). */
  hideHeader?: boolean;
  /** Override the submit button label. */
  submitLabel?: string;
  /**
   * When set, the form switches to "edit mode" — the create button is replaced by an "update
   * intake fields" action that PATCHes the existing entry instead of POSTing a new one.
   * Pass the live entry's id + version (for optimistic concurrency).
   */
  editEntry?: { id: string; version: number } | null;
  /** Called after a successful PATCH so the parent can close the edit drawer. */
  onUpdated?: () => void;
};

export function NewInquiryForm({ onCreated, hideHeader, submitLabel, editEntry, onUpdated }: NewInquiryFormProps = {}) {
  const router = useRouter();
  const { session } = useSession();
  const [mode, setMode] = useState<IntakeMode>("new");

  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [email, setEmail] = useState("");
  const [phone, setPhone] = useState("");
  const [nationality, setNationality] = useState("");

  const [searchQuery, setSearchQuery] = useState("");
  const [debouncedSearch, setDebouncedSearch] = useState("");
  const [selectedGuest, setSelectedGuest] = useState<GuestProfileSummary | null>(null);

  const [sourceChannel, setSourceChannel] = useState<string>("WALK_IN");
  const [notes, setNotes] = useState("");
  const [checkIn, setCheckIn] = useState("");
  const [checkOut, setCheckOut] = useState("");
  // Nights is a derived/editable string — empty = "no opinion yet", otherwise a positive int.
  const [nights, setNights] = useState<string>("");
  const [adults, setAdults] = useState<string>("1");
  const [children, setChildren] = useState<string>("0");
  // Child ages list, one entry per child. Length is synced to `children` count below.
  const [childAges, setChildAges] = useState<string[]>([]);
  const [numberOfRooms, setNumberOfRooms] = useState<string>("1");
  const [agentSelection, setAgentSelection] = useState<AgentCorporateSelection>({ kind: "NONE" });
  // Contact person = the on-site individual travelling / leading the group. Distinct from
  // travelAgent/corporateAccount contact fields. MANDATORY before S5 per W4 activation gate.
  const [contactPersonName, setContactPersonName] = useState<string>("");
  const [contactPersonPhone, setContactPersonPhone] = useState<string>("");

  // ---- Date / nights sync ----
  // When check-in is set without a check-out, auto-fill check-out to the next day.
  // When nights is set, recompute check-out from check-in + nights.
  // When check-out is edited directly, recompute nights from the new range.
  // Timezone-safe date math. Parsing "2026-06-25" as a Date and serializing via toISOString()
  // shifts the calendar day in any non-UTC timezone (e.g. Bhutan UTC+6 wraps a midnight back to
  // the previous day). Operate on the numeric Y/M/D components instead and reformat manually.
  function parseIsoDate(iso: string): { y: number; m: number; d: number } | null {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
    if (!match) return null;
    return { y: Number(match[1]), m: Number(match[2]), d: Number(match[3]) };
  }
  function formatIsoDate(y: number, m: number, d: number): string {
    return `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  }
  function diffNights(ci: string, co: string): number | null {
    const a = parseIsoDate(ci);
    const b = parseIsoDate(co);
    if (!a || !b) return null;
    // Use UTC.UTC to get a calendar-day diff that's immune to DST and timezone offsets.
    const aMs = Date.UTC(a.y, a.m - 1, a.d);
    const bMs = Date.UTC(b.y, b.m - 1, b.d);
    const diff = Math.round((bMs - aMs) / 86400_000);
    return diff > 0 ? diff : null;
  }
  function addDays(iso: string, n: number): string {
    const p = parseIsoDate(iso);
    if (!p) return "";
    const dt = new Date(Date.UTC(p.y, p.m - 1, p.d + n));
    return formatIsoDate(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate());
  }
  function handleCheckInChange(value: string) {
    setCheckIn(value);
    if (!value) return;
    if (nights && /^\d+$/.test(nights)) {
      // Nights field is authoritative — recompute checkout from check-in + nights.
      setCheckOut(addDays(value, parseInt(nights, 10)));
    } else if (!checkOut || (diffNights(value, checkOut) ?? 0) <= 0) {
      // No checkout yet (or it's now invalid) — default to next day, 1 night.
      setCheckOut(addDays(value, 1));
      setNights("1");
    } else {
      // Both dates valid — update nights to reflect the new range.
      const n = diffNights(value, checkOut);
      if (n) setNights(String(n));
    }
  }
  function handleCheckOutChange(value: string) {
    setCheckOut(value);
    if (checkIn && value) {
      const n = diffNights(checkIn, value);
      if (n) setNights(String(n));
    }
  }
  function handleNightsChange(value: string) {
    setNights(value);
    if (value && /^\d+$/.test(value) && checkIn) {
      setCheckOut(addDays(checkIn, parseInt(value, 10)));
    }
  }

  // ---- Children → ages list sync ----
  useEffect(() => {
    const n = Math.max(0, parseInt(children || "0", 10) || 0);
    setChildAges((prev) => {
      if (prev.length === n) return prev;
      if (prev.length > n) return prev.slice(0, n);
      return [...prev, ...Array.from({ length: n - prev.length }, () => "")];
    });
  }, [children]);

  const guestCount = (parseInt(adults || "0", 10) || 0) + (parseInt(children || "0", 10) || 0);

  useEffect(() => {
    const t = setTimeout(() => setDebouncedSearch(searchQuery), 300);
    return () => clearTimeout(t);
  }, [searchQuery]);

  const searchResults = useQuery({
    queryKey: ["guest-profiles", debouncedSearch, mode],
    queryFn: () => searchGuestProfiles(session!, debouncedSearch, 20),
    enabled:
      !!session &&
      mode === "returning" &&
      (debouncedSearch.length === 0 || debouncedSearch.length >= 2),
  });

  // Live child-policy snapshot — drives the max age of the child-age inputs. When L4 admin
  // changes `registry.child.unaccompaniedMinorMinAge.minimumAge`, the form's cap follows.
  const childPolicyQuery = useQuery({
    queryKey: ["lookup", "child-policy"],
    queryFn: () => getChildPolicy(session!),
    enabled: !!session,
    staleTime: 5 * 60_000,
  });
  const minAdultAge = childPolicyQuery.data?.unaccompaniedMinor.minimumAge ?? 18;
  const maxChildAge = Math.max(0, minAdultAge - 1);

  // Hotel-wide room list — used to compute the largest maxCapacity across all room types,
  // which serves as the fallback for the Number-of-Rooms envelope at S1 (before the guest
  // has picked a specific type). Per-type validation runs again at S2 seal.
  const roomsQuery = useQuery({
    queryKey: ["rooms", "all-with-capacity"],
    queryFn: () => listRooms(session!),
    enabled: !!session,
    staleTime: 5 * 60_000,
  });
  const largestMaxCapacity = (() => {
    let max = 3; // Sensible default if no rooms loaded yet.
    for (const r of roomsQuery.data?.items ?? []) {
      const cap = r.roomType?.maxCapacity;
      if (typeof cap === "number" && cap > max) max = cap;
    }
    return max;
  })();

  // Chargeable occupants + allowed room-count envelope — resolved by the backend so it stays
  // the single source of truth. Debounced so a rapid typing burst on the age inputs doesn't
  // hammer the endpoint.
  const parsedChildAges = childAges
    .map((a) => parseInt(a || "", 10))
    .filter((n) => Number.isFinite(n));
  const parsedAdults = parseInt(adults || "0", 10) || 0;
  const allowedRoomCountsQuery = useQuery({
    queryKey: ["allowed-room-counts", parsedAdults, parsedChildAges.join(","), largestMaxCapacity],
    queryFn: () =>
      getAllowedRoomCounts(session!, {
        adults: parsedAdults,
        childAges: parsedChildAges,
        maxCapacity: largestMaxCapacity,
      }),
    enabled: !!session && parsedAdults + parsedChildAges.length > 0,
    staleTime: 5_000,
  });
  const chargeableOccupants = allowedRoomCountsQuery.data?.chargeableOccupants ?? 0;
  const roomRange = allowedRoomCountsQuery.data?.allowedRoomCounts ?? { min: 0, max: 0 };
  const allowedRoomCounts: number[] =
    roomRange.min > 0 && roomRange.max >= roomRange.min
      ? Array.from({ length: roomRange.max - roomRange.min + 1 }, (_, i) => roomRange.min + i)
      : [];

  // Keep numberOfRooms in-range when composition changes upstream (e.g. adults drop
  // from 3 to 1 — allowed max becomes 1, so trim from 2 → 1).
  useEffect(() => {
    const n = parseInt(numberOfRooms || "0", 10) || 0;
    if (allowedRoomCounts.length === 0) return;
    if (!allowedRoomCounts.includes(n)) {
      setNumberOfRooms(String(allowedRoomCounts[0]));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chargeableOccupants, largestMaxCapacity]);

  const canSubmitNew =
    firstName.trim() &&
    lastName.trim() &&
    (email.trim() || phone.trim()) &&
    sourceChannel;

  const canSubmitReturning = !!selectedGuest && sourceChannel;

  const mutation = useMutation({
    mutationFn: async () => {
      if (!session) throw new Error("Not signed in");

      let guestProfileId: string;

      if (mode === "new") {
        const profile = await createGuestProfile(session, {
          firstName: firstName.trim(),
          lastName: lastName.trim(),
          email: email.trim() || undefined,
          phone: phone.trim() || undefined,
          nationality: nationality.trim() || undefined,
        });
        guestProfileId = profile.id;
      } else {
        if (!selectedGuest) throw new Error("Select a guest profile");
        guestProfileId = selectedGuest.id;
      }

      const inquiry = await createInquiry(session, {
        guestProfileId,
        sourceChannel,
        notes: notes.trim() || undefined,
        proposedCheckIn: checkIn || undefined,
        proposedCheckOut: checkOut || undefined,
        travelAgentId: agentSelection.kind === "TRAVEL_AGENT" ? agentSelection.party.id : null,
        corporateAccountId: agentSelection.kind === "CORPORATE" ? agentSelection.party.id : null,
      });

      const adultCount = parseInt(adults || "0", 10) || 0;
      const childCount = parseInt(children || "0", 10) || 0;
      const parsedAges = childAges.map((a) => parseInt(a || "0", 10)).filter((n) => Number.isFinite(n));
      const requestedRooms = parseInt(numberOfRooms || "0", 10) || 0;
      const entry = await createEntry(session, {
        inquiryId: inquiry.id,
        useType: "LEISURE",
        guestProfileId,
        checkInDate: checkIn || undefined,
        checkOutDate: checkOut || undefined,
        guestCount: guestCount || undefined,
        adultCount: adultCount > 0 ? adultCount : undefined,
        childCount: childCount > 0 ? childCount : undefined,
        childAges: parsedAges.length === childCount ? parsedAges : undefined,
        numberOfRooms: requestedRooms > 0 ? requestedRooms : undefined,
        contactPersonName: contactPersonName.trim() || undefined,
        contactPersonPhone: contactPersonPhone.trim() || undefined,
        otaSource: sourceChannel === "OTA",
      });

      return entry;
    },
    onSuccess: (entry) => {
      toast.success("Inquiry and entry created");
      if (onCreated) {
        onCreated(entry);
      } else {
        router.push(`/entries/${entry.id}/stages/s1`);
      }
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : "Failed to create inquiry"),
  });

  // ---- Update existing entry (Edit mode) ----
  const updateMutation = useMutation({
    mutationFn: async () => {
      if (!session) throw new Error("Not signed in");
      if (!editEntry) throw new Error("No entry to edit");
      const adultCount = parseInt(adults || "0", 10) || 0;
      const childCount = parseInt(children || "0", 10) || 0;
      const parsedAges = childAges.map((a) => parseInt(a || "0", 10)).filter((n) => Number.isFinite(n));
      const requestedRooms = parseInt(numberOfRooms || "0", 10) || 0;
      return updateEntryIntake(session, editEntry.id, {
        checkInDate: checkIn || undefined,
        checkOutDate: checkOut || undefined,
        guestCount: guestCount || undefined,
        adultCount,
        childCount,
        childAges: parsedAges.length === childCount ? parsedAges : undefined,
        numberOfRooms: requestedRooms > 0 ? requestedRooms : undefined,
        contactPersonName: contactPersonName.trim() || "",
        contactPersonPhone: contactPersonPhone.trim() || "",
        expectedVersion: editEntry.version,
      });
    },
    onSuccess: () => {
      toast.success("Intake fields updated");
      onUpdated?.();
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : "Failed to update entry"),
  });

  return (
    <div className={hideHeader ? "space-y-6" : "mx-auto max-w-2xl space-y-6"}>
      {!hideHeader && (
        <div>
          <h2 className="font-display text-2xl font-semibold">New inquiry</h2>
          <p className="text-sm text-muted-foreground">S1 intake — create or find a guest, then start the inquiry</p>
        </div>
      )}

      <div className="grid grid-cols-2 gap-2 rounded-xl border bg-card p-1">
        <button
          type="button"
          className={cn(
            "flex items-center justify-center gap-2 rounded-lg px-4 py-2.5 text-sm font-medium transition-colors",
            mode === "new" ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted",
          )}
          onClick={() => {
            setMode("new");
            setSelectedGuest(null);
          }}
        >
          <UserPlus className="h-4 w-4" />
          New guest
        </button>
        <button
          type="button"
          className={cn(
            "flex items-center justify-center gap-2 rounded-lg px-4 py-2.5 text-sm font-medium transition-colors",
            mode === "returning"
              ? "bg-primary text-primary-foreground"
              : "text-muted-foreground hover:bg-muted",
          )}
          onClick={() => setMode("returning")}
        >
          <Users className="h-4 w-4" />
          Returning guest
        </button>
      </div>

      {mode === "new" ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Guest details</CardTitle>
            <CardDescription>Creates a guest profile, then links the inquiry (SIG-S1)</CardDescription>
          </CardHeader>
          <CardContent className="grid gap-4 sm:grid-cols-2">
            <div>
              <label className="text-xs text-muted-foreground">First name</label>
              <Input value={firstName} onChange={(e) => setFirstName(e.target.value)} />
            </div>
            <div>
              <label className="text-xs text-muted-foreground">Last name</label>
              <Input value={lastName} onChange={(e) => setLastName(e.target.value)} />
            </div>
            <div>
              <label className="text-xs text-muted-foreground">Email</label>
              <Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
            </div>
            <div>
              <label className="text-xs text-muted-foreground">Phone</label>
              <Input value={phone} onChange={(e) => setPhone(e.target.value)} />
            </div>
            <div className="sm:col-span-2">
              <label className="text-xs text-muted-foreground">Nationality (optional)</label>
              <Input value={nationality} onChange={(e) => setNationality(e.target.value)} />
            </div>
            <p className="sm:col-span-2 text-xs text-muted-foreground">Email or phone is required.</p>
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Find guest</CardTitle>
            <CardDescription>Search by name, email, or phone</CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                className="pl-9"
                placeholder="Type at least 2 characters…"
                value={searchQuery}
                onChange={(e) => {
                  setSearchQuery(e.target.value);
                  setSelectedGuest(null);
                }}
              />
            </div>

            {searchResults.isLoading && (
              <Skeleton className="h-24 w-full" />
            )}

            {!searchResults.isLoading && mode === "returning" && (
              <ul className="max-h-48 space-y-1 overflow-auto rounded-lg border p-1">
                {(searchResults.data?.items ?? []).length === 0 ? (
                  <li className="px-3 py-4 text-center text-sm text-muted-foreground">No guests found</li>
                ) : (
                  searchResults.data?.items.map((g) => (
                    <li key={g.id}>
                      <button
                        type="button"
                        className={cn(
                          "w-full rounded-md px-3 py-2 text-left text-sm transition-colors hover:bg-muted",
                          selectedGuest?.id === g.id && "bg-primary/10 ring-1 ring-primary",
                        )}
                        onClick={() => setSelectedGuest(g)}
                      >
                        <span className="font-medium">{guestDisplayName(g)}</span>
                        {g.clientTier && (
                          <Badge variant="outline" className="ml-2 text-[10px]">
                            {g.clientTier}
                          </Badge>
                        )}
                      </button>
                    </li>
                  ))
                )}
              </ul>
            )}

            {selectedGuest && (
              <p className="text-sm text-[var(--success)]">
                Selected: {guestDisplayName(selectedGuest)}
              </p>
            )}
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Inquiry & stay</CardTitle>
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-2">
          <div className="sm:col-span-2">
            <label className="text-xs text-muted-foreground">Source channel</label>
            <select
              className="flex h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
              value={sourceChannel}
              onChange={(e) => setSourceChannel(e.target.value)}
            >
              {SOURCE_CHANNELS.map((ch) => (
                <option key={ch} value={ch}>
                  {ch}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="text-xs text-muted-foreground">Proposed check-in</label>
            <Input type="date" value={checkIn} onChange={(e) => handleCheckInChange(e.target.value)} />
          </div>
          <div>
            <label className="text-xs text-muted-foreground">Proposed check-out</label>
            <Input type="date" value={checkOut} onChange={(e) => handleCheckOutChange(e.target.value)} />
          </div>
          <div>
            <label className="text-xs text-muted-foreground">Number of nights</label>
            <Input
              type="number"
              min={1}
              max={365}
              value={nights}
              onChange={(e) => handleNightsChange(e.target.value)}
              placeholder="auto"
            />
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="text-xs text-muted-foreground">Adults</label>
              <Input
                type="number"
                min={1}
                value={adults}
                onChange={(e) => setAdults(e.target.value)}
              />
            </div>
            <div>
              <label className="text-xs text-muted-foreground">Children</label>
              <Input
                type="number"
                min={0}
                value={children}
                onChange={(e) => setChildren(e.target.value)}
              />
            </div>
          </div>
          <div className="sm:col-span-2">
            <label className="text-xs text-muted-foreground">Number of rooms</label>
            <select
              className="flex h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
              value={numberOfRooms}
              onChange={(e) => setNumberOfRooms(e.target.value)}
              disabled={allowedRoomCounts.length === 0}
            >
              {allowedRoomCounts.length === 0 ? (
                <option value="">—</option>
              ) : (
                allowedRoomCounts.map((n) => (
                  <option key={n} value={String(n)}>
                    {n} {n === 1 ? "room" : "rooms"}
                  </option>
                ))
              )}
            </select>
            <p className="mt-1 text-[11px] text-muted-foreground">
              Chargeable occupants: <span className="font-mono">{chargeableOccupants}</span>
              {" "}(adults + children aged {maxChildAge + 1}+). Allowed range: <span className="font-mono">{roomRange.min}</span>
              {" "}to <span className="font-mono">{roomRange.max}</span> rooms (max <span className="font-mono">{largestMaxCapacity}</span> chargeable per room).
            </p>
          </div>
          {childAges.length > 0 && (
            <div className="sm:col-span-2 rounded-lg border bg-muted/30 p-3">
              <p className="mb-2 text-xs text-muted-foreground">Child ages (0–{maxChildAge})</p>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                {childAges.map((age, idx) => (
                  <div key={idx}>
                    <label className="text-[10px] uppercase text-muted-foreground">Child {idx + 1}</label>
                    <Input
                      type="number"
                      min={0}
                      max={maxChildAge}
                      value={age}
                      onChange={(e) => {
                        // Soft-clamp to the policy cap for UX (so the user sees the value snap
                        // visibly), but the backend remains the authority. The cap comes from
                        // registry.child.unaccompaniedMinorMinAge — no hardcoded 17 here.
                        let v = e.target.value;
                        if (v !== "" && /^\d+$/.test(v)) {
                          const n = parseInt(v, 10);
                          if (n > maxChildAge) v = String(maxChildAge);
                          if (n < 0) v = "0";
                        }
                        setChildAges((prev) => prev.map((a, i) => (i === idx ? v : a)));
                      }}
                      placeholder="age"
                    />
                  </div>
                ))}
              </div>
            </div>
          )}
          <div className="sm:col-span-2 rounded-lg border bg-muted/30 p-3">
            <p className="mb-2 text-xs text-muted-foreground">
              <strong>Contact person</strong> — the on-site individual travelling or leading the group. Distinct from the travel-agent or corporate contact. Mandatory before check-in.
            </p>
            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <label className="text-xs text-muted-foreground">Name</label>
                <Input value={contactPersonName} onChange={(e) => setContactPersonName(e.target.value)} placeholder="Full name" />
              </div>
              <div>
                <label className="text-xs text-muted-foreground">Phone</label>
                <Input value={contactPersonPhone} onChange={(e) => setContactPersonPhone(e.target.value)} placeholder="Contact number" />
              </div>
            </div>
          </div>
          <div className="sm:col-span-2">
            <label className="text-xs text-muted-foreground">Notes</label>
            <Input value={notes} onChange={(e) => setNotes(e.target.value)} />
          </div>
          <div className="sm:col-span-2">
            <AgentCorporatePicker selection={agentSelection} onChange={setAgentSelection} />
          </div>
        </CardContent>
      </Card>

      {editEntry ? (
        <Button
          variant="gradient"
          className="w-full"
          size="lg"
          disabled={updateMutation.isPending}
          onClick={() => updateMutation.mutate()}
        >
          {updateMutation.isPending ? "Saving…" : "Save changes"}
        </Button>
      ) : (
        <Button
          variant="gradient"
          className="w-full"
          size="lg"
          disabled={
            mutation.isPending ||
            mutation.isSuccess ||
            (mode === "new" ? !canSubmitNew : !canSubmitReturning)
          }
          onClick={() => mutation.mutate()}
        >
          {mutation.isPending
            ? "Creating…"
            : mutation.isSuccess
              ? "Inquiry created — continue to availability"
              : (submitLabel ?? "Create inquiry & open S1 workspace")}
        </Button>
      )}
    </div>
  );
}
