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
import { createInquiry } from "@/lib/api/inquiries";
import { createEntry } from "@/lib/api/entries";
import { useSession } from "@/hooks/use-session";
import { ApiError } from "@/lib/api/client";

const SOURCE_CHANNELS = ["WALK_IN", "DIRECT", "OTA", "CORPORATE", "AGENT"] as const;

type IntakeMode = "new" | "returning";

export function NewInquiryForm() {
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
  const [guestCount, setGuestCount] = useState("1");

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
      });

      const entry = await createEntry(session, {
        inquiryId: inquiry.id,
        useType: "LEISURE",
        guestProfileId,
        checkInDate: checkIn || undefined,
        checkOutDate: checkOut || undefined,
        guestCount: guestCount ? Number(guestCount) : undefined,
        otaSource: sourceChannel === "OTA",
      });

      return entry;
    },
    onSuccess: (entry) => {
      toast.success("Inquiry and entry created");
      router.push(`/entries/${entry.id}/stages/s1`);
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : "Failed to create inquiry"),
  });

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <div>
        <h2 className="font-display text-2xl font-semibold">New inquiry</h2>
        <p className="text-sm text-muted-foreground">S1 intake — create or find a guest, then start the inquiry</p>
      </div>

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
            <Input type="date" value={checkIn} onChange={(e) => setCheckIn(e.target.value)} />
          </div>
          <div>
            <label className="text-xs text-muted-foreground">Proposed check-out</label>
            <Input type="date" value={checkOut} onChange={(e) => setCheckOut(e.target.value)} />
          </div>
          <div>
            <label className="text-xs text-muted-foreground">Guest count</label>
            <Input
              type="number"
              min={1}
              value={guestCount}
              onChange={(e) => setGuestCount(e.target.value)}
            />
          </div>
          <div className="sm:col-span-2">
            <label className="text-xs text-muted-foreground">Notes</label>
            <Input value={notes} onChange={(e) => setNotes(e.target.value)} />
          </div>
        </CardContent>
      </Card>

      <Button
        variant="gradient"
        className="w-full"
        size="lg"
        disabled={
          mutation.isPending ||
          (mode === "new" ? !canSubmitNew : !canSubmitReturning)
        }
        onClick={() => mutation.mutate()}
      >
        {mutation.isPending ? "Creating…" : "Create inquiry & open S1 workspace"}
      </Button>
    </div>
  );
}
