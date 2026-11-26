"use client";

/**
 * The booking file's Guests tab from Arrival on, between Papers and History (2026-11-24, operator: "whenever the user
 * submits the details of their info, their name, identity card document type and dob and pictures,
 * in the right panel can you add another tab where when clicked the user can see those guest infos").
 *
 * A reading of what the guest table on the step holds — the same list (`GET …/identity-proofs`, the
 * same query, so the two never disagree), each guest as recorded with their newest ID photo, grouped
 * by the room they sleep in. Each guest is one line until opened (same day, operator: "can it be shown
 * in a collapsed way so that user can expand it"); a date of birth that does not fit stays on the line.
 * Nothing is typed here; the guest table at Arrival, Check-in and Stay is where it is typed. At
 * Check-out and Closed it is the record of who stayed. One thing can be done here (2026-11-25): a
 * guest filed on another guest's row is swapped back (`SwapGuestsDialog`).
 */
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ChevronDown, ChevronRight, Lock } from "lucide-react";
import { useSession } from "@/hooks/use-session";
import { listIdentityProofs, type IdentityProofSummary } from "@/lib/api/identity-proofs";
import { getChildPolicy } from "@/lib/api/child-policy";
import { listRooms } from "@/lib/api/rooms";
import { seatPartyByComposition } from "@/lib/desk/party-rooms";
import { fmtDmy } from "@/lib/ds/format";
import { IdPhotoViewerHost } from "@/components/desk/workspace/id-photo-viewer";
import { IdentityProofBlock, partySlots, ProofThumb, UNTYPED_DOC_TYPES, type PartySlot } from "@/components/desk/workspace/identity-proof";
import { SubTabs, Tool } from "../steps/kit";
import type { EntryDetail } from "@/types/api";
import { Button } from "@/design-system";
import { SwapGuestsDialog, type SwapCandidate } from "./guests-swap";

const GENDER_WORDS: Record<string, string> = { MALE: "Male", FEMALE: "Female", OTHER: "Other" };

type GuestRow = { slot: PartySlot; detail: IdentityProofSummary | null; photo: IdentityProofSummary | null };

/** The guests recorded so far, out of the party — the server's count, for the tab's badge. */
export function useGuestsRecorded(entry: EntryDetail | null, on: boolean) {
  const { session } = useSession();
  const q = useQuery({
    queryKey: ["identity-proofs", entry?.id],
    queryFn: () => listIdentityProofs(session!, entry!.id),
    enabled: !!session && !!entry && on,
    staleTime: 5 * 60_000,
  });
  const c = q.data?.coverage;
  return c ? { filled: c.filledSlots, total: c.totalSlots, done: c.satisfied } : null;
}

/**
 * Two sub-tabs (2026-11-26, operator: "a subtab like info which shows the records of guest documents and
 * then edit where they can upload or change the info … use the same system to detect the info"):
 * Info — what is recorded, as before; Edit — the guest table itself, with its photo, phone code and the
 * reading of the ID, open from Arrival to the end of the stay (it is read-only once sealed).
 */
export function GuestsView({ entry }: { entry: EntryDetail }) {
  const editable = entry.status === "ACTIVE" && ["S5", "S6", "S7", "S8"].includes(entry.currentStage);
  return (
    <SubTabs
      label="The guests"
      param="gsub"
      tabs={[
        { key: "info", label: "Info", content: <GuestsInfo entry={entry} /> },
        editable
          ? {
              key: "edit",
              label: "Edit",
              content: (
                <div className="guests-edit">
                  <Tool inert={false}>
                    <IdentityProofBlock entry={entry} title="The guests' details and ID" />
                  </Tool>
                </div>
              ),
            }
          : null,
      ]}
    />
  );
}

function GuestsInfo({ entry }: { entry: EntryDetail }) {
  const { session } = useSession();
  const list = useQuery({
    queryKey: ["identity-proofs", entry.id],
    queryFn: () => listIdentityProofs(session!, entry.id),
    enabled: !!session,
    staleTime: 5 * 60_000,
  });
  const policy = useQuery({ queryKey: ["lookup", "child-policy"], queryFn: () => getChildPolicy(session!), enabled: !!session, staleTime: 10 * 60_000 });
  const rooms = useQuery({ queryKey: ["rooms-catalog"], queryFn: () => listRooms(session!), enabled: !!session, staleTime: 5 * 60_000 });

  /** The guests opened — each is one line until opened. */
  const [open, setOpen] = useState<Set<string>>(() => new Set());
  /** The row being swapped with another (2026-11-25). */
  const [swapFrom, setSwapFrom] = useState<string | null>(null);
  const docName = useMemo(() => new Map((list.data?.documentTypes ?? []).map((d) => [d.code, d.name])), [list.data]);
  const roomInfo = useMemo(() => {
    const m = new Map<string, { roomNumber: string; typeName: string | null }>();
    for (const r of rooms.data?.items ?? []) m.set(r.id, { roomNumber: r.roomNumber, typeName: r.roomType?.name ?? null });
    return m;
  }, [rooms.data]);
  const roomBySlot = useMemo(
    () => seatPartyByComposition(entry, policy.data?.ageBands.youngChildMaxAge ?? 5, policy.data?.ageBands.childMaxAge ?? 10),
    [entry, policy.data],
  );

  const groups = useMemo(() => {
    const items = (list.data?.items ?? []).filter((i) => i.entryId === entry.id);
    const rows: GuestRow[] = partySlots(entry).map((slot) => {
      const detail = items.find((i) => !i.hasFile && i.subjectKey === slot.key) ?? null;
      const photo =
        items
          .filter((i) => i.hasFile && i.subjectKey === slot.key)
          .sort((a, b) => (a.capturedAt < b.capturedAt ? 1 : -1))[0] ?? null;
      return { slot, detail, photo };
    });
    const byRoom = new Map<string, GuestRow[]>();
    for (const r of rows) {
      const key = roomBySlot.get(r.slot.key) ?? "";
      byRoom.set(key, [...(byRoom.get(key) ?? []), r]);
    }
    return [...byRoom.entries()].sort((a, b) => {
      if (!a[0]) return 1;
      if (!b[0]) return -1;
      return (roomInfo.get(a[0])?.roomNumber ?? "").localeCompare(roomInfo.get(b[0])?.roomNumber ?? "", undefined, { numeric: true });
    });
  }, [list.data, entry, roomBySlot, roomInfo]);

  if (list.isLoading) return <p className="meta">Reading the guests…</p>;
  if (list.isError) return <p className="stop-ink sm" role="alert">The guests could not be read — try again in a moment.</p>;

  const coverage = list.data?.coverage;
  const lead = list.data?.leadSubjectKey ?? "A0";
  // Rows can be swapped from Arrival on while the booking is not closed.
  const canSwap = (entry.status === "ACTIVE" || entry.status === "PARKED") && ["S5", "S6", "S7", "S8", "S9"].includes(entry.currentStage ?? "");
  const candidates: SwapCandidate[] = groups.flatMap(([roomId, rows]) =>
    rows.map(({ slot, detail, photo }) => {
      const name = detail?.subjectLabel?.trim() && detail.subjectLabel !== slot.label ? detail.subjectLabel.trim() : null;
      const info = roomId ? roomInfo.get(roomId) : null;
      const age = detail?.ageCheck?.ageAtCheckIn;
      return {
        key: slot.key,
        row: slot.label,
        person: name,
        where: info ? `Room ${info.roomNumber}${info.typeName ? ` · ${info.typeName}` : ""}` : null,
        born: detail?.dateOfBirth ? `born ${fmtDmy(detail.dateOfBirth.slice(0, 10))}${age != null ? ` · ${age} at check-in` : ""}` : null,
        holdsSomeone: !!(name || detail?.documentNumber || detail?.dateOfBirth || detail?.documentType || photo),
      };
    }),
  );
  const swapSource = swapFrom ? candidates.find((c) => c.key === swapFrom) ?? null : null;
  const several = groups.length > 1 || (groups[0] && groups[0][0] !== "");
  const allKeys = groups.flatMap(([, rows]) => rows.map((r) => r.slot.key));
  const allOpen = allKeys.length > 0 && allKeys.every((k) => open.has(k));
  const toggle = (k: string) =>
    setOpen((cur) => {
      const next = new Set(cur);
      if (next.has(k)) next.delete(k);
      else next.add(k);
      return next;
    });

  return (
    <div className="guests-view">
      {coverage ? (
        <div className={`gv-count ${coverage.satisfied ? "ok" : "short"}`}>
          <b>
            {coverage.filledSlots} of {coverage.totalSlots}
          </b>{" "}
          {coverage.totalSlots === 1 ? "guest" : "guests"} recorded
          {coverage.vipExempt ? <span className="sm"> · a VIP booking — not required</span> : null}
          {allKeys.length > 1 ? (
            <button type="button" className="gv-all" onClick={() => setOpen(allOpen ? new Set() : new Set(allKeys))}>
              {allOpen ? "Close all" : "Open all"}
            </button>
          ) : null}
        </div>
      ) : null}
      {groups.map(([roomId, rows]) => (
        <section key={roomId || "none"} className="gv-room">
          {several ? (
            <div className="gv-band">
              {roomId ? (
                <>
                  <b>Room {roomInfo.get(roomId)?.roomNumber ?? "…"}</b>
                  {roomInfo.get(roomId)?.typeName ? <span> · {roomInfo.get(roomId)!.typeName}</span> : null}
                </>
              ) : (
                <b>No room yet</b>
              )}
            </div>
          ) : null}
          {rows.map(({ slot, detail, photo }) => {
            const name = detail?.subjectLabel?.trim() && detail.subjectLabel !== slot.label ? detail.subjectLabel.trim() : null;
            const docType = detail?.documentType && !UNTYPED_DOC_TYPES.has(detail.documentType) ? (docName.get(detail.documentType) ?? detail.documentType) : null;
            const age = detail?.ageCheck?.ageAtCheckIn;
            const recorded = !!(name || docType || detail?.documentNumber || detail?.dateOfBirth || photo);
            const isOpen = open.has(slot.key);
            const dobOff = !!(detail?.ageCheck && !detail.ageCheck.ok && detail.ageCheck.message);
            // What is on file, in a few words, for the closed line.
            const onFile = recorded ? [docType ?? (detail?.documentNumber ? "document" : null), photo ? "photo" : "no photo"].filter(Boolean).join(" · ") : "nothing recorded";
            return (
              <div key={slot.key} className={`gv-item${isOpen ? " open" : ""}`} data-guest={slot.key}>
                <button type="button" className="gv-line" aria-expanded={isOpen} onClick={() => toggle(slot.key)}>
                  {isOpen ? <ChevronDown size={14} aria-hidden /> : <ChevronRight size={14} aria-hidden />}
                  <b className="gv-who">{name ?? slot.label}</b>
                  {name ? <span className="meta">{slot.label}</span> : null}
                  {slot.key === lead ? <span className="gv-lead">Lead</span> : null}
                  {detail?.detailsConfirmedAt ? <Lock size={12} aria-label="confirmed" className="gv-lockmark" /> : null}
                  <span className={`gv-onfile${recorded ? "" : " none"}`}>{onFile}</span>
                  {dobOff ? (
                    <span className="gv-dobflag" role="alert" title={detail!.ageCheck!.message!}>
                      ! date of birth
                    </span>
                  ) : null}
                </button>
                {isOpen ? (
              <div className="gv-guest">
                <div className="gv-photo">
                  {photo ? <ProofThumb proof={photo} size={60} name={name ?? slot.label} /> : <span className="gv-nophoto">No ID photo</span>}
                </div>
                <div className="gv-facts">
                  {detail?.detailsConfirmedAt ? (
                    <span className="gv-locked" title="Confirmed — the table is locked">
                      <Lock size={12} aria-hidden /> confirmed
                    </span>
                  ) : null}
                  {recorded ? (
                    <dl className="gv-dl">
                      <dt>Document</dt>
                      <dd>
                        {docType ?? <span className="meta">type not chosen</span>}
                        {detail?.documentNumber ? <> · {detail.documentNumber}</> : null}
                      </dd>
                      <dt>Born</dt>
                      <dd>
                        {detail?.dateOfBirth ? (
                          <>
                            {fmtDmy(detail.dateOfBirth.slice(0, 10))}
                            {age != null ? <span className="meta"> · {age} at check-in</span> : null}
                          </>
                        ) : (
                          <span className="meta">not recorded</span>
                        )}
                      </dd>
                      <dt>Gender</dt>
                      <dd>{detail?.gender ? (GENDER_WORDS[detail.gender] ?? detail.gender) : <span className="meta">not recorded</span>}</dd>
                    </dl>
                  ) : (
                    <p className="meta gv-none">Nothing recorded yet</p>
                  )}
                  {detail?.ageCheck && !detail.ageCheck.ok && detail.ageCheck.message ? (
                    <p className="stop-ink sm" role="alert">
                      {detail.ageCheck.message}
                    </p>
                  ) : null}
                  {canSwap && recorded ? (
                    <div className="gv-swap">
                      <Button kind={dobOff ? "primary" : "secondary"} compact className={dobOff ? "go" : undefined} onClick={() => setSwapFrom(slot.key)}>
                        Swap with another guest
                      </Button>
                    </div>
                  ) : null}
                </div>
              </div>
                ) : null}
              </div>
            );
          })}
        </section>
      ))}
      <p className="meta sm gv-foot">The details are typed in the guest table at Arrival, Check-in and Stay. A guest on the wrong row is swapped from here.</p>
      {swapSource ? (
        <SwapGuestsDialog
          entryId={entry.id}
          from={swapSource}
          others={candidates.filter((c) => c.key !== swapSource.key)}
          open
          onClose={() => setSwapFrom(null)}
        />
      ) : null}
      <IdPhotoViewerHost />
    </div>
  );
}
