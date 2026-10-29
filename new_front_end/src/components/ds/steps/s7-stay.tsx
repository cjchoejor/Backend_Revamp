"use client";

/**
 * Step 7 · Stay — "daily charges" (SS03 amendment T1–T4; prototype `stepCanvas[7]`,
 * `V16.stayBase`, `V16.caseActs`).
 *
 * In the stage-template layout since 2026-10-29 (operator: "also stage 7"): the step's sections are
 * the day's work — the bill, the nights, the departments, faults and disputes — numbered, and never
 * folded, because a stay is worked on every day in whatever order the day takes. The other things a
 * stay can need open in the page, with the way back: the keys and a mid-stay payment from the step
 * line, and Move a room, Extend the stay and Leaving early from Change booking. Move to Check-out
 * floats in once everything is done.
 */
import { useState } from "react";
import { Button } from "@/design-system";
import { useHotelClock } from "@/hooks/use-hotel-clock";
import { useHotelDay } from "@/hooks/use-hotel-day";
import { EarlyDepartureBlock, EarlyDepartureFacts } from "@/components/desk/workspace/early-departure";
import { IdentityProofBlock } from "@/components/desk/workspace/identity-proof";
import { SplitSettlementBlock } from "@/components/desk/workspace/split-settlement";
import { InterimPaymentBlock, StayExtensionBlock } from "@/components/desk/workspace/stay-money";
import type { EntryDetail } from "@/types/api";
import {
  ChangeBookingMenu,
  InlineWay,
  OtherWaysTabs,
  ShutWay,
  StageActs,
  StepCanvas,
  Tool,
  useOpenAlsoWay,
  useRefreshEntry,
  useStepPane,
  type ChangeBookingItem,
  type StepPane,
} from "./kit";
import { WhoPaysCard, DisputesCard, FaultsCard, HandoffsCard, RaiseDisputeDialog, TermsChangeCard } from "./s7-desk";
import { ChitsWaitingCard, FolioCard, PostChargeCard } from "./s7-folio";
import { NightsCard } from "./s7-nights";
import { FlagDeficientDialog, KeysCard, KeysDueNotice, RoomsInUseCard, keysDue, keysDueWords } from "./s7-rooms";
import { RoomsTableCard } from "./rooms-table";
import { PayLaterNote } from "./s6-balance";

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
        <KeysDueNotice entry={entry} onOpen={() => go("keys")} />
        <PayLaterNote entry={entry} at="stay" />
        <FolioCard entry={entry} onTab={setChargeTarget} onInterimPayment={() => go("interim")} />
        <PostChargeCard entry={entry} target={chargeTarget} setTarget={setChargeTarget} />
        <ChitsWaitingCard />
        <NightsCard entry={entry} setNightAuditOk={setNightAuditOk} onMoveRoom={() => go("rooms")} />
        <HandoffsCard entry={entry} tz={tz} />
        <FaultsCard entry={entry} tz={tz} onFlag={() => openWay("fault")} />
        <DisputesCard entry={entry} tz={tz} onRaise={() => openWay("dispute")} />
        <TermsChangeCard entry={entry} />
        <WhoPaysCard entry={entry} tz={tz} />
        <div id={ID.guests}>
          <Tool>
            <IdentityProofBlock entry={entry} collapsible />
          </Tool>
        </div>
      </div>

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
        <div id={ID.interim}>
          <Tool>
            <InterimPaymentBlock entry={entry} onChanged={onMoney} />
          </Tool>
        </div>
        {folioId ? (
          <div id={ID.split}>
            <Tool>
              <SplitSettlementBlock entry={entry} folioId={folioId} />
            </Tool>
          </div>
        ) : null}
      </div>

      <div className="pane" hidden={at("extend")}>
        <div id={ID.extend}>
          <Tool>
            <StayExtensionBlock entry={entry} onChanged={onMoney} />
          </Tool>
        </div>
      </div>

      <div className="pane" hidden={at("early")}>
        {entry.earlyDeparture ? (
          <Tool inert={false}>
            <EarlyDepartureFacts entry={entry} />
          </Tool>
        ) : null}
        <div id={ID.early}>
          <Tool>
            <EarlyDepartureBlock entry={entry} setSelected={goToStep} />
          </Tool>
        </div>
      </div>

      {past ? null : <StayActs entry={entry} inHouse={inHouse} onOpen={go} />}

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
 * The step line's right end at Stay (2026-10-29): the keys — with the number owed today in red —
 * a mid-stay payment, and Change booking (Move a room · Extend the stay · Leaving early).
 */
function StayActs({ entry, inHouse, onOpen }: { entry: EntryDetail; inHouse: boolean; onOpen: (k: string) => void }) {
  const hotelToday = useHotelDay()?.today ?? null;
  const due = keysDue(entry, hotelToday);
  const owed = due.collect.length + due.handOver.length;
  const owedWords = keysDueWords(due);
  const notNow = "Not possible on this booking now";
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
      onSelect: inHouse ? () => onOpen("setup") : undefined,
      reason: inHouse ? undefined : notNow,
    },
    {
      key: "extend",
      label: "Extend the stay",
      note: "More nights. The house is asked, the bill for them is sent and paid, then the stay is extended.",
      onSelect: inHouse ? () => onOpen("extend") : undefined,
      reason: inHouse ? undefined : notNow,
    },
    {
      key: "early",
      label: "Leaving early",
      note: "The guest goes before the booked check-out. The nights not slept are not charged; the GM records it.",
      onSelect: inHouse ? () => onOpen("early") : undefined,
      reason: inHouse ? undefined : notNow,
      danger: true,
    },
  ];
  return (
    <StageActs>
      <Button
        kind="secondary"
        className={owed ? "stage-due" : undefined}
        title={owedWords.length ? owedWords.join(" · ") : "Each room's key — handed over, back, or lost"}
        onClick={() => onOpen("keys")}
      >
        Keys
        {owed ? (
          <span className="due-n" aria-label={`${owed} owed today`}>
            {owed}
          </span>
        ) : null}
      </Button>
      <Button kind="secondary" state={inHouse ? "default" : "inert"} reason={inHouse ? undefined : notNow} onClick={() => onOpen("interim")}>
        Mid-stay payment
      </Button>
      <ChangeBookingMenu items={items} />
    </StageActs>
  );
}
