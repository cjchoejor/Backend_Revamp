"use client";

import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { ApiError } from "@/lib/api/client";
import { getHotelProfile, updateHotelProfile, type HotelProfileAdmin } from "@/lib/api/admin";
import { useSession } from "@/hooks/use-session";
import { SmartConfigEditor } from "@/components/admin/smart-config-editor";

type ContactRow = { label: string; value: string };

export default function AdminHotelProfilePage() {
  const { session } = useSession();
  const queryClient = useQueryClient();
  const profileQuery = useQuery({
    queryKey: ["admin", "hotel-profile"],
    queryFn: () => getHotelProfile(session!),
    enabled: !!session && session.actorLevel === "L4",
  });

  const [draft, setDraft] = useState<Partial<HotelProfileAdmin> | null>(null);
  const [contacts, setContacts] = useState<ContactRow[]>([{ label: "Front Desk", value: "" }]);
  const [checkIn, setCheckIn] = useState("14:00");
  const [checkOut, setCheckOut] = useState("12:00");
  const [holidays, setHolidays] = useState<unknown[]>([]);

  useEffect(() => {
    const row = profileQuery.data;
    if (!row) return;
    setDraft(row);
    const nums = Array.isArray(row.contactNumbers) ? (row.contactNumbers as ContactRow[]) : [];
    setContacts(nums.length > 0 ? nums.map((n) => ({ label: String(n.label ?? ""), value: String(n.value ?? "") })) : [{ label: "Front Desk", value: "" }]);
    const hours = typeof row.operatingHours === "object" && row.operatingHours !== null ? (row.operatingHours as Record<string, string>) : {};
    setCheckIn(hours.checkIn ?? "14:00");
    setCheckOut(hours.checkOut ?? "12:00");
    const holidays = Array.isArray(row.publicHolidaySchedule) ? row.publicHolidaySchedule : [];
    setHolidays(holidays);
  }, [profileQuery.data]);

  const saveMutation = useMutation({
    mutationFn: async () => {
      if (!draft) throw new Error("No profile loaded");
      const publicHolidaySchedule = holidays;
      return updateHotelProfile(session!, {
        expectedVersion: draft.version,
        hotelName: draft.hotelName ?? "",
        registeredAddress: draft.registeredAddress ?? "",
        tradingAddress: draft.tradingAddress ?? null,
        primaryEmail: draft.primaryEmail ?? "",
        timeZone: draft.timeZone ?? "",
        propertyCurrency: draft.propertyCurrency ?? "",
        contactNumbers: contacts.filter((c) => c.label.trim() || c.value.trim()),
        operatingHours: { checkIn, checkOut },
        publicHolidaySchedule,
      });
    },
    onSuccess: () => {
      toast.success("Hotel profile saved");
      void queryClient.invalidateQueries({ queryKey: ["admin", "hotel-profile"] });
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : e instanceof Error ? e.message : "Save failed"),
  });

  const row = profileQuery.data;
  const isBusy = profileQuery.isLoading || saveMutation.isPending;
  const canRender = !!session && session.actorLevel === "L4";

  const header = useMemo(() => {
    if (!row) return null;
    return (
      <div className="admin-panel p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="admin-display text-lg">{row.hotelName}</h2>
            <p className="admin-muted text-xs">Version {row.version}</p>
          </div>
          <button type="button" className="admin-btn" disabled={isBusy} onClick={() => saveMutation.mutate()}>
            Save
          </button>
        </div>
      </div>
    );
  }, [row, isBusy, saveMutation]);

  if (!canRender) return null;

  return (
    <div className="space-y-6 pb-16">
      <div>
        <p className="admin-eyebrow mb-2">Domain 01 · Identity</p>
        <h1 className="admin-display text-3xl">Hotel profile</h1>
        <p className="admin-muted mt-2 max-w-2xl text-sm">Single-row property identity record used across templates and invoices.</p>
      </div>

      {header}

      {profileQuery.isError && (
        <div className="admin-panel p-4 text-sm text-red-200">
          {profileQuery.error instanceof ApiError ? profileQuery.error.message : "Failed to load hotel profile"}
        </div>
      )}

      {draft && (
        <div className="admin-panel grid gap-4 p-5 md:grid-cols-2">
          <h2 className="admin-display col-span-full text-lg">Core fields</h2>
          <input className="admin-input" value={draft.hotelName ?? ""} onChange={(e) => setDraft({ ...draft, hotelName: e.target.value })} placeholder="Hotel name" />
          <input className="admin-input" value={draft.primaryEmail ?? ""} onChange={(e) => setDraft({ ...draft, primaryEmail: e.target.value })} placeholder="Primary email" />
          <input className="admin-input md:col-span-2" value={draft.registeredAddress ?? ""} onChange={(e) => setDraft({ ...draft, registeredAddress: e.target.value })} placeholder="Registered address" />
          <input className="admin-input md:col-span-2" value={draft.tradingAddress ?? ""} onChange={(e) => setDraft({ ...draft, tradingAddress: e.target.value || null })} placeholder="Trading address (optional)" />
          <input className="admin-input" value={draft.timeZone ?? ""} onChange={(e) => setDraft({ ...draft, timeZone: e.target.value })} placeholder="Time zone (IANA)" />
          <input className="admin-input" value={draft.propertyCurrency ?? ""} onChange={(e) => setDraft({ ...draft, propertyCurrency: e.target.value })} placeholder="Currency (e.g. BTN)" />

          <h2 className="admin-display col-span-full mt-4 text-lg">Contact numbers</h2>
          <div className="col-span-full space-y-2">
            {contacts.map((c, i) => (
              <div key={i} className="flex flex-wrap gap-2">
                <input className="admin-input flex-1" placeholder="Label" value={c.label} onChange={(e) => setContacts(contacts.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)))} />
                <input className="admin-input flex-[2]" placeholder="Phone number" value={c.value} onChange={(e) => setContacts(contacts.map((x, j) => (j === i ? { ...x, value: e.target.value } : x)))} />
                <button type="button" className="admin-btn text-[10px]" onClick={() => setContacts(contacts.filter((_, j) => j !== i))}>
                  Remove
                </button>
              </div>
            ))}
            <button type="button" className="admin-btn text-[10px]" onClick={() => setContacts([...contacts, { label: "", value: "" }])}>
              Add number
            </button>
          </div>

          <h2 className="admin-display col-span-full mt-4 text-lg">Operating hours</h2>
          <label className="space-y-1">
            <span className="admin-muted text-xs">Check-in from</span>
            <input type="time" className="admin-input" value={checkIn} onChange={(e) => setCheckIn(e.target.value)} />
          </label>
          <label className="space-y-1">
            <span className="admin-muted text-xs">Check-out by</span>
            <input type="time" className="admin-input" value={checkOut} onChange={(e) => setCheckOut(e.target.value)} />
          </label>

          <h2 className="admin-display col-span-full mt-4 text-lg">Public holidays (optional)</h2>
          <div className="col-span-full">
            <p className="admin-muted mb-1 text-xs">
              List of public holidays. Add items with at least a date (e.g. <code>2026-12-31</code>) and a label.
            </p>
            <SmartConfigEditor value={holidays} onChange={(v) => setHolidays(Array.isArray(v) ? (v as unknown[]) : [])} />
          </div>
        </div>
      )}
    </div>
  );
}
