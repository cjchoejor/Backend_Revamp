"use client";

/**
 * Step 6 · Check-in — "keys & live folio" (SS03 amendment C1–C3; prototype `stepCanvas[6]`).
 *
 * In the stage-template layout since 2026-10-29: the guests' documents, the registration, the
 * advance still owed, the VIP notice and the rooms with their keys, each a numbered section that
 * folds to one line once its own act finishes it; Check in floats in once every one is done. The
 * readiness lines are the workspace's `s6Readiness`, never re-decided here.
 */
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Button, Chip } from "@/design-system";
import { useSession } from "@/hooks/use-session";
import { useHotelClock } from "@/hooks/use-hotel-clock";
import { usePaymentStatus } from "@/hooks/use-payment-status";
import { getChildPolicy } from "@/lib/api/child-policy";
import { listIdentityProofs, type IdentityProofSummary } from "@/lib/api/identity-proofs";
import type { RoomCompositionInput } from "@/lib/api/quotations";
import {
  arrivalNightRoomIds,
  mealPlanSummary,
  operativeRoomCompositions,
  partySlotLabels,
  roomStayRangesByRoom,
  seatPartyRoomsByComposition,
} from "@/lib/desk/party-rooms";
import { guestName } from "@/lib/desk/model";
import { fmtDate, fmtDay, fmtStamp, money, plural } from "@/lib/ds/format";
import { AdvanceSettlementBlock } from "@/components/desk/workspace/advance-settlement";
import { IdentityProofBlock } from "@/components/desk/workspace/identity-proof";
import { ExtraBedEditor, InitialSelectionCell } from "@/components/desk/workspace/room-change-control";
import type { EntryDetail, RoomAssignmentSummary } from "@/types/api";
import {
  ChangeBookingMenu,
  Fact,
  Facts,
  InlineWay,
  Live,
  OtherWaysTabs,
  StageActs,
  StepCanvas,
  StepCard,
  Tool,
  atLeast,
  useFinishWhenDone,
  useFinishWhenMet,
  useOpenAlsoWay,
  useRefreshEntry,
  useStepPane,
  words,
  type ChangeBookingItem,
  type StepPane,
} from "./kit";
import { RoomsTableCard } from "./rooms-table";
import { CancelAtArrivalDialog } from "./s4-other-ways";
import { InlineTool, claimWord, distinctRoomRows, physicalWord, roomLabel } from "./s6-shared";
import { Help } from "@/components/ds/help";

/* ------------------------------------------------------------------ vocabulary */

const PATH_WORD: Record<string, string> = {
  FIRST_TIME: "a first-time guest",
  RETURNING_VALID: "returning · document still valid",
  RETURNING_EXPIRED: "returning · document renewed",
  VIP: "the VIP path",
};

/** Placeholder document codes the guest table stores before a type is picked. */
const NO_TYPE = new Set(["PASSPORT_OR_PERMIT", "PHOTO_PROOF"]);

const ID = {
  document: "s6-document",
  guests: "s6-guest-table",
  registration: "s6-registration",
  advance: "s6-advance",
  rooms: "s6-rooms",
};

/* ------------------------------------------------------------------ the step */

/** This stay's identity verification, from the identity-proofs feed (2026-09-18). */
type StayVerification = { verifiedAt: string; verifiedBy: string | null; path: string | null } | null;

/**
 * Check-in's own view in the page — the rooms as the negotiation table, opened from Change
 * booking's "Move a room" (2026-10-29, in the stage-template layout, as at Set up to Arrival).
 */
export const S6_PANES: StepPane[] = [{ key: "rooms", label: "Moving a room", cards: [] }];

/**
 * Check-in in the stage-template layout (2026-10-29, operator: "now make the same UI change for
 * stage 6"): five numbered sections in the order the desk works them — the guests' documents,
 * the registration, the advance, the VIP notice (a VIP's booking only), the rooms and their keys.
 * Each is finished by its own act and folds to one line; Check in floats in once all are done.
 * The facts list that stood at the top said every section again, and went.
 */
export function S6CheckIn({
  entry,
  past,
  issuedKeyRooms,
  toggleKeyRoom,
  setKeyRooms,
  registrationConfirmed,
  setRegistrationConfirmed,
  pane = null,
}: {
  entry: EntryDetail;
  past: boolean;
  pane?: string | null;
  issuedKeyRooms: Record<string, boolean>;
  toggleKeyRoom: (roomId: string) => void;
  setKeyRooms: (roomIds: string[], issued: boolean) => void;
  registrationConfirmed: boolean;
  setRegistrationConfirmed: (v: boolean) => void;
}) {
  // A pane is hidden, never unmounted — a half-typed reason survives a look at the rooms.
  const at = (k: string | null) => ((pane ?? null) === k ? undefined : true);
  const { session } = useSession();
  const { tz } = useHotelClock(60_000);
  const stepPane = useStepPane();

  const proofs = useQuery({
    queryKey: ["identity-proofs", entry.id],
    queryFn: () => listIdentityProofs(session!, entry.id),
    enabled: !!session,
  });
  const coverage = proofs.data?.coverage ?? null;
  // Verified at THIS stay — never the profile's stamp, which a returning guest carries over (2026-09-18).
  const verification = proofs.data?.verification ?? null;

  const guest = entry.guestProfile ?? entry.inquiry?.guestProfile ?? null;
  const isVip = !!guest?.vipTier?.trim();

  // The lead's row of the guest table — where the document is typed, and what verification records.
  const lead = useMemo(
    () => {
      // The row marked as the lead (2026-10-23), else the first adult row — the server says which.
      const key = proofs.data?.leadSubjectKey ?? "A0";
      return (proofs.data?.items ?? []).find((p) => p.entryId === entry.id && !p.hasFile && p.subjectKey === key) ?? null;
    },
    [proofs.data, entry.id],
  );
  const docName = (code?: string | null) =>
    !code || NO_TYPE.has(code) ? null : ((proofs.data?.documentTypes ?? []).find((t) => t.code === code)?.name ?? words(code));

  const rooms = useMemo(() => distinctRoomRows(entry), [entry]);
  const dayOne = useMemo(() => arrivalNightRoomIds(entry), [entry]);
  const dayOneIds = rooms.filter((a) => dayOne.has(a.roomId)).map((a) => a.roomId);
  const laterCount = rooms.length - dayOneIds.length;

  return (
    <StepCanvas past={past}>
      <div className="pane" hidden={at(null)}>
        <GuestDocumentsCard entry={entry} lead={lead} verification={verification} coverage={coverage} docName={docName} tz={tz} />

        <RegistrationCard entry={entry} tz={tz} confirmed={registrationConfirmed} setConfirmed={setRegistrationConfirmed} />

        <CheckInAdvanceCard entry={entry} />

        {isVip ? <VipCard entry={entry} tz={tz} /> : null}

        <RoomsCard
          entry={entry}
          past={past}
          rooms={rooms}
          dayOne={dayOne}
          dayOneIds={dayOneIds}
          laterCount={laterCount}
          issuedKeyRooms={issuedKeyRooms}
          toggleKeyRoom={toggleKeyRoom}
          setKeyRooms={setKeyRooms}
          tz={tz}
        />

        {past ? null : <CheckInChangeBooking entry={entry} onMoveRoom={() => stepPane.open("rooms")} />}
      </div>

      <div className="pane" hidden={at("rooms")}>
        <RoomsTableCard
          entry={entry}
          title="The rooms"
          lead="Who sleeps where, on what plan, with what beds. Double-click a room to give it another room — every night is checked again and the price follows."
        />
      </div>
    </StepCanvas>
  );
}

/* ------------------------------------------------------------------ change booking */

/**
 * Change booking at the end of the step line (2026-10-29), as at Reserve and Arrival: Move a room
 * opens the rooms in the page; the dates are not changed at Check-in — they move at Stay; and the
 * guest who is at the desk but not staying is cancelled (SIG-S6 §8.6 / Policy 35, the FOM's).
 */
function CheckInChangeBooking({ entry, onMoveRoom }: { entry: EntryDetail; onMoveRoom: () => void }) {
  const { session } = useSession();
  const openAlsoWay = useOpenAlsoWay();
  const fom = atLeast(session?.actorLevel, "L2");
  const active = entry.status === "ACTIVE";
  const items: ChangeBookingItem[] = [
    {
      key: "rooms",
      label: "Move a room",
      note: "Into another free room on the same dates. Every night is checked again and the price follows.",
      onSelect: active ? onMoveRoom : undefined,
      reason: active ? undefined : "Not possible on this booking now",
    },
    {
      key: "dates",
      label: "Change the dates",
      note: "Once the guest is checked in, Stay adds nights (Extend the stay) or ends the stay sooner (Leaving early).",
      reason: "Not at Check-in — the dates change at Stay",
    },
    {
      key: "cancel",
      label: "Cancel booking",
      note: "The guest is at the desk but is not staying. The agreed charge is kept, the rest of the advance goes back and the rooms are released.",
      onSelect: active && fom ? () => openAlsoWay("cancel") : undefined,
      reason: !active ? "Not possible on this booking now" : fom ? undefined : "The FOM's call",
      danger: true,
    },
  ];
  return (
    <>
      <StageActs>
        <ChangeBookingMenu items={items} />
      </StageActs>
      <OtherWaysTabs
        tabs={
          active && fom
            ? [
                {
                  key: "cancel",
                  label: "Cancel booking",
                  inBar: false,
                  content: <InlineWay render={(done) => <CancelAtArrivalDialog entry={entry} onClose={done} />} />,
                },
              ]
            : []
        }
      />
    </>
  );
}

/* ------------------------------------------------------------------ the advance */

/** The advance still owed — a section of its own, folding to one line once it is in order (2026-10-29). */
function CheckInAdvanceCard({ entry }: { entry: EntryDetail }) {
  const pay = usePaymentStatus(entry.id, { enabled: !!entry.folio }).data;
  // A payment, a credit extension or the sign-off finishes the section once it reads done.
  const finish = useFinishWhenDone("advance");
  const reconciled = entry.folio?.advancePaymentReconciliationComplete === true;
  const cur = entry.folio?.lines?.[0]?.currency;
  const signed = reconciled ? " · signed off" : "";
  const summary = pay
    ? pay.requiredAmount > 0
      ? `Received ${money(pay.totalReceived, cur)} of ${money(pay.requiredAmount, cur)}${signed}`
      : pay.totalReceived > 0
        ? `No advance asked · ${money(pay.totalReceived, cur)} received${signed}`
        : `No advance asked${signed}`
    : reconciled
      ? "Signed off"
      : undefined;
  return (
    <div id={ID.advance}>
      <StepCard
        flow="advance"
        title="The advance"
        meta="If the guest planned to settle the advance at the desk, take it now — checking in with money still short needs the FOM's credit extension instead."
        summary={summary}
      >
        <Tool>
          <AdvanceSettlementBlock entry={entry} title="The advance" noHeading onChanged={() => finish()} />
        </Tool>
      </StepCard>
    </div>
  );
}

/* ------------------------------------------------------------------ the guests' documents */

/**
 * The guests' documents (2026-10-29): the lead's document as recorded, and the guest table where
 * every guest's details are typed and the lead's identity is verified. One section — the card above
 * the table only pointed at it. Recording the verification with every guest on file finishes it.
 */
function GuestDocumentsCard({
  entry,
  lead,
  verification,
  coverage,
  docName,
  tz,
}: {
  entry: EntryDetail;
  lead: IdentityProofSummary | null;
  verification: StayVerification;
  coverage: { vipExempt: boolean; totalSlots: number; filledSlots: number; satisfied: boolean } | null;
  docName: (code?: string | null) => string | null;
  tz: string;
}) {
  useFinishWhenMet("identity");
  const verifiedAt = verification?.verifiedAt ?? null;
  const path = verification?.path ?? null;
  const doc = [docName(lead?.documentType), lead?.documentNumber].filter(Boolean).join(" ");
  const onFile = coverage ? (coverage.vipExempt ? "not needed · a VIP booking" : `${coverage.filledSlots} of ${coverage.totalSlots} guests on file`) : null;
  const summary = verifiedAt
    ? [`Verified ${fmtStamp(verifiedAt, tz)}`, doc || (path ? PATH_WORD[path] ?? words(path) : null), onFile].filter(Boolean).join(" · ")
    : undefined;
  return (
    <div id={ID.document}>
      <StepCard
        flow="identity"
        title="The guests' documents"
        meta="Each guest's details go in the table below — a document number or an ID photo on every row. The lead's document is verified under the table, with the guest type. Date of birth and gender are what the TRS asks for; an ID photo is uploaded, or taken on a phone, from the guest's row."
        summary={summary}
      >
        <Facts>
          <Fact k="The lead">{lead?.subjectLabel?.trim() || null}</Fact>
          <Fact k="Document">{doc || null}</Fact>
          <Fact k="Date of birth">{lead?.dateOfBirth ? fmtDate(lead.dateOfBirth) : null}</Fact>
          <Fact k="Verified" meta={verifiedAt && path ? PATH_WORD[path] ?? words(path) : undefined}>
            {verifiedAt ? fmtStamp(verifiedAt, tz) : <span className="warn-ink">not yet</span>}
          </Fact>
        </Facts>
        <div id={ID.guests} style={{ marginTop: 10 }}>
          <Tool>
            <IdentityProofBlock entry={entry} checkInGate />
          </Tool>
        </div>
      </StepCard>
    </div>
  );
}

/* ------------------------------------------------------------------ registration card */

function RegistrationCard({
  entry,
  tz,
  confirmed,
  setConfirmed,
}: {
  entry: EntryDetail;
  tz: string;
  confirmed: boolean;
  setConfirmed: (v: boolean) => void;
}) {
  const guest = entry.guestProfile ?? entry.inquiry?.guestProfile ?? null;
  const completedAt = entry.registrationCompletedAt ?? null;
  const party = entry.guestCount ?? (entry.adultCount ?? 0) + (entry.childCount ?? 0);
  const name = guestName(guest);
  // The tick finishes the section (2026-10-29).
  useFinishWhenMet("registration");
  return (
    <div id={ID.registration}>
      <StepCard
        flow="registration"
        flowAfter="identity"
        title="Registration card"
        summary={completedAt ? `Completed ${fmtStamp(completedAt, tz)}` : confirmed ? `Confirmed at the desk for ${name}` : undefined}
      >
        <Facts wide>
          <Fact k="State">
            {completedAt ? (
              <Chip tone="success" icon="check">
                completed · {fmtStamp(completedAt, tz)}
              </Chip>
            ) : confirmed ? (
              <Chip tone="success" icon="check">
                confirmed at the desk
              </Chip>
            ) : (
              <Chip tone="warning">not signed</Chip>
            )}
          </Fact>
          <Fact k="For">{name}</Fact>
          {party > 1 ? <Fact k="The party">{`${plural(party, "guest")} · one card each comes with the tablet`}</Fact> : null}
          <Fact k="Pre-filled from">the record — name, nationality, document, stay, room · the guest checks it, they do not type it</Fact>
        </Facts>
        <Live>
          {completedAt ? null : (
            <label className="sm" style={{ display: "flex", gap: 8, alignItems: "flex-start", marginTop: 10, cursor: "pointer" }}>
              <input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} style={{ marginTop: 3 }} />
              <span>
                The registration is complete — the guest checked the details on record for <b>{name}</b>
              </span>
            </label>
          )}
          <div className="row-acts" style={{ marginTop: 10 }}>
            <Button kind="secondary" compact state="inert">
              Send to the tablet
            </Button>
            <Help label="Not available yet">Not possible yet — there is no tablet for the guest to sign on. Confirm the registration at the desk, above.</Help>
            {party > 1 ? (
              <>
                <Button kind="quiet" compact state="inert">
                  Next person
                </Button>
                <Help label="Not available yet">Not possible yet — this comes with the tablet.</Help>
              </>
            ) : null}
            <Button kind="quiet" compact icon="eye" state="inert">
              Preview the signed card
            </Button>
            <Help label="Not available yet">Not possible yet — a signed card can&rsquo;t be printed yet.</Help>
          </div>
        </Live>
      </StepCard>
    </div>
  );
}

/* ------------------------------------------------------------------ VIP */

function VipCard({ entry, tz }: { entry: EntryDetail; tz: string }) {
  const notes = entry.vipArrivalNotifications ?? [];
  return (
    <StepCard flow="vip" title="VIP arrival" icon="bell">
      {notes.length === 0 ? (
        <span className="sm warn-ink">No VIP notice on record — it goes out when Arrival moves on with the guest present.</span>
      ) : (
        <div style={{ display: "grid", gap: 4 }}>
          {notes.map((n) => (
            <span key={n.id} className="sm">
              <b>{words(n.vipTier)}</b> · Room {n.roomNumber} <span className="meta">· the house told {fmtStamp(n.checkInInitiatedAt, tz)}</span>
            </span>
          ))}
        </div>
      )}
    </StepCard>
  );
}

/* ------------------------------------------------------------------ rooms and keys */

function RoomsCard({
  entry,
  past,
  rooms,
  dayOne,
  dayOneIds,
  laterCount,
  issuedKeyRooms,
  toggleKeyRoom,
  setKeyRooms,
  tz,
}: {
  entry: EntryDetail;
  past: boolean;
  rooms: RoomAssignmentSummary[];
  dayOne: Set<string>;
  dayOneIds: string[];
  laterCount: number;
  issuedKeyRooms: Record<string, boolean>;
  toggleKeyRoom: (roomId: string) => void;
  setKeyRooms: (roomIds: string[], issued: boolean) => void;
  tz: string;
}) {
  const { session } = useSession();
  const refresh = useRefreshEntry(entry.id);
  const [open, setOpen] = useState<Set<string>>(new Set());
  const toggleOpen = (id: string) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const policy = useQuery({
    queryKey: ["lookup", "child-policy"],
    queryFn: () => getChildPolicy(session!),
    enabled: !!session,
    staleTime: 600_000,
  });
  const proofs = useQuery({
    queryKey: ["identity-proofs", entry.id],
    queryFn: () => listIdentityProofs(session!, entry.id),
    enabled: !!session,
  });

  const stay = useMemo(() => roomStayRangesByRoom(entry), [entry]);
  const comps = useMemo(() => new Map((operativeRoomCompositions(entry) ?? []).map((c) => [c.roomId, c])), [entry]);
  // Who sleeps where: re-derived from the counts, the names typed in the guest table replacing
  // "Adult 2" the moment they are saved (the shared seating the guest table uses too).
  const guestsByRoom = useMemo(() => {
    const seat = seatPartyRoomsByComposition(entry, policy.data?.ageBands.youngChildMaxAge ?? 5, policy.data?.ageBands.childMaxAge ?? 10);
    const labels = partySlotLabels(entry);
    const named = new Map<string, string>();
    for (const p of proofs.data?.items ?? []) {
      if (p.entryId === entry.id && !p.hasFile && p.subjectKey && p.subjectLabel?.trim()) named.set(p.subjectKey, p.subjectLabel.trim());
    }
    const m = new Map<string, string[]>();
    for (const [slot, roomIds] of seat) {
      for (const r of roomIds) m.set(r, [...(m.get(r) ?? []), named.get(slot) ?? labels.get(slot) ?? slot]);
    }
    return m;
  }, [entry, policy.data, proofs.data]);

  const ordered = [...rooms].sort((a, b) => {
    const A = stay.get(a.roomId);
    const B = stay.get(b.roomId);
    return (A?.firstNight ?? "9999").localeCompare(B?.firstNight ?? "9999") || (B?.nightCount ?? 0) - (A?.nightCount ?? 0);
  });

  const marked = dayOneIds.filter((id) => issuedKeyRooms[id]).length;
  const allMarked = dayOneIds.length > 0 && marked === dayOneIds.length;
  const onChanged = () => refresh([["room-plan-history", entry.id], ["identity-proofs", entry.id], ["rooms-catalog"]]);
  // Every key of tonight marked finishes the section (2026-10-29).
  useFinishWhenMet("rooms");
  const numbers = ordered.map(roomLabel);
  const summary = numbers.length
    ? `${numbers.length > 1 ? "Rooms" : "Room"} ${numbers.join(", ")} · ${plural(marked, "key")} ready${laterCount > 0 ? ` · ${laterCount} on the move day` : ""}`
    : undefined;

  return (
    <div id={ID.rooms}>
      <StepCard
        flow="rooms"
        title={rooms.length > 1 ? `The rooms and keys · ${rooms.length}` : "The room and its key"}
        summary={summary}
        icon="bed"
        right={rooms.length > 1 ? <Chip tone="quiet">check-in covers all{entry.numberOfRooms ? ` · ${entry.numberOfRooms} asked for` : ""}</Chip> : null}
        meta="Mark each key as it is handed over. Every room the guest sleeps in tonight needs its key; a room the plan moves them into later gets its key on the move day, at Stay."
      >
        {rooms.length === 0 ? (
          <span className="sm warn-ink">No room assigned — rooms are assigned at Arrival.</span>
        ) : (
          <>
            {!past && dayOneIds.length > 1 ? (
              <div className="bind provisional" style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 10, flexWrap: "wrap", padding: "8px 12px", marginBottom: 6 }}>
                <span className="sm">
                  Keys handed over{" "}
                  <Chip tone={allMarked ? "success" : "warning"} icon="key">
                    {marked} of {dayOneIds.length}
                  </Chip>
                  {laterCount > 0 ? <span className="meta"> · {laterCount} on the move day</span> : null}
                </span>
                <Button
                  kind="secondary"
                  compact
                  title={allMarked ? "Untick every room's key" : `Mark all ${dayOneIds.length} of tonight's keys as handed over`}
                  onClick={() => setKeyRooms(dayOneIds, !allMarked)}
                >
                  {allMarked ? "Clear all" : "Mark all keys issued"}
                </Button>
              </div>
            ) : null}
            {ordered.map((a) => (
              <RoomRow
                key={a.roomId}
                entry={entry}
                a={a}
                past={past}
                stay={stay.get(a.roomId) ?? null}
                guests={guestsByRoom.get(a.roomId) ?? []}
                comp={comps.get(a.roomId) ?? null}
                anyComposition={comps.size > 0}
                tonight={dayOne.has(a.roomId)}
                keyMarked={!!issuedKeyRooms[a.roomId]}
                onKey={() => toggleKeyRoom(a.roomId)}
                open={open.has(a.roomId)}
                onToggleOpen={() => toggleOpen(a.roomId)}
                onChanged={onChanged}
                tz={tz}
              />
            ))}
          </>
        )}
      </StepCard>
    </div>
  );
}

function RoomRow({
  entry,
  a,
  past,
  stay,
  guests,
  comp,
  anyComposition,
  tonight,
  keyMarked,
  onKey,
  open,
  onToggleOpen,
  onChanged,
  tz,
}: {
  entry: EntryDetail;
  a: RoomAssignmentSummary;
  past: boolean;
  stay: { nightCount: number; firstNight: string | null; label: string } | null;
  guests: string[];
  comp: RoomCompositionInput | null;
  anyComposition: boolean;
  tonight: boolean;
  keyMarked: boolean;
  onKey: () => void;
  open: boolean;
  onToggleOpen: () => void;
  onChanged: () => void;
  tz: string;
}) {
  const number = roomLabel(a);
  const stamped = (entry.roomAssignments ?? []).filter((r) => r.roomId === a.roomId).find((r) => r.keyIssuedAt) ?? null;
  const standing = [claimWord(a.room?.currentClaimState), physicalWord(a.room?.physicalState)].filter(Boolean).join(" · ");
  return (
    <div style={{ borderTop: "1px solid var(--line)", padding: "10px 0", display: "grid", gap: 6 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12, flexWrap: "wrap" }}>
        <div style={{ display: "grid", gap: 2, minWidth: 0 }}>
          <span className="sm">
            <b>Room {number}</b>
            {stay ? <span className="meta"> · {stay.label} · {plural(stay.nightCount, "night")}</span> : null}
            {standing ? <span className="meta"> · {standing}</span> : null}
          </span>
          {guests.length ? (
            <span className="meta">{guests.join(" · ")}</span>
          ) : anyComposition ? (
            <span className="sm warn-ink">No guests seated in this room — use &ldquo;Seat everyone in a room&rdquo; on the guest table</span>
          ) : null}
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
          <InlineTool>
            <InitialSelectionCell entryId={entry.id} roomId={a.roomId} />
            <ExtraBedEditor entry={entry} roomId={a.roomId} onChanged={onChanged} />
          </InlineTool>
          <Button kind="quiet" compact onClick={onToggleOpen}>
            {open ? "Hide" : "Details"}
          </Button>
          {stamped?.keyIssuedAt ? (
            <Chip tone="success" icon="key">
              key issued · {fmtStamp(stamped.keyIssuedAt, tz)}
            </Chip>
          ) : tonight ? (
            past ? null : (
              <label className="sm" style={{ display: "inline-flex", alignItems: "center", gap: 6, cursor: "pointer", fontWeight: 700 }} title={`Mark when Room ${number}'s key is handed to the guest`}>
                <input type="radio" checked={keyMarked} onClick={onKey} readOnly style={{ cursor: "pointer" }} />
                Key handed over
              </label>
            )
          ) : (
            <Chip tone="quiet" icon="key">
              key on the move day{stay?.firstNight ? ` · ${fmtDay(stay.firstNight)}` : ""}
            </Chip>
          )}
        </div>
      </div>
      {open ? (
        <div className="bind bound" style={{ padding: "8px 12px" }}>
          <Facts>
            <Fact k="Staying">{stay ? `${stay.label} · ${plural(stay.nightCount, "night")}` : null}</Fact>
            <Fact k="Guests">{guests.length ? guests.join(" · ") : null}</Fact>
            {comp ? (
              <>
                <Fact k="Occupants">
                  {[
                    plural(comp.adultCount ?? 0, "adult"),
                    comp.cnb6To10Count ? plural(comp.cnb6To10Count, "child 6–10", "children 6–10") : null,
                    comp.cnbUnder6Count ? plural(comp.cnbUnder6Count, "child under 6", "children under 6") : null,
                    comp.extraBedCount ? plural(comp.extraBedCount, "extra bed") : null,
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </Fact>
                <Fact k="Meals">{mealPlanSummary(comp)}</Fact>
                {comp.negotiatedRoomRate != null || comp.negotiatedExtraBedRate != null ? (
                  <Fact k="Agreed rates">
                    {[
                      comp.negotiatedRoomRate != null ? `room ${money(comp.negotiatedRoomRate)} a night` : null,
                      comp.negotiatedExtraBedRate != null ? `extra bed ${money(comp.negotiatedExtraBedRate)} a night` : null,
                    ]
                      .filter(Boolean)
                      .join(" · ")}
                  </Fact>
                ) : null}
                {comp.isFoc || comp.serviceChargeApplies === false || comp.gstApplies === false ? (
                  <Fact k="Waived">
                    <span className="warn-ink">
                      {[comp.isFoc ? "free of charge" : null, comp.serviceChargeApplies === false ? "service charge" : null, comp.gstApplies === false ? "GST" : null]
                        .filter(Boolean)
                        .join(" · ")}
                    </span>
                  </Fact>
                ) : null}
              </>
            ) : (
              <Fact k="Composition">
                <span className="meta">not recorded at Negotiation</span>
                <Help label="About the composition">Occupants and meals were set on the guest board there.</Help>
              </Fact>
            )}
          </Facts>
        </div>
      ) : null}
    </div>
  );
}
