"use client";

/**
 * Step 7 · Stay — "daily charges" (SS03 amendment T1–T4; prototype `stepCanvas[7]`,
 * `V16.stayBase`, `V16.caseActs`).
 *
 * The folio is the destination; charges are keyed at the desk in the shape a till will send; the
 * nights are audited one by one; the rooms keep their own moves and keys. Around them, the money
 * of a long stay (interim payment, extension, who pays for what, leaving early, the bills), the
 * departments, disputes, faults, and the billing model. The forward move — Move to Check-out —
 * stays in the gate bar; this canvas reports the final night's audit up to it.
 */
import { useState } from "react";
import { useHotelClock } from "@/hooks/use-hotel-clock";
import { EarlyDepartureBlock, EarlyDepartureFacts } from "@/components/desk/workspace/early-departure";
import { IdentityProofBlock } from "@/components/desk/workspace/identity-proof";
import { SplitSettlementBlock } from "@/components/desk/workspace/split-settlement";
import { InterimPaymentBlock, StayExtensionBlock } from "@/components/desk/workspace/stay-money";
import type { EntryDetail } from "@/types/api";
import { StepCanvas, Tool, useRefreshEntry, type StepPane, OtherWaysTabs, InlineWay, ShutWay, useOpenOtherWay } from "./kit";
import { BillingModelCard, DisputesCard, FaultsCard, HandoffsCard, RaiseDisputeDialog, TermsChangeCard } from "./s7-desk";
import { ChitsWaitingCard, FolioCard, PostChargeCard } from "./s7-folio";
import { NightsCard } from "./s7-nights";
import { FlagDeficientDialog, KeysCard, RoomsInUseCard } from "./s7-rooms";
import { RoomsTableCard } from "./rooms-table";

const ID = {
  rooms: "s7-rooms",
  interim: "s7-interim",
  extend: "s7-extend",
  split: "s7-split",
  early: "s7-early",
  guests: "s7-guests",
};

/**
 * Stay's panes (2026-09-25). "This step" keeps the folio, the charges, the keys and the
 * departments — the day's work; each of the long-stay matters gets a tab of its own. Every pane
 * stays mounted (hidden, not unmounted): the nights card reports the final audit up to the gate
 * whichever pane is open, and a half-typed extension survives a look at the bills.
 */
export const S7_PANES: StepPane[] = [
  { key: "nights", label: "Night audit", cards: ["nights"] },
  { key: "rooms", label: "Rooms", cards: [] },
  { key: "interim", label: "Interim payment", cards: [] },
  { key: "extend", label: "Extend the stay", cards: [] },
  { key: "early", label: "Leaving early", cards: [] },
];

export function S7Stay({
  entry,
  past,
  setNightAuditOk,
  goToStep,
  pane = null,
  openPane,
}: {
  entry: EntryDetail;
  past: boolean;
  setNightAuditOk: (v: boolean) => void;
  goToStep: (n: number) => void;
  /** Which pane is open — null is This step. */
  pane?: string | null;
  openPane?: (key: string | null) => void;
}) {
  const { tz } = useHotelClock(60_000);
  const refresh = useRefreshEntry(entry.id);
  // An open room tab on the folio becomes the default "Room" of the next charge.
  const [chargeTarget, setChargeTarget] = useState("");
  // A dispute and a fault are raised in Other ways' own tabs (2026-10-17) — the cards' buttons go there.
  const openWay = useOpenOtherWay();

  const folioId = entry.folio?.id ?? null;
  const inHouse = entry.status === "ACTIVE" && entry.currentStage === "S7";
  const onMoney = () => refresh([["interim-payments", entry.id], ["stay-extensions", entry.id]]);

  // A pane is hidden, never unmounted — see S7_PANES.
  const at = (k: string | null) => ((pane ?? null) === k ? undefined : true);
  const go = (k: string) => openPane?.(k);

  return (
    <StepCanvas past={past}>
      <div className="pane" hidden={at(null)}>
        {entry.earlyDeparture ? (
          <Tool inert={false}>
            <EarlyDepartureFacts entry={entry} />
          </Tool>
        ) : null}
        <FolioCard entry={entry} onTab={setChargeTarget} onInterimPayment={() => go("interim")} />
        <PostChargeCard entry={entry} target={chargeTarget} setTarget={setChargeTarget} />
        <ChitsWaitingCard />
        <KeysCard entry={entry} />
        <HandoffsCard entry={entry} tz={tz} />
        <DisputesCard entry={entry} tz={tz} onRaise={() => openWay("dispute")} />
        <FaultsCard entry={entry} tz={tz} onFlag={() => openWay("fault")} />
        <TermsChangeCard entry={entry} />
        <BillingModelCard entry={entry} tz={tz} />
        <div id={ID.guests}>
          <Tool>
            <IdentityProofBlock entry={entry} collapsible />
          </Tool>
        </div>
      </div>

      <div className="pane" hidden={at("nights")}>
        <NightsCard entry={entry} setNightAuditOk={setNightAuditOk} onMoveRoom={() => go("rooms")} />
      </div>

      <div className="pane" hidden={at("rooms")}>
        {/* The rooms as the negotiation table (2026-10-06) — a room is changed by clicking it
            here, so the per-room control on the card below is gone. */}
        <RoomsTableCard
          entry={entry}
          title="The rooms"
          lead="In-house the rates and waivers are read-only. A change takes effect from tonight; the nights already slept stay billed as they were audited."
        />
        <RoomsInUseCard entry={entry} id={ID.rooms} />
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

      {/* Only what has no tab and no card of its own until it exists (2026-09-25): a dispute
          and a fault are raised from here because their cards render only once there is one.
          Extending, leaving early, a room change and an interim payment are tabs beside This
          step, so they are not repeated here. As sub-tabs since 2026-10-17, each its form. */}
      <OtherWaysTabs
        tabs={
          inHouse
            ? [
                {
                  key: "dispute",
                  label: "Raise a dispute",
                  content: folioId ? (
                    <InlineWay render={(done) => <RaiseDisputeDialog entry={entry} open onClose={done} />} />
                  ) : (
                    <ShutWay act="Raise" why="There is no folio to dispute." />
                  ),
                },
                {
                  key: "fault",
                  label: "Flag room deficient",
                  content: <InlineWay render={(done) => <FlagDeficientDialog entry={entry} open onClose={done} />} />,
                },
              ]
            : []
        }
      />
    </StepCanvas>
  );
}
