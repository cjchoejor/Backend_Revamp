"use client";

/**
 * An extra bed during an apartment stay (2026-11-27, operator: "they can ask extra bed during stay, so
 * somewhere in stay we need an option to add bed for how many days and charge it, now for extra bed rate
 * it can be different rate than normal hotel reservations").
 *
 * The apartments' own extra bed rate (Apartments › Extra bed on the admin console). A bed is added for
 * some nights and the night audit charges it night by night, with service charge and GST, like the
 * rooms; it can be ended early (or taken off before its first night). Every figure is the server's.
 */
import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Button } from "@/design-system";
import { Help } from "@/components/ds/help";
import { DateInput } from "@/components/ds/date-input";
import { useSession } from "@/hooks/use-session";
import {
  addApartmentExtraBed,
  endApartmentExtraBed,
  getApartmentExtraBeds,
  previewApartmentExtraBed,
  type ApartmentExtraBedRow,
} from "@/lib/api/apartments";
import { fmtDay, money, plural } from "@/lib/ds/format";
import type { EntryDetail } from "@/types/api";
import { DsDialog, NotNow, StepCard, toastRefusal } from "./kit";

const addDays = (ymd: string, n: number) => new Date(Date.parse(`${ymd}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const nightsFrom = (a: string, b: string) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);

function EndBedDialog({ bed, today, open, onClose, onEnd, busy }: { bed: ApartmentExtraBedRow | null; today: string; open: boolean; onClose: () => void; onEnd: (toDate: string, reason: string) => void; busy: boolean }) {
  const first = bed ? (bed.fromDate > today ? bed.fromDate : today) : today;
  // After tonight by default — the morning after the bed's first night, when that is still ahead.
  const [to, setTo] = useState(() => (bed && addDays(first, 1) < bed.toDate ? addDays(first, 1) : first));
  const [reason, setReason] = useState("");
  if (!bed) return null;
  const takenOff = to <= bed.fromDate;
  const last = addDays(bed.toDate, -1);
  return (
    <DsDialog
      open={open}
      onClose={onClose}
      closeX
      busy={busy}
      title={`End the extra bed in apartment ${bed.unitLabel}`}
      footer={
        <>
          <NotNow onClick={onClose} />
          <Button kind="primary" className="go" onClick={() => onEnd(to, reason)} state={busy ? "working" : "default"} workingLabel="Ending…">
            {takenOff ? "Take the bed off" : "End the bed"}
          </Button>
        </>
      }
    >
      <p>
        {plural(bed.beds, "bed")} from {fmtDay(bed.fromDate)}, going back the morning of {fmtDay(bed.toDate)}.
      </p>
      <div className="field">
        <label>It goes back the morning of</label>
        <DateInput value={to} min={first} max={last} onChange={(e) => setTo(e.target.value || first)} aria-label="It goes back the morning of" />
      </div>
      <p className={takenOff ? "warn-ink" : "muted"}>
        {takenOff
          ? "Taken off before its first night is over — nothing is charged for it, and a night already put on the bill tonight is put right."
          : `Charged for ${plural(nightsFrom(bed.fromDate, to), "night")}; the nights after are not charged.`}
      </p>
      <div className="field">
        <label>Why · optional</label>
        <input className="input" value={reason} maxLength={300} onChange={(e) => setReason(e.target.value)} placeholder="e.g. the guest's friend left" />
      </div>
    </DsDialog>
  );
}

export function ApartmentExtraBedCard({ entry }: { entry: EntryDetail }) {
  const { session } = useSession();
  const qc = useQueryClient();
  const key = ["apartment-extra-beds", entry.id] as const;
  const q = useQuery({ queryKey: key, queryFn: () => getApartmentExtraBeds(session!, entry.id), enabled: !!session && String(entry.useType ?? "") === "APARTMENT" });
  const data = q.data;
  const today = data?.stay.today ?? "";
  const lastMorning = data?.stay.lastMorning ?? "";
  const [unitId, setUnitId] = useState("");
  const [beds, setBeds] = useState(1);
  const [from, setFrom] = useState("");
  const [nights, setNights] = useState(1);
  const [note, setNote] = useState("");
  const [ending, setEnding] = useState<ApartmentExtraBedRow | null>(null);

  const unit = unitId || data?.units[0]?.unitId || "";
  const start = from || today;
  const maxNights = lastMorning && start ? Math.max(1, nightsFrom(start, lastMorning)) : 1;
  const n = Math.min(nights, maxNights);
  const until = start ? addDays(start, n) : "";
  const ask = useMemo(() => (unit && start ? { unitId: unit, beds, fromDate: start, toDate: until } : null), [unit, beds, start, until]);
  const preview = useQuery({
    queryKey: ["apartment-extra-bed-preview", entry.id, ask],
    queryFn: () => previewApartmentExtraBed(session!, entry.id, ask!),
    enabled: !!session && !!ask && !!data?.mayAdd,
    retry: false,
  });
  const refresh = () => {
    qc.invalidateQueries({ queryKey: key });
    qc.invalidateQueries({ queryKey: ["entry", entry.id] });
    qc.invalidateQueries({ queryKey: ["billing-summary", entry.id] });
  };
  const add = useMutation({
    mutationFn: () => addApartmentExtraBed(session!, entry.id, { ...ask!, note: note.trim() || null }),
    onSuccess: (out) => {
      qc.setQueryData(key, out);
      refresh();
      setNote("");
      toast.success(`${plural(beds, "extra bed")} in apartment ${preview.data?.unitLabel ?? ""} — charged night by night from ${fmtDay(start)}`);
    },
    onError: (e) => toastRefusal(e, "The bed could not be added"),
  });
  const end = useMutation({
    mutationFn: (v: { id: string; toDate: string; reason: string }) => endApartmentExtraBed(session!, entry.id, v.id, { toDate: v.toDate, reason: v.reason || null }),
    onSuccess: (out) => {
      qc.setQueryData(key, out);
      refresh();
      setEnding(null);
      toast.success("The extra bed is ended — no more nights are charged for it");
    },
    onError: (e) => toastRefusal(e, "The bed could not be ended"),
  });

  if (String(entry.useType ?? "") !== "APARTMENT") return null;
  if (!data) return <p className="muted">Reading the extra beds…</p>;

  return (
    <div className="apt-bed-form">
      <StepCard
        title={
          <>
            Extra beds in the apartment
            <Help label="How an apartment's extra bed is charged">
              The apartments have an extra bed rate of their own, set on the admin console under Apartments › Extra bed. A bed
              is charged night by night by the night audit, with service charge and GST, on the apartment&rsquo;s bill. Ended
              early, the nights after are not charged.
            </Help>
          </>
        }
        status={
          data.rate.rate ? (
            <span>
              {money(data.rate.rate)} a bed a night · {money(data.rate.total)} with service charge and GST
            </span>
          ) : (
            <span className="stop-ink">No extra bed rate is set for the apartments</span>
          )
        }
      >
        {data.beds.length ? (
          <table className="table zebra">
            <thead>
              <tr>
                <th>Apartment</th>
                <th className="num">Beds</th>
                <th>Nights</th>
                <th className="num">A night</th>
                <th className="num">In all</th>
                <th>Charged</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {data.beds.map((b) => (
                <tr key={b.id}>
                  <td>Apartment {b.unitLabel}</td>
                  <td className="num">{b.beds}</td>
                  <td>
                    {fmtDay(b.fromDate)} → morning of {fmtDay(b.toDate)} · {plural(b.nights, "night")}
                    {b.endedAt ? <span className="muted"> · ended{b.endReason ? ` — ${b.endReason}` : ""}</span> : null}
                  </td>
                  <td className="num">{money(b.night.total)}</td>
                  <td className="num">{money(b.all.total)}</td>
                  <td>
                    {b.nightsPosted} of {b.nights}
                  </td>
                  <td className="num">
                    {b.toDate > today && entry.status === "ACTIVE" ? (
                      <Button kind="quiet" compact onClick={() => setEnding(b)}>
                        End
                      </Button>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="muted">No extra bed on this stay.</p>
        )}
      </StepCard>

      <StepCard title="Add an extra bed">
        {data.mayAdd ? (
          <>
            <div className="form3">
              {data.units.length > 1 ? (
                <div className="field">
                  <label>Apartment</label>
                  <select className="input" value={unit} onChange={(e) => setUnitId(e.target.value)}>
                    {data.units.map((u) => (
                      <option key={u.unitId} value={u.unitId}>
                        Apartment {u.label}
                      </option>
                    ))}
                  </select>
                </div>
              ) : (
                <div className="field">
                  <label>Apartment</label>
                  <b>Apartment {data.units[0]?.label}</b>
                </div>
              )}
              <div className="field">
                <label>Beds</label>
                <select className="input" value={beds} onChange={(e) => setBeds(Number(e.target.value))}>
                  {[1, 2, 3, 4, 5].map((k) => (
                    <option key={k} value={k}>
                      {plural(k, "bed")}
                    </option>
                  ))}
                </select>
              </div>
              <div className="field">
                <label>From the night of</label>
                <DateInput value={start} min={today} max={lastMorning ? addDays(lastMorning, -1) : undefined} onChange={(e) => setFrom(e.target.value)} aria-label="From the night of" />
              </div>
              <div className="field">
                <label>For how many nights</label>
                <select className="input" value={n} onChange={(e) => setNights(Number(e.target.value))}>
                  {Array.from({ length: maxNights }, (_, i) => i + 1).map((k) => (
                    <option key={k} value={k}>
                      {plural(k, "night")} — back the morning of {fmtDay(addDays(start, k))}
                    </option>
                  ))}
                </select>
              </div>
            </div>
            <div className="field">
              <label>Note · optional</label>
              <input className="input" value={note} maxLength={300} onChange={(e) => setNote(e.target.value)} placeholder="e.g. the guest's friend joins" />
            </div>
            {preview.data ? (
              <div className="apt-bed-fig" role="status">
                <span>
                  A night <b>{money(preview.data.night.total)}</b> <span className="muted">({money(preview.data.night.net)} + SC {money(preview.data.night.serviceCharge)} + GST {money(preview.data.night.gst)})</span>
                </span>
                <span>
                  For {plural(preview.data.nights, "night")} <b>{money(preview.data.all.total)}</b>
                </span>
              </div>
            ) : preview.error ? (
              <p className="stop-ink" role="alert">
                {(preview.error as Error).message}
              </p>
            ) : null}
            <div className="row-acts" style={{ justifyContent: "flex-end", display: "flex" }}>
              <Button
                kind="primary"
                className="go"
                onClick={preview.data ? () => add.mutate() : undefined}
                state={add.isPending ? "working" : preview.data ? "default" : "inert"}
                workingLabel="Adding…"
              >
                Add the bed
              </Button>
            </div>
          </>
        ) : (
          <p className="warn-ink">{data.why}</p>
        )}
      </StepCard>

      <EndBedDialog
        key={ending?.id ?? "none"}
        bed={ending}
        today={today}
        open={!!ending}
        busy={end.isPending}
        onClose={() => setEnding(null)}
        onEnd={(toDate, reason) => ending && end.mutate({ id: ending.id, toDate, reason })}
      />
    </div>
  );
}
