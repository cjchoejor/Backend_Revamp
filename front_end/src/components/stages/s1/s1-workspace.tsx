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

  const configs: AvailabilityConfigSummary[] = entry.availabilityConfigs ?? [];
  const latestConfig = configs[0] ?? null;
  const preferredConfig = configs.find((c) => c.optionSelected != null) ?? null;
  const preferredRoomId = preferredConfig?.optionSelected?.roomId ?? null;

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
      roomId,
      isDeficient,
    }: {
      configurationId: string;
      roomId: string;
      isDeficient: boolean;
    }) => {
      return selectAvailabilityOption(session!, configurationId, {
        roomId,
        deficientAcknowledgements: isDeficient
          ? [
              {
                roomId,
                acknowledgedAt: new Date().toISOString(),
                note: "Acknowledged at S1 configuration selection",
              },
            ]
          : undefined,
      });
    },
    onSuccess: () => {
      setSelectError(null);
      setPendingRoomId(null);
      toast.success("Preferred room selected");
      void queryClient.invalidateQueries({ queryKey: ["entry", entry.id] });
    },
    onError: (e) => {
      setSelectError(e);
      toast.error(e instanceof ApiError ? e.message : "Could not select room");
    },
  });

  const activeConfigurationId =
    searchResult?.configurationId ?? latestConfig?.id ?? preferredConfig?.id ?? null;

  const { availableRooms, deficientRooms, unavailableRooms } = useMemo(() => {
    if (searchResult?.results) {
      const fromApi = roomsFromResultSet(searchResult.results);
      return {
        availableRooms: searchResult.results.availableRooms ?? fromApi.availableRooms,
        deficientRooms: searchResult.results.deficientRooms ?? fromApi.deficientRooms,
        unavailableRooms: searchResult.results.unavailableRooms ?? fromApi.unavailableRooms,
      };
    }
    const source = latestConfig?.resultSet ?? preferredConfig?.resultSet;
    if (source) return roomsFromResultSet(source);
    return { availableRooms: [], deficientRooms: [], unavailableRooms: [] };
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

  const handleSelectRoom = (room: AvailabilityRoomResult, isDeficient: boolean) => {
    const configId = searchResult?.configurationId ?? latestConfig?.id;
    if (!configId) {
      toast.error("Run availability search first");
      return;
    }
    setPendingRoomId(room.roomId);
    selectMutation.mutate({ configurationId: configId, roomId: room.roomId, isDeficient });
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
              <CardTitle className="text-base">2. Select preferred room</CardTitle>
              <CardDescription>
                Choose one room as the preferred configuration before progressing to S2.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              {preferredRoomId && (
                <div className="flex items-center gap-2 rounded-lg border border-[var(--success)]/40 bg-accent px-3 py-2 text-sm">
                  <CheckCircle2 className="h-4 w-4 text-[var(--success)]" />
                  Preferred room selected
                  {pendingRoomId === preferredRoomId && selectMutation.isPending && " (saving…)"}
                </div>
              )}

              {/* Phase 2: replaced the flat rooms list with a date × room-type calendar grid. */}
              <AvailabilityCalendar
                checkInDate={calendarCheckIn}
                checkOutDate={calendarCheckOut}
                availableRooms={availableRooms}
                deficientRooms={deficientRooms}
                unavailableRooms={unavailableRooms}
                allRooms={allRooms}
                selectedRoomId={preferredRoomId}
                pendingRoomId={pendingRoomId}
                disabled={selectMutation.isPending || !activeConfigurationId}
                onSelectRoomType={(room, isDeficient) => handleSelectRoom(room, isDeficient)}
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
