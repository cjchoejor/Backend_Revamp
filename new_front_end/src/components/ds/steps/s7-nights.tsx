"use client";

/**
 * Stay — the nights (SS03 amendment T2; prototype `V16.stayBase` "The nights").
 *
 * One row per night of the stay: whether the night audit has run for it, and the room charge it
 * posted (each room's own line, never added up here). The audit is a hotel-wide run for one
 * night, and a night can be audited only once it has ended on the hotel's calendar — the latest
 * is the hotel's yesterday. The step's gate reads the FINAL night's audit, reported upward exactly
 * as the old Stay step did.
 */
import { useEffect, useMemo, useState } from "react";
import { useMutation, useQueries } from "@tanstack/react-query";
import { toast } from "sonner";
import { Button, Chip } from "@/design-system";
import { useHotelDay } from "@/hooks/use-hotel-day";
import { useSession } from "@/hooks/use-session";
import { getNightAuditRecord, runNightAudit, type NightAuditRecord } from "@/lib/api/in-stay";
import { effectiveCheckOutIso } from "@/lib/desk/workspace";
import { fmtDate, fmtDay, money } from "@/lib/ds/format";
import type { EntryDetail } from "@/types/api";
import { Live, StepCard, atLeast, toastRefusal, useRefreshEntry, words } from "./kit";

/** Every night of a stay, `YYYY-MM-DD` — calendar arithmetic only. */
export function stayNights(checkIn?: string | null, checkOut?: string | null): string[] {
  if (!checkIn || !checkOut) return [];
  const start = Date.parse(`${checkIn.slice(0, 10)}T00:00:00Z`);
  const end = Date.parse(`${checkOut.slice(0, 10)}T00:00:00Z`);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return [];
  const out: string[] = [];
  for (let t = start, n = 0; t < end && n < 366; t += 86_400_000, n++) out.push(new Date(t).toISOString().slice(0, 10));
  return out;
}

/** The last night slept — the day before the (effective) checkout, as the old step read it. */
function lastStayNightYmd(checkOutIso: string) {
  const d = new Date(checkOutIso);
  const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - 1));
  return last.toISOString().slice(0, 10);
}

export function NightsCard({
  entry,
  setNightAuditOk,
  onMoveRoom,
}: {
  entry: EntryDetail;
  setNightAuditOk: (v: boolean) => void;
  onMoveRoom: () => void;
}) {
  const { session } = useSession();
  const refresh = useRefreshEntry(entry.id);
  const hotel = useHotelDay();
  const today = hotel?.today ?? null;
  const elevated = atLeast(session?.actorLevel, "L2");

  const checkIn = entry.reservation?.frozenCheckInDate ?? entry.checkInDate ?? null;
  const checkOutIso = effectiveCheckOutIso(entry) ?? "";
  const lastNight = checkOutIso ? lastStayNightYmd(checkOutIso) : "";
  const nights = useMemo(() => stayNights(checkIn, checkOutIso), [checkIn, checkOutIso]);

  // The nights worth asking about: every night that has ended, and always the final night (the gate)
  // — when the stay has one. A guest who checks in and leaves the same day slept no night.
  // Every night up to and including tonight (2026-09-25: the desk may post tonight for this
  // booking), and always the final night (the gate) — when the stay has one.
  const asked = useMemo(() => {
    const s = new Set(nights.filter((n) => !!today && n <= today));
    if (lastNight && nights.includes(lastNight)) s.add(lastNight);
    return [...s].sort();
  }, [nights, today, lastNight]);
  const records = useQueries({
    queries: asked.map((ymd) => ({
      queryKey: ["night-audit", ymd],
      queryFn: () => getNightAuditRecord(session!, ymd),
      enabled: !!session,
    })),
  });
  const recordOf = (ymd: string): NightAuditRecord | null | undefined => {
    const i = asked.indexOf(ymd);
    return i < 0 ? undefined : records[i]?.data;
  };

  const roomNo = useMemo(
    () => new Map((entry.roomAssignments ?? []).map((a) => [a.roomId, a.room?.roomNumber ?? a.roomId.slice(0, 6)])),
    [entry.roomAssignments],
  );
  const roomLines = (ymd: string) => (entry.folio?.lines ?? []).filter((l) => l.lineType === "ROOM_CHARGE" && l.chargeDate?.slice(0, 10) === ymd);
  // This booking's night is on its folio — what the manual run leaves behind; the backend's gate
  // reads the same thing beside the hotel's record.
  const postedHere = (ymd: string) => roomLines(ymd).length > 0;

  // The gate: the final night's audit — met outright when no night was slept (2026-09-18), as
  // the backend's gate is: "the night before check-out" is then a night before the stay began.
  const finalOk = nights.length === 0 || recordOf(lastNight)?.runStatus === "COMPLETE" || postedHere(lastNight);
  useEffect(() => {
    setNightAuditOk(finalOk);
  }, [finalOk, setNightAuditOk]);

  // A night the hotel's audit ran BEFORE this booking was in-house (a check-in completed after
  // the run) carries no charge for it; running the night again charges it (the backend catches up
  // only the bookings the run missed). "Audited" alone read as done while the room was never
  // billed, and settlement then refused the stay (2026-09-18).
  const hasRooms = (entry.roomAssignments ?? []).length > 0;
  const notChargedHere = (n: string) => hasRooms && !!today && n <= today && recordOf(n)?.runStatus === "COMPLETE" && !postedHere(n);

  // Which night to run: the one picked, else the earliest night up to tonight not yet on this
  // booking's folio.
  const firstOpen = asked.find((n) => !!today && n <= today && hasRooms && !postedHere(n)) ?? "";
  const [picked, setPicked] = useState<string | null>(null);
  const runDate = picked ?? firstOpen;
  const runFuture = !today || (!!runDate && runDate > today);
  const runDone = !!runDate && postedHere(runDate);

  // The run is THIS booking's alone (2026-09-25, operator ruling): it posts the night's lines for
  // this stay and nothing for anyone else; the hotel's own run at 08:00 covers the house.
  const run = useMutation({
    mutationFn: (ymd: string) => runNightAudit(session!, `${ymd}T00:00:00.000Z`, entry.id),
    onSuccess: (out, ymd) => {
      if (out.posted > 0) toast.success(`${fmtDate(ymd)} is on this booking's bill — ${out.posted === 1 ? "one line" : `${out.posted} lines`} posted`);
      else toast.message(`${fmtDate(ymd)} was already on this booking's bill — nothing to post`);
      setPicked(null);
      refresh([["night-audit"], ["early-departure-preview", entry.id]]);
    },
    onError: (e) => toastRefusal(e, "The night could not be posted"),
  });

  const audit = (n: string) => {
    const rec = recordOf(n);
    if (notChargedHere(n))
      return (
        <span className="row-acts" style={{ alignItems: "center" }}>
          <Chip tone="warning">hotel audited · not on this bill</Chip>
          {elevated ? (
            <Live>
              <Button kind="quiet" compact state={run.isPending ? "working" : "default"} workingLabel="Posting…" onClick={() => run.mutate(n)}>
                Post it
              </Button>
            </Live>
          ) : null}
        </span>
      );
    if (postedHere(n))
      return (
        <Chip tone="success" icon="check">
          {rec?.runStatus === "COMPLETE" ? "audited" : n === today ? "posted tonight, ahead of the hotel's run" : "posted for this booking"}
        </Chip>
      );
    if (rec?.runStatus === "COMPLETE")
      return (
        <Chip tone="success" icon="check">
          audited
        </Chip>
      );
    if (!today) return <Chip tone="quiet">…</Chip>;
    if (n <= today)
      return (
        <span className="row-acts" style={{ alignItems: "center" }}>
          <Chip tone={n === today ? "quiet" : "warning"}>{n === today ? "tonight" : rec?.runStatus ? words(rec.runStatus) : "not yet audited"}</Chip>
          {elevated ? (
            <Live>
              <Button kind="quiet" compact state={run.isPending ? "working" : "default"} workingLabel="Posting…" onClick={() => run.mutate(n)}>
                {n === today ? "Post tonight" : "Post it"}
              </Button>
            </Live>
          ) : null}
        </span>
      );
    return <Chip tone="quiet">ahead</Chip>;
  };

  return (
    <StepCard flow="nights" title="The nights" icon="clock">
      {nights.length === 0 ? (
        <span className="meta">No stay dates on record.</span>
      ) : (
        <table className="table compact">
          <thead>
            <tr>
              <th>Night</th>
              <th>Audit</th>
              <th>Room charge · net</th>
            </tr>
          </thead>
          <tbody>
            {nights.map((n) => {
              const ls = roomLines(n);
              return (
                <tr key={n} className="static">
                  <td>
                    {fmtDate(n)}
                    {n === lastNight ? <span className="meta"> · the last night</span> : null}
                  </td>
                  <td>{audit(n)}</td>
                  <td className="money">
                    {ls.length === 0 ? (
                      <span className="dash">—</span>
                    ) : (
                      ls.map((l, i) => (
                        <span key={l.id}>
                          {i > 0 ? <span className="meta"> · </span> : null}
                          {l.roomId && ls.length > 1 ? <span className="meta">Room {roomNo.get(l.roomId) ?? "?"} </span> : null}
                          {money(l.amount, l.currency)}
                        </span>
                      ))
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      <div className="meta" style={{ marginTop: 6 }}>
        The hotel&rsquo;s night audit runs on its own at 08:00 and posts every guest&rsquo;s night. From here the FOM posts a night for{" "}
        <b>this booking only</b> — a night the hotel&rsquo;s run missed, or tonight, for a guest settling before the morning run. Every night of
        the stay must be on the bill before check-out.
      </div>
      <Live>
        <div className="row-acts" style={{ marginTop: 12, alignItems: "flex-end" }}>
          {elevated ? (
            <>
              <div className="field" style={{ width: 180 }}>
                <label>Night to post</label>
                <input
                  className="input"
                  type="date"
                  value={runDate}
                  max={today && lastNight && lastNight < today ? lastNight : (today ?? undefined)}
                  min={nights[0]}
                  disabled={!today}
                  title={today ? undefined : "checking today's date at the hotel…"}
                  onChange={(e) => setPicked(e.target.value)}
                />
              </div>
              <Button
                kind="secondary"
                compact
                state={run.isPending ? "working" : !runDate || runFuture || runDone ? "inert" : "default"}
                title={
                  !today
                    ? "checking today's date at the hotel…"
                    : !runDate
                      ? "every night up to tonight is on the bill"
                      : runFuture
                        ? "a night ahead of today cannot be posted"
                        : runDone
                          ? "this night is already on the bill"
                          : undefined
                }
                workingLabel="Posting…"
                onClick={() => runDate && run.mutate(runDate)}
              >
                {runDate ? `Post the night · ${fmtDay(runDate)}` : "Post the night"}
              </Button>
            </>
          ) : (
            <Button kind="secondary" compact state="inert" unlockRole="FOM" reason="Posting a night for this booking">
              Post the night
            </Button>
          )}
          {hasRooms ? (
            <Button kind="quiet" compact onClick={onMoveRoom}>
              Move room · same category
            </Button>
          ) : null}
        </div>
      </Live>
    </StepCard>
  );
}
