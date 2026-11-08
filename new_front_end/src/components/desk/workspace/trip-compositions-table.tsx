"use client";

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { ArrowDownToLine, Maximize2, Minimize2, Wand2 } from "lucide-react";
import { useSession } from "@/hooks/use-session";
import { Help } from "@/components/ds/help";
import { previewTripQuotations, type TripPreviewStayInput } from "@/lib/api/quotations";
import {
  CompositionsHead,
  MEAL_COLS,
  MEAL_META,
  type GroupedColumns,
  type GroupedSection,
  type NumCol,
  type RateCol,
  type SectionApi,
  type SectionFacts,
} from "./room-compositions-table";

export type TripTableStay = { key: string; render: (grouped: GroupedSection) => ReactNode };

/**
 * ONE TABLE FOR THE STAYS SET UP THE SAME (2026-11-09, operator: "show both the stays configuration
 * in the same table so the user has the ease of making the changes"). One head, one set of tools,
 * and each stay's rows under its own band. A stay keeps what is its own — its guests, rates, live
 * price, discount, quotation — and this table owns only the columns they share. Every figure is the
 * server's: each stay's own preview, and the trip's total added up there.
 */
export function TripCompositionsTable({
  entryId,
  stays,
  ratesStartOpen,
  priceInputs,
  faults,
  unsaved,
  saving,
  saveLabel,
  onSave,
  allReadOnly,
}: {
  entryId: string;
  stays: TripTableStay[];
  ratesStartOpen: boolean;
  priceInputs: TripPreviewStayInput[];
  faults: string[];
  unsaved: boolean;
  saving: boolean;
  saveLabel: string;
  onSave: () => void;
  allReadOnly: boolean;
}) {
  const { session } = useSession();
  const scrollRef = useRef<HTMLDivElement>(null);
  const [facts, setFacts] = useState<Record<string, SectionFacts>>({});
  const apis = useRef<Record<string, SectionApi | null>>({});
  const [activePlans, setActivePlans] = useState<Set<NumCol>>(new Set());
  const [ratesOpen, setRatesOpen] = useState(ratesStartOpen);
  const [justOn, setJustOn] = useState<NumCol | null>(null);
  const [expanded, setExpanded] = useState(false);

  const all = Object.values(facts);
  const hasPax = (c: NumCol) => all.some((f) => f.pax.includes(c));
  const meals = MEAL_COLS.filter((c) => activePlans.has(c) || hasPax(c));
  const others = hasPax("ot");
  const bf = (["cp", "ml", "md", "ap"] as NumCol[]).some((c) => meals.includes(c)) || hasPax("obf");
  const lu = (["ml", "ap"] as NumCol[]).some((c) => meals.includes(c)) || hasPax("olu");
  const di = (["md", "ap"] as NumCol[]).some((c) => meals.includes(c)) || hasPax("odi");
  const rateCols: RateCol[] = ["rRoom", "rBed", ...(bf ? (["rBf"] as const) : []), ...(lu ? (["rLu"] as const) : []), ...(di ? (["rDi"] as const) : [])];
  const kids = all.some((f) => f.kids);
  const beds = all.some((f) => f.beds);
  const columns: GroupedColumns = { kids, meals, others, rateCols, beds, ratesOpen, justOn };
  const totalRows = stays.reduce((s, x) => s + (facts[x.key]?.rows ?? 0), 0);

  const each = (f: (a: SectionApi) => void) => {
    for (const s of stays) {
      const a = apis.current[s.key];
      if (a) f(a);
    }
  };
  const togglePlan = (c: NumCol) => {
    if (meals.includes(c)) {
      setActivePlans((prev) => {
        const n = new Set(prev);
        n.delete(c);
        return n;
      });
      each((a) => a.planOff(c));
    } else {
      setActivePlans((prev) => new Set(prev).add(c));
      setJustOn(c);
    }
  };
  const everyoneOn = (col: NumCol | "none") => {
    setActivePlans(col === "none" ? new Set() : new Set([col]));
    each((a) => a.everyoneOn(col));
  };
  /** The first row on screen, onto every other row of every stay. */
  const copyDown = () => {
    const first = apis.current[stays[0]?.key ?? ""];
    const src = first?.copySource();
    if (!src) return;
    stays.forEach((s, i) => apis.current[s.key]?.applyCopy(src, i === 0));
  };

  // A meal plan switched on: the cursor goes to its first cell. The table scrolls sideways inside
  // its own box; the page stays where it is.
  useEffect(() => {
    if (!justOn) return;
    const box = scrollRef.current;
    const cell = box?.querySelector<HTMLInputElement>(`input[data-cell$=":${justOn}"]:not([readonly])`);
    if (box && cell) {
      cell.focus({ preventScroll: true });
      const over = cell.getBoundingClientRect().right - box.getBoundingClientRect().right;
      if (over > 0) box.scrollLeft += over + 12;
    }
    const t = setTimeout(() => setJustOn(null), 1400);
    return () => clearTimeout(t);
  }, [justOn]);
  useEffect(() => {
    if (!expanded) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setExpanded(false);
    };
    window.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [expanded]);

  // The trip's figure, added up on the server.
  const key = JSON.stringify(priceInputs);
  const [body, setBody] = useState<TripPreviewStayInput[] | null>(null);
  useEffect(() => {
    if (priceInputs.length < 2 || priceInputs.some((s) => s.roomCompositions.length === 0)) return;
    const t = setTimeout(() => setBody(priceInputs), 450);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  const previewQ = useQuery({
    queryKey: ["trip-live-preview", entryId, body],
    queryFn: () => previewTripQuotations(session!, entryId, body!),
    enabled: !!session && !!body,
    placeholderData: (prev) => prev,
  });
  const trip = previewQ.data ?? null;
  const fmtNu = (n: number | null | undefined) => (n == null ? "—" : n.toLocaleString("en-IN", { maximumFractionDigits: 2 }));

  // The stay bands stay as wide as the visible box, so each stay's total sits at its right edge.
  useEffect(() => {
    const box = scrollRef.current;
    if (!box) return;
    const put = () => box.style.setProperty("--rct-w", `${box.clientWidth}px`);
    put();
    const ro = new ResizeObserver(put);
    ro.observe(box);
    return () => ro.disconnect();
  }, [expanded]);

  const offsets = useMemo(() => {
    const out: Record<string, number> = {};
    let at = 0;
    for (const s of stays) {
      out[s.key] = at;
      at += facts[s.key]?.rows ?? 0;
    }
    return out;
  }, [stays, facts]);

  return (
    <div className={`${expanded ? "rct rst-expandwrap on" : "rct"} rct-trip`}>
      {expanded && (
        <div className="rst-expandbar">
          <b>Room composition · {stays.length} stays</b>
          <span className="ln" />
          <button type="button" className="btn btn-ghost" onClick={() => setExpanded(false)}>
            <Minimize2 style={{ width: 13, height: 13 }} /> Close
          </button>
        </div>
      )}
      <div className="rce-bar">
        {!allReadOnly && (
          <>
            <button type="button" className="btn btn-ghost btn-sm" onClick={() => each((a) => a.distribute())} title="Spread each stay's own party across its rooms">
              <Wand2 style={{ width: 13, height: 13 }} /> Distribute party
            </button>
            <select
              className="rce-allsel"
              style={{ marginLeft: 0 }}
              value=""
              onChange={(e) => {
                if (e.target.value) everyoneOn(e.target.value as NumCol | "none");
              }}
              title="Set every room of every stay on one meal plan"
            >
              <option value="">Everyone on…</option>
              <option value="none">None (EP)</option>
              <option value="cp">CP · breakfast</option>
              <option value="ml">MAP · +lunch</option>
              <option value="md">MAP · +dinner</option>
              <option value="ap">AP · all meals</option>
              <option value="ot">Others</option>
            </select>
            {totalRows > 1 && (
              <button type="button" className="rcb-mini" onClick={copyDown} title="Copy the first row onto every other row of every stay — meals, extra beds, rates and charges (guest counts stay put)">
                <ArrowDownToLine style={{ width: 11, height: 11 }} /> Copy row 1 ↓
              </button>
            )}
            <span className="rce-lbl">Meals</span>
            {MEAL_COLS.map((c) => {
              const on = meals.includes(c);
              return (
                <button
                  key={c}
                  type="button"
                  className={`rct-chip${on ? " on" : ""}`}
                  onClick={() => togglePlan(c)}
                  title={on ? `${MEAL_META[c].title} — click to remove the column (zeroes its pax on every stay)` : `${MEAL_META[c].title} — click to add the column`}
                >
                  {MEAL_META[c].chip}
                </button>
              );
            })}
          </>
        )}
        <span className="ln" />
        {!expanded && (
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => setExpanded(true)} title="Expand to full screen">
            <Maximize2 style={{ width: 13, height: 13 }} /> Expand
          </button>
        )}
        <Help label="How this table works">
          <p>Every stay set up the same, in one table. Each stay has its own rows, its own guests, its own discount and its own quotation.</p>
          <p>Distribute party, Everyone on… and Copy row 1 reach every stay. To work one stay alone, pick it from the booking&rsquo;s number at the top of the page. What you change there is here when you come back.</p>
        </Help>
      </div>
      <div className="rct-scroll" ref={scrollRef}>
        <table className="rct-t">
          <CompositionsHead
            kids={kids}
            meals={meals}
            others={others}
            rateCols={rateCols}
            beds={beds}
            ratesOpen={ratesOpen}
            justOn={justOn}
            readOnly={allReadOnly}
            onToggleRates={() => setRatesOpen((v) => !v)}
          />
          {stays.map((s) =>
            s.render({
              columns,
              rowOffset: offsets[s.key] ?? 0,
              totalRows,
              scrollRef,
              band: null,
              onFacts: (f) => setFacts((prev) => ({ ...prev, [s.key]: f })),
              apiRef: (a) => {
                apis.current[s.key] = a;
              },
            }),
          )}
        </table>
      </div>
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
          {trip && (
            <span
              className="rct-triptot"
              title={`Net ${fmtNu(trip.totals.subtotal)}${trip.totals.netReduction > 0 ? ` − discount ${fmtNu(trip.totals.netReduction)} = ${fmtNu(trip.totals.payableSubtotal)}` : ""} + service charge ${fmtNu(trip.totals.payableServiceCharge)} + GST ${fmtNu(trip.totals.payableGst)}`}
            >
              Trip total <b>{trip.currency} {fmtNu(trip.totals.payable)}</b>
            </span>
          )}
          <button
            type="button"
            className={`btn btn-primary rct-save-btn${faults.length > 0 ? "" : unsaved ? " dirty" : " clean"}`}
            disabled={faults.length > 0 || saving || !unsaved}
            title={
              faults.length > 0
                ? `Put right what is listed first — ${faults.length} thing${faults.length === 1 ? "" : "s"} to fix`
                : unsaved
                  ? "Saves each stay that changed and makes its quotation"
                  : "Nothing to save — each quotation already carries its stay's rows"
            }
            onClick={onSave}
          >
            {saving ? "Saving…" : !unsaved && faults.length === 0 ? "Saved" : saveLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
