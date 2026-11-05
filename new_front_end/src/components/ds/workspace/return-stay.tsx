"use client";

/**
 * The trip — one enquiry, more than one stay (2026-09-25, operator ruling).
 *
 * "We stay two nights, go to Punakha, and stay again on the way back" is two bookings: each holds
 * its own rooms for its own nights, is checked in and out on its own and — the operator's choice
 * of the three offered — keeps its own folio, its own bill and its own tax invoice. The room in
 * between has to stay sellable, and a tax invoice covers one stay.
 *
 * What links them is the ENQUIRY. Both stays hang off the same one, so its number is the trip's
 * file number, the agency, the rate package and the notes are shared by construction, and either
 * booking can show the other. The desk never searches for the guest twice, which is also what
 * stops a second guest record being typed by mistake on the return visit.
 *
 * Since 2026-11-03 (operator): adding a return stay leaves the desk on the stay it was on, the
 * booking head chooses between the stays, and the new stay is set up either the same as this one
 * — it then copies it through Negotiation — or with different settings.
 */
import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Button, Chip, Icon } from "@/design-system";
import { bookingHref } from "@/components/ds/ui";
import { StayDates } from "@/components/ds/stay-dates";
import { useSession } from "@/hooks/use-session";
import { useHotelDay } from "@/hooks/use-hotel-day";
import { addReturnStay, chooseFollowRooms, getTripFollow, startFollowing, stopFollowing, type FollowShortfallView, type FollowView } from "@/lib/api/entries";
import { fmtStay, money, nightsOf, plural } from "@/lib/ds/format";
import { stepName, stepNoOfStage } from "@/lib/ds/steps";
import { DsDialog, Overlay, StepCard, toastRefusal, useRefreshEntry } from "@/components/ds/steps/kit";
import type { EntryDetail, TripStaySummary } from "@/types/api";
import { DateInput } from "@/components/ds/date-input";

/** A trip that is over — the next visit is a fresh enquiry, not a return stay on this one. */
const SEALED = new Set(["CANCELLED", "EXPIRED", "CLOSED"]);

export type Trip = {
  /** Every stay on this enquiry, oldest first, this one included. */
  stays: TripStaySummary[];
  /** Where this booking sits in the trip, 1-based; 0 when the payload carries no list. */
  position: number;
  others: TripStaySummary[];
  /** The last night the trip covers so far — where a return stay starts by default. */
  lastCheckOut: string | null;
};

export function tripOf(entry: EntryDetail): Trip {
  const stays = entry.inquiry?.entries ?? [];
  const others = stays.filter((s) => s.id !== entry.id);
  const lastCheckOut = stays.reduce<string | null>((acc, s) => {
    const co = s.checkOutDate?.slice(0, 10) ?? null;
    return co && (!acc || co > acc) ? co : acc;
  }, null);
  return { stays, position: stays.findIndex((s) => s.id === entry.id) + 1, others, lastCheckOut };
}

function addDays(ymd: string, days: number): string {
  if (!ymd) return "";
  const d = new Date(`${ymd}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return "";
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** What this stay copies and which stays copy it, re-read whenever the booking changes. */
export function useTripFollow(entry: EntryDetail) {
  const { session } = useSession();
  const many = (entry.inquiry?.entries ?? []).length > 1;
  return useQuery({
    queryKey: ["trip-follow", entry.id, entry.updatedAt],
    queryFn: () => getTripFollow(session!, entry.id),
    enabled: !!session && many,
  });
}

function stayStanding(s: TripStaySummary): { words: string; off: boolean } {
  if (s.status === "CANCELLED") return { words: "cancelled", off: true };
  if (s.status === "EXPIRED") return { words: "lapsed", off: true };
  const step = stepName(stepNoOfStage(s.currentStage));
  return { words: s.status === "PARKED" ? `${step} · waiting` : step, off: false };
}

/* ------------------------------------------------------------------ the list */

/** One line per stay of the trip, this one marked, the others opening in the workspace. */
export function TripStays({ entry }: { entry: EntryDetail }) {
  const trip = tripOf(entry);
  if (trip.stays.length < 2) return null;
  return (
    <div className="trip-stays">
      {trip.stays.map((s, i) => {
        const here = s.id === entry.id;
        const standing = stayStanding(s);
        return (
          <div key={s.id} className="trip-stay">
            <span className="meta">Stay {i + 1}</span>
            <span className={standing.off ? "dash" : "sm"}>
              <StayDates checkIn={s.checkInDate} checkOut={s.checkOutDate} />
              {s.numberOfRooms ? ` · ${plural(s.numberOfRooms, "room")}` : ""}
              {` · ${standing.words}`}
            </span>
            {here ? <Chip tone="accent">this one</Chip> : <Link href={bookingHref(s.id)}>{s.id}</Link>}
          </div>
        );
      })}
    </div>
  );
}

/* ------------------------------------------------------------------ the head */

/**
 * Choosing the stay, in the booking head (2026-11-03, operator: "in the booking head we need option
 * to choose the entry, maybe a dropdown on where entry is being shown, when the drop down is clicked
 * it can show check in date and check out date as extra info"). With one stay it is just the number.
 * Each other stay is a link, so moving to it parks and resumes as any move between stays does.
 */
export function StayPicker({ entry }: { entry: EntryDetail }) {
  const trip = tripOf(entry);
  const follow = useTripFollow(entry);
  const [open, setOpen] = useState(false);
  const [at, setAt] = useState<{ top: number; left: number } | null>(null);
  const btnRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const place = useCallback(() => {
    const b = btnRef.current?.getBoundingClientRect();
    if (b) setAt({ top: Math.round(b.bottom + 6), left: Math.round(b.left) });
  }, []);
  useEffect(() => setOpen(false), [entry.id]);
  useEffect(() => {
    if (!open) return;
    place();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (menuRef.current?.contains(t) || btnRef.current?.contains(t)) return;
      setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("mousedown", onDown);
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [open, place]);

  if (trip.stays.length < 2) {
    return (
      <span className="refid" title="The booking's number">
        {entry.id}
      </span>
    );
  }
  const shortOf = new Set((follow.data?.followers ?? []).filter((f) => f.shortfall).map((f) => f.entryId));
  if (follow.data?.following?.shortfall) shortOf.add(entry.id);
  return (
    <span className="refid">
      <button ref={btnRef} type="button" className="stay-pick" aria-haspopup="menu" aria-expanded={open} title="Choose a stay of this trip" onClick={() => setOpen((v) => !v)}>
        {entry.id}
        <span className="meta">
          stay {trip.position} of {trip.stays.length}
        </span>
        <Icon name="chev" className="cb-chev" />
      </button>
      {open && at ? (
        <Overlay>
          <div className="stay-menu" role="menu" aria-label="The stays of this trip" ref={menuRef} style={{ top: at.top, left: at.left }}>
            {trip.stays.map((s, i) => {
              const here = s.id === entry.id;
              const standing = stayStanding(s);
              const nights = nightsOf(s.checkInDate, s.checkOutDate);
              const body = (
                <>
                  <span className="si-head">
                    <b>Stay {i + 1}</b>
                    <span className="si-id">{s.id}</span>
                    {here ? <Chip tone="accent">open now</Chip> : null}
                  </span>
                  <StayDates checkIn={s.checkInDate} checkOut={s.checkOutDate} />
                  <span className={standing.off ? "si-line stop-ink" : "si-line"}>
                    {[nights ? plural(nights, "night") : null, s.numberOfRooms ? plural(s.numberOfRooms, "room") : null, standing.words].filter(Boolean).join(" · ")}
                  </span>
                  {shortOf.has(s.id) ? <span className="si-short">Its rooms need choosing</span> : null}
                </>
              );
              return here ? (
                <div key={s.id} className="stay-item here" role="menuitem" aria-current="true">
                  {body}
                </div>
              ) : (
                <Link key={s.id} className="stay-item" role="menuitem" href={bookingHref(s.id)}>
                  {body}
                </Link>
              );
            })}
          </div>
        </Overlay>
      ) : null}
    </span>
  );
}

/* ------------------------------------------------------------------ the act */

/** The intake keeps the lead, then the booking opens with the return stay's box already up. */
let openOnArrival: string | null = null;
export function openReturnStayOnArrival(entryId: string) {
  openOnArrival = entryId;
}

export function AddReturnStay({
  entry,
  kind = "quiet",
  shutReason,
  prepare,
  fromAfter,
}: {
  entry: EntryDetail;
  kind?: "quiet" | "secondary";
  /** Why it cannot be pressed yet, in words. */
  shutReason?: string | null;
  /** Save what is typed on the stay first; false leaves the box shut. */
  prepare?: () => Promise<boolean>;
  /** The check-out typed on the stay, which may not be saved yet. */
  fromAfter?: string | null;
}) {
  const [open, setOpen] = useState(false);
  const [preparing, setPreparing] = useState(false);
  const sealed = SEALED.has(entry.status ?? "");
  useEffect(() => {
    if (openOnArrival === entry.id) {
      openOnArrival = null;
      setOpen(true);
    }
  }, [entry.id]);
  const shut = sealed ? "this booking is closed — the guest's next visit starts a fresh enquiry" : (shutReason ?? null);
  return (
    <>
      <Button
        kind={kind}
        compact
        state={preparing ? "working" : shut ? "inert" : "default"}
        workingLabel="Saving the stay…"
        title={shut ?? "the guest leaves and comes back: a second booking under this enquiry"}
        onClick={() => {
          if (shut || preparing) return;
          if (!prepare) {
            setOpen(true);
            return;
          }
          setPreparing(true);
          void prepare()
            .then((ok) => {
              if (ok) setOpen(true);
            })
            .finally(() => setPreparing(false));
        }}
      >
        Add a return stay
      </Button>
      {open ? <ReturnStayDialog entry={entry} fromAfter={fromAfter ?? null} onClose={() => setOpen(false)} /> : null}
    </>
  );
}

type Stage =
  | { at: "dates" }
  | { at: "options"; created: { id: string; checkInDate: string; checkOutDate: string } }
  | { at: "short"; created: { id: string; checkInDate: string; checkOutDate: string }; shortfall: FollowShortfallView };

function ReturnStayDialog({ entry, fromAfter, onClose }: { entry: EntryDetail; fromAfter: string | null; onClose: () => void }) {
  const { session } = useSession();
  const qc = useQueryClient();
  const refresh = useRefreshEntry(entry.id);
  const day = useHotelDay();
  const trip = tripOf(entry);

  const [stage, setStage] = useState<Stage>({ at: "dates" });
  const [from, setFrom] = useState(() => {
    const dates = [trip.lastCheckOut, fromAfter, entry.checkOutDate?.slice(0, 10)].filter((d): d is string => !!d);
    return dates.sort().at(-1) ?? "";
  });
  const [nights, setNights] = useState("1");
  const nightsN = Math.max(1, parseInt(nights || "1", 10) || 1);
  const to = useMemo(() => addDays(from, nightsN), [from, nightsN]);
  const past = !!day && !!from && from < day.today;
  const ok = !!from && !!to && !past;

  const add = useMutation({
    mutationFn: () => addReturnStay(session!, entry.id, { checkInDate: from, checkOutDate: to }),
    onSuccess: (created) => {
      // The desk stays where it is (2026-11-03): the new stay shows in the head's list.
      refresh([["trip-follow", entry.id]]);
      setStage({ at: "options", created: { id: created.id, checkInDate: from, checkOutDate: to } });
    },
    onError: (e) => toastRefusal(e, "The return stay was not added."),
  });

  const created = stage.at === "dates" ? null : stage.created;
  const stayNo = (() => {
    const at = created ? trip.stays.findIndex((s) => s.id === created.id) : -1;
    return at >= 0 ? at + 1 : trip.stays.length + 1;
  })();

  const same = useMutation({
    mutationFn: () => startFollowing(session!, created!.id, entry.id),
    onSuccess: (out) => {
      refresh([["trip-follow", entry.id]]);
      void qc.invalidateQueries({ queryKey: ["entry", created!.id] });
      for (const n of out.notes) toast.warning(n);
      if (out.shortfall) {
        promptedShortfalls.add(`${created!.id}|${out.shortfall.key}`);
        setStage({ at: "short", created: created!, shortfall: out.shortfall });
        return;
      }
      toast.success(
        out.changed.includes("rooms")
          ? `Stay ${stayNo} is set up the same as this stay`
          : `Stay ${stayNo} copies this stay — its rooms and meal plans follow as you choose them here`,
        { description: "It stays the same until it is priced at Negotiation." },
      );
      onClose();
    },
    onError: (e) => toastRefusal(e, "This stay could not be copied"),
  });

  const different = () => {
    toast.success(`Stay ${stayNo} is added`, { description: "Open it from the stay list at the top of the page to choose its settings." });
    onClose();
  };

  if (stage.at === "short") {
    return <ShortRoomsDialog stayNo={stayNo} stayId={stage.created.id} checkIn={stage.created.checkInDate} checkOut={stage.created.checkOutDate} shortfall={stage.shortfall} onClose={onClose} sourceEntryId={entry.id} />;
  }

  if (stage.at === "options") {
    return (
      <DsDialog
        open
        onClose={different}
        closeX
        busy={same.isPending}
        register="report"
        width={560}
        title={`Stay ${stayNo} is added. How should it be set up?`}
        caseLines={[stage.created.id, <StayDates key="stay" checkIn={stage.created.checkInDate} checkOut={stage.created.checkOutDate} />]}
        footer={<span className="meta">Either way you stay on this stay. Open the new one from the list at the top of the page.</span>}
      >
        <div className="rs-opts">
          <button type="button" className="rs-opt" disabled={same.isPending} onClick={() => same.mutate()}>
            <b>{same.isPending ? "Copying…" : "Same as this stay"}</b>
            <span>The guests, children&apos;s ages, rooms, room types, meal plans and extra beds are copied from {entry.id}. They stay the same until stay {stayNo} is priced at Negotiation.</span>
          </button>
          <button type="button" className="rs-opt" disabled={same.isPending} onClick={different}>
            <b>Different settings</b>
            <span>You choose its rooms and meal plans on stay {stayNo}. It starts with the same guests, which you can change there.</span>
          </button>
        </div>
      </DsDialog>
    );
  }

  return (
    <DsDialog
      open
      onClose={onClose}
      busy={add.isPending}
      width={560}
      title="They are coming back"
      help="A second booking under the same enquiry: it holds its own rooms for its own nights and carries its own bill, so the room is free to sell in between."
      caseLines={[entry.inquiry?.id ?? entry.id, `${plural(trip.stays.length, "stay")} so far`]}
      footer={
        <>
          <Button kind="quiet" state={add.isPending ? "inert" : "default"} onClick={onClose}>
            Not now
          </Button>
          <Button
            className={ok ? "go" : undefined}
            state={add.isPending ? "working" : ok ? "default" : "inert"}
            title={!from ? "put in the day they come back" : past ? "a return stay starts today or later" : undefined}
            workingLabel="Adding…"
            onClick={() => add.mutate()}
          >
            Add the return stay
          </Button>
        </>
      }
    >
      <div className="form2">
        <div className="field">
          <label>Coming back on</label>
          <DateInput className="input" value={from} min={day?.today ?? undefined} onChange={(e) => setFrom(e.target.value)} />
        </div>
        <div className="field">
          <label>Nights</label>
          <input className="input" inputMode="numeric" value={nights} onChange={(e) => setNights(e.target.value.replace(/[^0-9]/g, ""))} />
          <span className="hint">{to ? fmtStay(from, to) : "put in the day they come back"}</span>
        </div>
      </div>
      {trip.stays.length > 1 ? <p className="meta" style={{ marginTop: 8 }}>A night already on this enquiry is refused: that would be the same stay twice.</p> : null}
    </DsDialog>
  );
}

/* ------------------------------------------------------------------ rooms not free */

/** Shortfalls already asked about, so one is not asked twice while the desk works. */
const promptedShortfalls = new Set<string>();

type RoomPick = { roomTypeId: string; name: string; count: number };

/**
 * The room type chosen on the first stay is not free on this stay's nights (2026-11-03, operator:
 * "prompt the user and in that box itself, show another pop up showing list of available room
 * types"). What is free stays chosen; the rest are picked from the list, and saved for this stay.
 */
export function ShortRoomsDialog({
  stayNo,
  stayId,
  sourceEntryId,
  checkIn,
  checkOut,
  shortfall,
  onClose,
}: {
  stayNo: number;
  stayId: string;
  sourceEntryId: string;
  checkIn: string | null;
  checkOut: string | null;
  shortfall: FollowShortfallView;
  onClose: () => void;
}) {
  const { session } = useSession();
  const qc = useQueryClient();
  const needed = shortfall.rooms || shortfall.wanted.reduce((a, w) => a + w.count, 0);
  const [picks, setPicks] = useState<RoomPick[]>(() => {
    let left = needed;
    const out: RoomPick[] = [];
    for (const w of shortfall.wanted) {
      const c = Math.min(w.canTake, left);
      if (c > 0) out.push({ roomTypeId: w.roomTypeId, name: w.name, count: c });
      left -= c;
    }
    return out;
  });
  const chosen = picks.reduce((a, p) => a + p.count, 0);
  const missing = Math.max(0, needed - chosen);
  const [listOpen, setListOpen] = useState(false);
  const pick = (t: { roomTypeId: string; name: string }) => {
    setPicks((cur) => {
      const has = cur.find((p) => p.roomTypeId === t.roomTypeId);
      return has ? cur.map((p) => (p === has ? { ...p, count: p.count + 1 } : p)) : [...cur, { roomTypeId: t.roomTypeId, name: t.name, count: 1 }];
    });
    if (missing <= 1) setListOpen(false);
  };
  const unpick = (id: string) => setPicks((cur) => cur.flatMap((p) => (p.roomTypeId !== id ? [p] : p.count > 1 ? [{ ...p, count: p.count - 1 }] : [])));

  const save = useMutation({
    mutationFn: () => chooseFollowRooms(session!, stayId, picks.map((p) => ({ roomTypeId: p.roomTypeId, count: p.count }))),
    onSuccess: () => {
      toast.success(`Stay ${stayNo}'s rooms are saved`, { description: picks.map((p) => `${p.count} ${p.name}`).join(" · ") });
      for (const id of [stayId, sourceEntryId]) {
        void qc.invalidateQueries({ queryKey: ["entry", id] });
        void qc.invalidateQueries({ queryKey: ["trip-follow", id] });
      }
      onClose();
    },
    onError: (e) => toastRefusal(e, "Those rooms could not be saved"),
  });

  return (
    <>
      <DsDialog
        open
        onClose={onClose}
        busy={save.isPending}
        register="danger"
        width={600}
        title={`Stay ${stayNo} cannot take the same rooms`}
        caseLines={[stayId, <StayDates key="stay" checkIn={checkIn} checkOut={checkOut} />]}
        footer={
          <>
            <Button kind="quiet" state={save.isPending ? "inert" : "default"} onClick={onClose}>
              Not now
            </Button>
            <Button
              className={missing === 0 ? "go" : undefined}
              state={save.isPending ? "working" : missing === 0 ? "default" : "inert"}
              workingLabel="Saving…"
              title={missing === 0 ? undefined : `choose ${plural(missing, "more room")} first`}
              onClick={() => save.mutate()}
            >
              Save these rooms
            </Button>
          </>
        }
      >
        <div className="short-alert" role="alert">
          <span className="short-mark" aria-hidden>
            !
          </span>
          <div>
            {shortfall.refusals.map((r) => (
              <div key={r}>{r}</div>
            ))}
          </div>
        </div>
        <div className="short-need">
          <span>
            Stay {stayNo} needs <b>{plural(needed, "room")}</b>
          </span>
          {missing > 0 ? <b className="stop-ink">{plural(missing, "more room")} to choose</b> : <b className="ok-ink">All chosen</b>}
        </div>
        {picks.length ? (
          <div className="short-picks">
            {picks.map((p) => (
              <span key={p.roomTypeId} className="short-pick">
                {p.count} {p.name}
                <button type="button" aria-label={`Take off one ${p.name}`} title={`Take off one ${p.name}`} onClick={() => unpick(p.roomTypeId)}>
                  ×
                </button>
              </span>
            ))}
          </div>
        ) : null}
        <div style={{ marginTop: 12 }}>
          <Button className={missing > 0 ? "go" : undefined} kind={missing > 0 ? undefined : "secondary"} state={missing > 0 ? "default" : "inert"} onClick={() => setListOpen(true)}>
            See the free room types
          </Button>
        </div>
      </DsDialog>
      {listOpen ? <FreeTypesDialog shortfall={shortfall} picks={picks} missing={missing} checkIn={checkIn} checkOut={checkOut} onPick={pick} onClose={() => setListOpen(false)} /> : null}
    </>
  );
}

function FreeTypesDialog({
  shortfall,
  picks,
  missing,
  checkIn,
  checkOut,
  onPick,
  onClose,
}: {
  shortfall: FollowShortfallView;
  picks: RoomPick[];
  missing: number;
  checkIn: string | null;
  checkOut: string | null;
  onPick: (t: { roomTypeId: string; name: string }) => void;
  onClose: () => void;
}) {
  // This pop-up sits on the box that opened it, so Escape closes only this one.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      onClose();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);
  return (
    <DsDialog
      open
      onClose={onClose}
      register="report"
      width={520}
      title="Free room types"
      caseLines={[<StayDates key="stay" checkIn={checkIn} checkOut={checkOut} />, `${plural(missing, "more room")} to choose`]}
      help="Free means a room of the type is open for every night of this stay."
      footer={
        <Button kind="quiet" onClick={onClose}>
          Close
        </Button>
      }
    >
      <div className="rs-types">
        {shortfall.types.map((t) => {
          const left = t.free - (picks.find((p) => p.roomTypeId === t.roomTypeId)?.count ?? 0);
          const none = left <= 0;
          return (
            <button key={t.roomTypeId} type="button" className="rs-type" disabled={none} onClick={() => onPick(t)}>
              <b>{t.name}</b>
              <span className={none ? "stop-ink" : left === 1 ? "warn-ink" : "ok-ink"}>{none ? "none free" : left === 1 ? "only 1 free" : `${left} free`}</span>
              <span className="rs-rate">{t.ratePerNight != null ? `${money(t.ratePerNight, shortfall.currency)} a night` : ""}</span>
            </button>
          );
        })}
      </div>
    </DsDialog>
  );
}

/** A later save on this stay that another stay could not copy: asked once, here, as it happens. */
export function TripFollowPrompt({ entry }: { entry: EntryDetail }) {
  const follow = useTripFollow(entry);
  const trip = tripOf(entry);
  const [shown, setShown] = useState<FollowView | null>(null);
  const waiting = (follow.data?.followers ?? []).find((f) => f.shortfall && !promptedShortfalls.has(`${f.entryId}|${f.shortfall.key}`)) ?? null;
  const waitingKey = waiting ? `${waiting.entryId}|${waiting.shortfall!.key}` : null;
  useEffect(() => {
    if (!waiting || !waitingKey || shown) return;
    promptedShortfalls.add(waitingKey);
    setShown(waiting);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [waitingKey]);
  if (!shown?.shortfall) return null;
  const at = trip.stays.findIndex((s) => s.id === shown.entryId);
  return <ShortRoomsDialog stayNo={at >= 0 ? at + 1 : trip.stays.length} stayId={shown.entryId} sourceEntryId={entry.id} checkIn={shown.checkInDate} checkOut={shown.checkOutDate} shortfall={shown.shortfall} onClose={() => setShown(null)} />;
}

/** On a stay that copies another: what it copies, and the way to stop. */
export function FollowNotice({ entry }: { entry: EntryDetail }) {
  const { session } = useSession();
  const refresh = useRefreshEntry(entry.id);
  const trip = tripOf(entry);
  const follow = useTripFollow(entry);
  const [choosing, setChoosing] = useState(false);
  const stop = useMutation({
    mutationFn: () => stopFollowing(session!, entry.id),
    onSuccess: () => {
      refresh([["trip-follow", entry.id]]);
      toast.success("This stay's settings are its own now");
    },
    onError: (e) => toastRefusal(e, "That could not be changed"),
  });
  const from = entry.followsEntryId;
  if (!from) return null;
  const view = follow.data?.following ?? null;
  const at = trip.stays.findIndex((s) => s.id === from);
  const atInquiry = entry.currentStage === "S1";
  return (
    <>
      <div className="notice follow">
        <span className="sm">
          <b>Same as {at >= 0 ? `stay ${at + 1}` : from}</b> · {from} —{" "}
          {atInquiry
            ? "its guests, rooms, meal plans and extra beds are copied here until this stay is priced. Changing any of them here ends the copying."
            : "its meal plans and extra beds are copied here until this stay is priced. Its rooms are this stay's own now."}
        </span>
        <Button kind="quiet" compact state={stop.isPending ? "working" : "default"} workingLabel="Saving…" onClick={() => stop.mutate()}>
          Set its own
        </Button>
      </div>
      {(view?.notes ?? []).map((n) => (
        <div key={n} className="notice next">
          <span className="sm">{n}</span>
        </div>
      ))}
      {view?.shortfall ? (
        <div className="short-alert standing" role="alert">
          <span className="short-mark" aria-hidden>
            !
          </span>
          <div className="short-lines">
            {view.shortfall.refusals.map((r) => (
              <div key={r}>{r}</div>
            ))}
          </div>
          <Button className="go" compact onClick={() => setChoosing(true)}>
            Choose its rooms
          </Button>
        </div>
      ) : null}
      {choosing && view?.shortfall ? (
        <ShortRoomsDialog
          stayNo={trip.position || 2}
          stayId={entry.id}
          sourceEntryId={from}
          checkIn={view.checkInDate}
          checkOut={view.checkOutDate}
          shortfall={view.shortfall}
          onClose={() => {
            setChoosing(false);
            refresh([["trip-follow", entry.id]]);
          }}
        />
      ) : null}
    </>
  );
}

/* ------------------------------------------------------------------ the card */

/** Booking details' "This trip" — every stay of the enquiry, and the way to add the next one. */
export function TripCard({ entry }: { entry: EntryDetail }) {
  const trip = tripOf(entry);
  const many = trip.stays.length > 1;
  return (
    <StepCard
      title="This trip"
      right={<AddReturnStay entry={entry} />}
      status={many ? `${plural(trip.stays.length, "stay")} on enquiry ${entry.inquiry?.id ?? "—"}` : `One stay, on enquiry ${entry.inquiry?.id ?? "—"}`}
      meta={
        many
          ? "Each stay holds its own rooms and carries its own bill."
          : "If the guest leaves and comes back, add the return stay here rather than starting again."
      }
    >
      {many ? <TripStays entry={entry} /> : null}
    </StepCard>
  );
}
