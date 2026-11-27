"use client";

/**
 * What an apartment holds (2026-11-27, operator: "somewhere here we need the option to add amenities and
 * their counts but they are not priced ... we need a field to add it and choose number, and also others
 * option, where they can type something new and add their number").
 *
 * One list per apartment of the booking: each item with a count, an item added from the hotel's list
 * or typed under Others. It starts from the package's usual list and is kept for this booking once
 * saved. Nothing here is priced; the quotation and the confirmation voucher print it.
 */
import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Button } from "@/design-system";
import { Help } from "@/components/ds/help";
import { useSession } from "@/hooks/use-session";
import { getEntryApartmentAmenities, setEntryApartmentAmenities, type AmenityItem } from "@/lib/api/apartments";
import type { EntryDetail } from "@/types/api";
import { StepCard, toastRefusal } from "./kit";

const OTHERS = "__others__";
const canon = (items: AmenityItem[]) => JSON.stringify(items.map((i) => [i.name.trim().toLowerCase(), i.count]));

function UnitList({
  label,
  packageName,
  roomNumbers,
  source,
  saved,
  known,
  editable,
  onSave,
  saving,
}: {
  label: string;
  packageName: string;
  roomNumbers: string[];
  source: "BOOKING" | "PACKAGE" | "NONE";
  saved: AmenityItem[];
  known: string[];
  editable: boolean;
  onSave: (items: AmenityItem[]) => void;
  saving: boolean;
}) {
  const [items, setItems] = useState<AmenityItem[]>(saved);
  const savedKey = canon(saved);
  // A save (here or on another screen) becomes the list shown.
  useEffect(() => setItems(saved), [savedKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const [pick, setPick] = useState("");
  const [other, setOther] = useState("");
  const [count, setCount] = useState("1");
  const changed = canon(items) !== savedKey || (source !== "BOOKING" && items.length > 0);
  const onList = new Set(items.map((i) => i.name.toLowerCase()));
  const offered = known.filter((k) => !onList.has(k.toLowerCase()));
  const name = pick === OTHERS ? other.replace(/\s+/g, " ").trim() : pick;
  const n = Number(count);
  const addWhy = !name
    ? pick === OTHERS
      ? "type what it is"
      : "pick an item"
    : onList.has(name.toLowerCase())
      ? `${name} is on the list already`
      : !Number.isInteger(n) || n < 0 || n > 99
        ? "a count from 0 to 99"
        : null;
  const add = () => {
    if (addWhy) return;
    setItems((prev) => [...prev, { name, count: n }]);
    setPick("");
    setOther("");
    setCount("1");
  };
  const setN = (i: number, v: number) => setItems((prev) => prev.map((x, k) => (k === i ? { ...x, count: Math.max(0, Math.min(99, v)) } : x)));

  return (
    <div className="apt-amen" data-apartment={label}>
      <div className="apt-amen-head">
        <b>Apartment {label}</b>
        <span className="muted">
          {packageName}
          {roomNumbers.length > 1 ? ` · Rooms ${roomNumbers.join(" + ")}` : ""}
        </span>
        <span className="ln" />
        <span className="muted">
          {source === "BOOKING" ? "kept for this booking" : source === "PACKAGE" ? "the package's usual list — not saved for this booking yet" : "nothing listed yet"}
        </span>
      </div>
      {items.length ? (
        <table className="table apt-amen-t">
          <thead>
            <tr>
              <th>Item</th>
              <th className="num">Count</th>
              {editable ? <th /> : null}
            </tr>
          </thead>
          <tbody>
            {items.map((it, i) => (
              <tr key={it.name}>
                <td>{it.name}</td>
                <td className="num">
                  {editable ? (
                    <span className="stepper">
                      <button type="button" aria-label={`One fewer ${it.name}`} onClick={() => setN(i, it.count - 1)} disabled={it.count <= 0}>
                        −
                      </button>
                      <input
                        className="input"
                        inputMode="numeric"
                        aria-label={`${it.name} — count`}
                        value={String(it.count)}
                        onChange={(e) => {
                          if (/^\d{0,2}$/.test(e.target.value)) setN(i, Number(e.target.value || 0));
                        }}
                      />
                      <button type="button" aria-label={`One more ${it.name}`} onClick={() => setN(i, it.count + 1)} disabled={it.count >= 99}>
                        +
                      </button>
                    </span>
                  ) : (
                    it.count
                  )}
                </td>
                {editable ? (
                  <td className="num">
                    <button type="button" className="x-btn" aria-label={`Take ${it.name} off the list`} title={`Take ${it.name} off the list`} onClick={() => setItems((prev) => prev.filter((_, k) => k !== i))}>
                      ×
                    </button>
                  </td>
                ) : null}
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p className="muted" style={{ margin: "4px 0" }}>
          Nothing listed for this apartment.
        </p>
      )}
      {editable ? (
        <div className="apt-amen-add">
          <div className="field">
            <label>Add an item</label>
            <select className="input" value={pick} onChange={(e) => setPick(e.target.value)} aria-label="Add an item">
              <option value="">Pick an item…</option>
              {offered.map((k) => (
                <option key={k} value={k}>
                  {k}
                </option>
              ))}
              <option value={OTHERS}>Others — type it</option>
            </select>
          </div>
          {pick === OTHERS ? (
            <div className="field">
              <label>What it is</label>
              <input className="input" value={other} maxLength={60} placeholder="e.g. Pressure cooker" onChange={(e) => setOther(e.target.value)} autoFocus />
            </div>
          ) : null}
          <div className="field narrow">
            <label>Count</label>
            <input className="input" inputMode="numeric" value={count} onChange={(e) => /^\d{0,2}$/.test(e.target.value) && setCount(e.target.value)} />
          </div>
          <Button kind="secondary" compact onClick={addWhy ? undefined : add} state={addWhy ? "inert" : "default"} title={addWhy ?? undefined}>
            Add
          </Button>
          <span className="ln" />
          {changed ? (
            <>
              <Button kind="quiet" compact onClick={() => setItems(saved)}>
                Undo
              </Button>
              <Button kind="primary" className="go" compact onClick={() => onSave(items)} state={saving ? "working" : "default"} workingLabel="Saving…">
                Save the list
              </Button>
            </>
          ) : (
            <span className="ok-ink" style={{ fontWeight: 600 }}>
              {source === "BOOKING" ? "Saved" : ""}
            </span>
          )}
        </div>
      ) : null}
    </div>
  );
}

/** The card: every apartment of the booking, each with its list. Nothing on a booking with no apartment. */
export function ApartmentAmenitiesCard({ entry, title = "In the apartment" }: { entry: EntryDetail; title?: string }) {
  const { session } = useSession();
  const qc = useQueryClient();
  const isApartment = String(entry.useType ?? "") === "APARTMENT";
  const q = useQuery({
    queryKey: ["apartment-amenities", entry.id, entry.updatedAt ?? ""],
    queryFn: () => getEntryApartmentAmenities(session!, entry.id),
    enabled: !!session && isApartment,
  });
  const save = useMutation({
    mutationFn: (v: { unitId: string; items: AmenityItem[] }) => setEntryApartmentAmenities(session!, entry.id, [v]),
    onSuccess: (out, v) => {
      qc.setQueryData(["apartment-amenities", entry.id, entry.updatedAt ?? ""], out);
      const u = out.units.find((x) => x.unitId === v.unitId);
      toast.success(`Kept for apartment ${u?.label ?? ""} — the quotation and the confirmation voucher print it`);
    },
    onError: (e) => toastRefusal(e, "The list could not be saved"),
  });
  const units = useMemo(() => q.data?.units ?? [], [q.data]);
  if (!isApartment || !units.length) return null;
  return (
    <StepCard
      title={
        <>
          {title}
          <Help label="What this list is">
            What each apartment holds for the guest — pots, plates, the dustbin — with how many of each. It is not priced. It
            starts from the package&rsquo;s usual list (set on the admin console under Apartments) and is kept for this booking
            once saved. The quotation and the confirmation voucher print it.
          </Help>
        </>
      }
      className="apt-amen-card"
    >
      {units.map((u) => (
        <UnitList
          key={u.label}
          label={u.label}
          packageName={u.packageName}
          roomNumbers={u.roomNumbers}
          source={u.source}
          saved={u.items}
          known={q.data?.known ?? []}
          editable={!!q.data?.editable}
          saving={save.isPending && save.variables?.unitId === u.unitId}
          onSave={(items) => save.mutate({ unitId: u.unitId, items })}
        />
      ))}
    </StepCard>
  );
}
