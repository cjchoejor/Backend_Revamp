"use client";

/**
 * Step 6 · Check-in — "keys & live folio" (SS03 amendment C1–C3; prototype `stepCanvas[6]`,
 * `V16.checkinFacts`).
 *
 * The code's facts read the Reserve way, one line each with "on record" or the one control that
 * puts it there. Two of them happen at the counter — the document and the keys. Below them: the
 * document (the lead's row of the guest table, which is where it is typed and verified), the
 * registration card, the advance still owed, the rooms with their keys, and the check-in itself.
 * Every figure is the backend's; the readiness lines are read from `s6Readiness`, never re-decided.
 */
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Button, Chip } from "@/design-system";
import { useSession } from "@/hooks/use-session";
import { useHotelClock } from "@/hooks/use-hotel-clock";
import { usePaymentStatus } from "@/hooks/use-payment-status";
import { getChildPolicy } from "@/lib/api/child-policy";
import { getEntryTrace } from "@/lib/api/entries";
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
import { s6Readiness } from "@/lib/desk/workspace";
import { fmtDate, fmtDay, fmtStamp, money, plural } from "@/lib/ds/format";
import { AdvanceSettlementBlock } from "@/components/desk/workspace/advance-settlement";
import { IdentityProofBlock } from "@/components/desk/workspace/identity-proof";
import { BedTypeEditor, ExtraBedEditor, InitialSelectionCell, RoomChangeControl } from "@/components/desk/workspace/room-change-control";
import type { EntryDetail, RoomAssignmentSummary } from "@/types/api";
import {
  Fact,
  FactLine,
  Facts,
  Live,
  OtherWays,
  PapersCard,
  RequestsCard,
  SeeRow,
  StepCanvas,
  StepCard,
  Tool,
  useRefreshEntry,
  words,
  type FactState,
} from "./kit";
import { InlineTool, claimWord, distinctRoomRows, physicalWord, physicallyReady, revealBlock, roomLabel } from "./s6-shared";

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

type CheckInMove = { onClick: () => void; ready: boolean; reason?: string } | null;

/* ------------------------------------------------------------------ the step */

/** This stay's identity verification, from the identity-proofs feed (2026-09-18). */
type StayVerification = { verifiedAt: string; verifiedBy: string | null; path: string | null } | null;

export function S6CheckIn({
  entry,
  past,
  issuedKeyRooms,
  toggleKeyRoom,
  setKeyRooms,
  registrationConfirmed,
  setRegistrationConfirmed,
  checkIn,
}: {
  entry: EntryDetail;
  past: boolean;
  issuedKeyRooms: Record<string, boolean>;
  toggleKeyRoom: (roomId: string) => void;
  setKeyRooms: (roomIds: string[], issued: boolean) => void;
  registrationConfirmed: boolean;
  setRegistrationConfirmed: (v: boolean) => void;
  checkIn: CheckInMove;
}) {
  const { session } = useSession();
  const { tz } = useHotelClock(60_000);

  const proofs = useQuery({
    queryKey: ["identity-proofs", entry.id],
    queryFn: () => listIdentityProofs(session!, entry.id),
    enabled: !!session,
  });
  const coverage = proofs.data?.coverage ?? null;
  // Verified at THIS stay — never the profile's stamp, which a returning guest carries over (2026-09-18).
  const verification = proofs.data?.verification ?? null;
  const readiness = useMemo(
    () => s6Readiness(entry, { guestDetails: coverage, identityVerified: !!verification }),
    [entry, coverage, verification],
  );
  const met = (re: RegExp) => readiness.find((r) => re.test(r.label))?.met ?? false;

  const guest = entry.guestProfile ?? entry.inquiry?.guestProfile ?? null;
  const isVip = !!guest?.vipTier?.trim();
  const folioLive = !!entry.folio?.convertedToLiveAt || entry.folio?.state === "LIVE";

  // The lead's row of the guest table — where the document is typed, and what verification records.
  const lead = useMemo(
    () => (proofs.data?.items ?? []).find((p) => p.entryId === entry.id && !p.hasFile && p.subjectKey === "A0") ?? null,
    [proofs.data, entry.id],
  );
  const docName = (code?: string | null) =>
    !code || NO_TYPE.has(code) ? null : ((proofs.data?.documentTypes ?? []).find((t) => t.code === code)?.name ?? words(code));

  const rooms = useMemo(() => distinctRoomRows(entry), [entry]);
  const dayOne = useMemo(() => arrivalNightRoomIds(entry), [entry]);
  const dayOneIds = rooms.filter((a) => dayOne.has(a.roomId)).map((a) => a.roomId);
  const laterCount = rooms.length - dayOneIds.length;

  const facts = useCheckInFacts({
    entry,
    past,
    tz,
    met,
    verification,
    lead,
    docName,
    coverage,
    rooms,
    dayOneIds,
    laterCount,
    issuedKeyRooms,
    setKeyRooms,
    registrationConfirmed,
    setRegistrationConfirmed,
    folioLive,
    isVip,
  });

  return (
    <StepCanvas past={past}>
      <StepCard
        title={past || folioLive ? "Checked in · what was on record" : "Before you check in · read these, then press Check in"}
        meta="The code needs every one of these before the folio goes live. Two of them happen at the counter: the document, and the keys."
      >
        {facts.map((f) => (
          <FactLine key={f.label} label={f.label} value={f.value} who={f.who} state={f.state} action={f.action} />
        ))}
      </StepCard>

      <DocumentCard entry={entry} past={past} lead={lead} verification={verification} docName={docName} tz={tz} />
      <div id={ID.guests}>
        <Tool>
          <IdentityProofBlock entry={entry} checkInGate />
        </Tool>
      </div>

      <RegistrationCard
        entry={entry}
        tz={tz}
        confirmed={registrationConfirmed}
        setConfirmed={setRegistrationConfirmed}
      />

      <div id={ID.advance}>
        <Tool>
          <AdvanceSettlementBlock
            entry={entry}
            title="Collect the remaining advance"
            intro="If the guest planned to settle the advance at the desk, take it now — checking in with money still short needs the FOM's credit extension instead."
          />
        </Tool>
      </div>

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

      <Live>
        {checkIn ? (
          <div style={{ display: "grid", gap: 6, justifyItems: "end" }}>
            <div className="row-acts" style={{ justifyContent: "flex-end", alignItems: "center" }}>
              {!checkIn.ready && checkIn.reason ? (
                <span className="control-note" style={{ margin: 0 }}>
                  {checkIn.reason}
                </span>
              ) : null}
              <Button icon="lock" state={checkIn.ready ? "default" : "inert"} title={checkIn.ready ? undefined : checkIn.reason} onClick={checkIn.onClick}>
                Check in · keys and the live folio
              </Button>
            </div>
            <span className="meta" style={{ textAlign: "right" }}>
              One act: the folio goes live, the rooms become occupied, the keys are handed over, and housekeeping and the kitchen are told.
            </span>
          </div>
        ) : null}
      </Live>

      <RequestsCard />
      <OtherWays>
        {entry.status === "ACTIVE"
          ? [
              <SeeRow
                key="cancel"
                label="Cancel…"
                state="inert"
                reason="Cancelling is recorded at Set up or Arrival; once the guest is at the desk it is not a cancellation"
                note="not at check-in — cancelling is recorded at Set up or at Arrival; a guest who leaves after checking in is an early departure at Stay"
              />,
              <SeeRow
                key="amend"
                label="Amend dates…"
                state="inert"
                reason="There is no date change from Check-in in the backend"
                note="not from Check-in — the dates move at Stay, through Extend stay or an early departure"
              />,
            ]
          : null}
      </OtherWays>
      <PapersCard entry={entry} />
    </StepCanvas>
  );
}

/* ------------------------------------------------------------------ the facts */

type FactRow = { label: string; value: React.ReactNode; who?: React.ReactNode; state: FactState; action?: React.ReactNode };

function useCheckInFacts({
  entry,
  past,
  tz,
  met,
  verification,
  lead,
  docName,
  coverage,
  rooms,
  dayOneIds,
  laterCount,
  issuedKeyRooms,
  setKeyRooms,
  registrationConfirmed,
  setRegistrationConfirmed,
  folioLive,
  isVip,
}: {
  entry: EntryDetail;
  past: boolean;
  tz: string;
  met: (re: RegExp) => boolean;
  verification: StayVerification;
  lead: IdentityProofSummary | null;
  docName: (code?: string | null) => string | null;
  coverage: { vipExempt: boolean; totalSlots: number; filledSlots: number; missing: { key: string; label: string }[]; satisfied: boolean } | null;
  rooms: RoomAssignmentSummary[];
  dayOneIds: string[];
  laterCount: number;
  issuedKeyRooms: Record<string, boolean>;
  setKeyRooms: (roomIds: string[], issued: boolean) => void;
  registrationConfirmed: boolean;
  setRegistrationConfirmed: (v: boolean) => void;
  folioLive: boolean;
  isVip: boolean;
}): FactRow[] {
  const { session } = useSession();
  const trace = useQuery({
    queryKey: ["entry-trace", entry.id, entry.updatedAt ?? ""],
    queryFn: () => getEntryTrace(session!, entry.id, 100),
    enabled: !!session,
  });
  const pay = usePaymentStatus(entry.id, { enabled: !!entry.folio });
  const working = !past && !folioLive;
  const guest = entry.guestProfile ?? entry.inquiry?.guestProfile ?? null;

  const out: FactRow[] = [];

  // Guest present — attested when Arrival moved on.
  const arrived = (trace.data?.items ?? [])
    .filter((e) => e.eventType === "ENTRY.STAGE_TRANSITION" && (e.payload as { toStage?: string } | null)?.toStage === "S6")
    .sort((a, b) => b.timestamp.localeCompare(a.timestamp))[0];
  out.push({
    label: "Guest present",
    value: arrived
      ? `the guest at the desk · ${fmtStamp(arrived.timestamp, tz)}`
      : entry.walkInCompressed
        ? "a walk-in, at the desk"
        : "at the desk — recorded when Arrival moved on",
    who: arrived?.actorName,
    state: "on",
  });

  // Rooms assigned.
  const numbers = rooms.map(roomLabel).sort((a, b) => a.localeCompare(b, "en", { numeric: true }));
  out.push({
    label: "Rooms assigned",
    value: numbers.length ? numbers.join(", ") : "none — rooms are assigned at Arrival",
    state: numbers.length ? "on" : "missing",
  });

  // The lead's identity — as verified at THIS stay.
  const verifiedAt = verification?.verifiedAt ?? null;
  const path = verification?.path ?? null;
  const doc = [docName(lead?.documentType), lead?.documentNumber].filter(Boolean).join(" ");
  const idOk = met(/^Identity verified/);
  out.push({
    label: "Identity verified · the lead",
    value: idOk ? `${doc || (path ? PATH_WORD[path] ?? words(path) : "verified")}${verifiedAt ? ` · ${fmtStamp(verifiedAt, tz)}` : ""}` : "the document, seen at the desk",
    who: idOk && doc && path ? PATH_WORD[path] ?? words(path) : undefined,
    state: idOk ? "on" : "missing",
    action: idOk || !working ? undefined : (
      <Button kind="secondary" compact onClick={() => revealBlock(ID.document, false)}>
        Fix
      </Button>
    ),
  });

  // The party's documents.
  if (!coverage) {
    out.push({ label: "The party's documents", value: "reading the guest table…", state: "waiting" });
  } else if (coverage.vipExempt) {
    out.push({ label: "The party's documents", value: "not needed · a VIP booking", state: "on" });
  } else if (coverage.satisfied) {
    out.push({ label: "The party's documents", value: `${coverage.filledSlots} of ${coverage.totalSlots} on file`, state: "on" });
  } else {
    out.push({
      label: "The party's documents",
      value: `${coverage.filledSlots} of ${coverage.totalSlots} on file — a number or an ID photo on each row`,
      who: coverage.missing.length ? `still to come: ${coverage.missing.map((m) => m.label).join(", ")}` : undefined,
      state: "missing",
      action: working ? (
        <span className="row-acts">
          <Button kind="secondary" compact onClick={() => revealBlock(ID.guests, false)}>
            Fill the rows
          </Button>
          <Button kind="quiet" compact state="inert" reason="not in the backend — check-in asks for every guest now">
            By the first night
          </Button>
        </span>
      ) : undefined,
    });
  }

  // Registration.
  const completedAt = entry.registrationCompletedAt ?? null;
  if (completedAt) {
    out.push({ label: "Registration", value: `completed with the check-in · ${fmtStamp(completedAt, tz)}`, state: "on" });
  } else if (registrationConfirmed) {
    out.push({
      label: "Registration",
      value: "confirmed at the desk — recorded with the check-in",
      state: "word",
      action: working ? (
        <span className="row-acts">
          <Chip tone="success" icon="check">
            confirmed
          </Chip>
          <Button kind="quiet" compact onClick={() => setRegistrationConfirmed(false)}>
            Undo
          </Button>
        </span>
      ) : undefined,
    });
  } else {
    out.push({
      label: "Registration",
      value: "not confirmed — the guest checks the details on record",
      state: "missing",
      action: working ? (
        <span className="row-acts">
          <Button kind="secondary" compact onClick={() => setRegistrationConfirmed(true)}>
            Confirm at the desk
          </Button>
          <Button kind="quiet" compact state="inert" reason="the tablet card is not in the backend yet (BE-45)">
            Send to the tablet
          </Button>
        </span>
      ) : undefined,
    });
  }

  // Advance reconciled.
  const advOk = met(/^Advance reconciled/);
  const ps = pay.data;
  const cur = entry.folio?.lines?.[0]?.currency ?? "BTN";
  out.push({
    label: "Advance reconciled",
    value: ps
      ? ps.requiredAmount > 0
        ? `${money(ps.totalReceived, cur)} received of ${money(ps.requiredAmount, cur)}${advOk ? " · reconciled" : ""}`
        : `no advance asked${advOk ? " · reconciled" : ""}`
      : advOk
        ? "reconciled"
        : "not reconciled yet",
    who: "system",
    state: advOk ? "system" : "missing",
    action: advOk || !working ? undefined : (
      <Button kind="secondary" compact onClick={() => revealBlock(ID.advance, false)}>
        Take the rest
      </Button>
    ),
  });

  // Housekeeping — the arrival prep and the rooms' own state.
  const roomsOk = met(/assigned & ready$/);
  const prepOk = met(/^Handoff fulfilled/);
  const notReady = rooms.filter((a) => !physicallyReady(a));
  out.push({
    label: "Housekeeping",
    value: [
      prepOk ? "arrival prep done" : "arrival prep still open — finish it at Arrival",
      notReady.length === 0
        ? rooms.length
          ? "rooms ready"
          : "no rooms yet"
        : notReady.map((a) => `Room ${roomLabel(a)} ${physicalWord(a.room?.physicalState) ?? "not ready"}`).join(" · "),
    ].join(" · "),
    who: "housekeeping",
    state: roomsOk && prepOk ? "on" : "missing",
  });

  // Keys.
  const stamped = rooms
    .map((a) => (entry.roomAssignments ?? []).filter((r) => r.roomId === a.roomId).find((r) => r.keyIssuedAt))
    .filter((r): r is RoomAssignmentSummary => !!r);
  const later = laterCount > 0 ? ` · ${laterCount} on the move day` : "";
  if (folioLive || past) {
    out.push({
      label: "Keys",
      value: stamped.length
        ? `${plural(stamped.length, "key")} issued · ${fmtStamp(stamped[0].keyIssuedAt, tz)}${later}`
        : entry.keysIssuedCount
          ? `${plural(entry.keysIssuedCount, "key")} issued at check-in`
          : "issued at check-in",
      state: "on",
    });
  } else {
    const marked = dayOneIds.filter((id) => issuedKeyRooms[id]).length;
    const ready = dayOneIds.length > 0 && marked === dayOneIds.length;
    out.push({
      label: "Keys",
      value:
        dayOneIds.length === 0
          ? "no room for tonight yet"
          : ready
            ? `${dayOneIds.length} ready · issued on the click${later}`
            : `${dayOneIds.length - marked} to make up${marked ? ` · ${marked} ready` : ""}${later}`,
      state: ready ? "word" : "missing",
      action:
        dayOneIds.length === 0 ? undefined : ready ? (
          <span className="row-acts">
            <Chip tone="success" icon="key">
              ready
            </Chip>
            <Button kind="quiet" compact onClick={() => setKeyRooms(dayOneIds, false)}>
              Clear
            </Button>
          </span>
        ) : (
          <Button kind="secondary" compact icon="key" onClick={() => setKeyRooms(dayOneIds, true)}>
            Keys ready
          </Button>
        ),
    });
  }

  // Folio.
  out.push({
    label: "Folio",
    value: folioLive
      ? `live${entry.folio?.convertedToLiveAt ? ` since ${fmtStamp(entry.folio.convertedToLiveAt, tz)}` : ""}`
      : "provisional · goes live on the click",
    who: "system",
    state: "system",
  });

  // VIP arrival notice — only for a VIP booking.
  if (isVip) {
    const vipOk = met(/^VIP arrival notified/);
    const n = (entry.vipArrivalNotifications ?? [])[0];
    out.push({
      label: "VIP arrival",
      value: vipOk && n ? `the house is told · ${fmtStamp(n.checkInInitiatedAt, tz)}` : "not told yet — it goes out when Arrival moves on with the guest present",
      who: "system",
      state: vipOk ? "system" : "missing",
    });
  }

  return out;
}

/* ------------------------------------------------------------------ the document */

function DocumentCard({
  entry,
  past,
  lead,
  verification,
  docName,
  tz,
}: {
  entry: EntryDetail;
  past: boolean;
  lead: IdentityProofSummary | null;
  verification: StayVerification;
  docName: (code?: string | null) => string | null;
  tz: string;
}) {
  const verifiedAt = verification?.verifiedAt ?? null;
  const path = verification?.path ?? null;
  return (
    <div id={ID.document}>
      <StepCard
        title="The document, at the desk"
        acts={
          past ? null : (
            <>
              <Button kind={verifiedAt ? "secondary" : "primary"} compact onClick={() => revealBlock(ID.guests, false)}>
                {verifiedAt ? "Open the guest table" : "Verify identity"}
              </Button>
              <Button kind="quiet" compact onClick={() => revealBlock(ID.guests, false)}>
                ID photo…
              </Button>
            </>
          )
        }
      >
        <Facts>
          <Fact k="The lead">{lead?.subjectLabel?.trim() || null}</Fact>
          <Fact k="Document type">{docName(lead?.documentType)}</Fact>
          <Fact k="Document number">{lead?.documentNumber}</Fact>
          <Fact k="Date of birth">{lead?.dateOfBirth ? fmtDate(lead.dateOfBirth) : null}</Fact>
          <Fact k="Gender">{lead?.gender ? words(lead.gender) : null}</Fact>
          <Fact k="Verified" meta={verifiedAt && path ? PATH_WORD[path] ?? words(path) : undefined}>
            {verifiedAt ? fmtStamp(verifiedAt, tz) : <span className="warn-ink">not yet</span>}
          </Fact>
        </Facts>
        <div className="meta" style={{ marginTop: 8 }}>
          Typed once, in the lead&rsquo;s row of the guest table below — choose the guest type there and record the verification under the table; it records that row&rsquo;s document. Date of birth and gender are what the TRS asks for. An ID photo is uploaded, or taken on a phone, from the same row.
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
  return (
    <div id={ID.registration}>
      <StepCard title="Registration card">
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
            <Button kind="secondary" compact state="inert" reason="The registration card on a tablet is not in the backend yet (BE-45) — confirm it at the desk above">
              Send to the tablet
            </Button>
            {party > 1 ? (
              <Button kind="quiet" compact state="inert" reason="One card per guest comes with the tablet card (BE-45)">
                Next person
              </Button>
            ) : null}
            <Button kind="quiet" compact icon="eye" state="inert" reason="The signed card as a paper is not in the backend yet (BE-45)">
              Preview the signed card
            </Button>
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
    <StepCard title="VIP arrival" icon="bell">
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

  return (
    <div id={ID.rooms}>
      <StepCard
        title={rooms.length > 1 ? `Rooms · ${rooms.length}` : "Room"}
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
            <BedTypeEditor roomId={a.roomId} entryId={entry.id} />
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
      <Live>
        <Tool>
          <RoomChangeControl entry={entry} fromRoomId={a.roomId} fromRoomNumber={number} onChanged={onChanged} compact />
        </Tool>
      </Live>
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
                <span className="meta">not recorded at Negotiation — occupants and meals were set on the guest board there</span>
              </Fact>
            )}
          </Facts>
        </div>
      ) : null}
    </div>
  );
}
