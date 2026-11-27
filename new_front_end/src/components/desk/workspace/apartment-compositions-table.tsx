"use client";

/**
 * The negotiation table for a booking let as apartments (2026-11-27, operator: "instead of showing as
 * two different rooms, can we just show it as one room using only their one number"; "they don't need
 * the meal plan option since they will be cooking by themselves"; "no extra bed option needed"; "the
 * max occupant should be the apartment's max, not by combining 2 rooms"; "we don't need the dropdown
 * for whole stay and all nights"; "edit rates we need in case we have to adjust the rent ... only the
 * rent amount per month if chose monthly or weekly rent if chosen weekly").
 *
 * One row per apartment. Behind it the booking still holds the apartment's rooms (keys, housekeeping
 * and the house's inventory are by room), so the table writes one composition per room: the
 * apartment's first room carries every guest and the rent agreed, its other rooms carry nobody. The
 * server prices the rent on the first room and charges the others nothing.
 *
 * NO MONEY IS COMPUTED HERE: the rent a month or week, the stay's rent and the totals are the
 * server's (the rate reference and the live preview).
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Wand2 } from "lucide-react";
import { useSession } from "@/hooks/use-session";
import { getChildPolicy } from "@/lib/api/child-policy";
import { previewQuotationPricing, type RoomCompositionInput } from "@/lib/api/quotations";
import type { EntryRateReference } from "@/lib/api/entries";
import { Help, useQuietScreen } from "@/components/ds/help";
import { FixedDiscount, type DiscountEdit } from "./room-compositions-table";

export type ApartmentRef = NonNullable<EntryRateReference["apartments"]>[number];

type Row = { ad: string; c6: string; u6: string; rent: string; sc: boolean; foc: boolean };

const cnt = (v: string | undefined) => {
  const n = Number(v ?? "");
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
};
const money = (v: string | number | null | undefined) => {
  const n = Number(v);
  return v == null || v === "" || !Number.isFinite(n) ? "—" : n.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
};
function dayToIso(v?: string | null): string | undefined {
  if (!v) return undefined;
  const d = new Date(v.slice(0, 10) + "T00:00:00.000Z");
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

/** "2 months and 5 nights" — the periods counted, never priced. */
function periodWords(plan: "MONTHLY" | "WEEKLY", periods: Array<{ whole: boolean; nights: number }>): string {
  const whole = periods.filter((p) => p.whole).length;
  const part = periods.filter((p) => !p.whole).reduce((s, p) => s + p.nights, 0);
  const unit = plan === "MONTHLY" ? "month" : "week";
  const parts: string[] = [];
  if (whole) parts.push(`${whole} ${unit}${whole === 1 ? "" : "s"}`);
  if (part) parts.push(`${part} night${part === 1 ? "" : "s"}`);
  return parts.join(" and ") || "—";
}

export function ApartmentCompositionsTable({
  apartments,
  entryId,
  sealedRoomIds,
  entryCheckIn,
  entryCheckOut,
  entryAdults,
  entryChildAges,
  initial,
  initialCompositions,
  onChange,
  onSave,
  saveLabel,
  saving,
  unsaved,
  saveAside,
  onFaultsChange,
  discountValue,
  discountUnit,
  onDiscountChange,
  lockCommercial,
  readOnly,
  previewStay,
  autoSeat,
}: DiscountEdit & {
  apartments: ApartmentRef[];
  entryId?: string;
  sealedRoomIds: string[];
  entryCheckIn?: string | null;
  entryCheckOut?: string | null;
  entryAdults?: number | null;
  entryChildAges?: number[] | null;
  initial?: RoomCompositionInput[];
  initialCompositions?: RoomCompositionInput[];
  onChange: (compositions: RoomCompositionInput[]) => void;
  onSave?: () => void;
  saveLabel?: string;
  saving?: boolean;
  unsaved?: boolean;
  saveAside?: React.ReactNode;
  onFaultsChange?: (faults: string[]) => void;
  lockCommercial?: boolean;
  readOnly?: boolean;
  previewStay?: { checkInDate: string; checkOutDate: string } | null;
  autoSeat?: boolean;
}) {
  const { session } = useSession();
  const quiet = useQuietScreen();
  const policyQuery = useQuery({
    queryKey: ["lookup", "child-policy"],
    queryFn: () => getChildPolicy(session!),
    enabled: !!session,
    staleTime: 10 * 60_000,
  });
  const youngMax = policyQuery.data?.ageBands.youngChildMaxAge ?? 5;
  const childMax = policyQuery.data?.ageBands.childMaxAge ?? 10;

  /** The apartments on this booking, in the order of their first room on the booking. */
  const units = useMemo(() => {
    const seen = new Set<string>();
    const out: ApartmentRef[] = [];
    for (const id of sealedRoomIds) {
      const a = apartments.find((x) => x.roomIds.includes(id));
      if (a && !seen.has(a.label)) {
        seen.add(a.label);
        out.push(a);
      }
    }
    return out;
  }, [apartments, sealedRoomIds]);
  const keyOf = (a: ApartmentRef) => a.label;

  const party = useMemo(() => {
    const ages = entryChildAges ?? [];
    return {
      ad: Math.max(0, entryAdults ?? 0) + ages.filter((a) => a > childMax).length,
      c6: ages.filter((a) => a > youngMax && a <= childMax).length,
      u6: ages.filter((a) => a <= youngMax).length,
    };
  }, [entryAdults, entryChildAges, youngMax, childMax]);
  const partySize = party.ad + party.c6 + party.u6;

  /** The party seated apartment by apartment: an adult in each first, then up to each one's most. */
  const seatParty = (list: ApartmentRef[]): Record<string, Pick<Row, "ad" | "c6" | "u6">> => {
    const left = { ...party };
    const seat: Record<string, { ad: number; c6: number; u6: number }> = {};
    for (const a of list) seat[keyOf(a)] = { ad: 0, c6: 0, u6: 0 };
    const room = (a: ApartmentRef) => {
      const s = seat[keyOf(a)];
      return (a.maxOccupants ?? 99) - s.ad - s.c6 - s.u6;
    };
    for (const a of list) {
      if (left.ad > 0 && room(a) > 0) {
        seat[keyOf(a)].ad += 1;
        left.ad -= 1;
      }
    }
    for (const band of ["ad", "c6", "u6"] as const) {
      for (const a of list) {
        while (left[band] > 0 && room(a) > 0) {
          seat[keyOf(a)][band] += 1;
          left[band] -= 1;
        }
      }
    }
    const out: Record<string, Pick<Row, "ad" | "c6" | "u6">> = {};
    for (const [k, s] of Object.entries(seat)) out[k] = { ad: String(s.ad), c6: String(s.c6), u6: String(s.u6) };
    return out;
  };

  // Read once, at mount: the other view's work or the booking's own figures, else the party seated.
  const seedRef = useRef<RoomCompositionInput[]>((initial && initial.length ? initial : initialCompositions) ?? []);
  const [rows, setRows] = useState<Record<string, Row>>(() => {
    const seed = seedRef.current;
    const out: Record<string, Row> = {};
    for (const a of units) {
      const mine = seed.filter((c) => a.roomIds.includes(c.roomId));
      const lead = mine.find((c) => c.roomId === a.leadRoomId) ?? mine[0];
      const rent = mine.find((c) => c.negotiatedRentRate != null)?.negotiatedRentRate;
      out[keyOf(a)] = {
        ad: String(mine.reduce((s, c) => s + (c.adultCount ?? 0), 0)),
        c6: String(mine.reduce((s, c) => s + (c.cnb6To10Count ?? 0), 0)),
        u6: String(mine.reduce((s, c) => s + (c.cnbUnder6Count ?? 0), 0)),
        rent: rent != null ? String(rent) : "",
        sc: lead?.serviceChargeApplies !== false,
        foc: lead?.isFoc === true,
      };
    }
    return out;
  });
  // A booking with nobody seated yet (a first quote), or one whose rooms or party changed, is seated by itself.
  const seatedOnce = useRef(false);
  useEffect(() => {
    if (seatedOnce.current || readOnly || !policyQuery.data || units.length === 0) return;
    seatedOnce.current = true;
    const nobody = units.every((a) => {
      const r = rows[keyOf(a)];
      return !r || cnt(r.ad) + cnt(r.c6) + cnt(r.u6) === 0;
    });
    if (!nobody && !autoSeat) return;
    const seat = seatParty(units);
    setRows((prev) => {
      const next = { ...prev };
      for (const a of units) next[keyOf(a)] = { ...(prev[keyOf(a)] ?? { rent: "", sc: true, foc: false }), ...seat[keyOf(a)] };
      return next;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [policyQuery.data, units.length, readOnly]);

  const [ratesOpen, setRatesOpen] = useState(() => units.some((a) => (rows[keyOf(a)]?.rent ?? "") !== ""));
  const set = (a: ApartmentRef, patch: Partial<Row>) => setRows((prev) => ({ ...prev, [keyOf(a)]: { ...prev[keyOf(a)], ...patch } }));
  const [limitMsg, setLimitMsg] = useState<string | null>(null);
  useEffect(() => {
    if (!limitMsg) return;
    const t = setTimeout(() => setLimitMsg(null), 5000);
    return () => clearTimeout(t);
  }, [limitMsg]);

  /** A guest count typed, held to the apartment's most and to the booking's party. */
  const typeGuests = (a: ApartmentRef, band: "ad" | "c6" | "u6", raw: string) => {
    if (!/^\d*$/.test(raw)) return;
    if (raw === "") return set(a, { [band]: "" });
    const want = Number(raw);
    const r = rows[keyOf(a)];
    const others = cnt(r.ad) + cnt(r.c6) + cnt(r.u6) - cnt(r[band]);
    const max = a.maxOccupants ?? 99;
    const room = Math.max(0, max - others);
    const elsewhere = units.filter((x) => x !== a).reduce((s, x) => s + cnt(rows[keyOf(x)]?.[band]), 0);
    const ofParty = partySize > 0 ? Math.max(0, party[band] - elsewhere) : want;
    const cap = Math.min(room, ofParty);
    if (want > cap) {
      setLimitMsg(
        want > room
          ? `Apartment ${a.label} sleeps at most ${max} guests — it is set to ${cap}.`
          : `This booking has ${party[band]} ${band === "ad" ? "guests aged 11 and over" : band === "c6" ? `children ${youngMax + 1}–${childMax}` : `children under ${youngMax + 1}`} — it is set to ${cap}.`,
      );
      return set(a, { [band]: String(cap) });
    }
    set(a, { [band]: raw });
  };

  // What the table writes: every room of each apartment, the first carrying its guests and rent.
  const compositions = useMemo<RoomCompositionInput[]>(() => {
    const out: RoomCompositionInput[] = [];
    for (const id of sealedRoomIds) {
      const a = units.find((x) => x.roomIds.includes(id));
      const r = a ? rows[keyOf(a)] : null;
      const lead = !!a && id === (a.roomIds.find((x) => sealedRoomIds.includes(x)) ?? a.leadRoomId);
      const base = {
        roomId: id,
        startDate: dayToIso(entryCheckIn),
        endDate: dayToIso(entryCheckOut),
        extraBedCount: 0,
        mealPlanCpCount: 0,
        mealPlanMaplCount: 0,
        mealPlanMapdCount: 0,
        mealPlanApCount: 0,
        mealPlanOthersCount: 0,
        serviceChargeApplies: r?.sc ?? true,
        gstApplies: true,
        isFoc: r?.foc ?? false,
      };
      if (lead && r) {
        const rent = r.rent.trim() === "" ? undefined : Number(r.rent);
        out.push({
          ...base,
          occupantCount: cnt(r.ad) + cnt(r.c6) + cnt(r.u6),
          adultCount: cnt(r.ad),
          cnb6To10Count: cnt(r.c6),
          cnbUnder6Count: cnt(r.u6),
          ...(rent != null && Number.isFinite(rent) ? { negotiatedRentRate: rent } : {}),
        });
      } else {
        out.push({ ...base, occupantCount: 0, adultCount: 0, cnb6To10Count: 0, cnbUnder6Count: 0 });
      }
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, units, sealedRoomIds.join(","), entryCheckIn, entryCheckOut]);
  const compKey = JSON.stringify(compositions);
  useEffect(() => {
    if (units.length === 0) return;
    onChange(compositions);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [compKey]);

  // ---- What is wrong, in the operator's words ------------------------------------------------
  const faults = useMemo(() => {
    const out: string[] = [];
    for (const a of units) {
      const r = rows[keyOf(a)];
      const g = cnt(r?.ad) + cnt(r?.c6) + cnt(r?.u6);
      if (g === 0) out.push(`Apartment ${a.label} — nobody is in it`);
      else if (cnt(r?.ad) === 0) out.push(`Apartment ${a.label} — no adult in it; children cannot be booked in on their own`);
      if (a.maxOccupants != null && g > a.maxOccupants) out.push(`Apartment ${a.label} sleeps at most ${a.maxOccupants} guests — ${g} are on it`);
      if (r && r.rent.trim() !== "" && !(Number(r.rent) > 0)) out.push(`Apartment ${a.label} — the rent must be more than nothing`);
    }
    if (partySize > 0) {
      const placed = units.reduce((s, a) => s + cnt(rows[keyOf(a)]?.ad) + cnt(rows[keyOf(a)]?.c6) + cnt(rows[keyOf(a)]?.u6), 0);
      if (placed < partySize) out.push(`${partySize - placed} of the booking's ${partySize} guests are not in an apartment yet`);
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, units, partySize]);
  const faultsKey = faults.join("|");
  useEffect(() => {
    onFaultsChange?.(faults);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [faultsKey]);

  // ---- The server's figures ----------------------------------------------------------------
  // The booking's discount comes off the rent as off any room's net (2026-11-27), so the server prices it.
  const discNum = Number(discountValue ?? "");
  const discount = Number.isFinite(discNum) && discNum > 0 ? ((discountUnit ?? "percent") === "amount" ? { amount: discNum } : { percent: discNum }) : null;
  const discKey = JSON.stringify(discount);
  const [previewBody, setPreviewBody] = useState<Parameters<typeof previewQuotationPricing>[2] | null>(null);
  useEffect(() => {
    if (!entryId || compositions.length === 0) return;
    const t = setTimeout(() => setPreviewBody({ roomCompositions: compositions, discount, ...(previewStay ? { stay: previewStay } : {}) }), 450);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [compKey, discKey, entryId, previewStay?.checkInDate, previewStay?.checkOutDate]);
  const previewQuery = useQuery({
    queryKey: ["quotation-live-preview", entryId, previewBody],
    queryFn: () => previewQuotationPricing(session!, entryId!, previewBody!),
    enabled: !!session && !!entryId && !!previewBody,
    placeholderData: (prev) => prev,
  });
  const preview = previewQuery.data ?? null;
  const pvByRoom = useMemo(() => new Map((preview?.rooms ?? []).map((l) => [l.roomId, l])), [preview]);

  const planWord = (a: ApartmentRef) => (a.plan === "MONTHLY" ? "a month" : "a week");
  const editRent = ratesOpen && !lockCommercial && !readOnly;

  return (
    <div className={`rct apt-table${readOnly ? " ro" : ""}`}>
      <div className="rce-bar">
        {!readOnly && partySize > 0 && (
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={() => {
              const seat = seatParty(units);
              setRows((prev) => {
                const next = { ...prev };
                for (const a of units) next[keyOf(a)] = { ...prev[keyOf(a)], ...seat[keyOf(a)] };
                return next;
              });
            }}
            title="Seat the booking's guests in the apartments, an adult in each first, up to each one's most"
          >
            <Wand2 style={{ width: 13, height: 13 }} /> Distribute party
          </button>
        )}
        <span className="ln" />
        {partySize > 0 && (
          <span
            className={`rce-tally${units.reduce((s, a) => s + cnt(rows[keyOf(a)]?.ad) + cnt(rows[keyOf(a)]?.c6) + cnt(rows[keyOf(a)]?.u6), 0) !== partySize ? " off" : ""}`}
          >
            {units.reduce((s, a) => s + cnt(rows[keyOf(a)]?.ad) + cnt(rows[keyOf(a)]?.c6) + cnt(rows[keyOf(a)]?.u6), 0)}/{partySize} placed
          </span>
        )}
        <button type="button" className="rct-rates-btn" onClick={() => setRatesOpen((v) => !v)}>
          {ratesOpen ? (lockCommercial || readOnly ? "See guests" : "Done with the rent") : lockCommercial || readOnly ? "See rent" : "Edit rent"}
        </button>
        {quiet && (
          <Help label="How this table works">
            An apartment is let as one place: its rooms go together, priced by the rent. Its guests cook for
            themselves, so there are no meal plans, and no extra bed. The rent is the package&rsquo;s for the
            month or the week; Edit rent sets another for this booking. Service charge and GST are added on
            top, period by period; the service charge can be waived. A fixed discount comes off the rent
            before service charge and GST, period by period.
          </Help>
        )}
      </div>

      {limitMsg && (
        <p className="rct-refusal" role="alert" aria-live="assertive">
          <span className="ic" aria-hidden="true">
            !
          </span>
          <span>{limitMsg}</span>
        </p>
      )}

      <div className="rct-scroll">
        <table className="rct-t apt-t">
          <thead>
            <tr>
              <th className="apt-name">Apartment</th>
              <th title="The most guests the apartment sleeps">Up to</th>
              <th title="Guests aged 11 and over">Adult</th>
              <th title={`Children ${youngMax + 1}–${childMax}`}>{youngMax + 1}–{childMax}</th>
              <th title={`Children under ${youngMax + 1}`}>&lt;{youngMax + 1}</th>
              <th title="Guests in the apartment">Guests</th>
              <th className="apt-rent">{units[0] ? `Rent ${planWord(units[0])}` : "Rent"}</th>
              <th className="apt-tax" title="Service charge on the stay's rent — untick to waive it">SC</th>
              <th className="apt-tax" title="GST on the stay's rent and its service charge — always charged">GST</th>
              <th className="apt-stay" title="The stay's rent with service charge and GST">Stay</th>
            </tr>
          </thead>
          <tbody>
            {units.map((a) => {
              const r = rows[keyOf(a)] ?? { ad: "", c6: "", u6: "", rent: "", sc: true, foc: false };
              const g = cnt(r.ad) + cnt(r.c6) + cnt(r.u6);
              const over = a.maxOccupants != null && g > a.maxOccupants;
              const lead = pvByRoom.get(a.roomIds.find((x) => sealedRoomIds.includes(x)) ?? a.leadRoomId);
              const rentNow = lead?.rent;
              const periods = (rentNow?.periods ?? []) as Array<{ whole: boolean; nights: number }>;
              return (
                <tr key={keyOf(a)} className={g === 0 || over || cnt(r.ad) === 0 ? "fault" : undefined}>
                  <td className="apt-name">
                    <b>Apartment {a.label}</b>
                    <span className="apt-sub">
                      {a.packageName} · let {a.plan === "MONTHLY" ? "monthly" : "weekly"}
                    </span>
                    {a.roomNumbers.length > 1 && <span className="apt-sub">Rooms {a.roomNumbers.join(" + ")}</span>}
                  </td>
                  <td className="num">{a.maxOccupants ?? "—"}</td>
                  {(["ad", "c6", "u6"] as const).map((band) => (
                    <td key={band} className={band === "ad" && g > 0 && cnt(r.ad) === 0 ? "stop" : undefined}>
                      <input
                        className="rct-in"
                        inputMode="numeric"
                        value={r[band]}
                        readOnly={readOnly}
                        tabIndex={readOnly ? -1 : undefined}
                        aria-label={`Apartment ${a.label} — ${band === "ad" ? "adults" : band === "c6" ? `children ${youngMax + 1}–${childMax}` : `children under ${youngMax + 1}`}`}
                        onChange={(e) => typeGuests(a, band, e.target.value)}
                      />
                    </td>
                  ))}
                  <td className={`num occ${over || g === 0 ? " stop" : ""}`} title={over ? `Over its most — ${g} guests in an apartment that sleeps ${a.maxOccupants}` : undefined}>
                    {g}
                  </td>
                  <td className="apt-rent">
                    {editRent ? (
                      <input
                        className="rct-in"
                        inputMode="decimal"
                        value={r.rent}
                        placeholder={money(a.rent.rate)}
                        aria-label={`Apartment ${a.label} — rent ${planWord(a)}, without service charge and GST`}
                        onChange={(e) => {
                          const v = e.target.value;
                          if (/^\d*\.?\d{0,2}$/.test(v)) set(a, { rent: v });
                        }}
                      />
                    ) : (
                      <span className="apt-figure">Nu {money(r.rent.trim() !== "" ? r.rent : a.rent.rate)}</span>
                    )}
                    <span className="apt-sub">
                      {r.rent.trim() !== "" && Number(r.rent) !== Number(a.rent.rate)
                        ? `agreed for this booking · the package's Nu ${money(a.rent.rate)}`
                        : `${planWord(a)} · Nu ${money(a.rent.total)} with SC and GST`}
                    </span>
                  </td>
                  <td className="apt-tax">
                    <input
                      type="checkbox"
                      checked={r.sc}
                      disabled={lockCommercial || readOnly}
                      aria-label={`Apartment ${a.label} — service charge`}
                      title={lockCommercial ? "Waiving the service charge now is a re-price, not a desk edit" : r.sc ? "Charged — untick to waive it" : "Waived — tick to charge it"}
                      onChange={(e) => set(a, { sc: e.target.checked })}
                    />
                    <span className="apt-sub">{lead ? `Nu ${money(lead.payableServiceCharge ?? lead.serviceCharge)}` : "—"}</span>
                  </td>
                  <td className="apt-tax" title="GST is charged on every stay">
                    <input type="checkbox" checked disabled aria-label={`Apartment ${a.label} — GST`} />
                    <span className="apt-sub">{lead ? `Nu ${money(lead.payableGst ?? lead.gst)}` : "—"}</span>
                  </td>
                  <td className="apt-stay">
                    <span className="apt-figure">{lead ? `Nu ${money(lead.payableTotal ?? lead.total)}` : "—"}</span>
                    {periods.length > 0 && (
                      <span className="apt-sub">
                        {periodWords(a.plan, periods)}
                        {discount && lead && Number(lead.payableTotal ?? lead.total) !== Number(lead.total) ? " · after the discount" : ""}
                      </span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <FixedDiscount
        discountValue={discountValue}
        discountUnit={discountUnit}
        onDiscountChange={onDiscountChange}
        lockCommercial={lockCommercial || readOnly}
      />

      {preview && (
        <div className="rct-live">
          <span className="k">Live total</span>
          <span className="parts">
            <i>Net</i> {money(preview.subtotal)}
            {preview.discount ? (
              <>
                {" "}
                <i>− discount</i> {money(preview.discount.netReduction)} <i>=</i> {money(preview.payableSubtotal)}
              </>
            ) : null}{" "}
            <i>+ SC</i> {money(preview.payableServiceCharge)} <i>+ GST</i> {money(preview.payableGst)}
          </span>
          <b className="tot">
            {preview.currency} {money(preview.payable)}
          </b>
          <span className="ln" />
          {!quiet && <span className="src">the quote will show the same figures</span>}
        </div>
      )}

      {onSave && (
        <div className="rct-save">
          {faults.length > 0 ? (
            <ul className="rct-faults" role="alert" aria-live="polite">
              {faults.map((f) => (
                <li key={f}>{f}</li>
              ))}
            </ul>
          ) : unsaved ? (
            <span className="stop-ink" style={{ fontWeight: 700 }} role="status">
              Changed since it was quoted — save it
            </span>
          ) : (
            <span />
          )}
          <div className="rct-save-act">
            {saveAside}
            <button
              type="button"
              className={`btn btn-primary rct-save-btn${faults.length > 0 ? "" : unsaved ? " dirty" : " clean"}`}
              disabled={faults.length > 0 || !!saving || !unsaved}
              title={
                faults.length > 0
                  ? `Put right what is listed first — ${faults.length} thing${faults.length === 1 ? "" : "s"} to fix`
                  : unsaved
                    ? "Saves this table and makes the quotation from it"
                    : "Nothing to save — the quotation already carries this table"
              }
              onClick={() => onSave()}
            >
              {saving ? "Saving…" : !unsaved && faults.length === 0 ? "Saved" : (saveLabel ?? "Save & quote it")}
            </button>
          </div>
        </div>
      )}
      {!onSave && faults.length > 0 && (
        <p className="rct-refusal" role="alert" aria-live="polite" style={{ marginTop: 8, marginBottom: 0 }}>
          <span className="ic" aria-hidden="true">
            !
          </span>
          <span>{faults.join(" · ")}.</span>
        </p>
      )}
    </div>
  );
}
