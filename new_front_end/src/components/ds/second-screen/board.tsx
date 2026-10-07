"use client";

/**
 * The second screen (2026-10-07) — a read-only board beside the desk.
 *
 * Monitor 1 is the desk the front office works in. This window sits on monitor 2 and shows, live,
 * everything about the booking the desk has open: where it stands in its nine steps, what to do
 * next and what holds the next move, the rooms night by night, who sleeps where and the price,
 * what has been typed but not saved yet, what was recorded and decided, and every problem the
 * moment it happens. Nothing is typed here.
 *
 * Three columns: Do next + Problems · The booking as it stands · Changes & decisions.
 *
 * Every figure is the backend's own: this window's cache is filled with the desk's answers
 * (lib/ds/second-screen), and it reads them under the desk's own keys. The to-do and the forward
 * move are the desk's own reading of the step, sent across, so the two screens never disagree.
 */
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Chip, Icon, IconSprite } from "@/design-system";
import { useSession } from "@/hooks/use-session";
import { useHotelDay } from "@/hooks/use-hotel-day";
import { useHotelClock } from "@/hooks/use-hotel-clock";
import { useSecondScreen } from "@/hooks/use-second-screen";
import { usePaymentStatus } from "@/hooks/use-payment-status";
import { getBillingSummary, getEntry, getEntryTimers, getEntryTrace, listEntryCommunications } from "@/lib/api/entries";
import { getEntryBedPlan, listRooms } from "@/lib/api/rooms";
import type { QuotationLivePreview } from "@/lib/api/quotations";
import { post, setScreenRole, type Notice } from "@/lib/ds/second-screen/channel";
import { boardState, draftOf, onBoardChange, startBoard, type BoardState } from "@/lib/ds/second-screen/board-store";
import type { DeskDraft, RoomsDraft, StayDraft, TableDraft } from "@/lib/ds/second-screen/drafts";
import {
  changedCompFields,
  draftNightRooms,
  roomsChanges,
  savedNightRooms,
  stayChanges,
  tableChanges,
} from "@/lib/ds/second-screen/diff";
import { DESK_STEPS, guestName } from "@/lib/desk/model";
import {
  confirmReadiness,
  currentStepOrder,
  liveQuotesThisPass,
  preconditionsFor,
  s1Readiness,
  s2Readiness,
  s5Readiness,
  s6Readiness,
  s7Readiness,
  s8Readiness,
} from "@/lib/desk/workspace";
import { mealPlanSummary, operativeRoomCompositions } from "@/lib/desk/party-rooms";
import { channelWord, factsFromEntry, standingOf } from "@/lib/ds/status";
import { clockParts, fmtDateTime, fmtDay, fmtRange, fmtTime, money, nightsOf, plural } from "@/lib/ds/format";
import { PHASES, STEP_NAMES } from "@/lib/ds/steps";
import { timerLabel } from "@/lib/ds/timers";
import { isHousekeeping, traceWords } from "@/lib/ds/trace-words";
import { inLens } from "@/lib/ds/lenses";
import { enumerateNights } from "@/components/ds/steps/use-room-selection";
import { StandingChip } from "@/components/ds/ui";
import { SidePapers } from "@/components/ds/workspace/side-papers";
import { BILLING_WORD } from "@/components/ds/workspace/details-view";
import type { EntryDetail } from "@/types/api";
import { InquiryBoard } from "@/components/ds/second-screen/inquiry-board";
import { GuideBox } from "@/components/ds/second-screen/guide-box";
import { ClockStrip, type StripClock } from "@/components/ds/second-screen/clock-strip";
import { MoreList } from "@/components/ds/second-screen/more-list";
import { guideFor, type GuideItem } from "@/lib/ds/second-screen/guide";

// This window is the board: nothing it does is ever sent back to the desk as a draft or a notice.
setScreenRole("board");

const NOOP = () => {};
const BED_WORD: Record<string, string> = { KING: "King", QUEEN: "Queen", TWIN: "Twin", SINGLE: "Single" };
/** The board re-reads on its own only as a backstop; the desk's answers normally arrive first. */
const BACKSTOP = { staleTime: 20_000, refetchInterval: 60_000, refetchOnWindowFocus: false } as const;

function useBoard(): BoardState {
  return useSyncExternalStore(onBoardChange, boardState, boardState);
}

/** The newest answer cached under a key prefix — the desk's live table pricing has a key per table state. */
function useNewestCached<T>(prefix: readonly unknown[]): T | null {
  const qc = useQueryClient();
  const cache = qc.getQueryCache();
  const read = () => {
    const all = cache.findAll({ queryKey: prefix }).filter((q) => q.state.status === "success" && q.state.data != null);
    all.sort((a, b) => b.state.dataUpdatedAt - a.state.dataUpdatedAt);
    return (all[0]?.state.data as T | undefined) ?? null;
  };
  return useSyncExternalStore(
    (fn) => cache.subscribe(fn),
    read,
    () => null,
  );
}

export function SecondScreenBoard() {
  const qc = useQueryClient();
  const { session, isLoading } = useSession();
  useEffect(() => {
    startBoard(qc);
  }, [qc]);
  useEffect(() => {
    document.title = "Second screen · LEGPHEL PMS";
  }, []);
  const s = useBoard();
  const { connected } = useSecondScreen();
  const clock = useHotelClock(1000);
  const [pinned, setPinned] = useState<string | null>(null);
  const following = s.focus?.entryId ?? null;
  const entryId = pinned ?? following;
  const { date, time } = clockParts(clock.now, clock.tz);

  const fill = () => {
    if (document.fullscreenElement) void document.exitFullscreen();
    else void document.documentElement.requestFullscreen?.().catch(() => {});
  };

  return (
    <div className="ds board">
      <IconSprite />
      <div className="board-bar">
        <span className="board-mark">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/brand/logo-mark.png" alt="" />
          Second screen
        </span>
        <span className={`board-link${connected ? " on" : ""}`}>
          <span className="dot" aria-hidden="true" />
          {connected ? "Following the desk" : s.synced ? "The desk window is closed" : "Looking for the desk…"}
        </span>
        {pinned ? (
          <button type="button" className="btn btn-quiet compact" onClick={() => setPinned(null)}>
            <Icon name="lock-open" /> Pinned to {pinned} — follow the desk again
          </button>
        ) : entryId ? (
          <button type="button" className="btn btn-quiet compact" onClick={() => setPinned(entryId)}>
            <Icon name="lock" /> Keep this booking here
          </button>
        ) : null}
        <span className="spacer" />
        <span className="board-clock">
          {date} · <b>{time}</b>
        </span>
        <button type="button" className="btn btn-quiet compact" onClick={fill}>
          Fill this screen
        </button>
      </div>
      {isLoading ? (
        <p className="board-empty">Opening…</p>
      ) : !session ? (
        <p className="board-empty">Sign in on the desk first, then open the second screen again.</p>
      ) : entryId ? (
        <BookingBoard entryId={entryId} s={s} />
      ) : (
        <IdleBoard path={s.focus?.path ?? null} notices={s.notices} />
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */

function IdleBoard({ path, notices }: { path: string | null; notices: Notice[] }) {
  const day = useHotelDay();
  return (
    <div className="board-idle">
      <h2>Open a booking on the desk</h2>
      <p>
        This screen follows the desk. When a booking is opened there, everything about it shows here — the
        rooms, the people, the price, what is not saved yet and what to do next.
      </p>
      {path ? <p className="meta">The desk is on {path === "/today" ? "Today" : path.replace(/^\//, "") || "the start page"}.</p> : null}
      {day ? <p className="meta">Today at the hotel: {fmtDay(day.today)}</p> : null}
      <NoticeList notices={notices.slice(0, 8)} empty="Nothing said on the desk yet." />
    </div>
  );
}

/* ------------------------------------------------------------------ */

function BookingBoard({ entryId, s }: { entryId: string; s: BoardState }) {
  const { session } = useSession();
  const hotelToday = useHotelDay()?.today ?? null;
  const { tz } = useHotelClock(30_000);
  const on = !!session;

  const entryQ = useQuery({ queryKey: ["entry", entryId], queryFn: () => getEntry(session!, entryId), enabled: on, ...BACKSTOP });
  const entry = entryQ.data ?? null;
  const billingQ = useQuery({
    queryKey: ["billing-summary", entryId, entry?.updatedAt ?? ""],
    queryFn: () => getBillingSummary(session!, entryId),
    enabled: on && !!entry,
    ...BACKSTOP,
  });
  const timersQ = useQuery({ queryKey: ["entry-timers", entryId], queryFn: () => getEntryTimers(session!, entryId), enabled: on, ...BACKSTOP });
  const traceQ = useQuery({
    queryKey: ["entry-trace", entryId, entry?.updatedAt ?? ""],
    queryFn: () => getEntryTrace(session!, entryId, 100),
    enabled: on && !!entry,
    ...BACKSTOP,
  });
  const commsQ = useQuery({ queryKey: ["entry-communications", entryId], queryFn: () => listEntryCommunications(session!, entryId), enabled: on, ...BACKSTOP });
  const bedQ = useQuery({ queryKey: ["bed-plan", entryId], queryFn: () => getEntryBedPlan(session!, entryId), enabled: on, ...BACKSTOP });
  const roomsQ = useQuery({ queryKey: ["rooms-catalog"], queryFn: () => listRooms(session!), enabled: on, staleTime: 5 * 60_000 });
  const payment = usePaymentStatus(entryId, { enabled: !!entry?.folio }).data ?? null;
  const preview = useNewestCached<QuotationLivePreview>(["quotation-live-preview", entryId]);

  const desk = draftOf<DeskDraft>(s, entryId, "desk")?.value ?? null;
  const stay = draftOf<StayDraft>(s, entryId, "s1.stay")?.value ?? null;
  const roomsDraft = draftOf<RoomsDraft>(s, entryId, "s1.rooms")?.value ?? null;
  const table = draftOf<TableDraft>(s, entryId, "s2.table")?.value ?? null;

  const catalog = roomsQ.data?.items ?? [];
  const roomById = useMemo(() => new Map(catalog.map((r) => [r.id, r])), [catalog]);
  const roomNo = (id: string) => roomById.get(id)?.roomNumber ?? id.slice(0, 6);

  if (!entry) {
    return <p className="board-empty">{entryQ.isError ? "This booking could not be read." : "Reading the booking…"}</p>;
  }

  const current = desk?.current ?? currentStepOrder(entry);
  const viewing = desk?.viewing ?? current;
  // When the desk is looking back at an earlier step it sends no to-do for the booking's own step —
  // the board then works it out with the same readiness rules, so its lines stay clickable.
  const lookingBack = !!desk && desk.viewing !== desk.current;
  const items =
    desk && !lookingBack
      ? desk.items
      : stepItems(entry, current, hotelToday, {
          paymentSatisfied: payment?.satisfied,
          totalReceived: payment?.totalReceived ?? null,
          requiredAmount: payment?.requiredAmount ?? null,
          communications: commsQ.data?.items ?? null,
        });

  /* the rooms, night by night */
  const nights = enumerateNights(stay?.checkIn || entry.checkInDate, stay?.checkOut || entry.checkOutDate);
  const saved = savedNightRooms(entry, nights);
  if (saved.size === 0 && (entry.roomAssignments ?? []).length) {
    const ids = [...new Set((entry.roomAssignments ?? []).map((a) => a.roomId))];
    for (const n of nights) saved.set(n, ids);
  }
  const draftRooms = draftNightRooms(roomsDraft);
  const numberOfRooms = stay?.rooms ?? entry.numberOfRooms ?? 1;

  /* what is not saved, in words */
  const unsaved: string[] = [
    ...(stay ? stayChanges(entry, stay) : []),
    ...(draftRooms ? roomsChanges(saved, draftRooms, roomNo) : []),
    ...(table ? tableChanges(entry, table, roomNo) : []),
  ];

  /* problems: what stands wrong now, then what the desk was just refused or warned */
  const standing: string[] = [
    ...(stay?.warning ? [stay.warning] : []),
    ...(roomsDraft && !roomsDraft.ready && roomsDraft.nights.length
      ? [`${roomsDraft.nightsReady} of ${plural(roomsDraft.nights.length, "night")} have all ${plural(roomsDraft.numberOfRooms, "room")}`]
      : []),
    ...(table?.faults ?? []),
  ];
  const live = s.notices.filter((n) => (n.entryId === entryId || n.entryId == null) && (n.tone === "error" || n.tone === "warning"));
  const said = s.notices.filter((n) => (n.entryId === entryId || n.entryId == null) && (n.tone === "success" || n.tone === "info"));

  const events = (traceQ.data?.items ?? []).filter((e) => !isHousekeeping(e.eventType));
  const decisions = events.filter((e) => inLens(e, "approvals"));
  // Every clock the desk has words for, soonest first — the strip under the steps.
  const clocks: StripClock[] = (timersQ.data?.items ?? [])
    .filter((t) => t.status === "SCHEDULED")
    .map((t) => ({ t, label: timerLabel(t) }))
    .filter((x): x is { t: (typeof x)["t"]; label: string } => !!x.label)
    .sort((a, b) => a.t.firesAt.localeCompare(b.t.firesAt))
    .slice(0, 8)
    .map(({ t, label }) => ({ id: t.id, label, firesAt: t.firesAt, createdAt: t.createdAt, warningAt: t.warningAt, criticalAt: t.criticalAt }));

  const billing = billingQ.data ?? null;
  const cur = billing?.currency ?? "BTN";

  /* the board is a way to navigate: a click takes the desk to the card, on the booking's own step */
  const go = (card: string) => post({ t: "goto", entryId, card, step: current });

  /* what to do next — the step's list, the guest's answers, the clocks, then the move */
  const latestRefusal = live.find((n) => n.tone === "error" && n.source === "refusal" && Date.now() - n.at < 90_000)?.text ?? null;
  const tableFix: GuideItem[] = table?.faults.length
    ? [{ key: "table", tone: "fix", now: "Put the table right before pricing it", how: table.faults.join(" · ") }]
    : [];
  const guide: GuideItem[] = [
    ...tableFix,
    ...guideFor({
      desk: desk && lookingBack ? { ...desk, viewing: desk.current, items } : desk,
      stage: entry.currentStage,
      timers: timersQ.data?.items ?? [],
      communications: commsQ.data?.items ?? [],
      passStart: (entry.segments ?? [])[0]?.startedAt ?? null,
      quotes: liveQuotesThisPass(entry),
      payment,
      balance: billing?.folio?.outstandingBalance ?? null,
      currency: cur,
      latestRefusal,
      now: Date.now(),
    }),
  ];
  const name = guestName(entry.guestProfile);
  const standingNow = standingOf(factsFromEntry(entry, billing?.folio?.outstandingBalance ?? null, null, hotelToday), hotelToday);
  const party = `${plural(entry.adultCount ?? entry.guestCount ?? 0, "adult")}${entry.childCount ? ` · ${plural(entry.childCount, "child", "children")}${entry.childAges?.length ? ` (${entry.childAges.join(", ")})` : ""}` : ""}`;

  return (
    <div className="board-page">
      {/* ---- the top band ---- */}
      <div className="board-head">
        <div className="who">
          <h1>{name}</h1>
          <StandingChip standing={standingNow} />
          {entry.groupBillingMode === "GROUP_MASTER" ? <Chip>Group</Chip> : null}
        </div>
        <div className="facts">
          <span>{entry.id}</span>
          {entry.inquiry?.id ? <span>Enquiry {entry.inquiry.id}</span> : null}
          <span>
            <b>{fmtRange(entry.checkInDate, entry.checkOutDate)}</b> · {plural(nightsOf(entry.checkInDate, entry.checkOutDate) ?? 0, "night")}
          </span>
          <span>{party}</span>
          <span>{plural(entry.numberOfRooms ?? 1, "room")} asked</span>
        </div>
        <StepStrip current={current} viewing={viewing} />
        <div className="board-money">
          <span className="k">{billing?.headline.kind === "BILLED_SO_FAR" ? "Billed so far" : billing?.headline.frozen ? "Total · as confirmed" : "Total · indicative"}</span>
          <b>{billing?.headline.amount != null ? money(billing.headline.amount, cur) : "—"}</b>
          {billing?.folio ? (
            <span className="meta">
              paid {money(billing.folio.paymentsReceived ?? 0, cur)} · balance {money(billing.folio.outstandingBalance ?? 0, cur)}
            </span>
          ) : null}
        </div>
      </div>

      <ClockStrip clocks={clocks} />

      {desk?.sealed ? <div className="board-sealed">{desk.sealed}</div> : null}

      {current === 1 && viewing === 1 && !desk?.sealed ? (
        <InquiryBoard
          entry={entry}
          desk={desk}
          stay={stay}
          rooms={roomsDraft}
          savedRooms={saved}
          roomById={roomById}
          unsaved={unsaved}
          live={live}
          events={events.map((e) => ({ id: e.id, timestamp: e.timestamp, words: traceWords(e), who: whoDid(e) }))}
          tz={tz}
          also={guide.filter((g) => !g.key.startsWith("step:") && g.key !== "move" && g.key !== "refusal")}
          onGo={go}
        />
      ) : (
      <div className="board-cols">
        {/* ---- left: do next + problems ---- */}
        <section className="board-col">
          <GuideBox
            items={guide}
            checklist={items}
            onGo={go}
            lookingBack={viewing !== current ? `The desk is looking back at ${STEP_NAMES[viewing - 1]}. The booking is at ${STEP_NAMES[current - 1]}.` : null}
          />

          <h3>Problems</h3>
          {standing.length === 0 && live.length === 0 ? <p className="quiet">None right now.</p> : null}
          {standing.length ? (
            <ul className="board-problems">
              {standing.map((p) => (
                <li key={p} className="warn">
                  <Icon name="alert" /> <span>{p}</span>
                </li>
              ))}
            </ul>
          ) : null}
          <NoticeList notices={live} limit={4} />

        </section>

        {/* ---- middle: the booking as it stands ---- */}
        <section className="board-col wide">
          <h3>The stay</h3>
          <div className="stay-grid">
            <StayCell k="Dates" v={`${fmtRange(entry.checkInDate, entry.checkOutDate)} · ${plural(nightsOf(entry.checkInDate, entry.checkOutDate) ?? 0, "night")}`}
              draft={stay && (stay.checkIn !== entry.checkInDate?.slice(0, 10) || stay.checkOut !== entry.checkOutDate?.slice(0, 10)) ? `${fmtRange(stay.checkIn, stay.checkOut)} · ${plural(stay.nights, "night")}` : null}
              onGo={current === 1 ? () => go("stay") : undefined} />
            <StayCell k="Party" v={party}
              draft={stay && (stay.adults !== (entry.adultCount ?? entry.guestCount) || stay.children !== (entry.childCount ?? 0)) ? `${plural(stay.adults, "adult")}${stay.children ? ` · ${plural(stay.children, "child", "children")}` : ""}` : null}
              onGo={current === 1 ? () => go("stay") : undefined} />
            <StayCell k="Rooms asked" v={String(entry.numberOfRooms ?? 1)} draft={stay && stay.rooms !== (entry.numberOfRooms ?? 1) ? String(stay.rooms) : null} onGo={current === 1 ? () => go("stay") : undefined} />
            <StayCell k="Bed setup asked" v={bedWords(entry.bedTypeRequest) || "no preference"} draft={stay && bedWords(stay.beds) !== bedWords(entry.bedTypeRequest) ? bedWords(stay.beds) || "no preference" : null} />
            <StayCell k="Came in as" v={channelWord(entry.inquiry?.sourceChannel, entry.inquiry?.cameInAs)} />
            <StayCell k="Booked by" v={entry.inquiry?.travelAgent?.displayName ?? entry.inquiry?.corporateAccount?.displayName ?? "the guest"} />
            {entry.contactPersonName || entry.contactPersonPhone ? (
              <StayCell k="Contact" v={[entry.contactPersonName, entry.contactPersonPhone].filter(Boolean).join(" · ")} onGo={current === 1 ? () => go("guest") : undefined} />
            ) : null}
          </div>

          <h3>
            Rooms by night{" "}
            <span className="h-meta">
              {plural(numberOfRooms, "room")} needed each night
              {draftRooms ? " · amber = not saved yet" : ""}
            </span>
          </h3>
          <RoomsGrid nights={nights} saved={saved} draft={draftRooms} need={numberOfRooms} roomById={roomById} beds={bedQ.data?.rooms ?? []} />

          {current >= 2 || table ? (
            <PartyTable entry={entry} table={table} preview={table ? preview : null} billing={billing} cur={cur} roomNo={roomNo} />
          ) : null}

          {current >= 3 ? (
            <>
              <h3>Set up</h3>
              <table className="board-facts">
                <tbody>
                  <FactRow k="Who pays" v={entry.folio?.billingModel ? BILLING_WORD[entry.folio.billingModel] ?? entry.folio.billingModel : "not chosen yet"} missing={!entry.folio?.billingModel} onGo={current === 3 ? () => go("billing-model") : undefined} />
                  <FactRow k="Cancellation terms" v={entry.cancellationDisclosure ? `recorded ${fmtDateTime(entry.cancellationDisclosure.disclosedAt, tz)}` : "not recorded yet"} missing={!entry.cancellationDisclosure} onGo={current === 3 ? () => go("terms") : undefined} />
                  <FactRow k="Proforma" v={proformaWords(entry)} missing={!(entry.folio?.invoices ?? []).some((i) => i.invoiceType === "PROFORMA" && i.state !== "SUPERSEDED")} onGo={current === 3 ? () => go("proforma") : undefined} />
                  <FactRow
                    k="Advance"
                    v={payment ? `asked ${money(payment.requiredAmount, cur)} · received ${money(payment.totalReceived, cur)}${payment.shortfall > 0 ? ` · ${money(payment.shortfall, cur)} still owed` : ""}` : "—"}
                    missing={!!payment && !payment.satisfied}
                    onGo={current === 3 ? () => go("money") : undefined}
                  />
                  <FactRow
                    k="Rooms held"
                    v={entry.committedHold ? `${entry.committedHold.state === "CONFIRMED" ? "held by the reservation" : `until ${fmtDateTime(entry.committedHold.expiresAt, tz)}`}` : "not held yet"}
                    missing={!entry.committedHold}
                    onGo={current === 3 ? () => go("hold") : undefined}
                  />
                </tbody>
              </table>
            </>
          ) : null}
        </section>

        {/* ---- right: changes & decisions ---- */}
        <section className="board-col">
          <h3>Not saved yet</h3>
          {unsaved.length ? (
            <ul className="board-unsaved">
              {unsaved.map((u) => (
                <li key={u}>{u}</li>
              ))}
            </ul>
          ) : (
            <p className="quiet">Everything on the desk is saved.</p>
          )}

          {said.length ? (
            <>
              <h3>Just said on the desk</h3>
              <NoticeList notices={said} limit={3} />
            </>
          ) : null}

          <h3>Decisions</h3>
          {decisions.length ? (
            <MoreList
              className="board-feed"
              items={decisions}
              limit={4}
              render={(e) => (
                <li key={e.id}>
                  <span>{traceWords(e)}</span>
                  <span className="meta">
                    {fmtTime(e.timestamp, tz)} · {whoDid(e)}
                  </span>
                </li>
              )}
            />
          ) : (
            <p className="quiet">No approvals or waivers on this booking.</p>
          )}

          <h3>Recorded</h3>
          <MoreList
            className="board-feed"
            items={events}
            limit={5}
            render={(e) => (
              <li key={e.id}>
                <span>{traceWords(e)}</span>
                <span className="meta">
                  {fmtDay(e.timestamp)} {fmtTime(e.timestamp, tz)} · {whoDid(e)}
                </span>
              </li>
            )}
          />

          <div className="side board-papers">
            <SidePapers entry={entry} communications={commsQ.data?.items ?? []} tz={tz} sealed={!!desk?.sealed} onGo={NOOP} />
          </div>
        </section>
      </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */

function StepStrip({ current, viewing }: { current: number; viewing: number }) {
  return (
    <ol className="board-steps">
      {PHASES.flatMap(([, steps]) => steps).map((n) => (
        <li key={n} className={`${n < current ? "done" : n === current ? "cur" : ""}${n === viewing && n !== current ? " look" : ""}`}>
          <span className="n">{n < current ? <Icon name="check" /> : n}</span>
          <span>{STEP_NAMES[n - 1]}</span>
        </li>
      ))}
    </ol>
  );
}

/** One fact of the stay, in a compact grid cell — the new value, a "not saved" pill and the old one when the desk has changed it. */
function StayCell({ k, v, draft, onGo }: { k: string; v: string; draft?: string | null; onGo?: () => void }) {
  const body = (
    <>
      <span className="k">{k}</span>
      {draft ? (
        <span className="v">
          <b>{draft}</b> <span className="ns">not saved</span> <s className="was">{v}</s>
        </span>
      ) : (
        <span className="v">{v}</span>
      )}
    </>
  );
  return onGo ? (
    <button type="button" className={`stay-cell go${draft ? " unsaved" : ""}`} onClick={onGo} title="Show it on the desk">
      {body}
    </button>
  ) : (
    <div className={`stay-cell${draft ? " unsaved" : ""}`}>{body}</div>
  );
}

function FactRow({ k, v, draft, missing, onGo }: { k: string; v: string; draft?: string | null; missing?: boolean; onGo?: () => void }) {
  return (
    <tr className={`${draft ? "unsaved" : missing ? "missing" : ""}${onGo ? " go" : ""}`} onClick={onGo} title={onGo ? "Show it on the desk" : undefined}>
      <th>{k}</th>
      <td>
        {draft ? (
          <>
            <b>{draft}</b> <span className="ns">not saved</span> <s className="was">{v}</s>
          </>
        ) : (
          v
        )}
      </td>
    </tr>
  );
}

function NoticeList({ notices, empty, limit = 8 }: { notices: Notice[]; empty?: string; limit?: number }) {
  const { tz } = useHotelClock(60_000);
  if (!notices.length) return empty ? <p className="quiet">{empty}</p> : null;
  return (
    <MoreList
      className="board-notices"
      items={notices}
      limit={limit}
      render={(n) => (
        <li key={n.id} className={n.tone}>
          <Icon name={n.tone === "error" || n.tone === "warning" ? "alert" : n.tone === "success" ? "check" : "info"} />
          <span>
            {n.text}
            {n.detail ? <span className="d">{n.detail}</span> : null}
          </span>
          <span className="meta">{fmtTime(n.at, tz)}</span>
        </li>
      )}
    />
  );
}

type CatalogRoom = { roomNumber: string; bedType?: string | null; roomType?: { name: string } | null };

function RoomsGrid({
  nights,
  saved,
  draft,
  need,
  roomById,
  beds,
}: {
  nights: string[];
  saved: Map<string, string[]>;
  draft: Map<string, string[]> | null;
  need: number;
  roomById: Map<string, CatalogRoom>;
  beds: Array<{ roomId: string; bedType: string | null }>;
}) {
  const ids = [...new Set([...[...saved.values()].flat(), ...(draft ? [...draft.values()].flat() : [])])].sort((a, b) =>
    (roomById.get(a)?.roomNumber ?? a).localeCompare(roomById.get(b)?.roomNumber ?? b, "en", { numeric: true }),
  );
  if (!nights.length) return <p className="quiet">No dates yet.</p>;
  if (!ids.length) return <p className="quiet">No rooms picked yet — they are picked on the desk.</p>;
  const bedOf = new Map(beds.map((b) => [b.roomId, b.bedType]));
  return (
    <div className="board-grid-wrap">
      <table className="board-grid">
        <thead>
          <tr>
            <th className="rn">Room</th>
            <th>Type · bed</th>
            {nights.map((n) => {
              const picked = (draft?.get(n) ?? saved.get(n) ?? []).length;
              return (
                <th key={n} className="nt">
                  {fmtDay(n)}
                  <span className={`cnt ${picked >= need ? "full" : "short"}`}>
                    {picked}/{need}
                  </span>
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {ids.map((id) => {
            const r = roomById.get(id);
            const bed = bedOf.get(id) ?? r?.bedType ?? null;
            return (
              <tr key={id}>
                <td className="rn">{r?.roomNumber ?? id.slice(0, 6)}</td>
                <td className="rt">
                  {r?.roomType?.name ?? "—"}
                  {bed ? ` · ${BED_WORD[bed] ?? bed}` : ""}
                </td>
                {nights.map((n) => {
                  const inSaved = (saved.get(n) ?? []).includes(id);
                  const inNow = draft ? (draft.get(n) ?? []).includes(id) : inSaved;
                  const cls = inNow && inSaved ? "held" : inNow ? "new" : inSaved ? "off" : "";
                  return (
                    <td key={n} className={`nc ${cls}`}>
                      {cls === "held" ? "■" : cls === "new" ? "new" : cls === "off" ? "off" : ""}
                    </td>
                  );
                })}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function PartyTable({
  entry,
  table,
  preview,
  billing,
  cur,
  roomNo,
}: {
  entry: EntryDetail;
  table: TableDraft | null;
  preview: QuotationLivePreview | null;
  billing: Awaited<ReturnType<typeof getBillingSummary>> | null;
  cur: string;
  roomNo: (id: string) => string;
}) {
  const rows = table?.rooms ?? operativeRoomCompositions(entry) ?? [];
  const priceOf = new Map<string, number | null>();
  if (table && preview) for (const r of preview.rooms) priceOf.set(r.roomId, r.total);
  else for (const r of billing?.rooms ?? []) if (r.roomId) priceOf.set(r.roomId, r.total);
  return (
    <>
      <h3>
        Who sleeps where{" "}
        <span className="h-meta">{table?.unsaved ? "amber = changed on the desk, not saved" : "as priced on the quotation"}</span>
      </h3>
      {rows.length === 0 ? (
        <p className="quiet">Not filled in yet.</p>
      ) : (
        <table className="board-party">
          <thead>
            <tr>
              <th>Room</th>
              <th>Adults</th>
              <th>6–10</th>
              <th>Under 6</th>
              <th>Extra bed</th>
              <th>Meals</th>
              <th>Room rate</th>
              <th className="num">Total</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((c) => {
              const moved = table?.unsaved ? changedCompFields(entry, c) : new Set<string>();
              const cell = (k: string, v: string | number | null | undefined) => <td className={moved.has(k as never) ? "chg" : undefined}>{v ?? "—"}</td>;
              const total = priceOf.get(c.roomId);
              return (
                <tr key={c.roomId}>
                  <td className="rn">{roomNo(c.roomId)}</td>
                  {cell("adultCount", c.adultCount ?? 0)}
                  {cell("cnb6To10Count", c.cnb6To10Count ?? 0)}
                  {cell("cnbUnder6Count", c.cnbUnder6Count ?? 0)}
                  {cell("extraBedCount", c.extraBedCount ?? 0)}
                  <td className={["mealPlanCpCount", "mealPlanMaplCount", "mealPlanMapdCount", "mealPlanApCount"].some((k) => moved.has(k as never)) ? "chg" : undefined}>
                    {mealPlanSummary(c)}
                  </td>
                  {cell("negotiatedRoomRate", c.negotiatedRoomRate != null ? money(c.negotiatedRoomRate, cur) : "standard")}
                  <td className="num">{total != null ? money(total, cur) : "—"}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      {table && preview ? (
        <div className="board-total">
          Net {money(preview.payableSubtotal, cur)} + SC {money(preview.payableServiceCharge, cur)} + GST {money(preview.payableGst, cur)} ={" "}
          <b>{money(preview.payable, cur)}</b>
          {preview.discount ? <span className="meta"> · discount {money(preview.discount.amountOffTotal, cur)} off</span> : null}
          <span className="ns">not saved</span>
        </div>
      ) : billing?.stayTotal?.amount != null ? (
        <div className="board-total">
          Stay total <b>{money(billing.stayTotal.amount, cur)}</b>
          <span className="meta"> · {billing.stayTotal.frozen ? "as confirmed" : "indicative"}</span>
        </div>
      ) : null}
    </>
  );
}

/* ------------------------------------------------------------------ */

/** The booking's own step's checklist, by the desk's own readiness rules. */
function stepItems(
  entry: EntryDetail,
  current: number,
  hotelToday: string | null,
  money: Parameters<typeof confirmReadiness>[1],
): Array<{ label: string; met: boolean; card?: string }> {
  switch (current) {
    case 1:
      return s1Readiness(entry);
    case 2:
      return s2Readiness(entry);
    case 3:
      return confirmReadiness(entry, money);
    case 5:
      return s5Readiness(entry, hotelToday);
    case 6:
      return s6Readiness(entry);
    case 7:
      return s7Readiness(entry, hotelToday);
    case 8:
      return s8Readiness(entry);
    default:
      return preconditionsFor(entry, DESK_STEPS[current - 1], hotelToday);
  }
}

function bedWords(b: Record<string, number> | null | undefined): string {
  return Object.entries(b ?? {})
    .filter(([, n]) => n > 0)
    .map(([t, n]) => `${n} ${BED_WORD[t] ?? t}`)
    .join(" · ");
}

function proformaWords(entry: EntryDetail): string {
  const live = (entry.folio?.invoices ?? []).filter((i) => i.invoiceType === "PROFORMA" && i.state !== "SUPERSEDED");
  const pi = live[live.length - 1];
  if (!pi) return "not generated yet";
  return `${pi.invoiceNumber ?? pi.id} · ${pi.dispatchedAt ? "sent to the guest" : "ready to send"}`;
}

function whoDid(ev: { actorId: string; actorLevel: string; actorName?: string }): string {
  if (ev.actorId === "SYSTEM" || ev.actorLevel === "SYSTEM") return "system";
  return ev.actorName ?? ev.actorId;
}
