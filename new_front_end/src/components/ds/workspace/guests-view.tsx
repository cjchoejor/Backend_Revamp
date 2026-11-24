"use client";

/**
 * The booking file's Guests tab at Arrival and Check-in (2026-11-24, operator: "whenever the user
 * submits the details of their info, their name, identity card document type and dob and pictures,
 * in the right panel can you add another tab where when clicked the user can see those guest infos").
 *
 * A reading of what the guest table on the step holds — the same list (`GET …/identity-proofs`, the
 * same query, so the two never disagree), each guest as recorded with their newest ID photo, grouped
 * by the room they sleep in. Nothing is changed here; the table on the step is where it is typed.
 */
import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { Lock } from "lucide-react";
import { useSession } from "@/hooks/use-session";
import { listIdentityProofs, type IdentityProofSummary } from "@/lib/api/identity-proofs";
import { getChildPolicy } from "@/lib/api/child-policy";
import { listRooms } from "@/lib/api/rooms";
import { seatPartyByComposition } from "@/lib/desk/party-rooms";
import { fmtDmy } from "@/lib/ds/format";
import { IdPhotoViewerHost } from "@/components/desk/workspace/id-photo-viewer";
import { partySlots, ProofThumb, UNTYPED_DOC_TYPES, type PartySlot } from "@/components/desk/workspace/identity-proof";
import type { EntryDetail } from "@/types/api";

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

export function GuestsView({ entry }: { entry: EntryDetail }) {
  const { session } = useSession();
  const list = useQuery({
    queryKey: ["identity-proofs", entry.id],
    queryFn: () => listIdentityProofs(session!, entry.id),
    enabled: !!session,
    staleTime: 5 * 60_000,
  });
  const policy = useQuery({ queryKey: ["lookup", "child-policy"], queryFn: () => getChildPolicy(session!), enabled: !!session, staleTime: 10 * 60_000 });
  const rooms = useQuery({ queryKey: ["rooms-catalog"], queryFn: () => listRooms(session!), enabled: !!session, staleTime: 5 * 60_000 });

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
  const several = groups.length > 1 || (groups[0] && groups[0][0] !== "");

  return (
    <div className="guests-view">
      {coverage ? (
        <div className={`gv-count ${coverage.satisfied ? "ok" : "short"}`}>
          <b>
            {coverage.filledSlots} of {coverage.totalSlots}
          </b>{" "}
          {coverage.totalSlots === 1 ? "guest" : "guests"} recorded
          {coverage.vipExempt ? <span className="sm"> · a VIP booking — not required</span> : null}
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
            return (
              <div key={slot.key} className="gv-guest" data-guest={slot.key}>
                <div className="gv-photo">
                  {photo ? <ProofThumb proof={photo} size={60} name={name ?? slot.label} /> : <span className="gv-nophoto">No ID photo</span>}
                </div>
                <div className="gv-facts">
                  <div className="gv-name">
                    <b>{name ?? slot.label}</b>
                    {name ? <span className="meta"> · {slot.label}</span> : null}
                    {slot.key === lead ? <span className="gv-lead">Lead</span> : null}
                    {detail?.detailsConfirmedAt ? (
                      <span className="gv-locked" title="Confirmed — the table is locked">
                        <Lock size={12} aria-hidden /> confirmed
                      </span>
                    ) : null}
                  </div>
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
                </div>
              </div>
            );
          })}
        </section>
      ))}
      <p className="meta sm gv-foot">The details are typed in the guest table on the step.</p>
      <IdPhotoViewerHost />
    </div>
  );
}
