"use client";

import { Fragment, type ReactNode } from "react";
import { useQueries, useQuery } from "@tanstack/react-query";
import { useSession } from "@/hooks/use-session";
import { getRateReference, type EntryRateReference } from "@/lib/api/entries";
import { moneyOrDash } from "@/lib/desk/workspace";
import { Help } from "@/components/ds/help";
import { TypePackagePick } from "@/components/ds/type-package-pick";

/**
 * Reference rates under the S2 composition editors (2026-08-01, operator request): typing a
 * negotiated rate needs an anchor — what would this room cost WITHOUT one? Reads
 * GET /api/entries/:id/rate-reference, which returns exactly the defaults the backend pricing
 * uses (agent/corporate card incl. per-type override, else the standard rate plan, plus the
 * card's extra-bed/meal add-ons and the standard rate + MSR floor). Display only — every
 * figure verbatim from the API, nothing computed here.
 */

/**
 * A rate on this strip is the anchor every negotiated figure below it is typed against, so it is
 * read, not squinted at ("UIappeal", 2026-09-29): the money in full ink and bold while the labels
 * around it stay quiet.
 */
const RATE: React.CSSProperties = { fontSize: 13.5, fontWeight: 700, color: "var(--ink, #1e1c19)", whiteSpace: "nowrap" };
/**
 * The MSR floor is a LIMIT, not a footnote: the house's minimum sellable rate for the type, and a
 * booking priced under it needs the GM's waiver (p19). It is drawn as a bounded chip so the eye
 * catches it, and the grid turns a room's rate red when it is typed below this figure.
 */
const FLOOR: React.CSSProperties = {
  display: "inline-block",
  padding: "1px 6px",
  borderRadius: 4,
  border: "1px solid var(--stop, #b3261e)",
  background: "var(--stop-t, #fbecea)",
  color: "var(--stop, #b3261e)",
  fontWeight: 700,
  fontSize: 12,
};
/** A quiet word beside a figure: the rooms of a type, where a rate comes from. */
const MUTED: React.CSSProperties = { color: "var(--ink-3, #7a6a52)", fontWeight: 400, fontSize: 12 };

/** The add-on rate columns. Rendered only when at least one type carries a value — without a
 *  rate card they are ALL null, and four columns of dashes were most of the strip's noise. */
const PLAN_LABEL: Record<string, string> = { cpRate: "CP", mapLunchRate: "MAP+L", mapDinnerRate: "MAP+D", apRate: "AP" };

const ADD_ON_COLS = [
  ["extraBedRate", "Extra bed"],
  ["breakfastRate", "Breakfast"],
  ["lunchRate", "Lunch"],
  ["dinnerRate", "Dinner"],
] as const;

/**
 * One line per room type (2026-10-29, operator: "is there a way this can be displayed differently
 * which takes less space"; and the room numbers it listed "shouldn't [show] unless a specified room
 * was picked"). The type, how many rooms of it the booking has — a room the guest asked for by
 * number named by its number, the system's rooms only counted — then each rate with its label, the
 * basis, and the MSR floor as a chip.
 */
export function RateReferenceStrip({
  entryId,
  compact,
  roomIds,
  quietNumbers,
}: {
  entryId: string;
  compact?: boolean;
  roomIds?: string[];
  /** Numbers of the rooms the system chose (they read "Standard Double · room 1" until Arrival) — counted, never named. */
  quietNumbers?: Set<string>;
}) {
  const { session } = useSession();
  const roomsKey = (roomIds ?? []).join(",");
  const query = useQuery({
    queryKey: roomsKey ? ["rate-reference", entryId, roomsKey] : ["rate-reference", entryId],
    queryFn: () => getRateReference(session!, entryId, roomIds),
    enabled: !!session,
    staleTime: 30_000,
  });

  const ref = query.data;
  if (!ref || ref.roomTypes.length === 0) return null;
  return <RateReferenceView ref_={ref} compact={compact} quietNumbers={quietNumbers} entryId={entryId} />;
}

/**
 * The rates of the stays worked in one table, once, above it (2026-11-09, operator: "this rate at
 * nights can be shown above the table as one"). A room type at the same rates on every stay is one
 * line; a type a stay does not have, or at other rates on another stay, says which stay it is for.
 */
export function TripRateReferenceStrip({ stays }: { stays: Array<{ entryId: string; roomIds: string[]; stayNo: number }> }) {
  const { session } = useSession();
  const reads = useQueries({
    queries: stays.map((s) => ({
      queryKey: ["rate-reference", s.entryId, s.roomIds.join(",")],
      queryFn: () => getRateReference(session!, s.entryId, s.roomIds),
      enabled: !!session && s.roomIds.length > 0,
      staleTime: 30_000,
    })),
  });
  const refs = reads.map((r) => r.data);
  if (stays.length === 0 || refs.some((r) => !r)) return null;
  type Row = EntryRateReference["roomTypes"][number];
  const groups = new Map<string, { t: Row; stayNos: number[] }>();
  refs.forEach((ref, i) => {
    for (const t of ref!.roomTypes) {
      const key = JSON.stringify([t.roomTypeId, t.roomRate, t.extraBedRate, t.breakfastRate, t.lunchRate, t.dinnerRate, t.roomRateSource, t.packageName, t.msrValue]);
      const g = groups.get(key);
      if (g) g.stayNos.push(stays[i].stayNo);
      else groups.set(key, { t, stayNos: [stays[i].stayNo] });
    }
  });
  const list = [...groups.values()];
  /**
   * The package of each type, stay by stay (2026-11-13, operator: "a trip viewed together at
   * Negotiation: do this"). A line is shared only while the stays are on the same package, so a
   * change splits it into a line per stay.
   */
  const picker = new Map<Row, ReactNode>();
  for (const g of list) {
    if (g.t.roomRateSource !== "AGENT_RATE_PACKAGE") continue;
    const on = g.stayNos
      .map((no) => ({ no, i: stays.findIndex((s) => s.stayNo === no) }))
      .filter(({ i }) => i >= 0 && (refs[i]!.packages?.length ?? 0) > 1);
    if (!on.length) continue;
    picker.set(
      g.t,
      <span className="rref-pkg trip">
        {on.map(({ no, i }) => {
          const r = refs[i]!;
          const mine = r.roomTypes.find((x) => x.roomTypeId === g.t.roomTypeId);
          return (
            <span key={no} className="rref-pkg-stay">
              Stay {no}
              <TypePackagePick
                entryId={stays[i].entryId}
                roomTypeId={g.t.roomTypeId}
                typeName={`Stay ${no}'s ${g.t.name}`}
                packages={r.packages!}
                value={mine?.ratePackageId ?? null}
                editable={!!r.packagesEditable}
              />
            </span>
          );
        })}
      </span>,
    );
  }
  const note = new Map<Row, string>();
  for (const g of list) {
    const everyStay = g.stayNos.length === stays.length;
    note.set(g.t, everyStay ? "" : g.stayNos.length === 1 ? `stay ${g.stayNos[0]}` : `stays ${g.stayNos.join(" and ")}`);
  }
  const first = refs[0]!;
  const plansOff = [...new Map(refs.flatMap((r) => r!.plansOff ?? []).map((p) => [JSON.stringify(p), p])).values()];
  return (
    <RateReferenceView ref_={{ ...first, roomTypes: list.map((g) => g.t), plansOff }} compact noteOf={(t) => note.get(t) ?? ""} pickerOf={(t) => picker.get(t) ?? null} />
  );
}

function RateReferenceView({
  ref_: ref,
  compact,
  quietNumbers,
  noteOf,
  entryId,
  pickerOf,
}: {
  ref_: EntryRateReference;
  compact?: boolean;
  quietNumbers?: Set<string>;
  /** One booking's strip: with several packages, each type's package can be changed here (2026-11-13). */
  entryId?: string;
  /** The stays' strip: a picker per stay in place of the package's name. */
  pickerOf?: (t: EntryRateReference["roomTypes"][number]) => ReactNode;
  /** In place of the rooms beside a type's name. */
  noteOf?: (t: EntryRateReference["roomTypes"][number]) => string;
}) {
  const pct = (rate: number) => `${(rate * 100).toLocaleString(undefined, { maximumFractionDigits: 2 })}%`;
  const visibleAddOns = ADD_ON_COLS.filter(([key]) => ref.roomTypes.some((t) => t[key] != null));
  const roomsWord = (numbers: string[]) => {
    const named = numbers.filter((n) => !quietNumbers?.has(n));
    const counted = numbers.length - named.length;
    const parts = [
      ...(counted > 0 ? [`${counted} room${counted === 1 ? "" : "s"}`] : []),
      ...(named.length ? [`Room${named.length === 1 ? "" : "s"} ${named.join(", ")}`] : []),
    ];
    return parts.join(" · ") || "not on the booking";
  };

  /**
   * A table, one row per room type (2026-11-25, operator, on a strip whose lines wrapped wherever they
   * ran out of room: "this part is very messy"): the labels once, in a header, and each rate in its own
   * column, so the figures line up down the page and nothing drops onto the next line. A wide table
   * scrolls inside its own box rather than wrapping.
   */
  // A room type whose rooms here are an apartment let by the month or the week (2026-11-25): its room
  // is priced by the rent, not a nightly rate, takes no extra bed, and no floor applies.
  const apartmentNumbers = new Set((ref.apartments ?? []).flatMap((a) => a.roomNumbers));
  const isApartment = (t: EntryRateReference["roomTypes"][number]) =>
    t.roomNumbers.length > 0 && t.roomNumbers.every((n) => apartmentNumbers.has(n));
  const hasBasis = ref.roomTypes.some((t) => t.roomRateSource !== "STANDARD_RATE_PLAN" && !isApartment(t));
  const hasMsr = ref.roomTypes.some((t) => t.roomRateSource === "STANDARD_RATE_PLAN" && t.msrValue != null && !isApartment(t));
  const columns = [
    "max-content",
    "max-content",
    ...visibleAddOns.map(() => "max-content"),
    ...(hasBasis ? ["max-content"] : []),
    ...(hasMsr ? ["max-content"] : []),
    // The rest of the box, so each row's line runs to its edge.
    "minmax(0, 1fr)",
  ].join(" ");
  const cell = (opts: { head?: boolean; first?: boolean; right?: boolean }): React.CSSProperties => ({
    padding: opts.head ? "2px 10px 5px" : "6px 10px",
    paddingLeft: opts.first ? 0 : 10,
    borderTop: opts.head ? undefined : "1px solid var(--line, #e3d9c8)",
    textAlign: opts.right ? "right" : "left",
    whiteSpace: "nowrap",
    alignSelf: "stretch",
    display: "flex",
    alignItems: "center",
    justifyContent: opts.right ? "flex-end" : "flex-start",
    gap: 6,
  });
  const basisOf = (t: EntryRateReference["roomTypes"][number]): ReactNode => {
    const standard = t.standardRate != null ? <span style={MUTED}>standard {moneyOrDash(t.standardRate, ref.currency)}</span> : null;
    if (t.roomRateSource === "AGENT_RATE_PACKAGE" && pickerOf?.(t)) {
      return (
        <span className="rref-pkg">
          {pickerOf(t)}
          {standard}
        </span>
      );
    }
    if (t.roomRateSource === "AGENT_RATE_PACKAGE" && entryId && (ref.packages?.length ?? 0) > 1) {
      return (
        <span className="rref-pkg">
          <TypePackagePick
            entryId={entryId}
            roomTypeId={t.roomTypeId}
            typeName={t.name}
            packages={ref.packages!}
            value={t.ratePackageId ?? null}
            editable={!!ref.packagesEditable}
          />
          {standard}
        </span>
      );
    }
    if (t.roomRateSource === "AGENT_RATE_PACKAGE") {
      return (
        <>
          <span style={{ color: "var(--ink, #1e1c19)", fontWeight: 600 }}>{t.packageName ?? "rate package"}</span>
          {standard}
        </>
      );
    }
    if (t.roomRateSource !== "STANDARD_RATE_PLAN") return <span>no rate on file</span>;
    return <span style={MUTED}>published</span>;
  };

  return (
    <div
      style={{
        marginTop: compact ? 0 : 12,
        fontSize: 12,
        color: "var(--ink-3, #7a6a52)",
        border: "1px solid var(--line-2, #d9cdb8)",
        borderRadius: "var(--r-md, 10px)",
        background: "var(--cream, #faf6ee)",
        padding: "8px 12px 4px",
        overflowX: "auto",
      }}
    >
      <div style={{ display: "grid", gridTemplateColumns: columns, width: "100%" }}>
        <div style={cell({ head: true, first: true })}>
          <span className="rce-lbl">Rates a night</span>
          <Help label="About the reference rates">
            <p>What each room type sells at per night when no rate is negotiated — the figure a rate typed in the table is set against.</p>
            <p>
              Service charge ({pct(ref.serviceChargeRate)}) and GST ({pct(ref.gstRate)}) are added on top.
              {ref.party ? ` The rates are ${ref.party.name}'s ${ref.party.type === "TRAVEL_AGENT" ? "agency" : "company"} rates.` : ""}
            </p>
            <p>The rates are the house&rsquo;s published rates unless a rate package is named beside them.</p>
            <p>MSR is the lowest rate the house sells at — a room priced below it needs the GM&rsquo;s waiver.</p>
            {visibleAddOns.length === 0 ? <p>No extra-bed or meal rates are on file — those price at nothing unless negotiated in the table.</p> : null}
          </Help>
        </div>
        <div style={cell({ head: true, right: true })}>
          <span className="rce-lbl">Room</span>
        </div>
        {visibleAddOns.map(([key, label]) => (
          <div key={key} style={cell({ head: true, right: true })}>
            <span className="rce-lbl">{label}</span>
          </div>
        ))}
        {hasBasis ? (
          <div style={cell({ head: true })}>
            <span className="rce-lbl">Rate from</span>
          </div>
        ) : null}
        {hasMsr ? (
          <div style={cell({ head: true })}>
            <span className="rce-lbl">MSR floor</span>
          </div>
        ) : null}
        <div style={cell({ head: true })} />

        {ref.roomTypes.map((t, i) => {
          const note = noteOf ? noteOf(t) : roomsWord(t.roomNumbers);
          return (
            <Fragment key={`${t.roomTypeId}${i}`}>
              <div style={cell({ first: true })}>
                <b style={{ color: "var(--ink, #1e1c19)", fontSize: 13 }}>{t.name}</b>
                {note ? <span style={MUTED}>{note}</span> : null}
              </div>
              <div style={cell({ right: true })}>
                {isApartment(t) ? (
                  <b style={RATE} title="Let as an apartment — priced by its rent, below">
                    rent
                  </b>
                ) : (
                  <b className="mono" style={RATE}>{moneyOrDash(t.roomRate, ref.currency)}</b>
                )}
              </div>
              {visibleAddOns.map(([key]) => (
                <div key={key} style={cell({ right: true })}>
                  {isApartment(t) && key === "extraBedRate" ? (
                    <span style={MUTED} title="An apartment's rooms take no extra bed">
                      —
                    </span>
                  ) : (
                    <b className="mono" style={RATE}>{moneyOrDash(t[key], ref.currency)}</b>
                  )}
                </div>
              ))}
              {hasBasis ? <div style={cell({})}>{isApartment(t) ? null : basisOf(t)}</div> : null}
              {hasMsr ? (
                <div style={cell({})}>
                  {t.roomRateSource === "STANDARD_RATE_PLAN" && t.msrValue != null && !isApartment(t) ? (
                    <span
                      className="mono"
                      style={FLOOR}
                      title="Minimum sellable rate — the house's floor for this room type. A booking priced below it needs the GM's waiver."
                    >
                      {moneyOrDash(t.msrValue, ref.currency)}
                    </span>
                  ) : (
                    <span style={MUTED} title="A rate package's rate is agreed with the party — no floor applies.">
                      —
                    </span>
                  )}
                </div>
              ) : null}
              <div style={cell({})} />
            </Fragment>
          );
        })}

        {/* The rent of each apartment, the server's figures (2026-11-25). */}
        {(ref.apartments ?? []).map((a) => (
          <div
            key={a.label}
            style={{ gridColumn: "1 / -1", padding: "6px 0", borderTop: "1px solid var(--line, #e3d9c8)", color: "var(--ink, #1e1c19)", whiteSpace: "normal" }}
          >
            <b>
              Apartment {a.label} · {a.packageName}
            </b>
            {a.roomNumbers.length > 1 ? ` · Rooms ${a.roomNumbers.join(" + ")}` : ""} · let {a.plan === "MONTHLY" ? "monthly" : "weekly"} at{" "}
            <b className="mono">{moneyOrDash(a.rent.total, ref.currency)}</b> a {a.plan === "MONTHLY" ? "month" : "week"} with service charge and GST{" "}
            <span style={MUTED}>({moneyOrDash(a.rent.rate, ref.currency)} without)</span> — no extra bed.
          </div>
        ))}

        {/* A plan at a figure of its own is charged in place of the meals above, so the meals alone would not explain the bill (2026-11-04). */}
        {ref.plansOff?.length ? (
          <div
            style={{
              gridColumn: "1 / -1",
              padding: "6px 0",
              borderTop: "1px solid var(--line, #e3d9c8)",
              color: "var(--warning, #8f5300)",
              fontWeight: 600,
              whiteSpace: "normal",
            }}
          >
            Charged in place of their meals:{" "}
            {ref.plansOff
              .map((p) => `${PLAN_LABEL[p.key] ?? p.key} ${moneyOrDash(p.rate, ref.currency)}${p.packageName ? ` on ${p.packageName}` : ""} (the meals come to ${moneyOrDash(p.meals, ref.currency)})`)
              .join(" · ")}
          </div>
        ) : null}
      </div>
    </div>
  );
}
