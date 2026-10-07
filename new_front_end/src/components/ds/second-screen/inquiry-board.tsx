"use client";

/**
 * The second screen at Inquiry (2026-10-07, second pass) — the phone call.
 *
 * The first pass mirrored the desk, which only gave the operator a second place to look. This one
 * shows what the desk CANNOT show while they type, and tells them what to do with it:
 *
 *  - **The coach** — what to do now, the words to say to the guest, and what the next press
 *    will do (lib/ds/second-screen/coach.ts).
 *  - **The house for these dates** — rooms free per type, night by night, with the price per room
 *    for the stay (the backend's own figures, tax included), for the dates and party being typed —
 *    before they are saved, before "Ask the house". When the stay does not fit, the same stay a
 *    day or two either side.
 *  - **The guest** — a returning guest's earlier stays, what they asked for then, and anything
 *    still owed; the agency's contact when an agency booked.
 *
 * Which panel leads follows the card the operator is working in on the desk.
 */
import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Icon } from "@/design-system";
import { useSession } from "@/hooks/use-session";
import { useHotelDay } from "@/hooks/use-hotel-day";
import { previewAvailability, type AvailabilityPreview } from "@/lib/api/availability";
import { deskMoneyFor, listDeskBookings } from "@/lib/api/desk";
import type { Notice } from "@/lib/ds/second-screen/channel";
import type { DeskDraft, RoomsDraft, StayDraft } from "@/lib/ds/second-screen/drafts";
import { coachInquiry, shortWords } from "@/lib/ds/second-screen/coach";
import { guestName } from "@/lib/desk/model";
import { factsFromRow, standingOf } from "@/lib/ds/status";
import { fmtDay, fmtRange, fmtTime, money, nightsOf, plural } from "@/lib/ds/format";
import { StandingChip } from "@/components/ds/ui";
import { GuideRest } from "@/components/ds/second-screen/guide-box";
import { MoreList } from "@/components/ds/second-screen/more-list";
import type { GuideItem } from "@/lib/ds/second-screen/guide";
import type { EntryDetail } from "@/types/api";

type CatalogRoom = { roomNumber: string; roomTypeId?: string; roomType?: { id: string; name: string } | null };

export function InquiryBoard({
  entry,
  desk,
  stay,
  rooms,
  savedRooms,
  roomById,
  unsaved,
  live,
  events,
  tz,
  also,
}: {
  entry: EntryDetail;
  desk: DeskDraft | null;
  stay: StayDraft | null;
  rooms: RoomsDraft | null;
  /** The saved pick, night by night. */
  savedRooms: Map<string, string[]>;
  roomById: Map<string, CatalogRoom>;
  unsaved: string[];
  live: Notice[];
  events: Array<{ id: string; timestamp: string; words: string; who: string }>;
  tz: string;
  /** What else the guide has — answers awaited, clocks running out — shown under the coach. */
  also: GuideItem[];
}) {
  const { session } = useSession();

  /* the stay being talked about: what is typed on the desk, else what the booking holds */
  const ci = stay?.checkIn || entry.checkInDate?.slice(0, 10) || "";
  const co = stay?.checkOut || entry.checkOutDate?.slice(0, 10) || "";
  const guests = stay ? stay.adults + stay.children : entry.guestCount ?? 1;
  // the rooms the party needs — what was asked for, or more when the party cannot fit in it
  const need = stay ? Math.max(stay.rooms, stay.minRooms ?? 0) : entry.numberOfRooms ?? 1;
  const [asked, setAsked] = useState({ ci, co, guests, need });
  useEffect(() => {
    const t = window.setTimeout(() => setAsked({ ci, co, guests, need }), 350);
    return () => window.clearTimeout(t);
  }, [ci, co, guests, need]);
  const previewQ = useQuery({
    queryKey: ["availability-preview", entry.id, asked.ci, asked.co, asked.guests, asked.need],
    queryFn: () => previewAvailability(session!, entry.id, { checkInDate: asked.ci, checkOutDate: asked.co, guestCount: asked.guests, roomsNeeded: asked.need }),
    enabled: !!session && !!asked.ci && !!asked.co && asked.co > asked.ci,
    placeholderData: (prev) => prev,
    staleTime: 30_000,
    refetchInterval: 60_000,
    refetchOnWindowFocus: false,
  });
  const preview = previewQ.data ?? null;

  /* the guest's earlier stays */
  const gid = entry.guestProfile?.id ?? null;
  const staysQ = useQuery({
    queryKey: ["guest-stays", gid],
    queryFn: () => listDeskBookings(session!, { guestProfileId: gid!, limit: 50 }),
    enabled: !!session && !!gid,
    staleTime: 60_000,
  });
  const earlier = (staysQ.data?.items ?? []).filter((r) => r.id !== entry.id).sort((a, b) => String(b.checkInDate ?? "").localeCompare(String(a.checkInDate ?? "")));
  const moneyQ = useQuery({
    queryKey: ["guest-stays-money", earlier.map((r) => r.id).join(",")],
    queryFn: () => deskMoneyFor(session!, earlier.map((r) => r.id)),
    enabled: !!session && earlier.length > 0,
    staleTime: 60_000,
  });
  const owedOf = new Map((moneyQ.data?.items ?? []).map((m) => [m.entryId, m]));

  const latestRefusal = live.find((n) => n.tone === "error" && n.source === "refusal" && Date.now() - n.at < 90_000)?.text ?? null;
  const coach = coachInquiry({ desk, stay, rooms, preview, latestRefusal });

  /* which panel leads: the card the operator is in */
  const focus = desk?.focus ?? null;
  const contactMissing = (desk?.items ?? []).some((i) => i.label === "A contact on file" && !i.met);
  const guestFirst = focus
    ? focus.key === "guest" || /^(Who is asking|The guest|Rate and notes)/.test(focus.title)
    : contactMissing;

  /* rooms picked so far, by type — the draft when there is one, else the saved pick */
  const pickedByType = useMemo(() => {
    const ids = new Set<string>(rooms ? rooms.nights.flatMap((n) => n.roomIds) : [...savedRooms.values()].flat());
    const out = new Map<string, number>();
    for (const id of ids) {
      const t = roomById.get(id)?.roomType?.id ?? roomById.get(id)?.roomTypeId;
      if (t) out.set(t, (out.get(t) ?? 0) + 1);
    }
    return out;
  }, [rooms, savedRooms, roomById]);

  const house = <HousePanel preview={preview} loading={previewQ.isFetching && !preview} typed={!!stay} pickedByType={pickedByType} refused={previewQ.error instanceof Error ? previewQ.error.message : null} />;
  const guest = <GuestPanel entry={entry} earlier={earlier} loading={staysQ.isLoading} owedOf={owedOf} />;

  return (
    <div className="ib">
      <div className="ib-main">
        <section className={`ib-coach ${coach.tone}`}>
          <span className="k">{coach.tone === "fix" ? "Put this right" : coach.tone === "ready" ? "Ready" : "Now"}</span>
          <h2>{coach.now}</h2>
          {coach.how ? <p className="how">{coach.how}</p> : null}
          {coach.say ? (
            <blockquote className="say">
              <span className="k">Say to the guest</span>
              {coach.say}
            </blockquote>
          ) : null}
          {coach.then ? (
            <p className="then">
              <b>What happens next · </b>
              {coach.then}
            </p>
          ) : null}
          <GuideRest items={also} title="Also" />
          <ol className="ib-steps">
            {(desk?.items ?? []).map((i, n) => (
              <li key={`${n}-${i.label}`} className={i.met ? "met" : ""}>
                <span className="mark">{i.met ? <Icon name="check" /> : n + 1}</span>
                {i.label}
              </li>
            ))}
          </ol>
        </section>
        <div className="ib-context">
          {focus ? <p className="ib-focus">Working in <b>{focus.title || "the step"}</b> on the desk</p> : null}
          {guestFirst ? (
            <>
              {guest}
              {house}
            </>
          ) : (
            <>
              {house}
              {guest}
            </>
          )}
        </div>
      </div>
      <div className="ib-foot">
        <section>
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
        </section>
        <section>
          <h3>Problems</h3>
          {live.length ? (
            <ul className="board-notices">
              {live.slice(0, 4).map((n) => (
                <li key={n.id} className={n.tone}>
                  <Icon name="alert" />
                  <span>{n.text}</span>
                  <span className="meta">{fmtTime(n.at, tz)}</span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="quiet">None right now.</p>
          )}
        </section>
        <section>
          <h3>Recorded</h3>
          <MoreList
            className="board-feed"
            items={events}
            limit={4}
            render={(e) => (
              <li key={e.id}>
                <span>{e.words}</span>
                <span className="meta">
                  {fmtTime(e.timestamp, tz)} · {e.who}
                </span>
              </li>
            )}
          />
        </section>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */

function HousePanel({
  preview,
  loading,
  typed,
  pickedByType,
  refused,
}: {
  preview: AvailabilityPreview | null;
  loading: boolean;
  typed: boolean;
  pickedByType: Map<string, number>;
  refused: string | null;
}) {
  if (!preview) {
    return (
      <section className="ib-panel">
        <h3>The house for these dates</h3>
        <p className="quiet">{refused ?? (loading ? "Asking the house…" : "Give the stay dates on the desk and the free rooms show here.")}</p>
      </section>
    );
  }
  const nights = preview.nights;
  const many = nights.length > 14;
  return (
    <section className="ib-panel">
      <h3>
        The house for {fmtRange(preview.checkInDate, preview.checkOutDate)} · {plural(nights.length, "night")}
        <span className="h-meta">{typed ? "the dates typed on the desk — not saved yet" : "the booking's dates"}</span>
      </h3>
      <div className={`ib-verdict ${preview.fits ? "ok" : "short"}`}>
        <b>
          {preview.fits
            ? `Fits — ${plural(preview.freeEveryNight, "room")} free every night, ${preview.roomsNeeded} needed`
            : `Short — ${plural(preview.freeEveryNight, "room")} free every night, ${preview.roomsNeeded} needed`}
        </b>
        {preview.shortNights.length ? <span>Tight on {shortWords(preview)}</span> : null}
      </div>
      {!preview.fits && preview.nearby.length ? (
        <div className="ib-nearby">
          <span className="k">Nearby dates</span>
          {preview.nearby.map((n) => (
            <span key={n.checkInDate} className={`chipish ${n.fits ? "ok" : ""}`}>
              {fmtRange(n.checkInDate, n.checkOutDate)} · {n.fits ? "fits" : `${n.freeEveryNight} free`}
            </span>
          ))}
        </div>
      ) : null}
      <table className="ib-house">
        <thead>
          <tr>
            <th>Room type</th>
            <th className="num">Sleeps</th>
            <th className="num">Free all nights</th>
            {many ? null : nights.map((n) => <th key={n} className="nt">{fmtDay(n)}</th>)}
            <th className="num">Per night</th>
            <th className="num">Stay, per room</th>
          </tr>
        </thead>
        <tbody>
          {preview.types.map((t) => {
            const picked = pickedByType.get(t.roomTypeId) ?? 0;
            return (
              <tr key={t.roomTypeId} className={t.freeEveryNight === 0 ? "none" : picked ? "picked" : undefined}>
                <td>
                  <b>{t.name}</b>
                  {picked ? <span className="pk">{picked} picked</span> : null}
                </td>
                <td className="num">{t.maxCapacity ?? "—"}</td>
                <td className="num">
                  <b>{t.freeEveryNight}</b> of {t.roomsInType}
                </td>
                {many
                  ? null
                  : t.freeByNight.map((n) => (
                      <td key={n.date} className={`nt ${n.free === 0 ? "zero" : ""}`}>
                        {n.free}
                      </td>
                    ))}
                <td className="num">{t.rate != null ? money(t.rate, preview.currency) : "—"}</td>
                <td className="num">
                  <b>{t.stayPerRoomWithTax != null ? money(t.stayPerRoomWithTax, preview.currency) : "—"}</b>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <p className="meta">
        Indicative, before the quotation. Per night is the room alone, before service charge ({Math.round(preview.serviceChargeRate * 100)}%) and GST (
        {Math.round(preview.gstRate * 100)}%); the stay column includes both. Meals and extra beds are priced at Negotiation.
      </p>
    </section>
  );
}

function GuestPanel({
  entry,
  earlier,
  loading,
  owedOf,
}: {
  entry: EntryDetail;
  earlier: Awaited<ReturnType<typeof listDeskBookings>>["items"];
  loading: boolean;
  owedOf: Map<string, { currency: string | null; folio: { outstandingBalance: number | null } | null }>;
}) {
  const hotelToday = useHotelDay()?.today ?? null;
  const g = entry.guestProfile;
  const party = entry.inquiry?.travelAgent ?? entry.inquiry?.corporateAccount ?? null;
  const owing = earlier.filter((r) => (owedOf.get(r.id)?.folio?.outstandingBalance ?? 0) > 0);
  const stayed = earlier.filter((r) => r.status === "CLOSED" || ["S7", "S8", "S9"].includes(r.currentStage));
  return (
    <section className="ib-panel">
      <h3>The guest</h3>
      <div className="ib-who">
        <b>{guestName(g)}</b>
        {g?.vipTier ? <span className="vip">VIP</span> : null}
        <span>{[g?.phone, g?.email, g?.nationality].filter(Boolean).join(" · ") || "no phone or email yet"}</span>
      </div>
      {party ? (
        <div className="ib-agency">
          <span className="k">{entry.inquiry?.travelAgent ? "Booked through the agency" : "Booked by the company"}</span>
          <b>{party.displayName}</b>
          <span>{[party.contactNumbers?.[0], party.contactEmail].filter(Boolean).join(" · ") || "no contact on file"}</span>
          {entry.contactPersonName || entry.contactPersonPhone ? (
            <span>
              Contact person: {[entry.contactPersonName, entry.contactPersonPhone].filter(Boolean).join(" · ")}
            </span>
          ) : null}
        </div>
      ) : null}
      {loading ? (
        <p className="quiet">Looking for earlier stays…</p>
      ) : earlier.length === 0 ? (
        <p className="ib-new">First booking with us — no earlier stays under this guest.</p>
      ) : (
        <>
          <p className={`ib-returning${owing.length ? " owes" : stayed.length ? "" : " known"}`}>
            {stayed.length ? (
              <>
                <b>Returning guest</b> · stayed with us {plural(stayed.length, "time")}
                {earlier.length > stayed.length ? ` · ${plural(earlier.length - stayed.length, "other booking")}` : ""}
              </>
            ) : (
              <>
                <b>Known to us</b> · {plural(earlier.length, "other booking")}, no stay yet
              </>
            )}
            {owing.length ? ` · still owes on ${plural(owing.length, "booking")}` : ""}
          </p>
          <table className="ib-history">
            <thead>
              <tr>
                <th>Dates</th>
                <th>Rooms</th>
                <th>How it went</th>
                <th>What they asked for</th>
                <th className="num">Still owed</th>
              </tr>
            </thead>
            <tbody>
              {earlier.slice(0, 8).map((r) => {
                const m = owedOf.get(r.id);
                const owed = m?.folio?.outstandingBalance ?? null;
                return (
                  <tr key={r.id}>
                    <td>
                      {fmtRange(r.checkInDate, r.checkOutDate)}
                      <span className="meta"> · {plural(nightsOf(r.checkInDate, r.checkOutDate) ?? 0, "night")}</span>
                    </td>
                    <td>{r.roomNumbers.length ? r.roomNumbers.join(", ") : "—"}</td>
                    <td>
                      <StandingChip standing={standingOf(factsFromRow(r), hotelToday)} />
                    </td>
                    <td>{r.inquiry?.notes?.trim() || "—"}</td>
                    <td className={`num${owed && owed > 0 ? " owes" : ""}`}>{owed && owed > 0 ? money(owed, m?.currency ?? "BTN") : "—"}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </>
      )}
    </section>
  );
}
