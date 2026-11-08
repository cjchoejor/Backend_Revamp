"use client";

/**
 * Change configuration for the stays worked in one table (2026-11-09, operator: "can it show the
 * change ui of both stays in one, but like efficiently, like how its shown in s1 for the available
 * rooms"). A line per stay for its dates and party, then their room types side by side; the house is
 * asked by itself for each stay's dates. Each stay is still its own governed change, with every check
 * the panel for one stay has: this draws them together and saves those that moved, one after another.
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useMutation } from "@tanstack/react-query";
import { toast } from "sonner";
import { Button } from "@/design-system";
import { Help } from "@/components/ds/help";
import { DateInput } from "@/components/ds/date-input";
import { fmtStay, plural } from "@/lib/ds/format";
import type { EntryDetail } from "@/types/api";
import { enumerateNights } from "./use-room-selection";
import { RoomCountField } from "./new-inquiry-parts";
import { Count, RoomsByNumberPick, useChangeConfiguration, type ChangeConfig } from "./s2-configuration";
import { RoomsByType, typeOrderOf } from "./s1-by-type";
import { toastRefusal } from "./kit";

/** Every stay's change, each from its own hook, handed on together. */
function StayChanges({
  stays,
  stayNoOf,
  at,
  got,
  render,
}: {
  stays: EntryDetail[];
  stayNoOf: (id: string) => number;
  at: number;
  got: ChangeConfig[];
  render: (list: ChangeConfig[]) => ReactNode;
}) {
  const c = useChangeConfiguration({ entry: stays[at], onDone: noop, quiet: true, prefix: `Stay ${stayNoOf(stays[at].id)} · ` });
  const list = [...got, c];
  return at + 1 < stays.length ? <StayChanges stays={stays} stayNoOf={stayNoOf} at={at + 1} got={list} render={render} /> : <>{render(list)}</>;
}
const noop = () => {};

function StayLine({ c, stayNo, showAges }: { c: ChangeConfig; stayNo: number; showAges: boolean }) {
  const { checkIn, setCheckIn, nights, setNights, checkOut, startsBeforeToday, hotelDay, adults, setAdults, children, setChildren, setAges, ageInputs, env, envMin, envMax, roomCount, setRooms, policy, overCapacity, roomsOutOfRange, nothingMoved, childCount } = c;
  return (
    <div className="cfg-stay-row">
      <div className="cfg-stay-no">
        Stay {stayNo}
        {nothingMoved ? null : <small>changed</small>}
      </div>
      <div className="field">
        <label>Check-in</label>
        <DateInput className="input" value={checkIn} min={hotelDay?.today} onChange={(e) => setCheckIn(e.target.value)} />
      </div>
      <Count label="Nights" value={nights} onChange={setNights} min={1} max={90} />
      <div className="field">
        <label>Check-out</label>
        <DateInput
          className="input"
          value={checkOut}
          min={checkIn || undefined}
          onChange={(e) => {
            const n = enumerateNights(checkIn, e.target.value).length;
            if (n >= 1) setNights(String(n));
          }}
        />
      </div>
      <Count label="Adults" value={adults} onChange={setAdults} min={1} />
      <Count
        label="Children"
        value={children}
        onChange={(v) => {
          setChildren(v);
          const n = Number(v || "0");
          setAges((prev) => Array.from({ length: n }, (_, i) => prev[i] ?? ""));
        }}
      />
      <RoomCountField env={env} rooms={roomCount} adultFrom={(policy.data?.ageBands.childMaxAge ?? 10) + 1} onChange={(n) => setRooms(String(n))} />
      {showAges ? (
        <div className="cfg-stay-ages">
          {childCount === 0 ? (
            <span className="meta" style={{ paddingTop: 6 }}>
              —
            </span>
          ) : (
            ageInputs.map((a, i) => (
              <input
                key={i}
                className="input"
                inputMode="numeric"
                aria-label={`Stay ${stayNo}, child ${i + 1}'s age`}
                placeholder={`${i + 1}`}
                value={a}
                onChange={(e) => {
                  const v = e.target.value.replace(/\D/g, "").slice(0, 2);
                  setAges((prev) => {
                    const next = [...prev];
                    next[i] = v;
                    return next;
                  });
                }}
              />
            ))
          )}
        </div>
      ) : null}
      {startsBeforeToday ? (
        <p className="cfg-stop cfg-stay-msg" role="alert">
          Stay {stayNo} can start today or later.
        </p>
      ) : null}
      {overCapacity ? (
        <p className="cfg-stop cfg-stay-msg" role="alert">
          Stay {stayNo}&rsquo;s party cannot be accommodated — the house sleeps {env?.hotelMaxOccupants} across its {env?.hotelRoomCount} rooms.
        </p>
      ) : null}
      {!overCapacity && roomsOutOfRange && env ? (
        <p className="cfg-stop cfg-stay-msg" role="alert">
          {roomCount < (envMin ?? 0)
            ? `Stay ${stayNo}: ${plural(env.chargeableOccupants, "chargeable guest")} will not fit in ${plural(roomCount, "room")} — ask for at least ${envMin}.`
            : `Stay ${stayNo}: ${plural(roomCount, "room")} is more than this party needs — at most ${envMax}.`}
        </p>
      ) : null}
    </div>
  );
}

function Panel({ list, stayNoOf, onClose, onChanged }: { list: ChangeConfig[]; stayNoOf: (id: string) => number; onClose: () => void; onChanged: () => void }) {
  const noState = useRef(() => {}).current;
  const noSaveRef = useRef(() => {}).current;
  const typeOrder = useMemo(() => typeOrderOf(list[0].catalog), [list[0].catalog]); // eslint-disable-line react-hooks/exhaustive-deps

  // The house is asked by itself: when the panel opens, and when a stay's dates change.
  const asked = useRef<Record<string, string>>({});
  const latest = useRef(list);
  latest.current = list;
  const key = list.map((c) => `${c.entry.id}:${c.datesKey}:${c.startsBeforeToday}`).join("|");
  useEffect(() => {
    const t = setTimeout(() => {
      for (const c of latest.current) {
        if (!c.checkIn || !c.checkOut || c.startsBeforeToday) continue;
        if (asked.current[c.entry.id] === c.datesKey) continue;
        asked.current[c.entry.id] = c.datesKey;
        c.ask.mutate();
      }
    }, 450);
    return () => clearTimeout(t);
  }, [key]);
  const asking = list.some((c) => c.ask.isPending);
  const failed = list.filter((c) => c.ask.isError && !c.result);
  const allAnswered = list.every((c) => !!c.result);

  const showAges = list.some((c) => c.childCount > 0);
  const moving = list.filter((c) => !c.nothingMoved);
  const held = moving.find((c) => c.blocked && !c.pending);
  const needsApproval = moving.some((c) => c.needsApproval);
  const [saving, setSaving] = useState(false);
  const blocked = moving.length === 0 || moving.some((c) => c.blocked) || saving;
  const reason = moving.length === 0 ? "Nothing has changed yet" : held ? `Stay ${stayNoOf(held.entry.id)}: ${held.saveReason ?? "not ready"}` : undefined;
  const saveAll = useMutation({
    mutationFn: async () => {
      setSaving(true);
      let done = 0;
      for (const c of latest.current.filter((x) => !x.nothingMoved)) {
        // Each says what it did or why it was refused; a refusal stops the rest.
        await c.save.mutateAsync();
        done++;
      }
      return done;
    },
    onSuccess: () => {
      onChanged();
      onClose();
    },
    onError: (e) => {
      onChanged();
      toastRefusal(e, "Not every stay was changed");
    },
    onSettled: () => setSaving(false),
  });

  return (
    <div className="cfg-change cfg-trip">
      <div className="cfg-head">
        <div>
          <b>Change the dates, the rooms and the party</b>
          <Help label="About changing the stays">
            <p>A line for each stay, then its room types. The house is asked by itself for each stay&rsquo;s dates.</p>
            <p>Each stay is saved as its own change, and any quotation priced on the old configuration is retired.</p>
          </Help>
        </div>
        <Button kind="quiet" compact onClick={onClose}>
          Cancel
        </Button>
      </div>

      <section>
        <b className="cfg-n">1 · The stays</b>
        <div className={`cfg-stays${showAges ? " has-ages" : ""}`}>
          <div className="cfg-stays-h">
            <span />
            <span>Check-in</span>
            <span>Nights</span>
            <span>Check-out</span>
            <span>Adults</span>
            <span>Children</span>
            <span>Rooms</span>
            {showAges ? <span>Their ages</span> : null}
          </div>
          {list.map((c) => (
            <StayLine key={c.entry.id} c={c} stayNo={stayNoOf(c.entry.id)} showAges={showAges} />
          ))}
        </div>
      </section>

      <section>
        <b className="cfg-n">2 · The rooms</b>
        {asking && !allAnswered ? <span className="meta cfg-rooms-status">Asking the house…</span> : null}
        {failed.length ? (
          <div className="row-acts" style={{ marginTop: 8 }}>
            <span className="stop-ink sm">The house could not be asked for {failed.map((c) => `stay ${stayNoOf(c.entry.id)}`).join(" and ")}.</span>
            <Button kind="secondary" compact onClick={() => failed.forEach((c) => c.ask.mutate())}>
              Try again
            </Button>
          </div>
        ) : null}
        {list.some((c) => c.result && c.typeMode) ? (
          <div className="trip-house" style={{ marginTop: 8 }}>
            <div className="trip-house-cols">
              {list
                .filter((c) => c.typeMode)
                .map((c, i) => (
                  <div key={c.entry.id} className={`trip-house-col${i === 0 ? " first" : ""}`}>
                    {c.result ? (
                      <RoomsByType
                        key={`${c.checkIn}|${c.checkOut}|${c.roomCount}`}
                        entry={c.entry}
                        configId={c.configId}
                        stale={false}
                        nights={c.stayNights}
                        numberOfRooms={c.roomCount}
                        catalog={c.catalog}
                        editable={!c.pending}
                        onPicks={c.setTypePicks}
                        onSaved={noop}
                        onParticular={noop}
                        stay={{ checkIn: c.checkIn, checkOut: c.checkOut }}
                        noSave
                        flowKey={null}
                        combined={{
                          caption: (
                            <>
                              <span className="bt-cap-line">
                                <b>Stay {stayNoOf(c.entry.id)}</b>
                                <span className="meta">{plural(c.roomCount, "room")}</span>
                              </span>
                              <span className="sm">{fmtStay(c.checkIn, c.checkOut)}</span>
                            </>
                          ),
                          typeOrder,
                          showTypeColumn: i === 0,
                          onState: noState,
                          saveRef: noSaveRef,
                        }}
                      />
                    ) : (
                      <p className="meta">Asking the house for stay {stayNoOf(c.entry.id)}…</p>
                    )}
                  </div>
                ))}
            </div>
          </div>
        ) : null}
        {list
          .filter((c) => !c.typeMode && c.result)
          .map((c) => (
            <div key={c.entry.id} className="cfg-numbers">
              <b>Stay {stayNoOf(c.entry.id)} · by number</b>
              <RoomsByNumberPick c={c} />
            </div>
          ))}
        {allAnswered ? (
          <div className="row-acts" style={{ marginTop: 8 }}>
            {list
              .filter((c) => c.typeMode)
              .map((c) => (
                <Button
                  key={c.entry.id}
                  kind="quiet"
                  compact
                  onClick={() => {
                    c.setTypePicks(null);
                    c.setByNumber(true);
                  }}
                >
                  Pick stay {stayNoOf(c.entry.id)}&rsquo;s rooms by number
                </Button>
              ))}
          </div>
        ) : null}
      </section>

      <section className="cfg-savebar">
        {needsApproval ? <p className="warn-ink sm cfg-save-note">This goes to the FOM — nothing changes on the booking until they approve it.</p> : null}
        <div className="cfg-save-row">
          {!blocked ? (
            <span className="cfg-save-prompt" role="status">
              All in — {moving.length > 1 ? "save both stays" : `save stay ${stayNoOf(moving[0].entry.id)}`}
            </span>
          ) : null}
          <Button kind="primary" className={!blocked ? "go" : undefined} onClick={() => saveAll.mutate()} state={saving ? "working" : blocked ? "inert" : "default"} workingLabel="Saving…" reason={reason}>
            {needsApproval ? "Send for the FOM's approval" : "Save the configuration"}
          </Button>
        </div>
      </section>
    </div>
  );
}

export function ChangeStaysTogether({
  stays,
  stayNoOf,
  onClose,
  onChanged,
}: {
  stays: EntryDetail[];
  stayNoOf: (id: string) => number;
  onClose: () => void;
  onChanged: () => void;
}) {
  return (
    <StayChanges
      stays={stays}
      stayNoOf={stayNoOf}
      at={0}
      got={[]}
      render={(list) => <Panel list={list} stayNoOf={stayNoOf} onClose={onClose} onChanged={onChanged} />}
    />
  );
}
