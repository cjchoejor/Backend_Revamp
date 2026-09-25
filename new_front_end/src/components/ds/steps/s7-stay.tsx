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
import { useHotelDay } from "@/hooks/use-hotel-day";
import { departureWouldBeEarly } from "@/lib/desk/workspace";
import { EarlyDepartureBlock, EarlyDepartureFacts } from "@/components/desk/workspace/early-departure";
import { FolioDocumentsBlock } from "@/components/desk/workspace/folio-documents";
import { IdentityProofBlock } from "@/components/desk/workspace/identity-proof";
import { SplitSettlementBlock } from "@/components/desk/workspace/split-settlement";
import { InterimPaymentBlock, StayExtensionBlock } from "@/components/desk/workspace/stay-money";
import type { EntryDetail } from "@/types/api";
import { OtherWays, PapersCard, RequestsCard, SeeRow, StepCanvas, Tool, useRefreshEntry, type StepPane } from "./kit";
import { BillingModelCard, DisputesCard, FaultsCard, HandoffsCard, RaiseDisputeDialog, TermsChangeCard } from "./s7-desk";
import { ChitsWaitingCard, FolioCard, PostChargeCard } from "./s7-folio";
import { NightsCard } from "./s7-nights";
import { FlagDeficientDialog, KeysCard, RoomsInUseCard } from "./s7-rooms";

const ID = {
  rooms: "s7-rooms",
  interim: "s7-interim",
  extend: "s7-extend",
  split: "s7-split",
  bills: "s7-bills",
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
  { key: "rooms", label: "Room change", cards: [] },
  { key: "interim", label: "Interim payment", cards: [] },
  { key: "extend", label: "Extend the stay", cards: [] },
  { key: "bills", label: "Bills & statements", cards: [] },
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
  const hotelToday = useHotelDay()?.today ?? null;
  // An open room tab on the folio becomes the default "Room" of the next charge.
  const [chargeTarget, setChargeTarget] = useState("");
  const [disputeOpen, setDisputeOpen] = useState(false);
  const [faultOpen, setFaultOpen] = useState(false);

  const folioId = entry.folio?.id ?? null;
  const inHouse = entry.status === "ACTIVE" && entry.currentStage === "S7";
  const early = departureWouldBeEarly(entry, hotelToday);
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
        <DisputesCard entry={entry} tz={tz} onRaise={() => setDisputeOpen(true)} />
        <FaultsCard entry={entry} tz={tz} onFlag={() => setFaultOpen(true)} />
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

      <div className="pane" hidden={at("bills")}>
        <div id={ID.bills}>
          <Tool inert={false}>
            <FolioDocumentsBlock entry={entry} stage="S7" />
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

      <RequestsCard />
      <OtherWays>
        {inHouse
          ? [
              <SeeRow
                key="extend"
                label="Extend stay…"
                note="checks the rooms are free for the extra nights, prices them, takes the payment first, then re-freezes the booking"
                onClick={() => go("extend")}
              />,
              <SeeRow
                key="early"
                label="Early departure…"
                note={
                  entry.earlyDeparture
                    ? "already recorded — the stay is shortened"
                    : early === true
                      ? "shortens the stay; the nights slept stay billed, the rest fall away; the fee follows the setting — the GM's"
                      : early === null
                        ? "checking today's date at the hotel…"
                        : "the booked check-out day is here — this is an ordinary check-out"
                }
                onClick={early === true && !entry.earlyDeparture ? () => go("early") : undefined}
                reason={early === true && !entry.earlyDeparture ? undefined : "nothing to shorten today"}
              />,
              <SeeRow
                key="category"
                label="Change category…"
                note="a room of another type, from the room's own Change room — the FOM's; the stay is re-priced from tonight"
                onClick={() => go("rooms")}
              />,
              <SeeRow
                key="dispute"
                label="Raise a dispute…"
                note="an open dispute holds the move to Check-out"
                onClick={folioId ? () => setDisputeOpen(true) : undefined}
                reason={folioId ? undefined : "there is no folio to dispute"}
              />,
              <SeeRow
                key="fault"
                label="Flag room deficient…"
                note="the room leaves sale at once; the guest is offered a move; settled or acknowledged before check-out"
                onClick={() => setFaultOpen(true)}
              />,
              <SeeRow
                key="interim"
                label="Interim payment"
                note="the bill goes out first, then the money; it reduces the balance and nothing more"
                onClick={() => go("interim")}
              />,
            ]
          : null}
      </OtherWays>
      <PapersCard entry={entry} />

      {past ? null : (
        <>
          <RaiseDisputeDialog entry={entry} open={disputeOpen} onClose={() => setDisputeOpen(false)} />
          <FlagDeficientDialog entry={entry} open={faultOpen} onClose={() => setFaultOpen(false)} />
        </>
      )}
    </StepCanvas>
  );
}
