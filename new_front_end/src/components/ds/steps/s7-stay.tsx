"use client";

/**
 * Step 7 · Stay — "daily charges" (SS03 amendment T1–T4; prototype `stepCanvas[7]`,
 * `V16.stayBase`, `V16.caseActs`).
 *
 * In the stage-template layout since 2026-10-29 (operator: "also stage 7"): the page is the day's
 * work — the bill (with its one Post a charge) and the departments — never folded, because a stay is
 * worked on every day in whatever order the day takes. The rest opens from the step line (same day,
 * operator: "move night audit, disputes, guest details and ID proof, and faults in the room from the
 * main page … categorize them well … shown as a pop-up blurring the left panel, with a clear sign to
 * close it"): Charges › Night audit · Who pays (since 2026-11-10) · Disputes, Guests and rooms › Guest
 * details & ID proof · Faults in the room, each in a pop-up over the work column; what needs doing from
 * them is one line on the page.
 * The keys, Move a room, Extend the stay and Leaving early open in the page, with the way back. Move to
 * Check-out floats in once everything is done.
 */
import { useMemo, useState } from "react";
import { Button } from "@/design-system";
import { useHotelClock } from "@/hooks/use-hotel-clock";
import { useHotelDay } from "@/hooks/use-hotel-day";
import { useSession } from "@/hooks/use-session";
import { roomsInUseFor } from "@/lib/desk/party-rooms";
import { EarlyDepartureFacts } from "@/components/desk/workspace/early-departure";
import { LeavingEarly, RoomsEditPane, RoomsLeavingCard } from "./s7-leaving";
import { IdentityProofBlock } from "@/components/desk/workspace/identity-proof";
import { SplitSettlementBlock } from "@/components/desk/workspace/split-settlement";
import { InterimPaymentBlock } from "@/components/desk/workspace/stay-money";
import { ExtendStay } from "./s7-extend";
import type { EntryDetail } from "@/types/api";
import {
  ChangeBookingMenu,
  atLeast,
  InlineWay,
  OtherWaysTabs,
  ShutWay,
  StageActs,
  StepCanvas,
  SubTabs,
  Tool,
  WorkPopup,
  useOpenAlsoWay,
  useRefreshEntry,
  useStepPane,
  type ChangeBookingItem,
  type StepPane,
} from "./kit";
import { WhoPaysCard, DisputesCard, FaultsCard, HandoffsCard, RaiseDisputeDialog, usePayerWords } from "./s7-desk";
import { FolioCard } from "./s7-folio";
import { NightsCard } from "./s7-nights";
import { FlagDeficientDialog, KeysCard, KeysDueNotice, RoomsInUseCard, keysDue, keysDueWords } from "./s7-rooms";
import { RoomsTableCard } from "./rooms-table";
import { PayLaterNote } from "./s6-balance";
import { ApartmentExtraBedCard } from "./s7-apartment-bed";
import { ApartmentAmenitiesCard } from "./apartment-amenities";
import { effectiveCheckOutIso } from "@/lib/desk/workspace";

/** The sections that open from the step line, each in a pop-up over the work column. */
type StayPopup = "nights" | "payer" | "disputes" | "guests" | "faults" | "aptbed" | "amenities";
const POPUP_TITLE: Record<StayPopup, string> = {
  nights: "Night audit",
  payer: "Who pays",
  disputes: "Disputes",
  guests: "Guest details & ID proof",
  faults: "Faults in the room",
  aptbed: "Extra bed in the apartment",
  amenities: "What the apartment holds",
};

const ID = {
  rooms: "s7-rooms",
  interim: "s7-interim",
  extend: "s7-extend",
  split: "s7-split",
  early: "s7-early",
  guests: "s7-guests",
};

/**
 * Stay's views in the page (2026-10-29), each opened from the step line and closed with the way back
 * to Stay. Every view stays mounted (hidden, not unmounted), so a half-typed extension survives a
 * look at the keys. The night audit is a section of the step itself — the move waits for it.
 */
export const S7_PANES: StepPane[] = [
  { key: "rooms", label: "Moving a room", cards: [] },
  // The same table, opened on Change configuration (2026-10-29).
  { key: "setup", label: "Changing the extra beds or meals", cards: [] },
  // The keys owed on a move day (2026-10-26, operator: room 304's key was never handed over).
  { key: "keys", label: "The keys", cards: [] },
  { key: "interim", label: "A mid-stay payment", cards: [] },
  { key: "extend", label: "Extending the stay", cards: [] },
  { key: "early", label: "Leaving early", cards: [] },
  // A room added on the check-in day, or one booked by mistake removed (2026-11-26) — two sub-tabs.
  { key: "rooms-edit", label: "Adding or removing a room", cards: [] },
];

export function S7Stay({
  entry,
  past,
  setNightAuditOk,
  goToStep,
  pane = null,
}: {
  entry: EntryDetail;
  past: boolean;
  setNightAuditOk: (v: boolean) => void;
  goToStep: (n: number) => void;
  /** Which view is open in the page — null is the step itself. */
  pane?: string | null;
}) {
  const { tz } = useHotelClock(60_000);
  const refresh = useRefreshEntry(entry.id);
  // An open room tab on the folio becomes the default "Room" of the next charge.
  const [chargeTarget, setChargeTarget] = useState("");
  // A dispute and a fault are raised in the middle of the screen, from their own sections.
  const openWay = useOpenAlsoWay();
  const stepPane = useStepPane();
  const [popup, setPopup] = useState<StayPopup | null>(null);
  // The night audit lives in a pop-up but reports to the move from there — kept mounted, and read here too.
  const [nightOk, setNightOk] = useState(true);
  const reportNight = (v: boolean) => {
    setNightOk(v);
    setNightAuditOk(v);
  };

  const folioId = entry.folio?.id ?? null;
  const inHouse = entry.status === "ACTIVE" && entry.currentStage === "S7";
  const onMoney = () => refresh([["interim-payments", entry.id], ["stay-extensions", entry.id]]);

  // A view is hidden, never unmounted — see S7_PANES.
  const at = (k: string | null) => ((pane ?? null) === k ? undefined : true);
  const go = (k: string) => stepPane.open(k);

  return (
    <StepCanvas past={past}>
      <div className="pane" hidden={at(null)}>
        {entry.earlyDeparture ? (
          <Tool inert={false}>
            <EarlyDepartureFacts entry={entry} />
          </Tool>
        ) : null}
        {/* Rooms recorded to leave on a later day — the one due today is released here (2026-11-26). */}
        {past ? null : <RoomsLeavingCard entry={entry} />}
        <KeysDueNotice entry={entry} onOpen={() => go("keys")} />
        <PayLaterNote entry={entry} at="stay" />
        {past ? null : <StayAttention entry={entry} nightOk={nightOk} onOpen={setPopup} />}
        <FolioCard
          entry={entry}
          onTab={setChargeTarget}
          onInterimPayment={() => go("interim")}
          target={chargeTarget}
          setTarget={setChargeTarget}
        />
        <HandoffsCard entry={entry} tz={tz} />
      </div>

      {/* From the step line: each in a pop-up over the work column, the booking file clear. */}
      <WorkPopup open={popup === "nights"} keepMounted title={POPUP_TITLE.nights} onClose={() => setPopup(null)}>
        <NightsCard entry={entry} setNightAuditOk={reportNight} />
      </WorkPopup>
      {/* Who pays moved here from the page (2026-11-10, operator: "move the who pays section to charges"). */}
      <WorkPopup open={popup === "payer"} title={POPUP_TITLE.payer} onClose={() => setPopup(null)}>
        <WhoPaysCard entry={entry} tz={tz} />
      </WorkPopup>
      <WorkPopup open={popup === "disputes"} title={POPUP_TITLE.disputes} onClose={() => setPopup(null)}>
        <DisputesCard
          entry={entry}
          tz={tz}
          onRaise={() => {
            setPopup(null);
            openWay("dispute");
          }}
        />
      </WorkPopup>
      <WorkPopup open={popup === "guests"} title={POPUP_TITLE.guests} onClose={() => setPopup(null)}>
        <div id={ID.guests}>
          <Tool>
            <IdentityProofBlock entry={entry} />
          </Tool>
        </div>
      </WorkPopup>
      {/* An apartment stay's extra bed and its list of items (2026-11-27). */}
      <WorkPopup open={popup === "aptbed"} title={POPUP_TITLE.aptbed} onClose={() => setPopup(null)}>
        <ApartmentExtraBedCard entry={entry} />
      </WorkPopup>
      <WorkPopup open={popup === "amenities"} title={POPUP_TITLE.amenities} onClose={() => setPopup(null)}>
        <ApartmentAmenitiesCard entry={entry} />
      </WorkPopup>
      <WorkPopup open={popup === "faults"} title={POPUP_TITLE.faults} onClose={() => setPopup(null)}>
        <FaultsCard
          entry={entry}
          tz={tz}
          onFlag={() => {
            setPopup(null);
            openWay("fault");
          }}
        />
      </WorkPopup>

      <div className="pane" hidden={at("rooms") && at("setup")}>
        {/* The rooms as the negotiation table (2026-10-06) — a room is changed by double-clicking it. */}
        <RoomsTableCard
          entry={entry}
          title="The rooms"
          lead="While the guest is staying the prices can't be changed here. A change takes effect from tonight; the nights already slept stay as they were charged."
          editNow={pane === "setup"}
        />
        <RoomsInUseCard entry={entry} id={ID.rooms} />
      </div>

      <div className="pane" hidden={at("keys")}>
        <KeysCard entry={entry} emptyNote />
      </div>

      <div className="pane" hidden={at("interim")}>
        {/* Two ways to take money mid-stay, as sub-tabs (2026-10-29, operator: "make these into sub tabs"):
            ask for part of the bill with an interim bill, or take money now against a room, a hall or the rest. */}
        <SubTabs
          label="Taking a payment"
          param="pay"
          tabs={[
            {
              key: "interim",
              label: "Interim payment",
              content: (
                <div id={ID.interim}>
                  <Tool>
                    <InterimPaymentBlock entry={entry} onChanged={onMoney} unfolded />
                  </Tool>
                </div>
              ),
            },
            folioId
              ? {
                  key: "parts",
                  label: "Who's paying for what",
                  content: (
                    <div id={ID.split}>
                      <Tool>
                        <SplitSettlementBlock entry={entry} folioId={folioId} unfolded />
                      </Tool>
                    </div>
                  ),
                }
              : null,
          ]}
        />
      </div>

      <div className="pane" hidden={at("extend")}>
        <div id={ID.extend}>
          <ExtendStay entry={entry} onChanged={onMoney} />
        </div>
      </div>

      <div className="pane" hidden={at("early")}>
        {entry.earlyDeparture ? (
          <Tool inert={false}>
            <EarlyDepartureFacts entry={entry} />
          </Tool>
        ) : null}
        <div id={ID.early}>
          <LeavingEarly
            entry={entry}
            goToStep={goToStep}
            onNightAudit={() => {
              stepPane.close();
              setPopup("nights");
            }}
          />
          <RoomsLeavingCard entry={entry} all />
        </div>
      </div>

      <div className="pane" hidden={at("rooms-edit")}>
        <RoomsEditPane
          entry={entry}
          goToStep={goToStep}
          onNightAudit={() => {
            stepPane.close();
            setPopup("nights");
          }}
        />
      </div>

      {past ? null : <StayActs entry={entry} inHouse={inHouse} onOpen={go} onPopup={setPopup} />}

      {/* A dispute and a fault are raised in the middle of the screen, opened from their sections. */}
      <OtherWaysTabs
        tabs={
          inHouse
            ? [
                {
                  key: "dispute",
                  label: "Raise a dispute",
                  inBar: false,
                  content: folioId ? (
                    <InlineWay render={(done) => <RaiseDisputeDialog entry={entry} open onClose={done} />} />
                  ) : (
                    <ShutWay act="Raise" why="There is no folio to dispute." />
                  ),
                },
                {
                  key: "fault",
                  label: "Report a fault",
                  inBar: false,
                  content: <InlineWay render={(done) => <FlagDeficientDialog entry={entry} open onClose={done} />} />,
                },
              ]
            : []
        }
      />
    </StepCanvas>
  );
}

/**
 * What needs doing from the sections that open from the step line — one line each, with the way to
 * it (2026-10-29). Nothing when nothing does: an open dispute, a fault still open in a room, and the
 * last night not posted once the guest's check-out day has come.
 */
function StayAttention({ entry, nightOk, onOpen }: { entry: EntryDetail; nightOk: boolean; onOpen: (p: StayPopup) => void }) {
  const hotelToday = useHotelDay()?.today ?? null;
  const openDisputes = (entry.disputes ?? []).filter((d) => d.status === "OPEN" || d.status === "IN_PROGRESS").length;
  const openFaults = useMemo(() => {
    const ids = new Set<string>();
    for (const a of entry.roomAssignments ?? [])
      for (const d of a.room?.deficientConditionRecords ?? []) if (d.status !== "RESOLVED" && d.status !== "UNRESOLVED" && d.status !== "DEFICIENT_UNRESOLVED_AT_CHECKOUT") ids.add(d.id);
    return ids.size;
  }, [entry.roomAssignments]);
  const checkOut = effectiveCheckOutIso(entry)?.slice(0, 10) ?? null;
  const leaving = !!hotelToday && !!checkOut && hotelToday >= checkOut;
  const rows: Array<{ key: StayPopup; text: string; act: string; stop?: boolean }> = [];
  if (leaving && !nightOk) rows.push({ key: "nights", text: "The last night is not posted yet — check-out waits for it", act: "Night audit", stop: true });
  if (openDisputes) rows.push({ key: "disputes", text: `${openDisputes} open dispute${openDisputes === 1 ? "" : "s"} — check-out waits until ${openDisputes === 1 ? "it is" : "they are"} closed`, act: "Disputes", stop: true });
  if (openFaults) rows.push({ key: "faults", text: `${openFaults} fault${openFaults === 1 ? "" : "s"} in the room still to settle`, act: "Faults in the room" });
  if (!rows.length) return null;
  return (
    <div className="stay-attention">
      {rows.map((r) => (
        <div key={r.key} className={`att${r.stop ? " stop" : ""}`} role={r.stop ? "alert" : "status"}>
          <b>{r.text}</b>
          <Button kind="secondary" onClick={() => onOpen(r.key)}>
            {r.act}
          </Button>
        </div>
      ))}
    </div>
  );
}

/**
 * The step line's right end at Stay (2026-10-29): the keys — with the number owed today in red —
 * then the sections that open in a pop-up, by what they are about (Charges · Guests and rooms), and
 * Change booking (Move a room · Extend the stay · Leaving early). The mid-stay payment left the line
 * the same day — the bill's Interim payment is the same act (operator).
 */
function StayActs({
  entry,
  inHouse,
  onOpen,
  onPopup,
}: {
  entry: EntryDetail;
  inHouse: boolean;
  onOpen: (k: string) => void;
  onPopup: (p: StayPopup) => void;
}) {
  const hotelToday = useHotelDay()?.today ?? null;
  const due = keysDue(entry, hotelToday);
  const owed = due.collect.length + due.handOver.length;
  const owedWords = keysDueWords(due);
  const notNow = "Not possible on this booking now";
  const openDisputes = (entry.disputes ?? []).filter((d) => d.status === "OPEN" || d.status === "IN_PROGRESS").length;
  const payer = usePayerWords(entry);
  const { session } = useSession();
  const gm = atLeast(session?.actorLevel, "L3");
  const severalRooms = roomsInUseFor(entry, hotelToday).length > 1;
  const apartment = String(entry.useType ?? "") === "APARTMENT";
  const charges: ChangeBookingItem[] = [
    {
      key: "nights",
      label: "Night audit",
      note: "Each night of the stay and its room charge. Tonight is posted when the guest checks in; the hotel's run posts the rest each morning.",
      onSelect: () => onPopup("nights"),
    },
    {
      key: "payer",
      label: "Who pays",
      note: entry.folio ? `${payer}. The FOM can change it while the guest is staying.` : "Who each kind of charge goes to.",
      onSelect: () => onPopup("payer"),
    },
    {
      key: "disputes",
      label: "Disputes",
      due: openDisputes ? `${openDisputes} open` : undefined,
      note: openDisputes
        ? `Check-out waits until ${openDisputes === 1 ? "it is" : "they are"} closed — open it to review or close it.`
        : "A charge the guest questions — raised, reviewed, closed. Check-out waits while one is open.",
      onSelect: () => onPopup("disputes"),
    },
  ];
  const guestsAndRooms: ChangeBookingItem[] = [
    {
      key: "keys",
      label: "Keys",
      due: owed ? `${owed} owed today` : undefined,
      note: owedWords.length ? owedWords.join(" · ") : "Each room's key — handed over, back, or lost.",
      onSelect: () => onOpen("keys"),
    },
    {
      key: "guests",
      label: "Guest details & ID proof",
      note: "Each guest's document and photo — a guest added to the room is recorded here.",
      onSelect: () => onPopup("guests"),
    },
    {
      key: "faults",
      label: "Faults in the room",
      note: "Something broken in a room — reported, put right, or carried to check-out.",
      onSelect: () => onPopup("faults"),
    },
    // An apartment stay (2026-11-27): its own extra bed, charged night by night, and its list of items.
    ...(apartment
      ? [
          {
            key: "aptbed",
            label: "Extra bed in the apartment",
            note: "For some nights, at the apartments' own extra bed rate — charged night by night with the rent's bill.",
            onSelect: inHouse ? () => onPopup("aptbed") : undefined,
            reason: inHouse ? undefined : notNow,
          },
          {
            key: "amenities",
            label: "What the apartment holds",
            note: "Pots, plates and the rest, with how many of each — not priced.",
            onSelect: () => onPopup("amenities"),
          },
        ]
      : []),
  ];
  const items: ChangeBookingItem[] = [
    {
      key: "rooms",
      label: "Move a room",
      note: "Into another free room, from tonight. The nights already slept stay as they were charged.",
      onSelect: inHouse ? () => onOpen("rooms") : undefined,
      reason: inHouse ? undefined : notNow,
    },
    {
      key: "setup",
      label: "Change extra beds or meals",
      note: "Who sleeps where, the meal plans and the extra beds — from tonight. The nights already slept stay as they were charged.",
      onSelect: inHouse && !apartment ? () => onOpen("setup") : undefined,
      reason: apartment ? "An apartment has no meal plans — its extra bed is under Guests and rooms › Extra bed in the apartment" : inHouse ? undefined : notNow,
    },
    {
      key: "extend",
      label: "Extend the stay",
      note: "More nights. The house is asked, the bill for them is sent and paid, then the stay is extended.",
      onSelect: inHouse ? () => onOpen("extend") : undefined,
      reason: inHouse ? undefined : notNow,
    },
    {
      key: "rooms-edit",
      label: "Add or remove a room",
      note: "Add a room on the check-in day, for the whole stay, with its new guests — or take off a room the hotel booked by mistake, with no fee. Who may is set in the admin console; anyone else asks them.",
      onSelect: inHouse ? () => onOpen("rooms-edit") : undefined,
      reason: inHouse ? undefined : notNow,
    },
    {
      key: "early",
      label: "Leaving early",
      note: "The guest leaves before the check-out — the whole booking or some rooms, today or on a later day. The nights not slept are not charged; the hotel's early-departure fee applies.",
      onSelect: inHouse ? () => onOpen("early") : undefined,
      reason: inHouse ? undefined : notNow,
      danger: true,
    },
  ];
  return (
    <StageActs>
      <ChangeBookingMenu
        label="Charges"
        items={charges}
        badge={openDisputes}
        badgeTitle={openDisputes ? `${openDisputes} open dispute${openDisputes === 1 ? "" : "s"} — check-out waits until answered` : undefined}
      />
      <ChangeBookingMenu
        label="Guests and rooms"
        items={guestsAndRooms}
        badge={owed}
        badgeTitle={owed ? `${owed} key${owed === 1 ? "" : "s"} owed today — ${owedWords.join(" · ")}` : undefined}
      />
      <ChangeBookingMenu items={items} />
    </StageActs>
  );
}
