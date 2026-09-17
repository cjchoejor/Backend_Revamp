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
  const yesterday = hotel?.yesterday ?? null;
  const elevated = atLeast(session?.actorLevel, "L2");

  const checkIn = entry.reservation?.frozenCheckInDate ?? entry.checkInDate ?? null;
  const checkOutIso = effectiveCheckOutIso(entry) ?? "";
  const lastNight = checkOutIso ? lastStayNightYmd(checkOutIso) : "";
  const nights = useMemo(() => stayNights(checkIn, checkOutIso), [checkIn, checkOutIso]);

  // The nights worth asking about: every night that has ended, and always the final night (the gate).
  const asked = useMemo(() => {
    const s = new Set(nights.filter((n) => !!yesterday && n <= yesterday));
    if (lastNight) s.add(lastNight);
    return [...s].sort();
  }, [nights, yesterday, lastNight]);
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

  // The gate: the final night's audit, exactly as the old Stay step reported it.
  const finalOk = recordOf(lastNight)?.runStatus === "COMPLETE";
  useEffect(() => {
    setNightAuditOk(finalOk);
  }, [finalOk, setNightAuditOk]);

  const roomNo = useMemo(
    () => new Map((entry.roomAssignments ?? []).map((a) => [a.roomId, a.room?.roomNumber ?? a.roomId.slice(0, 6)])),
    [entry.roomAssignments],
  );
  const roomLines = (ymd: string) => (entry.folio?.lines ?? []).filter((l) => l.lineType === "ROOM_CHARGE" && l.chargeDate?.slice(0, 10) === ymd);

  // Which night to run: the one picked, else the earliest ended night not yet complete.
  const firstOpen = asked.find((n) => !!yesterday && n <= yesterday && recordOf(n)?.runStatus !== "COMPLETE") ?? "";
  const [picked, setPicked] = useState<string | null>(null);
  const runDate = picked ?? firstOpen;
  const runFuture = !yesterday || (!!runDate && runDate > yesterday);
  const runDone = !!runDate && recordOf(runDate)?.runStatus === "COMPLETE";

  const run = useMutation({
    mutationFn: (ymd: string) => runNightAudit(session!, `${ymd}T00:00:00.000Z`),
    onSuccess: (_d, ymd) => {
      toast.success(`The night audit has run for ${fmtDate(ymd)}`);
      setPicked(null);
      refresh([["night-audit"], ["early-departure-preview", entry.id]]);
    },
    onError: (e) => toastRefusal(e, "The night audit could not run"),
  });

  const audit = (n: string) => {
    const rec = recordOf(n);
    if (rec?.runStatus === "COMPLETE")
      return (
        <Chip tone="success" icon="check">
          audited
        </Chip>
      );
    if (!today || !yesterday) return <Chip tone="quiet">…</Chip>;
    if (n <= yesterday)
      return (
        <span className="row-acts" style={{ alignItems: "center" }}>
          <Chip tone="warning">{rec?.runStatus ? words(rec.runStatus) : "not yet audited"}</Chip>
          {elevated ? (
            <Live>
              <Button kind="quiet" compact state={run.isPending ? "working" : "default"} workingLabel="Running…" onClick={() => run.mutate(n)}>
                Run it
              </Button>
            </Live>
          ) : null}
        </span>
      );
    if (n === today) return <Chip tone="quiet">tonight</Chip>;
    return <Chip tone="quiet">ahead</Chip>;
  };

  const hasRooms = (entry.roomAssignments ?? []).length > 0;

  return (
    <StepCard title="The nights" icon="clock">
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
        A night&rsquo;s charge is posted and its date sealed by the night audit · every night must be audited before check-out · a night is audited once it has ended · the run covers the whole hotel, so a night already audited from another booking needs nothing more here
      </div>
      <Live>
        <div className="row-acts" style={{ marginTop: 12, alignItems: "flex-end" }}>
          {elevated ? (
            <>
              <div className="field" style={{ width: 180 }}>
                <label>Night to audit</label>
                <input
                  className="input"
                  type="date"
                  value={runDate}
                  max={yesterday ?? undefined}
                  min={nights[0]}
                  disabled={!yesterday}
                  title={yesterday ? undefined : "checking today's date at the hotel…"}
                  onChange={(e) => setPicked(e.target.value)}
                />
              </div>
              <Button
                kind="secondary"
                compact
                state={run.isPending ? "working" : !runDate || runFuture || runDone ? "inert" : "default"}
                title={
                  !yesterday
                    ? "checking today's date at the hotel…"
                    : !runDate
                      ? "every ended night is audited — pick one to run it again"
                      : runFuture
                        ? "a night can be audited only once it has ended — a guest leaving early is an early departure, below"
                        : runDone
                          ? "this night is already audited"
                          : undefined
                }
                workingLabel="Running…"
                onClick={() => runDate && run.mutate(runDate)}
              >
                {runDate ? `Run the night audit · ${fmtDay(runDate)}` : "Run the night audit"}
              </Button>
            </>
          ) : (
            <Button kind="secondary" compact state="inert" unlockRole="FOM" reason="Running the night audit">
              Run the night audit
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
