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
import { setScreenRole, type Notice } from "@/lib/ds/second-screen/channel";
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
import { currentStepOrder, preconditionsFor } from "@/lib/desk/workspace";
import { mealPlanSummary, operativeRoomCompositions } from "@/lib/desk/party-rooms";
import { channelWord, factsFromEntry, standingOf } from "@/lib/ds/status";
import { clockParts, fmtDateTime, fmtDay, fmtRange, fmtTime, money, nightsOf, plural } from "@/lib/ds/format";
import { PHASES, STEP_NAMES } from "@/lib/ds/steps";
import { timerLabel } from "@/lib/ds/timers";
import { isHousekeeping, traceWords } from "@/lib/ds/trace-words";
import { inLens } from "@/lib/ds/lenses";
import { enumerateNights } from "@/components/ds/steps/use-room-selection";
import { StandingChip } from "@/components/ds/ui";
import { SideTimer } from "@/components/ds/workspace/side-timer";
import { SidePapers } from "@/components/ds/workspace/side-papers";
import { BILLING_WORD } from "@/components/ds/workspace/details-view";
import type { EntryDetail } from "@/types/api";

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
  const items = desk?.items ?? preconditionsFor(entry, DESK_STEPS[current - 1], hotelToday);
  const gate = desk?.gate ?? null;
  const next = items.find((i) => !i.met) ?? null;

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
  const decisions = events.filter((e) => inLens(e, "approvals")).slice(0, 6);
  const timers = (timersQ.data?.items ?? [])
    .filter((t) => t.status === "SCHEDULED")
    .map((t) => ({ t, label: timerLabel(t) }))
    .filter((x): x is { t: (typeof x)["t"]; label: string } => !!x.label)
    .sort((a, b) => a.t.firesAt.localeCompare(b.t.firesAt))
    .slice(0, 3);

  const billing = billingQ.data ?? null;
  const cur = billing?.currency ?? "BTN";
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

      {desk?.sealed ? <div className="board-sealed">{desk.sealed}</div> : null}

      <div className="board-cols">
        {/* ---- left: do next + problems ---- */}
        <section className="board-col">
          <h3>Do next</h3>
          {viewing !== current ? (
            <p className="board-note">
              The desk is looking back at {STEP_NAMES[viewing - 1]}. The booking is at <b>{STEP_NAMES[current - 1]}</b>.
            </p>
          ) : null}
          {next ? (
            <div className="board-next">
              <span className="k">Next</span>
              <b>{next.label}</b>
            </div>
          ) : items.length ? (
            <div className="board-next done">
              <span className="k">This step</span>
              <b>Everything it needs is done</b>
            </div>
          ) : null}
          <ol className="board-todo">
            {items.map((i, n) => (
              <li key={`${n}-${i.label}`} className={i.met ? "met" : i === next ? "now" : ""}>
                <span className="mark">{i.met ? <Icon name="check" /> : n + 1}</span>
                <span>{i.label}</span>
              </li>
            ))}
          </ol>
          {gate ? (
            <div className={`board-gate${gate.ready ? " open" : ""}`}>
              <b>{gate.label}</b>
              <span>{gate.ready ? "open — the desk can press it" : `waits: ${gate.reason ?? "something first"}`}</span>
            </div>
          ) : null}

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
          <NoticeList notices={live.slice(0, 8)} />

          {timers.length ? (
            <>
              <h3>Clocks</h3>
              <div className="side board-timers">
                <div className="list">
                  {timers.map(({ t, label }) => (
                    <SideTimer key={t.id} timer={t} label={label} />
                  ))}
                </div>
              </div>
            </>
          ) : null}
        </section>

        {/* ---- middle: the booking as it stands ---- */}
        <section className="board-col wide">
          <h3>The stay</h3>
          <table className="board-facts">
            <tbody>
              <FactRow k="Dates" v={`${fmtRange(entry.checkInDate, entry.checkOutDate)} · ${plural(nightsOf(entry.checkInDate, entry.checkOutDate) ?? 0, "night")}`}
                draft={stay && (stay.checkIn !== entry.checkInDate?.slice(0, 10) || stay.checkOut !== entry.checkOutDate?.slice(0, 10)) ? `${fmtRange(stay.checkIn, stay.checkOut)} · ${plural(stay.nights, "night")}` : null} />
              <FactRow k="Party" v={party}
                draft={stay && (stay.adults !== (entry.adultCount ?? entry.guestCount) || stay.children !== (entry.childCount ?? 0)) ? `${plural(stay.adults, "adult")}${stay.children ? ` · ${plural(stay.children, "child", "children")}` : ""}` : null} />
              <FactRow k="Rooms asked" v={String(entry.numberOfRooms ?? 1)} draft={stay && stay.rooms !== (entry.numberOfRooms ?? 1) ? String(stay.rooms) : null} />
              <FactRow k="Bed setup asked" v={bedWords(entry.bedTypeRequest) || "no preference"} draft={stay && bedWords(stay.beds) !== bedWords(entry.bedTypeRequest) ? bedWords(stay.beds) || "no preference" : null} />
              <FactRow k="Came in as" v={channelWord(entry.inquiry?.sourceChannel, entry.inquiry?.cameInAs)} />
              <FactRow k="Booked by" v={entry.inquiry?.travelAgent?.displayName ?? entry.inquiry?.corporateAccount?.displayName ?? "the guest"} />
              {entry.contactPersonName || entry.contactPersonPhone ? (
                <FactRow k="Contact" v={[entry.contactPersonName, entry.contactPersonPhone].filter(Boolean).join(" · ")} />
              ) : null}
            </tbody>
          </table>

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
                  <FactRow k="Who pays" v={entry.folio?.billingModel ? BILLING_WORD[entry.folio.billingModel] ?? entry.folio.billingModel : "not chosen yet"} missing={!entry.folio?.billingModel} />
                  <FactRow k="Cancellation terms" v={entry.cancellationDisclosure ? `recorded ${fmtDateTime(entry.cancellationDisclosure.disclosedAt, tz)}` : "not recorded yet"} missing={!entry.cancellationDisclosure} />
                  <FactRow k="Proforma" v={proformaWords(entry)} missing={!(entry.folio?.invoices ?? []).some((i) => i.invoiceType === "PROFORMA" && i.state !== "SUPERSEDED")} />
                  <FactRow
                    k="Advance"
                    v={payment ? `asked ${money(payment.requiredAmount, cur)} · received ${money(payment.totalReceived, cur)}${payment.shortfall > 0 ? ` · ${money(payment.shortfall, cur)} still owed` : ""}` : "—"}
                    missing={!!payment && !payment.satisfied}
                  />
                  <FactRow
                    k="Rooms held"
                    v={entry.committedHold ? `${entry.committedHold.state === "CONFIRMED" ? "held by the reservation" : `until ${fmtDateTime(entry.committedHold.expiresAt, tz)}`}` : "not held yet"}
                    missing={!entry.committedHold}
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
              <NoticeList notices={said.slice(0, 5)} />
            </>
          ) : null}

          <h3>Decisions</h3>
          {decisions.length ? (
            <ul className="board-feed">
              {decisions.map((e) => (
                <li key={e.id}>
                  <span>{traceWords(e)}</span>
                  <span className="meta">
                    {fmtTime(e.timestamp, tz)} · {whoDid(e)}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="quiet">No approvals or waivers on this booking.</p>
          )}

          <h3>Recorded</h3>
          <ul className="board-feed">
            {events.slice(0, 12).map((e) => (
              <li key={e.id}>
                <span>{traceWords(e)}</span>
                <span className="meta">
                  {fmtDay(e.timestamp)} {fmtTime(e.timestamp, tz)} · {whoDid(e)}
                </span>
              </li>
            ))}
          </ul>

          <div className="side board-papers">
            <SidePapers entry={entry} communications={commsQ.data?.items ?? []} tz={tz} sealed={!!desk?.sealed} onGo={NOOP} />
          </div>
        </section>
      </div>
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

function FactRow({ k, v, draft, missing }: { k: string; v: string; draft?: string | null; missing?: boolean }) {
  return (
    <tr className={draft ? "unsaved" : missing ? "missing" : undefined}>
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

function NoticeList({ notices, empty }: { notices: Notice[]; empty?: string }) {
  const { tz } = useHotelClock(60_000);
  if (!notices.length) return empty ? <p className="quiet">{empty}</p> : null;
  return (
    <ul className="board-notices">
      {notices.map((n) => (
        <li key={n.id} className={n.tone}>
          <Icon name={n.tone === "error" || n.tone === "warning" ? "alert" : n.tone === "success" ? "check" : "info"} />
          <span>
            {n.text}
            {n.detail ? <span className="d">{n.detail}</span> : null}
          </span>
          <span className="meta">{fmtTime(n.at, tz)}</span>
        </li>
      ))}
    </ul>
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
