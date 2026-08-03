"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckCircle2, Circle, AlertTriangle, ArrowRight } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { StagePanel } from "@/components/stages/shared/stage-panel";
import { PolicyGateAlert } from "@/components/stages/shared/policy-gate-alert";
import { ProgressStageButton } from "@/components/stages/shared/progress-stage-button";
import { STAGES, stagePath } from "@/config/stages";
import {
  queryAvailabilityByEntry,
  roomsFromResultSet,
  selectAvailabilityOption,
  type AvailabilityQueryResponse,
  type AvailabilityRoomResult,
} from "@/lib/api/availability";
import { listInquiries } from "@/lib/api/inquiries";
import { listRooms } from "@/lib/api/rooms";
import { AvailabilityCalendar } from "@/components/stages/s1/availability-calendar";
import { useSession } from "@/hooks/use-session";
import { ApiError } from "@/lib/api/client";
import { cn } from "@/lib/utils";
import {
  describeUnavailableRoom,
  formatClaimState,
  formatUnavailabilityReason,
} from "@/lib/room-inventory-status";
import type { AvailabilityConfigSummary, EntryDetail } from "@/types/api";
import { optionSelectedRoomIds } from "@/types/api";

type S1WorkspaceProps = {
  entry: EntryDetail;
};

function RoomOption({
  room,
  variant,
  selected,
  onSelect,
  disabled,
}: {
  room: AvailabilityRoomResult;
  variant: "available" | "deficient";
  selected: boolean;
  onSelect: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onSelect}
      className={cn(
        "flex w-full items-center justify-between rounded-lg border px-3 py-2 text-left text-sm transition-colors",
        selected ? "border-primary bg-primary/10 ring-1 ring-primary" : "hover:bg-muted",
        variant === "deficient" && !selected && "border-amber-500/40",
      )}
    >
      <span>
        <span className="font-medium">Room {room.roomNumber ?? room.roomId.slice(0, 8)}</span>
        {room.capacity != null && (
          <span className="ml-2 text-muted-foreground">· {room.capacity} guests</span>
        )}
      </span>
      <span className="flex shrink-0 items-center gap-1.5">
        {room.claimState && (
          <Badge variant="outline" className="text-muted-foreground">
            {formatClaimState(room.claimState)}
          </Badge>
        )}
        {variant === "deficient" && (
          <Badge variant="outline" className="border-amber-500 text-amber-700 dark:text-amber-400">
            Deficient
          </Badge>
        )}
      </span>
    </button>
  );
}

function UnavailableRoomRow({ room }: { room: AvailabilityRoomResult }) {
  return (
    <div className="flex w-full items-center justify-between rounded-lg border border-dashed bg-muted/30 px-3 py-2 text-sm text-muted-foreground">
      <span>
        <span className="font-medium text-foreground">
          Room {room.roomNumber ?? room.roomId.slice(0, 8)}
        </span>
        {room.capacity != null && <span className="ml-2">· {room.capacity} guests</span>}
        <p className="mt-0.5 text-xs">{describeUnavailableRoom(room)}</p>
      </span>
      <Badge variant="outline" className="shrink-0 border-red-500/40 text-red-800 dark:text-red-400">
        {formatUnavailabilityReason(room.unavailabilityReason)}
      </Badge>
    </div>
  );
}

export function S1Workspace({ entry }: S1WorkspaceProps) {
  const { session } = useSession();
  const queryClient = useQueryClient();
  const meta = STAGES[0];

  const [checkIn, setCheckIn] = useState(entry.checkInDate?.slice(0, 10) ?? "");
  const [checkOut, setCheckOut] = useState(entry.checkOutDate?.slice(0, 10) ?? "");
  const [guestCount, setGuestCount] = useState(String(entry.guestCount ?? 1));

  // When the operator edits intake dates upstream (step 1's "Edit" affordance in the booking
  // flow patches the entry, which refetches), reflect the new dates into this workspace's
  // search form so the operator doesn't have to re-type them. We only refresh when the entry
  // value has actually changed so we don't clobber an in-progress edit.
  const entryCheckIn = entry.checkInDate?.slice(0, 10) ?? "";
  const entryCheckOut = entry.checkOutDate?.slice(0, 10) ?? "";
  useEffect(() => {
    if (entryCheckIn) setCheckIn(entryCheckIn);
  }, [entryCheckIn]);
  useEffect(() => {
    if (entryCheckOut) setCheckOut(entryCheckOut);
  }, [entryCheckOut]);
  useEffect(() => {
    if (entry.guestCount != null) setGuestCount(String(entry.guestCount));
  }, [entry.guestCount]);
  const [searchResult, setSearchResult] = useState<AvailabilityQueryResponse | null>(null);
  const [searchError, setSearchError] = useState<unknown>(null);
  const [selectError, setSelectError] = useState<unknown>(null);
  const [pendingRoomId, setPendingRoomId] = useState<string | null>(null);
  // Per-night selections: date (YYYY-MM-DD) → list of roomIds picked for that night.
  // Owned here so we can build the seal payload from the assembled state; the calendar
  // renders from it and reports clicks back via onToggleCell.
  const [selectionsByDate, setSelectionsByDate] = useState<Record<string, string[]>>({});
  // Track which rooms were entered as DEFICIENT so we can build the acknowledgements payload
  // at seal time. Keyed by roomId (deficiency is a property of the room, not the night).
  const [deficientRoomIdsMap, setDeficientRoomIdsMap] = useState<Record<string, boolean>>({});
  // True when the operator clicked "Change selection" after a save — puts the calendar back
  // into editable mode with the previous picks pre-populated.
  const [editingAfterSeal, setEditingAfterSeal] = useState(false);

  const configs: AvailabilityConfigSummary[] = entry.availabilityConfigs ?? [];
  const latestConfig = configs[0] ?? null;
  const preferredConfig = configs.find((c) => c.optionSelected != null) ?? null;
  const preferredRoomIds: string[] = optionSelectedRoomIds(preferredConfig?.optionSelected ?? null);
  const sealedByDate: Record<string, string[]> = (() => {
    const opt = preferredConfig?.optionSelected;
    if (!opt) return {};
    if ("perNight" in opt && Array.isArray(opt.perNight)) {
      const map: Record<string, string[]> = {};
      for (const n of opt.perNight) map[n.date] = n.roomIds.map((r) => r.roomId);
      return map;
    }
    return {};
  })();
  const targetRoomCount = entry.numberOfRooms ?? 1;

  const inquiriesQuery = useQuery({
    queryKey: ["inquiries", entry.inquiryId],
    queryFn: () => listInquiries(session!, 50),
    enabled: !!session,
  });
  const inquiry = inquiriesQuery.data?.items.find((i) => i.id === entry.inquiryId);

  const searchMutation = useMutation({
    mutationFn: () => {
      if (!checkIn || !checkOut) throw new Error("Check-in and check-out dates required");
      return queryAvailabilityByEntry(session!, entry.id, {
        checkInDate: checkIn,
        checkOutDate: checkOut,
        guestCount: Number(guestCount) || undefined,
        useType: entry.useType ?? undefined,
      });
    },
    onSuccess: (data) => {
      setSearchResult(data);
      setSearchError(null);
      setPendingRoomId(null);
      toast.success("Availability saved — select a preferred room below");
      void queryClient.invalidateQueries({ queryKey: ["entry", entry.id] });
    },
    onError: (e) => {
      setSearchError(e);
      toast.error(e instanceof ApiError ? e.message : "Search failed");
    },
  });

  const selectMutation = useMutation({
    mutationFn: async ({
      configurationId,
      perNight,
      deficientRoomIds,
    }: {
      configurationId: string;
      perNight: Array<{ date: string; roomIds: string[] }>;
      deficientRoomIds: string[];
    }) => {
      return selectAvailabilityOption(session!, configurationId, {
        // Per-night shape: each night carries its own room list. Backend validates that
        // every night has exactly entry.numberOfRooms picks + every stay date is covered.
        perNight,
        deficientAcknowledgements: deficientRoomIds.length > 0
          ? deficientRoomIds.map((roomId) => ({
              roomId,
              acknowledgedAt: new Date().toISOString(),
              note: "Acknowledged at S1 configuration selection",
            }))
          : undefined,
      });
    },
    onSuccess: () => {
      setSelectError(null);
      setPendingRoomId(null);
      setSelectionsByDate({});
      setDeficientRoomIdsMap({});
      setEditingAfterSeal(false);
      toast.success("Preferred rooms saved");
      void queryClient.invalidateQueries({ queryKey: ["entry", entry.id] });
    },
    onError: (e) => {
      setSelectError(e);
      setPendingRoomId(null);
      toast.error(e instanceof ApiError ? e.message : "Could not select rooms");
    },
  });

  const activeConfigurationId =
    searchResult?.configurationId ?? latestConfig?.id ?? preferredConfig?.id ?? null;

  const { availableRooms, deficientRooms, unavailableRooms, perDate } = useMemo(() => {
    if (searchResult?.results) {
      const fromApi = roomsFromResultSet(searchResult.results);
      return {
        availableRooms: searchResult.results.availableRooms ?? fromApi.availableRooms,
        deficientRooms: searchResult.results.deficientRooms ?? fromApi.deficientRooms,
        unavailableRooms: searchResult.results.unavailableRooms ?? fromApi.unavailableRooms,
        perDate: searchResult.results.perDate,
      };
    }
    const source = latestConfig?.resultSet ?? preferredConfig?.resultSet;
    if (source) {
      const rs = source as { perDate?: typeof searchResult extends null ? never : any };
      return { ...roomsFromResultSet(source), perDate: (rs?.perDate ?? undefined) };
    }
    return { availableRooms: [], deficientRooms: [], unavailableRooms: [], perDate: undefined };
  }, [searchResult, latestConfig, preferredConfig]);

  const hasRoomResults =
    availableRooms.length > 0 || deficientRooms.length > 0 || unavailableRooms.length > 0;

  // Hotel-wide room list — used by the calendar grid for floor + room-type lookups.
  const allRoomsQuery = useQuery({
    queryKey: ["rooms", "all"],
    queryFn: () => listRooms(session!),
    enabled: !!session,
    staleTime: 5 * 60_000,
  });
  const allRooms = allRoomsQuery.data?.items ?? [];

  // Calendar grid wants the active stay range. Prefer the form (latest search), fall back to entry.
  const calendarCheckIn = (checkIn || entry.checkInDate?.slice(0, 10)) ?? "";
  const calendarCheckOut = (checkOut || entry.checkOutDate?.slice(0, 10)) ?? "";

  const exitChecks = useMemo(() => {
    const hasDates = !!(entry.checkInDate && entry.checkOutDate) || !!(checkIn && checkOut);
    const hasGuestCount = (entry.guestCount ?? 0) >= 1 || Number(guestCount) >= 1;
    const hasContact = !!(entry.guestProfile?.email || entry.guestProfile?.phone);
    const hasPreferred = !!preferredConfig && !preferredConfig.isStale;
    return [
      { label: "Stay dates on entry", ok: !!(entry.checkInDate && entry.checkOutDate) },
      { label: "Stay dates for search", ok: hasDates },
      { label: "Guest count set", ok: hasGuestCount },
      { label: "Guest contact (email or phone)", ok: hasContact },
      { label: "Availability search run", ok: !!activeConfigurationId },
      { label: "Preferred room selected", ok: hasPreferred },
    ];
  }, [entry, checkIn, checkOut, guestCount, preferredConfig, activeConfigurationId]);

  const canProgress =
    exitChecks.every((c) => c.ok) &&
    entry.currentStage === "S1" &&
    !!(entry.checkInDate && entry.checkOutDate);

  // Compute stay nights on the workspace side too (for the auto-seal check + progress).
  const stayNights: string[] = (() => {
    const ci = checkIn || entry.checkInDate?.slice(0, 10);
    const co = checkOut || entry.checkOutDate?.slice(0, 10);
    if (!ci || !co) return [];
    const re = /^(\d{4})-(\d{2})-(\d{2})$/;
    const a = re.exec(ci);
    const b = re.exec(co);
    if (!a || !b) return [];
    const aDate = new Date(Date.UTC(Number(a[1]), Number(a[2]) - 1, Number(a[3])));
    const bDate = new Date(Date.UTC(Number(b[1]), Number(b[2]) - 1, Number(b[3])));
    const days: string[] = [];
    const cur = new Date(aDate);
    while (cur < bDate) {
      days.push(cur.toISOString().slice(0, 10));
      cur.setUTCDate(cur.getUTCDate() + 1);
      if (days.length > 90) break;
    }
    return days;
  })();

  const handleToggleCell = (roomId: string, isoDate: string, isDeficient: boolean) => {
    setSelectionsByDate((prev) => {
      const currentForNight = prev[isoDate] ?? [];
      const already = currentForNight.includes(roomId);
      const nextForNight = already ? currentForNight.filter((id) => id !== roomId) : [...currentForNight, roomId];
      const next = { ...prev, [isoDate]: nextForNight };

      // Track deficient status per room so we can bundle acknowledgements at commit time.
      setDeficientRoomIdsMap((m) => {
        const copy = { ...m };
        if (already) {
          const stillPicked = Object.entries(next).some(([d, ids]) => d !== isoDate && ids.includes(roomId));
          if (!stillPicked) delete copy[roomId];
        } else if (isDeficient) {
          copy[roomId] = true;
        }
        return copy;
      });

      return next;
    });
  };

  // Explicit save — user has to click "Save selection" once every night is at target count.
  // Kept out of the toggle handler so users can freely deselect / adjust before committing.
  const allNightsComplete =
    stayNights.length > 0 &&
    stayNights.every((n) => (selectionsByDate[n] ?? []).length === targetRoomCount);

  const handleSaveSelection = () => {
    const configId = searchResult?.configurationId ?? latestConfig?.id;
    if (!configId) {
      toast.error("Run availability search first");
      return;
    }
    if (!allNightsComplete) {
      toast.error(`Fill every night with ${targetRoomCount} room(s) before saving.`);
      return;
    }
    const perNight = stayNights.map((date) => ({ date, roomIds: selectionsByDate[date] ?? [] }));
    const deficientRoomIds = Object.keys(deficientRoomIdsMap).filter((id) =>
      Object.values(selectionsByDate).some((ids) => ids.includes(id)),
    );
    setPendingRoomId(perNight[0]?.roomIds[0] ?? null);
    selectMutation.mutate({ configurationId: configId, perNight, deficientRoomIds });
  };

  const resetSelections = () => {
    setSelectionsByDate({});
    setDeficientRoomIdsMap({});
  };

  // Re-open editing after a seal: copy the sealed picks back into local state so the operator
  // can adjust them. The next "Save" call overwrites the same AvailabilityConfiguration row
  // (backend does update, not insert), so this is safe.
  const handleEditAfterSeal = () => {
    setSelectionsByDate(sealedByDate);
    // Preserve deficient map for the sealed picks — assume they were flagged the same way.
    // Un-flagged rooms just won't have entries, which is fine.
    setEditingAfterSeal(true);
  };
  const cancelEditAfterSeal = () => {
    setSelectionsByDate({});
    setDeficientRoomIdsMap({});
    setEditingAfterSeal(false);
  };

  // The stage-mismatch gate (was: `if (entry.currentStage !== "S1") return <placeholder>`) has
  // been removed — the read-only shell + <fieldset disabled> in stage-page.tsx now handles the
  // case when the operator views a past or future stage. Workspace content always renders.

  return (
    <StagePanel meta={meta}>
      <div className="space-y-6">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Linked inquiry</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            <p>
              <span className="text-muted-foreground">Inquiry:</span>{" "}
              <span className="font-mono text-xs">{entry.inquiryId.slice(0, 16)}…</span>
            </p>
            <p>
              <span className="text-muted-foreground">Channel:</span> {inquiry?.sourceChannel ?? "—"}
            </p>
            <p>
              <span className="text-muted-foreground">Guest:</span>{" "}
              {entry.guestProfile?.displayName ??
                [entry.guestProfile?.firstName, entry.guestProfile?.lastName].filter(Boolean).join(" ") ??
                "—"}
            </p>
            {!entry.guestProfile?.email && !entry.guestProfile?.phone && (
              <p className="text-amber-700 dark:text-amber-400">
                Guest profile needs email or phone before S1 exit.
              </p>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">1. Availability search</CardTitle>
            <CardDescription>
              Search rooms for this entry. Results are saved as an availability configuration (SIG-S1).
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            {!entry.checkInDate && (
              <p className="rounded-lg border border-amber-500/40 bg-amber-500/5 px-3 py-2 text-sm text-amber-800 dark:text-amber-200">
                This entry has no stay dates saved. Set dates when creating the inquiry, or contact support —
                search alone does not update the entry record.
              </p>
            )}
            <div className="grid gap-4 sm:grid-cols-3">
              <div>
                <label className="text-xs text-muted-foreground">Check-in</label>
                <Input type="date" value={checkIn} onChange={(e) => setCheckIn(e.target.value)} />
              </div>
              <div>
                <label className="text-xs text-muted-foreground">Check-out</label>
                <Input type="date" value={checkOut} onChange={(e) => setCheckOut(e.target.value)} />
              </div>
              <div>
                <label className="text-xs text-muted-foreground">Guests</label>
                <Input
                  type="number"
                  min={1}
                  value={guestCount}
                  onChange={(e) => setGuestCount(e.target.value)}
                />
              </div>
            </div>
            <Button
              variant="gradient"
              onClick={() => searchMutation.mutate()}
              disabled={searchMutation.isPending}
            >
              {searchMutation.isPending ? "Searching…" : "Search availability"}
            </Button>
            <PolicyGateAlert error={searchError} />
            {activeConfigurationId && (
              <p className="text-xs text-muted-foreground">
                Configuration: <span className="font-mono">{activeConfigurationId.slice(0, 20)}…</span>
                {(latestConfig?.isStale || searchResult?.isStale) && (
                  <Badge variant="outline" className="ml-2">
                    Stale — search again
                  </Badge>
                )}
              </p>
            )}
          </CardContent>
        </Card>

        {hasRoomResults && (
          <Card>
            <CardHeader>
              <CardTitle className="text-base">2. Select preferred rooms</CardTitle>
              <CardDescription>
                Assign {targetRoomCount === 1 ? "1 room" : `${targetRoomCount} rooms`} per night. Different rooms per night are allowed
                (e.g. room 201 for night 1, room 301 for night 2). The seal fires when every night is fully assigned.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              {/* Sealed banner. Once picks are saved, the calendar shows them as green ✓ cells
                  and the operator can either accept them and move on, or click "Change
                  selection" to unlock and adjust. */}
              {preferredRoomIds.length > 0 && !editingAfterSeal && (
                <div className="flex items-center justify-between gap-2 rounded-lg border border-[var(--success)]/40 bg-accent px-3 py-2 text-sm">
                  <span className="flex items-center gap-2">
                    <CheckCircle2 className="h-4 w-4 text-[var(--success)]" />
                    Preferred rooms saved
                    {selectMutation.isPending && " (saving…)"}
                  </span>
                  <Button variant="outline" size="sm" onClick={handleEditAfterSeal} disabled={selectMutation.isPending}>
                    Change selection
                  </Button>
                </div>
              )}

              {/* Editing banner — either fresh in-progress or re-opened after a seal. */}
              {(editingAfterSeal || (preferredRoomIds.length === 0 && Object.values(selectionsByDate).some((ids) => ids.length > 0))) && (
                <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-primary/30 bg-primary/5 px-3 py-2 text-sm">
                  <span className="text-muted-foreground">
                    {editingAfterSeal
                      ? "Adjusting saved selection — click Save to overwrite, or Cancel to keep the previous save."
                      : `Assign ${targetRoomCount} ${targetRoomCount === 1 ? "room" : "rooms"} per night, then click Save selection.`}
                  </span>
                  <div className="flex items-center gap-2">
                    <Button
                      variant="gradient"
                      size="sm"
                      onClick={handleSaveSelection}
                      disabled={!allNightsComplete || selectMutation.isPending}
                    >
                      {selectMutation.isPending ? "Saving…" : "Save selection"}
                    </Button>
                    <Button variant="outline" size="sm" onClick={editingAfterSeal ? cancelEditAfterSeal : resetSelections} disabled={selectMutation.isPending}>
                      {editingAfterSeal ? "Cancel" : "Reset"}
                    </Button>
                  </div>
                </div>
              )}

              <AvailabilityCalendar
                checkInDate={calendarCheckIn}
                checkOutDate={calendarCheckOut}
                availableRooms={availableRooms}
                deficientRooms={deficientRooms}
                unavailableRooms={unavailableRooms}
                perDate={perDate}
                allRooms={allRooms}
                selectionsByDate={selectionsByDate}
                // Only render the sealed-cell green ticks when NOT re-editing — in edit mode
                // the sealed picks live in selectionsByDate so cells behave like normal picks.
                sealedByDate={editingAfterSeal ? {} : sealedByDate}
                targetRoomsPerNight={targetRoomCount}
                disabled={
                  selectMutation.isPending ||
                  !activeConfigurationId ||
                  // Locked ONLY when a seal exists AND the operator hasn't asked to change it.
                  (preferredRoomIds.length > 0 && !editingAfterSeal)
                }
                onToggleCell={handleToggleCell}
              />

              <PolicyGateAlert error={selectError} />
            </CardContent>
          </Card>
        )}

        <Card>
          <CardHeader>
            <CardTitle className="text-base">S1 exit checklist</CardTitle>
            <CardDescription>Required before moving to S2 (quotation)</CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            {exitChecks.map((item) => (
              <div key={item.label} className="flex items-center gap-2 text-sm">
                {item.ok ? (
                  <CheckCircle2 className="h-4 w-4 shrink-0 text-[var(--success)]" />
                ) : (
                  <Circle className="h-4 w-4 shrink-0 text-muted-foreground" />
                )}
                <span className={item.ok ? "text-foreground" : "text-muted-foreground"}>{item.label}</span>
              </div>
            ))}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">3. Progress to S2</CardTitle>
          </CardHeader>
          <CardContent>
            {!canProgress && (
              <p className="mb-4 text-sm text-muted-foreground">
                Complete the checklist above: run availability search, select a preferred room, and ensure the
                entry has stay dates and guest contact on file.
              </p>
            )}
            {entry.currentStage === "S1" && (
              <ProgressStageButton
                entryId={entry.id}
                version={entry.version}
                targetStage="S2"
                label="Progress to S2 — Quotation"
                variant={canProgress ? "gradient" : "outline"}
                disabled={!canProgress}
              />
            )}
          </CardContent>
        </Card>
      </div>
    </StagePanel>
  );
}
