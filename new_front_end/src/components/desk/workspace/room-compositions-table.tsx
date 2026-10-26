"use client";

import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ArrowDownToLine, ChevronLeft, ChevronRight, Maximize2, Minimize2, Wand2 } from "lucide-react";
import { RateReferenceStrip } from "./rate-reference-strip";
import { useSession } from "@/hooks/use-session";
import { listRooms } from "@/lib/api/rooms";
import { getAllowedRoomCounts, getChildPolicy } from "@/lib/api/child-policy";
import { getRateReference } from "@/lib/api/entries";
import { previewQuotationPricing, type RoomCompositionInput, type RoomNightMealOverrideInput } from "@/lib/api/quotations";
import { Help, useQuietScreen } from "@/components/ds/help";

/**
 * Spreadsheet-style composition table (2026-07-28) — the pure-tabular alternative to the
 * guest board on the S2 quote step. One row per sealed room, every field a cell, in the
 * shape the hotel's legacy PMS grid trained the staff on.
 *
 * What makes it a spreadsheet and not just a dense form:
 *   - "Occ" is DERIVED (adults + child bands) — the Policy-79 "breakdown ≠ occupants"
 *     error can no longer be typed, so that whole warning class is gone;
 *   - arrow keys / Enter walk the grid cell-to-cell (inputs are text+numeric, not
 *     type=number, so ArrowUp/Down navigates instead of spinning the value);
 *   - bulk actions do the repetitive part: "Distribute party" spreads the booking's
 *     guests across rows, "Everyone on <plan>" sets each room's plan pax to its
 *     occupancy, "Copy row 1 ↓" clones meals / beds / toggles / rates (never the
 *     guest bands) onto every other row;
 *   - a live Σ footer reconciles guests placed vs the intake party and sums each
 *     meal-plan column;
 *   - columns are ADAPTIVE (2026-07-28): CNB columns only exist when the intake party
 *     has children (or saved data already carries child counts — the manual "Kids +"
 *     corner toggle was removed 2026-07-31; only the Rates toggle remains),
 *     and meal-plan columns appear per plan as the operator toggles its chip
 *     or picks "Everyone on…" — a two-adult CP booking sees a 2-guest, 1-meal grid,
 *     not the full matrix. A column with pax in it can never silently hide; switching
 *     a plan chip off zeroes its column so nothing invisible feeds the draft.
 *
 * Meal pax that exceed a row's occupancy get a warn outline (Policy 79's second rule —
 * still enforced server-side on draft). Negotiated-rate columns and Others à-la-carte
 * columns stay collapsed until toggled / needed so the common case stays narrow.
 * NO MONEY IS COMPUTED HERE — the backend prices when the draft is created.
 */

type RowState = {
  ad: string;
  c6: string;
  u6: string;
  bed: string;
  cp: string;
  ml: string;
  md: string;
  ap: string;
  ot: string;
  obf: string;
  olu: string;
  odi: string;
  rRoom: string;
  rBed: string;
  rBf: string;
  rLu: string;
  rDi: string;
  sc: boolean;
  gst: boolean;
  foc: boolean;
};

const EMPTY_ROW: RowState = {
  ad: "",
  c6: "",
  u6: "",
  bed: "0",
  cp: "0",
  ml: "0",
  md: "0",
  ap: "0",
  ot: "0",
  obf: "",
  olu: "",
  odi: "",
  rRoom: "",
  rBed: "",
  rBf: "",
  rLu: "",
  rDi: "",
  sc: true,
  gst: true,
  foc: false,
};

type NumCol = Exclude<keyof RowState, "sc" | "gst" | "foc">;
const MEAL_COLS: NumCol[] = ["cp", "ml", "md", "ap", "ot"];
const MEAL_META: Record<string, { chip: string; th: string; title: string }> = {
  cp: { chip: "CP", th: "CP", title: "Breakfast only" },
  ml: { chip: "MAP+L", th: "M+L", title: "Breakfast + lunch" },
  md: { chip: "MAP+D", th: "M+D", title: "Breakfast + dinner" },
  ap: { chip: "AP", th: "AP", title: "All meals" },
  ot: { chip: "Others", th: "Oth", title: "Others — à-la-carte, set pax in the columns that appear" },
};

/**
 * The negotiated-rate columns (2026-08-07, operator request). Room and Bed are the DEFAULT
 * pair — always present while the rates group is open, because every booking sells a room
 * and may sell beds. Each meal's column exists only while that meal is actually in play
 * (some room's plan includes it, or à-la-carte pax order it): an EP booking negotiates room
 * & bed alone; three CP rooms + one MAP+L show Breakfast for all and Lunch for that one
 * room; no plan with dinner → no Dinner column at all.
 */
type RateCol = "rRoom" | "rBed" | "rBf" | "rLu" | "rDi";
const RATE_META: Record<RateCol, { th: string; meal: string | null }> = {
  rRoom: { th: "Room", meal: null },
  rBed: { th: "Extra bed", meal: null },
  rBf: { th: "B'fast", meal: "breakfast" },
  rLu: { th: "Lunch", meal: "lunch" },
  rDi: { th: "Dinner", meal: "dinner" },
};

function cnt(v: string): number {
  const n = parseInt(v || "0", 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * Booking-wide discount, edited from inside the composition panel. The figure can be a percent
 * OR a flat Nu amount (2026-08-06, operator request) — `discountUnit` says which; both are
 * measured against the grand total server-side (`applyBookingDiscountToTotals`).
 */
export type DiscountUnit = "percent" | "amount";
export type DiscountEdit = {
  discountValue?: string;
  discountUnit?: DiscountUnit;
  discountBasis?: string;
  onDiscountChange?: (patch: { value?: string; unit?: DiscountUnit; basis?: string }) => void;
};

/**
 * Negotiation strip (2026-08-03, operator request) — the discount moved out of the form
 * blocks below and into the composition panel, so rates, FOC and the discount are edited in
 * one place and the panel reads as the negotiation surface.
 *
 * The discount is BOOKING-WIDE, not per room: the backend folds it into the resolved room
 * rate before the compositions are costed (`prepareQuotationDraft`). Two consequences the
 * strip states outright rather than leaving the operator to discover them from the total —
 * a room carrying its own negotiated rate ignores the default rate and so prices the same
 * discounted or not, and meals / extra beds are never discounted (they come off the rate
 * card's add-ons). NO MONEY IS COMPUTED HERE — the backend prices on create/regenerate.
 */
export function NegotiationDiscountBar({
  discountValue,
  discountUnit,
  discountBasis,
  onDiscountChange,
  lockCommercial,
}: DiscountEdit & { lockCommercial?: boolean }) {
  const quiet = useQuietScreen();
  if (!onDiscountChange) return null;
  const unit: DiscountUnit = discountUnit ?? "percent";
  const n = Number(discountValue ?? "");
  const live = Number.isFinite(n) && n > 0;
  return (
    <div className="rct-neg">
      <span className="rce-lbl">Negotiate</span>
      <label className="rct-neg-f">
        Discount
        <input
          type="text"
          inputMode="decimal"
          className="rct-neg-val"
          value={discountValue ?? ""}
          placeholder="0"
          readOnly={lockCommercial}
          onChange={(e) => {
            const v = e.target.value;
            if (!/^\d*\.?\d*$/.test(v)) return;
            // 100% off is a full waiver — use the per-room FOC toggle for that instead. A flat
            // amount has no such cap client-side; the backend clamps it to the bill.
            if (unit === "percent" && v !== "" && Number(v) > 100) return;
            onDiscountChange({ value: v });
          }}
          title={
            unit === "percent"
              ? "Percentage off the booking's grand total"
              : "Flat amount off the booking's grand total (Nu)"
          }
        />
      </label>
      {/* The unit is the operator's choice (2026-08-06): the same figure box holds a percent or
          a flat Nu amount, and this switch says which the backend receives. The `amount` class
          slides the pill thumb (CSS ::before) — the buttons themselves never move or resize. */}
      <span className={`rct-neg-unit${unit === "amount" ? " amount" : ""}`} role="group" aria-label="Discount given as">
        <button
          type="button"
          className={unit === "percent" ? "on" : ""}
          disabled={lockCommercial}
          title="Give the discount as a percentage of the grand total"
          onClick={() =>
            // A figure over 100 is legal as an amount but not as a percent — clear it on switch
            // rather than carrying an untypeable value into the capped input.
            onDiscountChange({ unit: "percent", ...(live && n > 100 ? { value: "" } : {}) })
          }
        >
          %
        </button>
        <button
          type="button"
          className={unit === "amount" ? "on" : ""}
          disabled={lockCommercial}
          title="Give the discount as a flat amount in Nu"
          onClick={() => onDiscountChange({ unit: "amount" })}
        >
          Nu
        </button>
      </span>
      <label className="rct-neg-f wide">
        Basis
        <input
          type="text"
          value={discountBasis ?? ""}
          readOnly={lockCommercial}
          placeholder="negotiation"
          onChange={(e) => onDiscountChange({ basis: e.target.value })}
          title="Why the discount is being given — recorded on the quote and audited"
        />
      </label>
      {live && (
        <span className="rct-neg-on">
          −{unit === "percent" ? `${n}%` : `Nu ${n.toLocaleString()}`} off the total
        </span>
      )}
      {/* States the CURRENT model (operator ruling 2026-08-04, applyBookingDiscountToTotals):
          the deduction comes off the grand total, meals and beds included — the earlier
          "room rate only" wording described the superseded 2026-08-03 model. In a quiet screen
          it is behind a "?" beside the fields it explains. */}
      {quiet ? (
        <Help label="About the discount">
          <p>A percentage or a flat amount in Nu. Either way it comes off the booking&rsquo;s grand total, meals and extra beds included.</p>
          <p>Service charge and GST follow the discounted figure. A discount larger than the bill brings it to zero — it is never a refund.</p>
          <p>The basis is why the discount is given; it is recorded on the quotation.</p>
        </Help>
      ) : null}
      <span className="ln" />
      {quiet ? null : (
        <span
          className="rct-neg-note"
          style={{ textAlign: "right", flex: "0 1 auto" }}
          title="Percent or flat amount — both come off the booking's grand total, meals and extra beds included. Service charge and GST follow the discounted figure, and a discount larger than the bill settles it (never a refund). The hotel's system works out the figures when the quote is saved."
        >
          Comes off the grand total — meals &amp; beds included
        </span>
      )}
    </div>
  );
}

function numOrUndef(v: string): number | undefined {
  if (v === "") return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
}

/**
 * What a room may hold differently NIGHT BY NIGHT (2026-10-22, operator: "if the guest doesn't
 * want a meal plan on the late date, I can't do that"): its meals and its extra beds. Who
 * sleeps in the room, its negotiated rates and its charges stay the room's for every night it
 * is held — a composition row has one set of guests, and the backend stores the rest per night
 * (`nightMealOverrides`).
 */
type NightCol = "bed" | "cp" | "ml" | "md" | "ap" | "ot" | "obf" | "olu" | "odi";
const NIGHT_COLS: NightCol[] = ["bed", "cp", "ml", "md", "ap", "ot", "obf", "olu", "odi"];
type NightVals = Pick<RowState, NightCol>;
function isNightCol(c: string): c is NightCol {
  return (NIGHT_COLS as string[]).includes(c);
}
function pickNight(r: RowState): NightVals {
  return { bed: r.bed, cp: r.cp, ml: r.ml, md: r.md, ap: r.ap, ot: r.ot, obf: r.obf, olu: r.olu, odi: r.odi };
}
function nightKeyOf(v: NightVals): string {
  return NIGHT_COLS.map((c) => cnt(v[c] ?? "")).join(",");
}
function sameNight(a: NightVals, b: NightVals): boolean {
  return nightKeyOf(a) === nightKeyOf(b);
}
/** As typed — a cleared cell is not yet the room's "0", so it must not snap back to it while
 *  the operator types (the counts compare equal; the strings do not). */
function sameNightExact(a: NightVals, b: NightVals): boolean {
  return NIGHT_COLS.every((c) => (a[c] ?? "") === (b[c] ?? ""));
}
/** A stored per-night override read back as that night's own values — the backend's reading:
 *  an override naming no meal leaves the night's meals at the room's. */
function nightValsFromOverride(o: RoomNightMealOverrideInput, row: RowState): NightVals {
  const carriesMeals = [
    o.mealPlanCpCount,
    o.mealPlanMaplCount,
    o.mealPlanMapdCount,
    o.mealPlanApCount,
    o.mealPlanOthersCount,
    o.othersBreakfastPax,
    o.othersLunchPax,
    o.othersDinnerPax,
  ].some((v) => v != null);
  const s = (v?: number | null) => String(v ?? 0);
  const blankable = (v?: number | null) => (v == null ? "" : String(v));
  return {
    bed: o.extraBedCount != null ? String(o.extraBedCount) : row.bed,
    ...(carriesMeals
      ? {
          cp: s(o.mealPlanCpCount),
          ml: s(o.mealPlanMaplCount),
          md: s(o.mealPlanMapdCount),
          ap: s(o.mealPlanApCount),
          ot: s(o.mealPlanOthersCount),
          obf: blankable(o.othersBreakfastPax),
          olu: blankable(o.othersLunchPax),
          odi: blankable(o.othersDinnerPax),
        }
      : { cp: row.cp, ml: row.ml, md: row.md, ap: row.ap, ot: row.ot, obf: row.obf, olu: row.olu, odi: row.odi }),
  };
}
/** Every night of a stay, as YYYY-MM-DD (check-in inclusive, check-out exclusive). */
function stayNightsOf(checkIn?: string | null, checkOut?: string | null): string[] {
  if (!checkIn || !checkOut) return [];
  const a = new Date(`${checkIn.slice(0, 10)}T00:00:00Z`).getTime();
  const b = new Date(`${checkOut.slice(0, 10)}T00:00:00Z`).getTime();
  if (!Number.isFinite(a) || !Number.isFinite(b) || b <= a) return [];
  const out: string[] = [];
  for (let t = a; t < b && out.length < 366; t += 86_400_000) out.push(new Date(t).toISOString().slice(0, 10));
  return out;
}
/** A room's per-night overrides as one comparable string — for "is the table saved?" checks
 *  that must notice a meal changed on one night (2026-10-22). */
export function nightOverridesCanon(list?: readonly RoomNightMealOverrideInput[] | null): string {
  return [...(list ?? [])]
    .map((o) =>
      [
        String(o.date).slice(0, 10),
        o.mealPlanCpCount ?? 0,
        o.mealPlanMaplCount ?? 0,
        o.mealPlanMapdCount ?? 0,
        o.mealPlanApCount ?? 0,
        o.mealPlanOthersCount ?? 0,
        o.othersBreakfastPax ?? 0,
        o.othersLunchPax ?? 0,
        o.othersDinnerPax ?? 0,
        o.extraBedCount ?? "",
      ].join(","),
    )
    .sort()
    .join(";");
}

/** Normalise an entry date to a midnight-UTC ISO string (entry dates arrive as full
 *  ISO timestamps; slicing the day out first avoids invalid-date throws). */
function dayToIso(v?: string | null): string | undefined {
  if (!v) return undefined;
  const d = new Date(v.slice(0, 10) + "T00:00:00.000Z");
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

/** Rebuild a row's field state from an emitted composition — used when the planner hands
 *  this editor the other mode's last snapshot so a mode switch resumes, not resets. */
function rowFromComposition(c: RoomCompositionInput): RowState {
  const s = (v: number | undefined | null, blankWhenNull = false): string =>
    v == null ? (blankWhenNull ? "" : "0") : String(v);
  return {
    ad: s(c.adultCount),
    c6: s(c.cnb6To10Count),
    u6: s(c.cnbUnder6Count),
    bed: s(c.extraBedCount),
    cp: s(c.mealPlanCpCount),
    ml: s(c.mealPlanMaplCount),
    md: s(c.mealPlanMapdCount),
    ap: s(c.mealPlanApCount),
    ot: s(c.mealPlanOthersCount),
    obf: s(c.othersBreakfastPax, true),
    olu: s(c.othersLunchPax, true),
    odi: s(c.othersDinnerPax, true),
    rRoom: s(c.negotiatedRoomRate, true),
    rBed: s(c.negotiatedExtraBedRate, true),
    rBf: s(c.negotiatedBreakfastRate, true),
    rLu: s(c.negotiatedLunchRate, true),
    rDi: s(c.negotiatedDinnerRate, true),
    sc: c.serviceChargeApplies ?? true,
    gst: c.gstApplies ?? true,
    foc: c.isFoc ?? false,
  };
}

/** One room's line of the booking's bed plan — `entry-bed-plan-service` on the backend. */
export interface BedPlanCell {
  bedType: string | null;
  source: "PLAN" | "ASK" | "USUAL";
  usual: string | null;
  allowed: string[];
  roomNow: string | null;
  appliesNow: boolean;
}

const BED_WORDS: Record<string, string> = { KING: "King", QUEEN: "Queen", TWIN: "Twin", SINGLE: "Single" };

/** The guest's bed ask against the plan, as the backend counted it (`GET /entries/:id/bed-plan`). */
export interface BedAskSummary {
  lines: { bedType: string; asked: number; planned: number; met: boolean; shortNights: string[] }[];
  met: boolean;
  /** The rooms differ by night, so each night was counted on its own. */
  nightsVary: boolean;
  /** Every asked setup could be given a room at all. */
  satisfiable: boolean;
  message: string | null;
}

/**
 * What the guest asked for, at the top of the table (2026-10-06, operator: "we need to show
 * somewhere above or on the top the amount and type of bed type the guest asked, or else the user
 * wouldn't know"). The Bed type column below is where it is answered, so the ask sits directly
 * over it. "UIappeal": every setup is a chip whose colour is its state — red while the plan makes
 * up fewer rooms that way than asked, green once it does. Nothing is counted here; the figures
 * are the server's, night by night on a stay that moves rooms.
 */
function BedAskStrip({ ask }: { ask: BedAskSummary }) {
  return (
    <div className={`rct-bedask ${ask.met ? "met" : "short"}`} role="status" aria-live="polite">
      <span className="lbl">Guest asked for</span>
      {ask.lines.map((l) => {
        const word = BED_WORDS[l.bedType] ?? l.bedType;
        const short = l.asked - l.planned;
        return (
          <span
            key={l.bedType}
            className={`chip ${l.met ? "ok" : "stop"}`}
            title={
              l.met
                ? `${l.planned} room${l.planned === 1 ? " is" : "s are"} to be made up as ${word}${ask.nightsVary ? " on every night" : ""}`
                : `${l.asked} asked, ${l.planned} set${l.shortNights.length ? ` — short on ${l.shortNights.map(shortNight).join(", ")}` : ""}`
            }
          >
            <b>
              {l.asked} {word}
            </b>
            <span className="st">
              {l.met ? (
                <>✓ {l.planned} set</>
              ) : (
                <>
                  {l.planned} set · {short} short
                  {l.shortNights.length ? ` on ${l.shortNights.map(shortNight).join(", ")}` : ""}
                </>
              )}
            </span>
          </span>
        );
      })}
      <span className="note">
        {!ask.satisfiable && ask.message
          ? ask.message
          : ask.met
            ? ask.nightsVary
              ? "Every night has the setups asked for"
              : "Every setup asked for has a room"
            : "Set the rest in the Bed type column below"}
      </span>
    </div>
  );
}

/** "Thu 22 Oct" — a night's band in the table, and its name in the night picker. */
function nightLabel(iso: string): string {
  const d = new Date(`${iso.slice(0, 10)}T00:00:00Z`);
  return Number.isNaN(d.getTime())
    ? iso
    : d.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });
}

/** "6 Oct" — the night a fault belongs to, on a booking that moves rooms mid-stay. */
function shortNight(iso: string): string {
  const d = new Date(`${iso}T00:00:00Z`);
  return Number.isNaN(d.getTime())
    ? iso
    : d.toLocaleDateString("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });
}

/**
 * How this room is made up for this stay. Not a composition field — a bed setup carries no price
 * (the EXTRA bed is the charged one, two columns along), so changing it leaves the table priced
 * exactly as it was and never asks for a re-quote.
 */
function BedCell({
  roomId,
  cell,
  onChange,
}: {
  roomId: string;
  cell?: BedPlanCell;
  onChange?: (roomId: string, bedType: string | null) => void;
}) {
  if (!cell) return <td className="bedcol" />;
  const opts = cell.allowed.length ? cell.allowed : Object.keys(BED_WORDS);
  const differs = cell.roomNow && cell.bedType && cell.roomNow !== cell.bedType;
  const why =
    cell.source === "PLAN"
      ? "Set for this booking"
      : cell.source === "ASK"
        ? "From the bed setup the guest asked for"
        : "The room's usual setup";
  return (
    <td
      className="bedcol"
      title={`${why}${differs ? ` · the room is made up as ${BED_WORDS[cell.roomNow!] ?? cell.roomNow} until it is set for this stay` : ""}`}
    >
      <select
        className="rct-in"
        value={cell.bedType ?? ""}
        disabled={!onChange}
        onChange={(e) => onChange?.(roomId, e.target.value || null)}
      >
        {!cell.bedType && <option value="">—</option>}
        {opts.map((t) => (
          <option key={t} value={t}>
            {BED_WORDS[t] ?? t}
            {t === cell.usual ? " (usual)" : ""}
          </option>
        ))}
      </select>
    </td>
  );
}

export function RoomCompositionsTable({
  entryId,
  sealedRoomIds,
  entryCheckIn,
  entryCheckOut,
  entryAdults,
  entryChildAges,
  roomDates,
  onSave,
  saveLabel,
  saving,
  unsaved,
  saveAside,
  onFaultsChange,
  initial,
  initialCompositions,
  onChange,
  onOpenRoomInBoard,
  onPickRoom,
  pickedRoomId,
  bedPlan,
  onBedChange,
  bedAsk,
  discountValue,
  discountUnit,
  discountBasis,
  onDiscountChange,
  lockCommercial,
  readOnly,
}: DiscountEdit & {
  /**
   * Post-freeze, in-house (2026-08-19): the negotiated rates and the FOC / service-charge
   * waivers render read-only, because changing them mid-stay is a GM rate revision the backend
   * gates separately (p58 `enforceRepriceAuthorityForStage`) — and a per-night override cannot
   * express a changed RATE, so nights the folio has already posted would silently re-price.
   * Occupancy, meals and extra beds stay editable. The figures still SHOW: the operator needs
   * to read what the booking is priced at even where they may not change it.
   */
  lockCommercial?: boolean;
  /**
   * The whole table reads and nothing can be typed (2026-10-19, operator: "in stages 3 4 5 6 ...
   * the user can type or rewrite the table without having to click on the change configuration
   * button"). The rooms tab from Set up on is changed only through Change configuration, which
   * runs the governed walk; until then the cells show the booking as it is priced. The bed
   * column is not part of the price and keeps its own control.
   */
  readOnly?: boolean;
  /** Set by the planner — clicking a room number opens that room alone in the guest board. */
  onOpenRoomInBoard?: (roomId: string) => void;
  /**
   * Clicking a room CHOOSES it, so the surface above can offer that room's own acts — change it,
   * change its setup, assign it (2026-10-06, operator: "changing can be just clicking on one room
   * in the table and showing an option"). Takes precedence over `onOpenRoomInBoard`: the rooms
   * surface at Arrival / Check-in / Stay is about what to DO with a room, not about re-seating
   * its guests on the board.
   */
  onPickRoom?: (roomId: string) => void;
  /** The room currently chosen, drawn as such. */
  pickedRoomId?: string | null;
  /**
   * How each room is to be made up for this stay, from the booking's bed plan (2026-10-06,
   * operator: "in the table in s2 we can have column as bed type ... make it for s5 s6 s7 as
   * well"). Seeded from the guest's own ask at intake, else the room's usual setup.
   */
  bedPlan?: Record<string, BedPlanCell>;
  onBedChange?: (roomId: string, bedType: string | null) => void;
  /** The guest's bed ask against that plan — drawn at the top of the table when there is one. */
  bedAsk?: BedAskSummary | null;
  /**
   * Commit the table (2026-09-30, operator: "a save button to save the config, but it'll only
   * allow ... if there's no error or red boxes or mismatches, then it'll generate the quotation
   * based on the saved list"). A composition is not stored anywhere of its own — the QUOTATION
   * is where it lands — so saving the table IS pricing it, and the button says so.
   */
  onSave?: () => void;
  saveLabel?: string;
  saving?: boolean;
  /**
   * Does the table still say what the quotation was priced on? (2026-09-30, operator: "if
   * there's changes made in the table before it can it be shown in red and green after clicking
   * it and again if there's changes in the table red so that user knows he made changes".)
   * True = edited since it was priced, or never priced at all. The COLOUR is the state
   * ("UIappeal"): red while the two disagree, green once they match — and green is inert,
   * because pressing it then would mint a new version identical to the one on file.
   */
  unsaved?: boolean;
  /**
   * Rendered immediately LEFT of the Save (2026-09-30, operator: "move this section to left side
   * of save button below the table since we have to set and save it at that section"). The
   * quotation's validity is written BY the save, so it belongs with it rather than in a card
   * further down the step.
   */
  saveAside?: React.ReactNode;
  /**
   * Every fault the table can see, in the operator's words, so the step can hold its own acts
   * shut for the same reasons rather than each surface deciding separately what "sound" means.
   */
  onFaultsChange?: (faults: string[]) => void;
  /**
   * roomId → the nights that room actually holds, display-ready (2026-09-30, operator: "a
   * column showing the dates they were assigned to"). Derived by the CALLER with
   * `roomStayRangesByRoom(entry)` — the same fold the S5-S7 room rows print, so the desk can
   * never describe one room's nights two ways. Absent = no Dates column (the room-change
   * panel prices a substitution, where the booking's own stay would be the wrong answer).
   */
  /**
   * Per room: the nights it is held for. `dates` is what makes a SPLIT legible — a booking that
   * moves rooms on the second night has rooms that are not in use at the same time, so their
   * guests are the same people, not more people (2026-10-06, operator: "we have booked rooms in
   * different rooms the next day ... the table treats this somewhat like a new room and I can't
   * allocate the same people").
   */
  roomDates?: Record<string, { label: string; nights: number; dates?: string[] }>;
  /** Enables the reference-rate placeholders in the negotiated-rate cells. */
  entryId?: string;
  sealedRoomIds: string[];
  entryCheckIn?: string | null;
  entryCheckOut?: string | null;
  entryAdults?: number | null;
  entryChildAges?: number[] | null;
  /** Snapshot from the other planner mode — mount-time seed so switching modes resumes
   *  from the same data. Read once on mount; later prop changes are ignored. */
  initial?: RoomCompositionInput[];
  /**
   * What each room is priced on as the caller sees it NOW — the seed for a room added after the
   * table mounted (2026-10-19, operator: in the room-change panel, picking 202 and 203 for later
   * nights added rows with nobody in them, because `initial` is read once at mount and knew only
   * the first room). A room already in `initial` keeps that seed.
   */
  initialCompositions?: RoomCompositionInput[];
  onChange: (compositions: RoomCompositionInput[]) => void;
}) {
  const { session } = useSession();
  const roomsQuery = useQuery({
    queryKey: ["rooms", "all"],
    queryFn: () => listRooms(session!),
    enabled: !!session,
    staleTime: 5 * 60_000,
  });
  const roomById = new Map((roomsQuery.data?.items ?? []).map((r) => [r.id, r]));

  const policyQuery = useQuery({
    queryKey: ["lookup", "child-policy"],
    queryFn: () => getChildPolicy(session!),
    enabled: !!session,
    staleTime: 10 * 60_000,
  });
  const youngMax = policyQuery.data?.ageBands.youngChildMaxAge ?? 5;
  const childMax = policyQuery.data?.ageBands.childMaxAge ?? 10;

  /**
   * Reference rates, resolved per ROOM. The endpoint answers by room type; each room's type comes
   * from the catalogue above, so no extra call is needed. These become the rate cells' placeholder
   * text: an empty negotiated cell is not "no rate", it is "price at this", and the operator had
   * no way to see which figure that was without leaving the grid.
   */
  // The table's own rooms ride along, so a room the booking does not hold yet (the room-change
  // panel) is anchored at its OWN type's rate, not at the booking's (2026-10-19).
  const rateRefRoomsKey = sealedRoomIds.join(",");
  const rateRefQuery = useQuery({
    queryKey: ["rate-reference", entryId, rateRefRoomsKey],
    queryFn: () => getRateReference(session!, entryId!, sealedRoomIds),
    enabled: !!session && !!entryId,
    staleTime: 5 * 60_000,
  });
  const rateRef = rateRefQuery.data ?? null;
  const refByRoomType = useMemo(
    () => new Map((rateRef?.roomTypes ?? []).map((t) => [t.roomTypeId, t])),
    [rateRef],
  );
  /**
   * What is wrong with a row, in the operator's words — null when nothing is (2026-09-30,
   * operator's screenshot: room 205 sitting at 0 adults, "that whole box should be showing in red
   * highlight ... similar like that if there is any issue in any of the boxes"). Both faults are
   * refused downstream, so the grid says so before the click rather than after it: a room in the
   * plan with nobody in it breaks the "no room is empty" seating invariant, and a room of children
   * with no adult is the unaccompanied-minor rule (`requiredAccompanyingAdults`, default 1 on
   * every room type).
   */
  const rowFault = (roomId: string): string | null => {
    const r = rows[roomId] ?? EMPTY_ROW;
    const adults = cnt(r.ad);
    if (adults + cnt(r.c6) + cnt(r.u6) === 0)
      return "nobody is in this room — put someone in it, or drop the room back at Inquiry";
    if (adults === 0) return "no adult in this room — children cannot be booked in on their own";
    return null;
  };
  /**
   * The MSR floor for a room's type — the house's minimum sellable rate (2026-09-29). It applies
   * only where the rate came from the standard plan: a party's own rate package is negotiated, so
   * the pricing pipeline exempts it (`belowMsr: agentRate ? false : …`).
   */
  const floorOf = (roomId: string): number | null => {
    const t = refByRoomType.get(roomById.get(roomId)?.roomType?.id ?? "");
    return t?.roomRateSource === "STANDARD_RATE_PLAN" ? (t.msrValue ?? null) : null;
  };
  /** A typed room rate under that floor — a breach the operator must see, so the cell reads red. */
  const belowFloor = (roomId: string, col: NumCol): boolean => {
    if (col !== "rRoom") return false;
    const floor = floorOf(roomId);
    const typed = parseFloat(rows[roomId]?.rRoom ?? "");
    return floor != null && Number.isFinite(typed) && typed > 0 && typed < floor;
  };
  /** The reference figure a given rate cell would fall back to — null when nothing is on file. */
  const refFor = (roomId: string, col: NumCol): number | null => {
    const typeId = roomById.get(roomId)?.roomType?.id;
    const t = typeId ? refByRoomType.get(typeId) : undefined;
    if (!t) return null;
    switch (col) {
      case "rRoom":
        return t.roomRate;
      case "rBed":
        return t.extraBedRate;
      case "rBf":
        return t.breakfastRate;
      case "rLu":
        return t.lunchRate;
      case "rDi":
        return t.dinnerRate;
      default:
        return null;
    }
  };

  const envAdults = Math.max(0, entryAdults ?? 0);
  const roomEnvelopeQuery = useQuery({
    queryKey: ["lookup", "allowed-room-counts", envAdults, (entryChildAges ?? []).join(",")],
    queryFn: () => getAllowedRoomCounts(session!, { adults: envAdults, childAges: entryChildAges ?? [] }),
    enabled: !!session && envAdults > 0,
  });
  const roomMin = roomEnvelopeQuery.data?.allowedRoomCounts.min ?? null;

  // Mount-time copy of the seed snapshot — deliberately not reactive.
  const initialRef = useRef(initial);
  // The caller's latest seed, read only for rooms added after mount (see `initialCompositions`).
  const lateSeedRef = useRef(initialCompositions);
  lateSeedRef.current = initialCompositions;
  const [rows, setRows] = useState<Record<string, RowState>>({});
  /** A room's meals and extra beds on a night where they differ from its own row (2026-10-22). */
  const [nightVals, setNightVals] = useState<Record<string, Record<string, NightVals>>>({});
  /** The nights each room is held for — the caller's dates, else the whole stay. */
  const stayNightList = useMemo(() => stayNightsOf(entryCheckIn, entryCheckOut), [entryCheckIn, entryCheckOut]);
  const nightListOf = (id: string): string[] => {
    const ds = roomDates?.[id]?.dates;
    if (ds && ds.length > 0) return ds.map((d) => d.slice(0, 10));
    return roomDates ? stayNightList : [];
  };
  const [ratesOpen, setRatesOpen] = useState(
    () => (initial ?? []).some((c) =>
      [c.negotiatedRoomRate, c.negotiatedExtraBedRate, c.negotiatedBreakfastRate, c.negotiatedLunchRate, c.negotiatedDinnerRate].some((v) => v != null),
    ),
  );
  // Full-screen layer, same affordance as the S1 room table: with the rate columns open the grid
  // is wider than the canvas column, so reading rooms against their rates meant scrolling
  // sideways. Reuses the .rst-expandwrap / .rst-expandbar styles.
  const [expanded, setExpanded] = useState(false);
  /** Which night the table shows on a stay whose rooms change between nights — "all" sets every
   *  night out in turn, one under the other (2026-10-22, operator). */
  const [nightView, setNightView] = useState<string>("");
  /** Explanations behind a "?" — only messages on screen (2026-10-12). */
  const quiet = useQuietScreen();
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
  // Plans the operator switched on. A plan column is VISIBLE when toggled on OR when any
  // row carries pax for it — a column with data can never silently disappear.
  const [activePlans, setActivePlans] = useState<Set<NumCol>>(new Set());
  // CNB columns exist automatically when the intake party has children, or when saved
  // data already carries child counts — the manual "Kids +" toggle was removed
  // (2026-07-31, operator request); only the Rates toggle remains in the corner.
  const hasKids = (entryChildAges?.length ?? 0) > 0;
  const [childColsManual] = useState(
    () => !hasKids && (initial ?? []).some((c) => (c.cnb6To10Count ?? 0) > 0 || (c.cnbUnder6Count ?? 0) > 0),
  );
  const childColsVisible = hasKids || childColsManual;

  useEffect(() => {
    setRows((prev) => {
      if (sealedRoomIds.every((id) => prev[id])) return prev;
      const seedById = new Map(
        [...(lateSeedRef.current ?? []), ...(initialRef.current ?? [])].map((c) => [c.roomId, c] as const),
      );
      const next = { ...prev };
      for (const id of sealedRoomIds) {
        if (!next[id]) {
          const seed = seedById.get(id);
          next[id] = seed ? rowFromComposition(seed) : { ...EMPTY_ROW };
        }
      }
      return next;
    });
  }, [sealedRoomIds]);

  // Per-night values come with the seed, once per room (a room added later reads the caller's
  // latest seed, as its row does).
  const nightSeededRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    const seedById = new Map(
      [...(lateSeedRef.current ?? []), ...(initialRef.current ?? [])].map((c) => [c.roomId, c] as const),
    );
    const add: Record<string, Record<string, NightVals>> = {};
    for (const id of sealedRoomIds) {
      if (nightSeededRef.current.has(id)) continue;
      nightSeededRef.current.add(id);
      const seed = seedById.get(id);
      if (!seed?.nightMealOverrides?.length) continue;
      const row = rowFromComposition(seed);
      const m: Record<string, NightVals> = {};
      for (const o of seed.nightMealOverrides) {
        const v = nightValsFromOverride(o, row);
        if (!sameNight(v, pickNight(row))) m[String(o.date).slice(0, 10)] = v;
      }
      if (Object.keys(m).length) add[id] = m;
    }
    if (Object.keys(add).length) setNightVals((prev) => ({ ...add, ...prev }));
  }, [sealedRoomIds]);

  const setCell = (roomId: string, patch: Partial<RowState>) =>
    setRows((prev) => ({ ...prev, [roomId]: { ...(prev[roomId] ?? EMPTY_ROW), ...patch } }));
  /** The value a cell shows: the night's own when it has one, else the room's. */
  const valAt = (id: string, night: string | null, col: NumCol): string => {
    if (night && isNightCol(col)) {
      const o = nightVals[id]?.[night];
      if (o) return o[col];
    }
    return (rows[id] ?? EMPTY_ROW)[col];
  };
  const rowAt = (id: string, night: string | null): RowState => {
    const r = rows[id] ?? EMPTY_ROW;
    const o = night ? nightVals[id]?.[night] : undefined;
    return o ? { ...r, ...o } : r;
  };
  /** Whether a room's nights disagree on a column — the whole-stay view says so. */
  const variesOn = (id: string, col: NightCol): boolean => {
    const ns = nightListOf(id);
    if (ns.length < 2 || !nightVals[id]) return false;
    return new Set(ns.map((n) => cnt(valAt(id, n, col)))).size > 1;
  };
  /** One night's meals or beds for one room. Back to the room's own figures, it drops away. */
  const writeNight = (id: string, night: string, patch: Partial<NightVals>) =>
    setNightVals((prev) => {
      const base = pickNight(rows[id] ?? EMPTY_ROW);
      const cur = prev[id]?.[night] ?? base;
      const nextV = { ...cur, ...patch };
      const forRoom = { ...(prev[id] ?? {}) };
      if (sameNightExact(nextV, base)) delete forRoom[night];
      else forRoom[night] = nextV;
      return { ...prev, [id]: forRoom };
    });
  /** The same change on every night the room is held — its row and every night of its own. */
  const writeAllNights = (id: string, patch: Partial<NightVals>) => {
    setRows((prev) => ({ ...prev, [id]: { ...(prev[id] ?? EMPTY_ROW), ...patch } }));
    setNightVals((prev) => {
      const forRoom = prev[id];
      if (!forRoom) return prev;
      const base = { ...pickNight(rows[id] ?? EMPTY_ROW), ...patch };
      const kept: Record<string, NightVals> = {};
      for (const [n, v] of Object.entries(forRoom)) {
        const nv = { ...v, ...patch };
        if (!sameNightExact(nv, base)) kept[n] = nv;
      }
      return { ...prev, [id]: kept };
    });
  };
  /** Extra beds follow the adults on every night (the auto-bed rule), not only on the row. */
  const syncNightBeds = (id: string, bed: number) =>
    setNightVals((prev) => {
      const forRoom = prev[id];
      if (!forRoom) return prev;
      const base = { ...pickNight(rows[id] ?? EMPTY_ROW), bed: String(bed) };
      const kept: Record<string, NightVals> = {};
      for (const [n, v] of Object.entries(forRoom)) {
        const nv = { ...v, bed: String(Math.max(bed, Math.min(cnt(v.bed), bedMaxOf(id)))) };
        if (!sameNightExact(nv, base)) kept[n] = nv;
      }
      return { ...prev, [id]: kept };
    });

  // ---- Input bounds (2026-08-01) --------------------------------------------------
  // The grid used to accept ANY number in the people cells; the Σ footer only warned.
  // The counts must stay within the party captured at Inquiry (S1) — the same bands the
  // guest board is bound to by construction. Type-time clamps, with a notice saying why.
  // An entry with NO party breakdown stays unconstrained (the table is deliberately the
  // fallback editor for those).
  const partyBands = useMemo(() => {
    const ages = entryChildAges ?? [];
    return {
      ad: Math.max(0, entryAdults ?? 0) + ages.filter((a) => a > childMax).length,
      c6: ages.filter((a) => a > youngMax && a <= childMax).length,
      u6: ages.filter((a) => a <= youngMax).length,
    };
  }, [entryAdults, entryChildAges, youngMax, childMax]);
  const partyBound = (entryAdults ?? 0) + (entryChildAges?.length ?? 0) > 0;

  const [limitMsg, setLimitMsg] = useState<string | null>(null);
  const limitTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flashLimit = (msg: string) => {
    setLimitMsg(msg);
    if (limitTimer.current) clearTimeout(limitTimer.current);
    limitTimer.current = setTimeout(() => setLimitMsg(null), 5000);
  };

  const bandLabel = (col: "ad" | "c6" | "u6", n: number): string =>
    col === "ad"
      ? `adult-rate guest${n === 1 ? "" : "s"} (adults + 11+)`
      : col === "c6"
        ? `child${n === 1 ? "" : "ren"} ${youngMax + 1}–${childMax}`
        : `child${n === 1 ? "" : "ren"} under ${youngMax + 1}`;
  const roomNoOf = (id: string) => roomById.get(id)?.roomNumber ?? id.slice(0, 6);
  const capOf = (id: string): number | null => {
    const rt = roomById.get(id)?.roomType;
    return rt?.maxCapacity ?? rt?.standardCapacity ?? null;
  };
  const bedMaxOf = (id: string): number => roomById.get(id)?.roomType?.maxExtraBeds ?? 0;
  /** Extra beds a room NEEDS for its adults: everyone past base capacity gets one (children
   *  under 11 share bedding — they never need a bed), AND — p78, mirrored from the backend —
   *  a non-FOC room with 3+ adult-rate guests always needs at least one, even when its base
   *  beds could sleep them (every real room type has maxCapacity 3, so the capacity rule
   *  alone said 0 there and generation was refused). The backend now auto-adds that bed at
   *  generation and in the live preview anyway (2026-08-12, operator ruling); deriving it
   *  here keeps the cell honest about what will be priced. */
  const bedsNeeded = (id: string, adults: number, foc = false): number => {
    const cap = capOf(id);
    const capacityBeds = cap == null ? 0 : Math.max(0, adults - cap);
    const p78Min = !foc && adults >= 3 ? 1 : 0;
    return Math.min(Math.max(capacityBeds, p78Min), bedMaxOf(id));
  };
  /** Re-derive a row's bed cell from its adults — auto-add when adults exceed base
   *  capacity, auto-remove when they no longer do (2026-08-01 operator ruling). */
  const withAutoBed = (id: string, row: RowState): RowState => ({
    ...row,
    bed: String(bedsNeeded(id, cnt(row.ad), row.foc)),
  });

  /**
   * Band-cell edit (2026-08-01) — a HARD cap, never an auto-move (operator ruling: the
   * earlier version pulled overflow out of other rooms, which read as the grid changing
   * numbers behind your back):
   *   1. `ad` is capped at the ROOM's ceiling (base capacity + max extra beds; beds
   *      auto-derive below) — pooling every adult into one room stops at what it can sleep.
   *   2. The cell is capped at what's LEFT of the intake party band once the other rooms
   *      are counted — moving someone between rooms means reducing the source room first
   *      (or dragging their chip on the guest board, which moves them properly).
   *   3. The room's extra beds re-derive whenever its adults change.
   */
  const applyBandChange = (roomId: string, col: "ad" | "c6" | "u6", v: string) => {
    let n = cnt(v);
    /** What was typed — named in a refusal, since a caret left after "2" makes a typed 3 read "23"
     *  (2026-10-22, operator: the cell showed 3 under a message about capping it at 3). */
    const typed = n;
    let display = v; // keep the raw string (e.g. "") when nothing clamps
    if (col === "ad") {
      const cap = capOf(roomId);
      if (cap != null) {
        const ceil = cap + bedMaxOf(roomId);
        if (n > ceil) {
          flashLimit(
            `You typed ${typed} — Room ${roomNoOf(roomId)} sleeps at most ${ceil} adult-rate guests (${cap} + ${bedMaxOf(roomId)} extra bed${bedMaxOf(roomId) === 1 ? "" : "s"}), so it is set to ${ceil}.`,
          );
          n = ceil;
          display = String(n);
        }
      }
    }
    if (partyBound) {
      // The rooms that share a night with this one (2026-10-19, operator: a stay moving from 201
      // to 202 to 203 night by night could not put its one guest in 202 — the cap counted the
      // guest already in 201 on ANOTHER night). Without dates every room shares every night.
      const datesOf = (id: string) => roomDates?.[id]?.dates ?? null;
      const mine = datesOf(roomId);
      const sameNights = !!mine && mine.length > 0;
      const others = sameNights
        ? Math.max(
            0,
            ...mine!.map((night) =>
              sealedRoomIds.reduce((s, id) => {
                if (id === roomId) return s;
                const theirs = datesOf(id);
                return !theirs || theirs.includes(night) ? s + cnt(rows[id]?.[col] ?? "0") : s;
              }, 0),
            ),
          )
        : sealedRoomIds.reduce((s, id) => (id === roomId ? s : s + cnt(rows[id]?.[col] ?? "0")), 0);
      const remaining = Math.max(0, partyBands[col] - others);
      if (n > remaining) {
        flashLimit(
          `You typed ${typed} — Room ${roomNoOf(roomId)} can take ${remaining} ${bandLabel(col, remaining)}, so it is set to ${remaining}. This booking has ${partyBands[col]}${
            others > 0 ? ` and ${others} ${others === 1 ? "is" : "are"} already in other rooms${sameNights ? " on the same nights" : ""}` : ""
          }. To move someone here, reduce another room first, or change the party at the Inquiry step.`,
        );
        n = remaining;
        display = String(n);
      }
    }
    setRows((prev) => {
      const next = { ...prev };
      let mine = { ...(next[roomId] ?? EMPTY_ROW), [col]: display };
      if (col === "ad") mine = withAutoBed(roomId, mine);
      next[roomId] = mine;
      return next;
    });
    if (col === "ad") syncNightBeds(roomId, bedsNeeded(roomId, n, rows[roomId]?.foc ?? false));
  };

  /** Extra beds: floored at what the room's adults need, capped at the type's max.
   *  Manual raises (e.g. a separate bed for a child) stay until the adults change. */
  const clampBed = (roomId: string, v: string): string => {
    const max = bedMaxOf(roomId);
    const row = rows[roomId];
    const needed = bedsNeeded(roomId, cnt(row?.ad ?? "0"), row?.foc ?? false);
    const n = cnt(v);
    if (n > max) {
      flashLimit(`Room ${roomNoOf(roomId)} allows at most ${max} extra bed${max === 1 ? "" : "s"} — capped.`);
      return String(max);
    }
    if (n < needed) {
      flashLimit(
        `Room ${roomNoOf(roomId)} needs ${needed} extra bed${needed === 1 ? "" : "s"} for its adults (3+ adults always need one) — it can't go lower while they're in the room.`,
      );
      return String(needed);
    }
    return v;
  };
  /** Meal-plan pax: a room can't feed more people than it sleeps (Policy 79 rule 2). */
  const clampMeal = (roomId: string, col: NumCol, v: string, night: string | null = null): string => {
    const r = rows[roomId] ?? EMPTY_ROW;
    const occ = cnt(r.ad) + cnt(r.c6) + cnt(r.u6);
    // On one night, that night's other plans; for the whole stay, the fullest night's.
    const nights: (string | null)[] = night ? [night] : nightListOf(roomId).length ? nightListOf(roomId) : [null];
    const otherMeals = Math.max(
      0,
      ...nights.map((n) => MEAL_COLS.reduce((s, c) => (c === col ? s : s + cnt(valAt(roomId, n, c))), 0)),
    );
    const allowed = Math.max(0, occ - otherMeals);
    if (cnt(v) <= allowed) return v;
    const roomNo = roomById.get(roomId)?.roomNumber ?? "";
    flashLimit(
      `Room ${roomNo} has ${occ} guest${occ === 1 ? "" : "s"}${
        otherMeals > 0 ? ` (${otherMeals} already on other plans)` : ""
      } — meal-plan pax can't exceed the people in the room; capped at ${allowed}.`,
    );
    return String(allowed);
  };

  /** Pax for a column on any night of any room — a column with data never silently hides. */
  const paxAnywhere = (col: NumCol) =>
    sealedRoomIds.some(
      (id) =>
        cnt(rows[id]?.[col] ?? "0") > 0 ||
        (isNightCol(col) && Object.values(nightVals[id] ?? {}).some((v) => cnt(v[col]) > 0)),
    );
  const visibleMeals = MEAL_COLS.filter((c) => activePlans.has(c) || paxAnywhere(c));

  // ---- Which rate columns exist (2026-08-07) ---------------------------------------
  // Room + Bed are the default pair; a meal's rate column exists only while that meal is in
  // play somewhere — via a plan that includes it (chip on or pax present, i.e. the plan
  // column is visible) or via à-la-carte pax. No plan with dinner → no Dinner column.
  const anyPax = paxAnywhere;
  const bfInPlay = ["cp", "ml", "md", "ap"].some((c) => visibleMeals.includes(c as NumCol)) || anyPax("obf");
  const luInPlay = ["ml", "ap"].some((c) => visibleMeals.includes(c as NumCol)) || anyPax("olu");
  const diInPlay = ["md", "ap"].some((c) => visibleMeals.includes(c as NumCol)) || anyPax("odi");
  const rateCols: RateCol[] = [
    "rRoom",
    "rBed",
    ...(bfInPlay ? (["rBf"] as const) : []),
    ...(luInPlay ? (["rLu"] as const) : []),
    ...(diInPlay ? (["rDi"] as const) : []),
  ];
  /** Whether THIS row consumes each meal — its rate cell is editable only then; the other
   *  rooms see a dash (their plan doesn't buy that meal, so there's nothing to negotiate). */
  const rowConsumes = (r: RowState): Record<"rBf" | "rLu" | "rDi", boolean> => ({
    rBf: cnt(r.cp) + cnt(r.ml) + cnt(r.md) + cnt(r.ap) + cnt(r.obf) > 0,
    rLu: cnt(r.ml) + cnt(r.ap) + cnt(r.olu) > 0,
    rDi: cnt(r.md) + cnt(r.ap) + cnt(r.odi) > 0,
  });
  /** A room's rates are the room's, so a meal's rate opens when ANY night of it buys that meal. */
  const roomConsumes = (id: string): Record<"rBf" | "rLu" | "rDi", boolean> => {
    const ns = nightListOf(id);
    const list = ns.length ? ns.map((n) => rowAt(id, n)) : [rows[id] ?? EMPTY_ROW];
    const out = { rBf: false, rLu: false, rDi: false };
    for (const rr of list) {
      const c = rowConsumes(rr);
      out.rBf ||= c.rBf;
      out.rLu ||= c.rLu;
      out.rDi ||= c.rDi;
    }
    return out;
  };

  /** Chip toggle for a plan column. Switching a visible plan OFF zeroes its column
   *  (and the Others à-la-carte pax when it's `ot`) — a hidden column must not keep
   *  feeding the draft. */
  const togglePlan = (c: NumCol) => {
    if (visibleMeals.includes(c)) {
      setActivePlans((prev) => {
        const n = new Set(prev);
        n.delete(c);
        return n;
      });
      for (const id of sealedRoomIds) {
        writeAllNights(id, { [c]: "0", ...(c === "ot" ? { obf: "", olu: "", odi: "" } : {}) } as Partial<NightVals>);
      }
    } else {
      setActivePlans((prev) => new Set(prev).add(c));
    }
  };

  /**
   * Party spread (rewritten 2026-10-22, operator report on ENT-20261022-0001/0002: "I can't fill
   * the table even when Distribute party is clicked"). It used to put every child in the first
   * room of each night and re-seat every room on every night, so a room's row ended up
   * describing whichever night came last, and a room with two adults and two small children read
   * red (four guests in a room that sleeps three) with no way for the button to put it right.
   *
   * Now it seats the party so the table it leaves is one the fault list accepts whenever the
   * party fits:
   *  - **Night by night, each room once.** A room keeps one row for all its nights, so it is
   *    seated on the first night it appears and stays as it is; each later night shares out only
   *    what that night's rooms have not already taken. On a booking whose rooms are the same
   *    every night there is one night-group and this is a plain spread.
   *  - **Adult-rate guests evenly**, the remainder on the first rooms, never past what a room can
   *    sleep (its capacity + the extra beds its type allows).
   *  - **Each child in a room with an adult and space for them** — inside the room's capacity and
   *    the bed its adults already need, and within its type's limit on children. When no room has
   *    space it may take an extra bed (up to the type's limit); when the type limits are what
   *    stand in the way, the room with the most space takes the child and the operator decides.
   * CNB 11+ retired: declared children above the child band join the adult pool.
   */
  const distribute = () => {
    if (sealedRoomIds.length === 0) return;
    const ages = entryChildAges ?? [];
    const party = {
      ad: Math.max(0, entryAdults ?? 0) + ages.filter((a) => a > childMax).length,
      c6: ages.filter((a) => a > youngMax && a <= childMax).length,
      u6: ages.filter((a) => a <= youngMax).length,
    };
    // The party is seated NIGHT BY NIGHT. On a booking that moves rooms mid-stay the rooms are
    // not in use together, so spreading the party once across every row would leave each night
    // holding a fraction of it (2026-10-06).
    const groups: string[][] = busiestNight
      ? allNights.map((n) => roomsOn(n)).filter((g, i, all) => g.length > 0 && all.findIndex((h) => h.join(",") === g.join(",")) === i)
      : [sealedRoomIds];
    type Seat = { ad: number; c6: number; u6: number; bed: number };
    const seats = new Map<string, Seat>();
    const focOf = (id: string) => rows[id]?.foc ?? false;
    const capNum = (id: string) => capOf(id) ?? Number.POSITIVE_INFINITY;
    const adultCeil = (id: string) => capNum(id) + bedMaxOf(id);
    const kidsMax = (id: string) => roomById.get(id)?.roomType?.maxChildren ?? Number.POSITIVE_INFINITY;
    const adultsNeeded = (id: string) => Math.max(1, roomById.get(id)?.roomType?.requiredAccompanyingAdults ?? 1);
    for (const ids of groups) {
      const fresh = ids.filter((id) => !seats.has(id));
      if (fresh.length === 0) continue;
      const taken = ids.filter((id) => seats.has(id)).map((id) => seats.get(id)!);
      const left = {
        ad: Math.max(0, party.ad - taken.reduce((s, x) => s + x.ad, 0)),
        c6: Math.max(0, party.c6 - taken.reduce((s, x) => s + x.c6, 0)),
        u6: Math.max(0, party.u6 - taken.reduce((s, x) => s + x.u6, 0)),
      };
      const w = new Map<string, Seat>(fresh.map((id) => [id, { ad: 0, c6: 0, u6: 0, bed: 0 }]));
      // Adult-rate guests: evenly, the remainder on the first rooms, each room up to what it sleeps.
      const base = Math.floor(left.ad / fresh.length);
      const rem = left.ad % fresh.length;
      let over = 0;
      fresh.forEach((id, i) => {
        const want = base + (i < rem ? 1 : 0);
        const got = Math.min(want, adultCeil(id));
        w.get(id)!.ad = got;
        over += want - got;
      });
      for (const id of fresh) {
        if (over === 0) break;
        const s = w.get(id)!;
        const more = Math.min(over, adultCeil(id) - s.ad);
        if (more > 0) { s.ad += more; over -= more; }
      }
      if (over > 0) w.get(fresh[0])!.ad += over; // nowhere fits them — the fault list says so
      for (const id of fresh) {
        const s = w.get(id)!;
        s.bed = bedsNeeded(id, s.ad, focOf(id));
      }
      // Children, one at a time, into the first room that can take them, in order of preference.
      const occ = (s: Seat) => s.ad + s.c6 + s.u6;
      const kids = (s: Seat) => s.c6 + s.u6;
      const tiers: Array<(id: string, s: Seat) => boolean> = [
        (id, s) => s.ad >= adultsNeeded(id) && kids(s) < kidsMax(id) && occ(s) + 1 <= capNum(id) + s.bed,
        (id, s) => s.ad >= adultsNeeded(id) && kids(s) < kidsMax(id) && occ(s) + 1 <= capNum(id) + bedMaxOf(id),
        (id, s) => s.ad >= 1 && occ(s) + 1 <= capNum(id) + s.bed,
        (id, s) => s.ad >= 1 && occ(s) + 1 <= capNum(id) + bedMaxOf(id),
      ];
      const placeChild = (band: "c6" | "u6") => {
        for (const fits of tiers) {
          const id = fresh.find((r) => fits(r, w.get(r)!));
          if (id) {
            const s = w.get(id)!;
            s[band] += 1;
            if (occ(s) > capNum(id) + s.bed) s.bed = occ(s) - capNum(id);
            return;
          }
        }
        // No room can take them — the one with the most space does, and the fault list names it.
        const id = fresh.reduce((best, r) => {
          const room = (x: string) => capNum(x) + bedMaxOf(x) - occ(w.get(x)!);
          return w.get(r)!.ad > 0 && room(r) > room(best) ? r : best;
        }, fresh[0]);
        w.get(id)![band] += 1;
      };
      for (let k = 0; k < left.c6; k++) placeChild("c6");
      for (let k = 0; k < left.u6; k++) placeChild("u6");
      for (const id of fresh) seats.set(id, w.get(id)!);
    }
    setRows((prev) => {
      const next = { ...prev };
      for (const [id, s] of seats) {
        next[id] = {
          ...(next[id] ?? { ...EMPTY_ROW }),
          ad: String(s.ad),
          c6: String(s.c6),
          u6: String(s.u6),
          bed: String(s.bed),
        };
      }
      return next;
    });
    for (const [id, s] of seats) syncNightBeds(id, s.bed);
  };

  // First-open distribute, once, while the band columns are untouched — the operator
  // lands on a filled grid instead of a wall of zeros. Ref-guarded against re-renders.
  const autoRanRef = useRef(false);
  // It waits for the room list and the child policy (2026-10-22): the spread reads each room's
  // capacity, extra beds and child limit, and run before they arrive it saw rooms with no limit
  // and put every child in the first room of the night.
  const ready =
    sealedRoomIds.length > 0 &&
    sealedRoomIds.every((id) => rows[id]) &&
    roomsQuery.isFetched &&
    policyQuery.isFetched;
  useEffect(() => {
    if (autoRanRef.current || !ready || readOnly) return;
    const pristine = sealedRoomIds.every((id) => rows[id].ad === "" && rows[id].c6 === "" && rows[id].u6 === "");
    autoRanRef.current = true;
    if (pristine && (entryAdults ?? 0) + (entryChildAges?.length ?? 0) > 0) distribute();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready]);

  /** Every room's plan pax = its occupancy on ONE plan — the "whole booking is on CP"
   *  case in a single pick. Also collapses the visible plan columns to just that one. */
  const everyoneOn = (col: NumCol | "none") => {
    setActivePlans(col === "none" ? new Set() : new Set([col as NumCol]));
    // The rows on screen (2026-10-22): one night shown sets that night; every night, every night.
    for (const sec of sections) {
      for (const id of sec.ids) {
        const r = rows[id] ?? EMPTY_ROW;
        const occ = cnt(r.ad) + cnt(r.c6) + cnt(r.u6);
        const meals = {
          ...Object.fromEntries(MEAL_COLS.map((c) => [c, c === col ? String(occ) : "0"])),
          ...(col === "ot" ? {} : { obf: "", olu: "", odi: "" }),
        } as Partial<NightVals>;
        if (sec.night) writeNight(id, sec.night, meals);
        else writeAllNights(id, meals);
      }
    }
  };

  /** Clone row 1's meals / beds / toggles / rates / others pax onto every other row —
   *  never the guest bands (copying people would double the party). Beds and meal pax
   *  are clamped per target row (its own bed limit / its own occupancy), so the copy
   *  can't write what typing wouldn't have allowed. */
  const copyFirstDown = () => {
    // The first row ON SCREEN onto every other row on screen (2026-10-22, operator: "if only one
    // date is picked, copy row should only happen for the rooms for that date"). Meals and extra
    // beds go to the night each row stands under. Rates and the charges belong to the room for
    // every night it is held, so they are copied only when every night is on screen.
    const order = sections.flatMap((s) => s.ids.map((id) => ({ id, night: s.night })));
    if (order.length < 2) return;
    const src = order[0];
    const srcVals = pickNight(rowAt(src.id, src.night));
    const srcRow = rows[src.id] ?? EMPTY_ROW;
    const roomLevel = !viewNight;
    const roomDone = new Set<string>([src.id]);
    for (const t of order.slice(1)) {
      const target = rows[t.id] ?? EMPTY_ROW;
      const v: NightVals = { ...srcVals };
      // Bed bounds per target room: capped at its type's max, floored at what its own adults
      // need (the copy must not strip beds a fuller room depends on).
      const needed = bedsNeeded(t.id, cnt(target.ad), roomLevel ? srcRow.foc : target.foc);
      v.bed = String(Math.max(needed, Math.min(cnt(v.bed), bedMaxOf(t.id))));
      // Meal pax ≤ the TARGET row's occupancy (it keeps its own guest bands).
      let left = cnt(target.ad) + cnt(target.c6) + cnt(target.u6);
      for (const c of MEAL_COLS as NightCol[]) {
        const take = Math.min(cnt(v[c]), left);
        v[c] = String(take);
        left -= take;
      }
      if (t.night) writeNight(t.id, t.night, v);
      else writeAllNights(t.id, v);
      if (roomLevel && !roomDone.has(t.id)) {
        roomDone.add(t.id);
        setCell(t.id, {
          rRoom: srcRow.rRoom,
          rBed: srcRow.rBed,
          rBf: srcRow.rBf,
          rLu: srcRow.rLu,
          rDi: srcRow.rDi,
          sc: srcRow.sc,
          gst: srcRow.gst,
          foc: srcRow.foc,
        });
      }
    }
  };

  // Per-night overrides carried in from the board, keyed by room. Read from the mount-time
  // seed only — same lifetime rule as the rest of `initial`.
  const nightOverridesBySeedRoom = useMemo(
    () =>
      new Map(
        (initialRef.current ?? [])
          .filter((c) => (c.nightMealOverrides?.length ?? 0) > 0)
          .map((c) => [c.roomId, c.nightMealOverrides]),
      ),
    [],
  );

  // The editor's current state as compositions — what gets emitted to the parent AND what
  // the live pricing preview prices. One builder so the two can never disagree.
  const compositions: RoomCompositionInput[] = useMemo(
    () =>
      sealedRoomIds
        .filter((id) => rows[id])
        .map((id) => {
        const r0 = rows[id];
        const occ = cnt(r0.ad) + cnt(r0.c6) + cnt(r0.u6);
        // The room's usual night is the one most of its nights share; the others are sent as
        // that night's own meals and beds (2026-10-22).
        const ns = nightListOf(id);
        const own = nightVals[id];
        let r = r0;
        let overrides: RoomNightMealOverrideInput[] | undefined;
        if (ns.length > 0 && own && Object.keys(own).length > 0) {
          const per = ns.map((n) => ({ n, v: own[n] ?? pickNight(r0) }));
          const tally = new Map<string, { v: NightVals; k: number; first: number }>();
          per.forEach((p, i) => {
            const key = nightKeyOf(p.v);
            const e = tally.get(key);
            if (e) e.k += 1;
            else tally.set(key, { v: p.v, k: 1, first: i });
          });
          const usual = [...tally.values()].sort((a, b) => b.k - a.k || a.first - b.first)[0].v;
          r = { ...r0, ...usual };
          const differ = per.filter((p) => !sameNight(p.v, usual));
          if (differ.length) {
            overrides = differ.map(({ n, v }) => ({
              date: `${n}T00:00:00.000Z`,
              mealPlanCpCount: cnt(v.cp),
              mealPlanMaplCount: cnt(v.ml),
              mealPlanMapdCount: cnt(v.md),
              mealPlanApCount: cnt(v.ap),
              mealPlanOthersCount: cnt(v.ot),
              othersBreakfastPax: cnt(v.obf),
              othersLunchPax: cnt(v.olu),
              othersDinnerPax: cnt(v.odi),
              extraBedCount: cnt(v.bed),
            }));
          }
        }
        return {
          roomId: id,
          startDate: dayToIso(entryCheckIn),
          endDate: dayToIso(entryCheckOut),
          occupantCount: occ,
          adultCount: cnt(r.ad),
          cnb6To10Count: cnt(r.c6),
          cnbUnder6Count: cnt(r.u6),
          extraBedCount: cnt(r.bed),
          mealPlanCpCount: cnt(r.cp),
          mealPlanMaplCount: cnt(r.ml),
          mealPlanMapdCount: cnt(r.md),
          mealPlanApCount: cnt(r.ap),
          mealPlanOthersCount: cnt(r.ot),
          othersBreakfastPax: numOrUndef(r.obf),
          othersLunchPax: numOrUndef(r.olu),
          othersDinnerPax: numOrUndef(r.odi),
          negotiatedRoomRate: numOrUndef(r.rRoom),
          negotiatedExtraBedRate: numOrUndef(r.rBed),
          negotiatedBreakfastRate: numOrUndef(r.rBf),
          negotiatedLunchRate: numOrUndef(r.rLu),
          negotiatedDinnerRate: numOrUndef(r.rDi),
          serviceChargeApplies: r.sc,
          // GST is statutory — always applied regardless of any historic seed value.
          gstApplies: true,
          isFoc: r.foc,
          // Per-night meal overrides are a guest-board concept — this grid has no column for
          // them. Carry the seed's through untouched so a board → table → board round trip
          // doesn't quietly delete the operator's per-date plans. The board re-derives them
          // from chip placement on its next emit, so a stale carry-through can't win.
          // A room with nights of its own sends them; one the table cannot place by night (no
          // dates known) carries the seed's untouched, as before.
          ...(overrides
            ? { nightMealOverrides: overrides }
            : ns.length === 0 && nightOverridesBySeedRoom.get(id)?.length
              ? { nightMealOverrides: nightOverridesBySeedRoom.get(id) }
              : {}),
        };
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [rows, nightVals, sealedRoomIds, entryCheckIn, entryCheckOut, roomDates],
  );

  // Emit on every change. Occ is derived, so invariant (1) of Policy 79 holds by
  // construction; invariant (2) (plan pax ≤ occ) is warned inline and enforced server-side.
  // Not before every room has its row (2026-10-19): on mount the rows are still empty, and an
  // empty emission was written over the planner's stored copy — which then outranked the saved
  // quotation and opened the table with no meals.
  useEffect(() => {
    if (!ready) return;
    onChange(compositions);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [compositions, ready]);

  // ---- Live pricing (2026-08-07) ---------------------------------------------------
  // The rate cells show `heads × rate` money and the Σ row shows column totals — all read
  // from the quotation-preview endpoint (the quote's own arithmetic, nothing persisted),
  // never computed here. Debounced so the grid re-prices ~half a second after typing stops.
  const discNum = Number(discountValue ?? "");
  const discUnitNow: DiscountUnit = discountUnit ?? "percent";
  const [previewBody, setPreviewBody] = useState<{
    roomCompositions: RoomCompositionInput[];
    discount: { percent?: number; amount?: number } | null;
    roomNights?: Record<string, number>;
    roomNightDates?: Record<string, string[]>;
  } | null>(null);
  // The nights each row is priced for, from the caller's dates — on the room-change panel the
  // rooms are picked night by night and the booking does not hold them yet (2026-10-19).
  const previewRoomNights = useMemo(() => {
    const out: Record<string, number> = {};
    for (const id of sealedRoomIds) {
      const n = roomDates?.[id]?.dates?.length ?? 0;
      if (n > 0) out[id] = n;
    }
    return Object.keys(out).length ? out : undefined;
  }, [sealedRoomIds, roomDates]);
  const previewRoomNightDates = useMemo(() => {
    const out: Record<string, string[]> = {};
    for (const id of sealedRoomIds) {
      const ds = roomDates?.[id]?.dates;
      if (ds && ds.length > 0) out[id] = ds.map((d) => d.slice(0, 10));
    }
    return Object.keys(out).length ? out : undefined;
  }, [sealedRoomIds, roomDates]);
  const previewRoomNightsKey = JSON.stringify([previewRoomNights ?? null, previewRoomNightDates ?? null]);
  // The preview runs whether or not the rate columns are open (2026-09-30, operator report:
  // the sum row's SC and GST "can be left unseen ... they show when Rates + is clicked, and after
  // clicking Rates + once and Rates - again they keep showing"). That was this query: it was
  // gated on `ratesOpen`, while the footer cells that print its figures were not — so the figures
  // were blank until the group had been opened once, then stayed from the cache. The money
  // belongs under the table at all times, so the query does too.
  useEffect(() => {
    if (!entryId || compositions.length === 0) return;
    const discount =
      Number.isFinite(discNum) && discNum > 0
        ? discUnitNow === "percent"
          ? { percent: discNum }
          : { amount: discNum }
        : null;
    const t = setTimeout(
      () =>
        setPreviewBody({
          roomCompositions: compositions,
          discount,
          ...(previewRoomNights ? { roomNights: previewRoomNights } : {}),
          ...(previewRoomNightDates ? { roomNightDates: previewRoomNightDates } : {}),
        }),
      450,
    );
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [compositions, entryId, discNum, discUnitNow, previewRoomNightsKey]);
  const previewQuery = useQuery({
    queryKey: ["quotation-live-preview", entryId, previewBody],
    queryFn: () => previewQuotationPricing(session!, entryId!, previewBody!),
    enabled: !!session && !!entryId && !!previewBody,
    // Keep the previous figures on screen while the next debounce round-trips — totals
    // shouldn't blink to dashes on every keystroke.
    placeholderData: (prev) => prev,
  });
  const preview = previewQuery.data ?? null;
  const pvByRoom = useMemo(() => new Map((preview?.rooms ?? []).map((l) => [l.roomId, l])), [preview]);
  /** Backend money → display string. Formatting only — never arithmetic. */
  const fmtNu = (n: number | null | undefined): string =>
    n == null ? "—" : n.toLocaleString("en-IN", { maximumFractionDigits: 2 });

  // Others à-la-carte columns appear only once someone is on the Others plan.
  const othersVisible = paxAnywhere("ot");

  // ---- Which nights each room is for (2026-09-30) ----------------------------------
  // Operator: "the reservation is from 30 Sept to 3 Oct but we don't know which dates the rooms
  // are for" — and then, on seeing a banner above the grid: "I wanted a COLUMN showing the dates
  // they were assigned to". It leads the row, because it is part of the room's identity: a row
  // reads "12 – 15 Oct · 204" before any of its counts mean anything. The labels are the
  // caller's (see `roomDates`); the table only prints them.
  const datesShown = !!roomDates && sealedRoomIds.some((id) => roomDates[id]);
  const bedsShown = !!bedPlan && sealedRoomIds.some((id) => bedPlan[id]);
  /** The stay's own night count — a room that differs from it is the interesting case. */
  const ciIso = dayToIso(entryCheckIn);
  const coIso = dayToIso(entryCheckOut);
  const stayNights =
    ciIso && coIso ? Math.round((new Date(coIso).getTime() - new Date(ciIso).getTime()) / 86400000) : null;

  // ---- Spreadsheet keyboard navigation -------------------------------------------
  // Cells are addressed `row:col` via data-cell. Arrow keys move between cells (Left/
  // Right only once the caret is at the text boundary, so in-value cursor movement
  // still works); Enter moves down. Checkboxes participate too (Space still toggles).
  const wrapRef = useRef<HTMLDivElement>(null);
  const visibleCols: string[] = useMemo(() => {
    const cols: string[] = ["ad"];
    if (childColsVisible) cols.push("c6", "u6");
    cols.push("bed", ...visibleMeals);
    if (othersVisible) cols.push("obf", "olu", "odi");
    cols.push("sc", "gst", "foc");
    if (ratesOpen) cols.push(...rateCols);
    return cols;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [othersVisible, ratesOpen, childColsVisible, visibleMeals.join(","), rateCols.join(",")]);

  const focusCell = (rowIdx: number, col: string) => {
    const el = wrapRef.current?.querySelector<HTMLInputElement>(`[data-cell="${rowIdx}:${col}"]`);
    if (el) {
      el.focus();
      if (el.type === "text") el.select();
    }
  };
  /** Horizontal move that SKIPS cells with no input — a rate column can render a dash for
   *  rows whose plan doesn't include that meal, and the walk must not dead-end on them. */
  const focusSideways = (rowIdx: number, fromCi: number, dir: 1 | -1) => {
    for (let i = fromCi + dir; i >= 0 && i < visibleCols.length; i += dir) {
      const el = wrapRef.current?.querySelector<HTMLInputElement>(`[data-cell="${rowIdx}:${visibleCols[i]}"]`);
      if (el) {
        el.focus();
        if (el.type === "text") el.select();
        return;
      }
    }
  };
  const onCellKeyDown = (rowIdx: number, col: string) => (e: React.KeyboardEvent<HTMLInputElement>) => {
    const input = e.currentTarget;
    const ci = visibleCols.indexOf(col);
    const atStart = input.type !== "text" || (input.selectionStart === 0 && input.selectionEnd === 0);
    const atEnd =
      input.type !== "text" ||
      (input.selectionStart === input.value.length && input.selectionEnd === input.value.length);
    if (e.key === "ArrowDown" || e.key === "Enter") {
      e.preventDefault();
      focusCell(Math.min(displayRowCount - 1, rowIdx + 1), col);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      focusCell(Math.max(0, rowIdx - 1), col);
    } else if (e.key === "ArrowRight" && atEnd && ci < visibleCols.length - 1) {
      e.preventDefault();
      focusSideways(rowIdx, ci, 1);
    } else if (e.key === "ArrowLeft" && atStart && ci > 0) {
      e.preventDefault();
      focusSideways(rowIdx, ci, -1);
    }
  };

  // ---- Totals ---------------------------------------------------------------------
  /**
   * A booking that changes rooms mid-stay holds rooms that are never in use together, and the
   * party sleeps in each of them in turn. Adding every row up then says the booking has twice
   * the guests it has, and every room on the later night reads as one nobody is in.
   *
   * So the reconciliation is **per night**: on each night, the rooms held that night must hold
   * the party between them. The Σ row prints the busiest night's figures — on a plain booking,
   * where every room runs the whole stay, that is exactly the old sum.
   */
  const nightsOf = (id: string) => roomDates?.[id]?.dates ?? null;
  const splitStay = sealedRoomIds.some((id) => (nightsOf(id)?.length ?? 0) > 0)
    && new Set(sealedRoomIds.flatMap((id) => nightsOf(id) ?? [])).size > 0
    && sealedRoomIds.some((a) => sealedRoomIds.some((b) => {
      const A = nightsOf(a);
      const B = nightsOf(b);
      return A && B && a !== b && !A.some((n) => B.includes(n));
    }));
  const allNights = Array.from(new Set(sealedRoomIds.flatMap((id) => nightsOf(id) ?? []))).sort();
  const roomsOn = (night: string) => sealedRoomIds.filter((id) => (nightsOf(id) ?? []).includes(night));
  const sumOver = (ids: string[], col: NumCol) => ids.reduce((s, id) => s + cnt(rows[id]?.[col] ?? "0"), 0);
  const guestsOver = (ids: string[]) => sumOver(ids, "ad") + sumOver(ids, "c6") + sumOver(ids, "u6");
  /** The night the table reconciles against: the one holding the most guests. */
  const busiestNight = splitStay && allNights.length
    ? allNights.reduce((best, n) => (guestsOver(roomsOn(n)) > guestsOver(roomsOn(best)) ? n : best), allNights[0])
    : null;
  const idsForTotals = busiestNight ? roomsOn(busiestNight) : sealedRoomIds;
  const sum = (col: NumCol) => sumOver(idsForTotals, col);
  const totalGuests = guestsOver(idsForTotals);
  const partySize = (entryAdults ?? 0) + (entryChildAges?.length ?? 0);
  /** Nights whose rooms do not hold the party between them — named in the fault list. */
  const nightsShort = splitStay && partySize > 0
    ? allNights.filter((n) => guestsOver(roomsOn(n)) !== partySize)
    : [];

  // ---- The table, night by night (2026-10-22, operator) -------------------------------
  // "The dates column causes the confusion ... when it has a range and others have a single
  // date it's hard to allocate." On a stay whose rooms change between nights the table is set
  // out NIGHT BY NIGHT instead: each night under a band naming it, holding the rooms in use that
  // night — or one night alone, picked beside Expand. A room held on several nights is still ONE
  // row (its figures are the same every night it is held), so it appears under each of its
  // nights and an edit to it on one changes them all; its cell says how many nights it covers.
  // Any stay of more than one night may be read night by night (2026-10-22): meals and extra
  // beds can differ by night on any stay, not only on one that changes rooms. A stay with the
  // same rooms every night opens on the whole stay; one that changes rooms, on every night.
  const pickerNights = splitStay ? allNights : stayNightList;
  const nightsEditable = datesShown && pickerNights.length > 1;
  const viewKey = nightView || (splitStay ? "all" : "stay");
  const roomsOnNight = (n: string) => sealedRoomIds.filter((id) => nightListOf(id).includes(n));
  const viewNight = nightsEditable && pickerNights.includes(viewKey) ? viewKey : null;
  const wholeStay = !nightsEditable || (!splitStay && !viewNight && viewKey !== "all");
  const sections: { night: string | null; ids: string[] }[] = wholeStay
    ? [{ night: null, ids: sealedRoomIds }]
    : (viewNight ? [viewNight] : pickerNights).map((n) => ({ night: n, ids: roomsOnNight(n) }));
  /** Each section's first row in the keyboard walk — a room shown under two nights is two stops. */
  const sectionStarts = sections.map((_, i) => sections.slice(0, i).reduce((s, x) => s + x.ids.length, 0));
  const displayRowCount = sections.reduce((s, x) => s + x.ids.length, 0);
  /** The Σ row reads the night on screen, else the busiest night (or the whole plan). */
  const footIds = viewNight ? roomsOnNight(viewNight) : idsForTotals;
  const footSum = (col: NumCol) => sumOver(footIds, col);
  const footGuests = guestsOver(footIds);
  /** How many nights a room's one row covers — stated where it is not obvious. */
  const nightsChip = (id: string): { text: string; title: string } | null => {
    const ns = nightsOf(id);
    if (!ns || ns.length === 0) return null;
    const show = splitStay ? ns.length > 1 : stayNights != null && ns.length !== stayNights;
    if (!show) return null;
    const list = ns.map(shortNight).join(", ");
    const no = roomById.get(id)?.roomNumber ?? "This room";
    return {
      text:
        stayNights != null && ns.length === stayNights
          ? "every night"
          : stayNights != null
            ? `${ns.length} of ${stayNights} nights`
            : `${ns.length} nights`,
      title: splitStay
        ? `Room ${no} is held on ${list}. It has one row for all of those nights, so a change to it here changes every one of them.`
        : `Room ${no} is held on ${list} only.`,
    };
  };

  /**
   * Everything wrong with the table right now, named room by room (2026-09-30). This is the ONE
   * definition of "sound enough to price": the red cells above are its symptoms, and the Save
   * button and the step's own acts both read it, so the grid and the page can never disagree
   * about whether the configuration may be committed.
   *
   * Every item here is refused by the backend too — the list exists so the refusal arrives
   * before the click rather than after it, naming the room instead of an id.
   */
  const faults = useMemo<string[]>(() => {
    const out: string[] = [];
    if (roomMin != null && sealedRoomIds.length < roomMin) {
      out.push(
        `${roomEnvelopeQuery.data?.chargeableOccupants ?? partySize} chargeable guests need at least ${roomMin} room${roomMin === 1 ? "" : "s"} — ${sealedRoomIds.length} chosen at Inquiry`,
      );
    }
    for (const id of sealedRoomIds) {
      const r = rows[id] ?? EMPTY_ROW;
      const occ = cnt(r.ad) + cnt(r.c6) + cnt(r.u6);
      const fault = rowFault(id);
      if (fault) out.push(`Room ${roomNoOf(id)} — ${fault}`);
      const room = roomById.get(id);
      const cap = room?.roomType?.maxCapacity ?? room?.roomType?.standardCapacity;
      // Meals and extra beds may differ night by night (2026-10-22), so each night is judged on its own.
      const checkNights: (string | null)[] = nightListOf(id).length ? nightListOf(id) : [null];
      const onNights = (ns: (string | null)[]) =>
        ns.length === checkNights.length ? "" : ` on ${ns.map((n) => shortNight(n ?? "")).join(", ")}`;
      const capNights = cap == null ? [] : checkNights.filter((n) => occ > cap + cnt(valAt(id, n, "bed")));
      if (cap != null && capNights.length) {
        const bed = cnt(valAt(id, capNights[0], "bed"));
        out.push(
          `Room ${roomNoOf(id)} — ${occ} guests in a room that sleeps ${cap}${bed > 0 ? ` + ${bed} extra bed(s)` : ""}${onNights(capNights)}`,
        );
      }
      const mealNights = checkNights.filter((n) => MEAL_COLS.reduce((s2, c) => s2 + cnt(valAt(id, n, c)), 0) > occ);
      if (mealNights.length) {
        out.push(`Room ${roomNoOf(id)} — more meal-plan pax than guests in the room${onNights(mealNights)}`);
      }
      if (belowFloor(id, "rRoom")) {
        out.push(`Room ${roomNoOf(id)} — priced below the house floor of ${floorOf(id)}, which needs the GM's waiver`);
      }
    }
    if (partySize > 0) {
      if (splitStay) {
        // Each night on its own: the rooms in use that night must hold the party between them.
        for (const n of nightsShort) {
          const g = guestsOver(roomsOn(n));
          out.push(
            g < partySize
              ? `${shortNight(n)} — ${partySize - g} of the booking's ${partySize} guests are not in a room`
              : `${shortNight(n)} — ${g} guests are placed but the booking has ${partySize}`,
          );
        }
      } else if (totalGuests !== partySize) {
        out.push(
          totalGuests < partySize
            ? `${partySize - totalGuests} of the booking's ${partySize} guests are not in a room yet`
            : `${totalGuests} guests are placed but the booking has ${partySize}`,
        );
      }
    }
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sealedRoomIds, rows, nightVals, roomDates, roomMin, partySize, totalGuests, roomById, rateRef, splitStay, nightsShort.join(",")]);

  useEffect(() => {
    onFaultsChange?.(faults);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [faults.join("|")]);

  if (sealedRoomIds.length === 0) {
    return (
      <div style={{ padding: 10, fontSize: 11.5, color: "var(--ink-3)" }}>
        Seal a room selection in Inquiry first — per-room composition unlocks after that.
      </div>
    );
  }

  const numCell = (
    rowIdx: number,
    roomId: string,
    col: NumCol,
    opts?: {
      warn?: boolean;
      /** A breach, not a caution — the cell reads in the stop colour ("UIappeal", 2026-09-29). */
      stop?: boolean;
      decimal?: boolean;
      wide?: boolean;
      placeholder?: string;
      title?: string;
      sub?: string | null;
      /** Reads, never writes — the value and its sub-line still show. */
      readOnly?: boolean;
      /** The night the row stands under — its meals and beds are that night's (2026-10-22). */
      night?: string | null;
    },
  ) => {
    const night = opts?.night ?? null;
    const varies = !night && isNightCol(col) && variesOn(roomId, col);
    // Marked against the room's USUAL night (the value more of its nights share than any other),
    // so a change made on every night alike marks nothing and the one night that differs stands
    // out. When the nights split evenly there is no usual night, and every night is marked —
    // picking one would be arbitrary (2026-10-22, operator: a two-night room marked only on its
    // second night).
    const mark = (() => {
      if (!night || !isNightCol(col)) return null;
      const ns = nightListOf(roomId);
      if (ns.length < 2) return null;
      const tally = new Map<number, number>();
      for (const n of ns) {
        const v = cnt(valAt(roomId, n, col));
        tally.set(v, (tally.get(v) ?? 0) + 1);
      }
      if (tally.size < 2) return null;
      const ranked = [...tally.entries()].sort((a, b) => b[1] - a[1]);
      const usual = ranked[0][1] > ranked[1][1] ? ranked[0][0] : null;
      const here = cnt(valAt(roomId, night, col));
      if (usual != null && here === usual) return null;
      return { usual, nights: ns };
    })();
    const ownNight = mark != null;
    const raw = varies ? "" : valAt(roomId, night, col);
    const cls = [opts?.stop ? "stop" : opts?.warn ? "warn" : "", varies ? "varies" : "", ownNight ? "own" : ""]
      .filter(Boolean)
      .join(" ");
    const title = varies
      ? `Differs by night — ${nightListOf(roomId)
          .map((n) => `${shortNight(n)}: ${cnt(valAt(roomId, n, col))}`)
          .join(" · ")}. Typing here sets every night.`
      : mark
        ? mark.usual != null
          ? `${shortNight(night!)} only — most of this room's nights have ${mark.usual}`
          : `This room's nights differ — ${mark.nights.map((n) => `${shortNight(n)}: ${cnt(valAt(roomId, n, col))}`).join(" · ")}`
        : opts?.title;
    return (
      <td key={col} className={cls || undefined} title={title}>
        <input
          type="text"
          inputMode={opts?.decimal ? "decimal" : "numeric"}
          className={opts?.wide ? "wide" : undefined}
          data-cell={`${rowIdx}:${col}`}
          placeholder={varies ? "varies" : opts?.placeholder}
          readOnly={opts?.readOnly || readOnly}
          tabIndex={readOnly ? -1 : undefined}
          style={opts?.readOnly ? { background: "var(--panel-2, transparent)", color: "var(--ink-3)", cursor: "default" } : undefined}
          value={raw}
          onKeyDown={onCellKeyDown(rowIdx, col)}
          onFocus={(e) => e.currentTarget.select()}
          onChange={(e) => {
            let v = e.target.value;
            // Digits only for counts; digits + one dot for rate cells.
            if (!(opts?.decimal ? /^\d*\.?\d*$/.test(v) : /^\d*$/.test(v))) return;
            // People/bed/meal cells are bounded — see the clamp helpers above. Band cells go
            // through the MOVE-semantics writer (it updates other rooms + auto beds itself).
            if (col === "ad" || col === "c6" || col === "u6") {
              applyBandChange(roomId, col, v);
              return;
            }
            if (col === "bed") v = clampBed(roomId, v);
            else if ((MEAL_COLS as string[]).includes(col)) v = clampMeal(roomId, col, v, night);
            // Meals and beds under a night are that night's; over the whole stay, every night's.
            if (isNightCol(col)) {
              if (night) writeNight(roomId, night, { [col]: v } as Partial<NightVals>);
              else writeAllNights(roomId, { [col]: v } as Partial<NightVals>);
            } else {
              setCell(roomId, { [col]: v });
            }
          }}
        />
        {/* Backend-priced `heads × rate` line under the rate input — display only. */}
        {opts?.sub != null && <span className="rct-sub">{opts.sub}</span>}
      </td>
    );
  };
  /** Every column of a row, so a band spans the table whatever is open. */
  const colCount =
    1 + (bedsShown ? 1 : 0) + 2 + (childColsVisible ? 2 : 0) + 1 + visibleMeals.length + (othersVisible ? 3 : 0) +
    (ratesOpen ? rateCols.length : 0) + 3 + 1;
  /** A night's band — where the date changes, so it reads as a break ("UIappeal"): the date at
   *  the table's largest size, and the night's own guest tally, green when the rooms that night
   *  hold the whole party and red while they do not. */
  const nightBand = (night: string, ids: string[]) => {
    const g = guestsOver(ids);
    const short = partySize > 0 && g !== partySize;
    return (
      <tr className="nightband">
        <td colSpan={colCount}>
          <div className="nb-in">
            <b className="nb-date">{nightLabel(night)}</b>
            <span className="nb-meta">
              night {pickerNights.indexOf(night) + 1} of {pickerNights.length} · {ids.length} room{ids.length === 1 ? "" : "s"}
            </span>
            {partySize > 0 && (
              <span
                className={`nb-tally${short ? " off" : ""}`}
                title={short ? `The rooms that night hold ${g} of the booking's ${partySize} guests` : "Every guest has a room that night"}
              >
                {g} of {partySize} guests
              </span>
            )}
          </div>
        </td>
      </tr>
    );
  };
  /** One band over a stay whose rooms run night to night unchanged — the dates once, not on
   *  every row. */
  const everyRoomEveryNight =
    stayNights != null && sealedRoomIds.every((id) => (nightsOf(id)?.length ?? stayNights) === stayNights);
  const stayBand =
    ciIso && coIso && stayNights ? (
      <tr className="nightband stay">
        <td colSpan={colCount}>
          <div className="nb-in">
            <b className="nb-date">
              {nightLabel(ciIso)} → {nightLabel(coIso)}
            </b>
            <span className="nb-meta">
              {stayNights} night{stayNights === 1 ? "" : "s"}
              {everyRoomEveryNight ? " · the same rooms every night" : ""}
            </span>
          </div>
        </td>
      </tr>
    ) : null;
  const boolCell = (rowIdx: number, roomId: string, col: "sc" | "gst" | "foc") =>
    col === "gst" ? (
      // GST is statutory — not an option (2026-08-01 operator ruling). Always on, always sent.
      <td key={col} className="ck" title="GST is mandatory — applied on every room">
        <input type="checkbox" checked disabled />
      </td>
    ) : (
      <td
        key={col}
        className="ck"
        title={
          lockCommercial
            ? "The guest is in-house — waiving the service charge or making a room FOC mid-stay is a GM re-price, not a desk edit."
            : undefined
        }
      >
        <input
          type="checkbox"
          data-cell={`${rowIdx}:${col}`}
          checked={rows[roomId]?.[col] ?? EMPTY_ROW[col]}
          disabled={lockCommercial || readOnly}
          onKeyDown={onCellKeyDown(rowIdx, col)}
          onChange={(e) => {
            const v = e.target.checked;
            if (col === "foc") {
              // FOC exempts the room from the p78 bed mandate; turning it OFF re-imposes it,
              // so the bed floor re-derives (raise only — a manual extra bed is never taken).
              setRows((prev) => {
                const r = { ...(prev[roomId] ?? EMPTY_ROW), foc: v };
                const needed = bedsNeeded(roomId, cnt(r.ad), v);
                if (cnt(r.bed) < needed) r.bed = String(needed);
                return { ...prev, [roomId]: r };
              });
              {
                const r = rows[roomId] ?? EMPTY_ROW;
                syncNightBeds(roomId, Math.max(cnt(r.bed), bedsNeeded(roomId, cnt(r.ad), v)));
              }
            } else {
              setCell(roomId, { [col]: v });
            }
          }}
        />
      </td>
    );

  return (
    <div className={`${expanded ? "rct rst-expandwrap on" : "rct"}${readOnly ? " ro" : ""}`}>
      {expanded && (
        <div className="rst-expandbar">
          <b>Room composition · {sealedRoomIds.length} room{sealedRoomIds.length === 1 ? "" : "s"}</b>
          <span className="ln" />
          <button type="button" className="btn btn-ghost" onClick={() => setExpanded(false)}>
            <Minimize2 style={{ width: 13, height: 13 }} /> Close
          </button>
        </div>
      )}
      {/* Reference rates ride above the grid in NORMAL PAGE FLOW (2026-08-03, operator request).
          The old `position: sticky` wrapper pinned the strip to the viewport whenever the canvas
          scrolled — so it hung over unrelated blocks inline, and in the expanded layer it drifted
          across the close bar. Inline it now simply scrolls away with the panel; expanded, the
          layer is a flex column in which only `.rct-scroll` scrolls, so this strip, the close bar
          and the toolbar are held at the top structurally rather than by sticky positioning. */}
      {bedAsk && bedsShown && <BedAskStrip ask={bedAsk} />}
      {entryId && <RateReferenceStrip entryId={entryId} compact roomIds={sealedRoomIds} />}
      {/* Discount rides with the rates, inside the panel — one negotiation surface. */}
      <NegotiationDiscountBar
        discountValue={discountValue}
        discountUnit={discountUnit}
        discountBasis={discountBasis}
        onDiscountChange={onDiscountChange}
        lockCommercial={lockCommercial || readOnly}
      />
      <div className="rce-bar">
        {!readOnly && (
        <>
        {partySize > 0 && (
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={distribute}
            title="Spread the booking's party across the rows (children stay together on the first room)"
          >
            <Wand2 style={{ width: 13, height: 13 }} /> Distribute party
          </button>
        )}
        <select
          className="rce-allsel"
          style={{ marginLeft: 0 }}
          value=""
          onChange={(e) => {
            if (e.target.value) everyoneOn(e.target.value as NumCol | "none");
          }}
          title="Set every room's meal-plan pax to its occupancy on one plan"
        >
          <option value="">Everyone on…</option>
          <option value="none">None (EP)</option>
          <option value="cp">CP · breakfast</option>
          <option value="ml">MAP · +lunch</option>
          <option value="md">MAP · +dinner</option>
          <option value="ap">AP · all meals</option>
          <option value="ot">Others</option>
        </select>
        {sealedRoomIds.length > 1 && (
          <button
            type="button"
            className="rcb-mini"
            onClick={copyFirstDown}
            title="Copy the first row on screen onto every other row on screen — meals and extra beds for the night each stands under; rates and charges too when every night is shown (guest counts stay put)"
          >
            <ArrowDownToLine style={{ width: 11, height: 11 }} /> Copy row 1 ↓
          </button>
        )}
        <span className="rce-lbl">Meals</span>
        {MEAL_COLS.map((c) => {
          const on = visibleMeals.includes(c);
          return (
            <button
              key={c}
              type="button"
              className={`rct-chip${on ? " on" : ""}`}
              onClick={() => togglePlan(c)}
              title={
                on
                  ? `${MEAL_META[c].title} — click to remove the column (zeroes its pax)`
                  : `${MEAL_META[c].title} — click to add the column`
              }
            >
              {MEAL_META[c].chip}
            </button>
          );
        })}
        </>
        )}
        <span className="ln" />
        {/* Compact tallies — the long forms crowded the row until "Expand" wrapped onto its own
            orphan line. Full wording rides on hover. */}
        {roomMin != null && (
          <span
            className={`rce-tally${sealedRoomIds.length < roomMin ? " off" : ""}`}
            title={`This party needs at least ${roomMin} room${roomMin === 1 ? "" : "s"} — ${sealedRoomIds.length} chosen`}
          >
            {sealedRoomIds.length} room{sealedRoomIds.length === 1 ? "" : "s"} · needs ≥{roomMin}
          </span>
        )}
        {partySize > 0 && (
          <span
            className={`rce-tally${(splitStay ? nightsShort.length > 0 : totalGuests !== partySize) ? " off" : ""}`}
            title={
              splitStay
                ? `${totalGuests} of ${partySize} guests placed on ${shortNight(busiestNight ?? "")}` +
                  (nightsShort.length ? ` · short on ${nightsShort.map(shortNight).join(", ")}` : " · every night covered")
                : `${totalGuests} of ${partySize} intake guests placed in rooms`
            }
          >
            {totalGuests}/{partySize} placed
          </span>
        )}
        {nightsEditable && (() => {
          const idx = viewNight ? pickerNights.indexOf(viewNight) : -1;
          return (
            <span className={`rce-night${nightsShort.length ? " off" : ""}`}>
              <button
                type="button"
                className="rcb-mini"
                aria-label="Previous night"
                title={idx === 0 ? "Every night" : "Previous night"}
                disabled={idx === -1}
                onClick={() => setNightView(idx <= 0 ? (splitStay ? "all" : "stay") : pickerNights[idx - 1])}
              >
                <ChevronLeft style={{ width: 12, height: 12 }} />
              </button>
              <select
                value={viewNight ?? (wholeStay ? "stay" : "all")}
                onChange={(e) => setNightView(e.target.value)}
                aria-label="Night shown"
                title={nightsShort.length ? `Short of guests on ${nightsShort.map(shortNight).join(", ")}` : "Every night holds the whole party"}
              >
                {!splitStay && <option value="stay">Whole stay · {pickerNights.length} nights</option>}
                <option value="all">All nights · {pickerNights.length}</option>
                {pickerNights.map((n, i) => {
                  const ids = roomsOnNight(n);
                  const short = partySize > 0 && guestsOver(ids) !== partySize;
                  return (
                    <option key={n} value={n}>
                      {`Night ${i + 1} · ${nightLabel(n)} · ${ids.length} room${ids.length === 1 ? "" : "s"}${short ? " · short" : ""}`}
                    </option>
                  );
                })}
              </select>
              <button
                type="button"
                className="rcb-mini"
                aria-label="Next night"
                title="Next night"
                disabled={idx === pickerNights.length - 1}
                onClick={() => setNightView(pickerNights[idx + 1])}
              >
                <ChevronRight style={{ width: 12, height: 12 }} />
              </button>
            </span>
          );
        })()}
        {!expanded && (
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={() => setExpanded(true)}
            title="Expand to full screen — fits every room and the rate columns on one screen"
          >
            <Maximize2 style={{ width: 13, height: 13 }} /> Expand
          </button>
        )}
        {quiet && (
          <Help label="How this table works">
            <p>One row per room: who sleeps there by age, their meal plans and any extra bed. Occ adds itself up from the guest columns.</p>
            <p>Arrow keys and Enter move between cells. Distribute party spreads the guests over the rooms; Everyone on… puts every room on one meal plan.</p>
            <p>Rates + opens the negotiated rates. A meal&rsquo;s rate opens for a room once its plan includes that meal; with no plan (EP) only the room and the extra bed are negotiated.</p>
            <p>Count children on the meal plans — under 6 eat free, 6 to 10 at the child rate.</p>
            {nightsEditable && (
              <p>
                Pick one night beside Expand, or All nights, to set meals and extra beds night by night — under a
                night a change is that night&rsquo;s only. Who sleeps in a room, its rates and its charges are the
                room&rsquo;s for every night it is held. Whole stay sets every night at once; a cell reading
                &ldquo;varies&rdquo; differs between nights. A small amber corner on a cell: that night is not like
                the room&rsquo;s other nights (when its nights split evenly, each one is marked). Copy row 1 and Everyone on… work on the rows on screen.
              </p>
            )}
            <p>Every figure is priced by the hotel&rsquo;s server, the same way the quotation will be.</p>
          </Help>
        )}
      </div>
      {/* A refusal of what was just typed — the loudest thing on the table while it shows
          (2026-09-29, "UIappeal"): it appears with a flash, reads at the table's own size in the
          stop colour, and says what was capped. It clears itself after five seconds. */}
      {limitMsg && (
        <p className="rct-refusal" role="alert" aria-live="assertive">
          <span className="ic" aria-hidden="true">
            !
          </span>
          <span>{limitMsg}</span>
        </p>
      )}
      {!onSave && roomMin != null && sealedRoomIds.length < roomMin && (
        <p className="rce-block">
          {roomEnvelopeQuery.data?.chargeableOccupants} chargeable guest
          {(roomEnvelopeQuery.data?.chargeableOccupants ?? 0) === 1 ? "" : "s"} won&rsquo;t fit in{" "}
          {sealedRoomIds.length} room{sealedRoomIds.length === 1 ? "" : "s"} — go back to Inquiry and seal at
          least {roomMin}.
        </p>
      )}

      <div className="rct-scroll" ref={wrapRef}>
        <table className="rct-t">
          <thead>
            <tr className="grp">
              <th className="room" />
              {bedsShown && <th />}
              <th />
              <th colSpan={childColsVisible ? 4 : 2}>Guests</th>
              {visibleMeals.length > 0 && <th colSpan={visibleMeals.length}>Meal-plan pax</th>}
              {othersVisible && <th colSpan={3}>Others à-la-carte pax</th>}
              {ratesOpen && (
                <th
                  colSpan={rateCols.length}
                  title="Columns follow the meal plans in use — room & bed always; a meal appears only while some room's plan includes it"
                >
                  Negotiated rates (Nu., optional{rateCols.length === 2 ? " · EP — room only" : ""})
                </th>
              )}
              {/* Charges sits at the far right, beside the total it changes (2026-09-29, operator).
                  SC / GST / FOC are set once and rarely touched; between the pax counts and the
                  rate columns they broke the typing path — pax, then the rate that prices it. */}
              <th colSpan={3}>Charges</th>
              <th className="ratebtn" rowSpan={2}>
                <div className="rct-corner">
                  <button type="button" className="rcb-mini" onClick={() => setRatesOpen((v) => !v)}>
                    {ratesOpen ? "Rates −" : "Rates +"}
                  </button>
                </div>
              </th>
            </tr>
            <tr>
              <th className="room">Room</th>
              {bedsShown && (
                <th className="bedcol" title="How the room is made up for this stay">
                  Bed type
                </th>
              )}
              <th title="Occupants — derived: adults + children">Occ</th>
              <th>Adult</th>
              {childColsVisible && (
                <>
                  <th title="Children 6–10">6–10</th>
                  <th title="Children under 6">&lt;6</th>
                </>
              )}
              <th title="Extra beds">Extra bed</th>
              {visibleMeals.map((c) => (
                <th key={c} title={MEAL_META[c].title}>
                  {MEAL_META[c].th}
                </th>
              ))}
              {othersVisible && (
                <>
                  <th>B'fast</th>
                  <th>Lunch</th>
                  <th>Dinner</th>
                </>
              )}
              {ratesOpen &&
                rateCols.map((c) => (
                  <th
                    key={c}
                    title={
                      RATE_META[c].meal
                        ? `Per-person ${RATE_META[c].meal} rate — editable only for rooms whose plan includes ${RATE_META[c].meal}`
                        : c === "rRoom"
                          ? "Per-night room rate"
                          : "Per-bed per-night extra-bed rate"
                    }
                  >
                    {RATE_META[c].th}
                  </th>
                ))}
              <th title="Service charge applies">SC</th>
              <th title="GST applies">GST</th>
              <th title="Free of charge — room priced at zero">FOC</th>
            </tr>
          </thead>
          <tbody>
            {sections.map((sec, si) => (
              <Fragment key={sec.night ?? "stay"}>
                {sec.night ? nightBand(sec.night, sec.ids) : datesShown ? stayBand : null}
                {sec.ids.map((id, k) => {
                  const rowIdx = sectionStarts[si] + k;
                  const r = rows[id] ?? EMPTY_ROW;
                  const room = roomById.get(id);
                  const occ = cnt(r.ad) + cnt(r.c6) + cnt(r.u6);
                  // Meals and beds are judged on the night shown — over the whole stay, on every night.
                  const nightsHere: (string | null)[] = sec.night
                    ? [sec.night]
                    : nightListOf(id).length
                      ? nightListOf(id)
                      : [null];
                  const plansOver = nightsHere.some(
                    (n) => MEAL_COLS.reduce((s, c) => s + cnt(valAt(id, n, c)), 0) > occ,
                  );
                  const cap = room?.roomType?.maxCapacity ?? room?.roomType?.standardCapacity;
                  const bedHere = Math.min(...nightsHere.map((n) => cnt(valAt(id, n, "bed"))));
                  const overCap = cap != null && occ > cap + bedHere;
                  const chip = nightsChip(id);
                  return (
                    <tr key={`${sec.night ?? "stay"}|${id}`} className={r.foc ? "foc" : undefined}>
                      {/* The room cell doubles as "open this room in the guest board". Deliberately
                          the room cell and not the whole row: a row-level handler would fire on
                          every cell click and fight the grid's own editing/navigation. */}
                      <td
                        className={`room${onPickRoom || onOpenRoomInBoard ? " opens" : ""}${onPickRoom && pickedRoomId === id ? " picked" : ""}`}
                        onClick={onPickRoom ? () => onPickRoom(id) : onOpenRoomInBoard ? () => onOpenRoomInBoard(id) : undefined}
                        title={
                          onPickRoom
                            ? pickedRoomId === id
                              ? "Chosen — its acts are above the table"
                              : "Choose this room to see what can be done with it"
                            : onOpenRoomInBoard
                              ? "Open this room on its own in the guest board"
                              : undefined
                        }
                      >
                        <b>{room?.roomNumber ?? id.slice(0, 6)}</b>
                        {room?.roomType?.code && <span>{room.roomType.code}</span>}
                        {chip && (
                          <span className="nn" title={chip.title}>
                            {chip.text}
                          </span>
                        )}
                      </td>
                      {bedsShown && <BedCell roomId={id} cell={bedPlan?.[id]} onChange={onBedChange} />}
                      {/* Occ is the row's own reconciliation: over the room's capacity it reads RED,
                          not a quiet amber — the figure the operator must not miss (2026-09-29). */}
                      <td
                        className={`occ${overCap || occ === 0 ? " over" : ""}`}
                        title={
                          occ === 0
                            ? "Nobody is in this room — every room in the plan must hold someone, or drop the room at Inquiry"
                            : overCap
                              ? `Over capacity — ${occ} guests in a room that sleeps ${cap}${bedHere > 0 ? ` + ${bedHere} extra bed(s)` : ""}`
                              : cap != null
                                ? `Capacity ${cap}`
                                : undefined
                        }
                      >
                        {occ}
                      </td>
                      {/* A room with no adult in it is refused downstream, so the cell says so here
                          (2026-09-30, "UIappeal") — red, not a quiet blank. */}
                      {numCell(rowIdx, id, "ad", {
                        stop: cnt(r.ad) === 0,
                        title:
                          occ === 0
                            ? "Nobody is in this room yet"
                            : cnt(r.ad) === 0
                              ? "Every room needs at least one adult — children cannot be booked into a room on their own"
                              : undefined,
                      })}
                      {childColsVisible && (
                        <>
                          {numCell(rowIdx, id, "c6")}
                          {numCell(rowIdx, id, "u6")}
                        </>
                      )}
                      {numCell(rowIdx, id, "bed", { night: sec.night })}
                      {visibleMeals.map((c) => numCell(rowIdx, id, c, { warn: plansOver, night: sec.night }))}
                      {othersVisible && (
                        <>
                          {numCell(rowIdx, id, "obf", { night: sec.night })}
                          {numCell(rowIdx, id, "olu", { night: sec.night })}
                          {numCell(rowIdx, id, "odi", { night: sec.night })}
                        </>
                      )}
                      {/* Each rate cell shows the figure it would price at when left empty, as the
                          placeholder — so the column reads as rates rather than as blanks, and a
                          negotiation is entered against a visible anchor. Typing overrides it.
                          A meal's cell is editable only for rooms whose plan includes that meal —
                          the others get a dash (nothing to negotiate); same for Bed with no extra
                          beds. Under each active input, the backend-priced `heads × rate` line. */}
                      {ratesOpen &&
                        rateCols.map((col) => {
                          const consumes = roomConsumes(id);
                          const active =
                            col === "rRoom" ? true : col === "rBed" ? cnt(r.bed) > 0 : consumes[col];
                          if (!active) {
                            return (
                              <td
                                key={col}
                                className="mut"
                                title={
                                  col === "rBed"
                                    ? "No extra beds in this room — nothing to negotiate"
                                    : `Room ${roomNoOf(id)}'s meal plan doesn't include ${RATE_META[col].meal} — put someone on a plan that does (or à-la-carte pax) to unlock this rate`
                                }
                              >
                                —
                              </td>
                            );
                          }
                          const ref = refFor(id, col);
                          const l = pvByRoom.get(id);
                          const nn = l ? `${l.nights}n` : "";
                          const sub = !l
                            ? null
                            : col === "rRoom"
                              ? `${nn} · ${fmtNu(l.roomSubtotal)}`
                              : col === "rBed"
                                ? `${l.extraBedCount}×${nn} · ${fmtNu(l.extraBedSubtotal)}`
                                : col === "rBf"
                                  ? l.hasNightMealOverrides
                                    ? `varies · ${fmtNu(l.breakfastSubtotal)}`
                                    : `${l.breakfastPax}×${nn} · ${fmtNu(l.breakfastSubtotal)}`
                                  : col === "rLu"
                                    ? l.hasNightMealOverrides
                                      ? `varies · ${fmtNu(l.lunchSubtotal)}`
                                      : `${l.lunchPax}×${nn} · ${fmtNu(l.lunchSubtotal)}`
                                    : l.hasNightMealOverrides
                                      ? `varies · ${fmtNu(l.dinnerSubtotal)}`
                                      : `${l.dinnerPax}×${nn} · ${fmtNu(l.dinnerSubtotal)}`;
                          return numCell(rowIdx, id, col, {
                            decimal: true,
                            wide: true,
                            readOnly: lockCommercial,
                            stop: belowFloor(id, col),
                            placeholder: ref != null ? String(ref) : "—",
                            sub,
                            title: belowFloor(id, col)
                              ? `Below the floor for this room type — ${floorOf(id)} ${rateRef?.currency ?? ""} is the house's minimum sellable rate. A booking priced under it needs the GM's waiver.`
                              : lockCommercial
                              ? "The guest is in-house — a rate change mid-stay is a GM re-price, not a desk edit. The figures here are what the booking is priced at."
                              : (ref != null
                                ? `Prices at ${ref} ${rateRef?.currency ?? ""} unless you type a negotiated rate`
                                : "No rate on file for this room type — leave empty and it prices at zero") +
                              (RATE_META[col].meal
                                ? ". Below: covers × nights · stay amount (children priced by age band)"
                                : sub
                                  ? ". Below: the stay amount this rate produces"
                                  : ""),
                          });
                        })}
                      {/* The charges follow the rates, beside the total they change (2026-09-29). */}
                      {boolCell(rowIdx, id, "sc")}
                      {boolCell(rowIdx, id, "gst")}
                      {boolCell(rowIdx, id, "foc")}
                      {ratesOpen && preview ? (
                        <td
                          className="rowtot"
                          title="This room's stay total, with service charge and GST"
                        >
                          {fmtNu(pvByRoom.get(id)?.total)}
                        </td>
                      ) : (
                        <td />
                      )}
                    </tr>
                  );
                })}
              </Fragment>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <td
                className="room"
                title={
                  viewNight
                    ? `${nightLabel(viewNight)} — the rooms in use that night`
                    : busiestNight
                      ? `${nightLabel(busiestNight)} — the night holding the most guests`
                      : undefined
                }
              >
                Σ
              </td>
              {bedsShown && <td className="bedcol" />}
              <td className={`occ${partySize > 0 && footGuests !== partySize ? " off" : ""}`}>{footGuests}</td>
              <td>{footSum("ad")}</td>
              {childColsVisible && (
                <>
                  <td>{footSum("c6")}</td>
                  <td>{footSum("u6")}</td>
                </>
              )}
              <td>{footSum("bed")}</td>
              {visibleMeals.map((c) => (
                <td key={c}>{footSum(c)}</td>
              ))}
              {othersVisible && (
                <>
                  <td>{footSum("obf")}</td>
                  <td>{footSum("olu")}</td>
                  <td>{footSum("odi")}</td>
                </>
              )}
              {/* Column money totals (2026-08-07, operator request): each rate column's whole-stay
                  total across every room — net of tax, straight from the live preview; the corner
                  carries the tax-inclusive grand total. Never summed here. */}
              {ratesOpen &&
                rateCols.map((c) => (
                  <td
                    key={c}
                    className="money"
                    title={`${RATE_META[c].th} — whole-stay total across all rooms, before service charge & GST`}
                  >
                    {preview
                      ? fmtNu(
                          c === "rRoom"
                            ? preview.columns.room
                            : c === "rBed"
                              ? preview.columns.extraBed
                              : c === "rBf"
                                ? preview.columns.breakfast
                                : c === "rLu"
                                  ? preview.columns.lunch
                                  : preview.columns.dinner,
                        )
                      : "—"}
                  </td>
                ))}
              {/* What the service charge and the GST come to, under the columns that switch them
                  on (2026-09-29, operator) — the same server figures the live total prints, never
                  summed here. FOC has nothing to total. */}
              {preview ? (
                <>
                  <td className="money" title="Service charge across every room — whole stay">
                    {fmtNu(preview.serviceCharge)}
                  </td>
                  <td className="money" title="GST across every room — whole stay">
                    {fmtNu(preview.gst)}
                  </td>
                  <td />
                </>
              ) : (
                <td colSpan={3} />
              )}
              {ratesOpen && preview ? (
                <td className="rowtot" title="Grand total including service charge & GST">
                  {fmtNu(preview.grandTotal)}
                </td>
              ) : (
                <td />
              )}
            </tr>
          </tfoot>
        </table>
      </div>

      {/* Running total, backend-priced (2026-08-07): the same figures the generated quote will
          carry — net, taxes, grand total, and the discount's effect when one is set. */}
      {preview && (
        <div className="rct-live">
          <span className="k">Live total</span>
          <span className="parts">
            <i>Net</i> {fmtNu(preview.subtotal)} <i>+ SC</i> {fmtNu(preview.serviceCharge)} <i>+ GST</i> {fmtNu(preview.gst)}
          </span>
          {/* What the booking costs — the one figure the whole table is for, so it is read at a
              glance and never mistaken for another number in the row (2026-09-29, "UIappeal"). */}
          <b className="tot">
            {preview.currency} {fmtNu(preview.grandTotal)}
          </b>
          {preview.discount && (
            <span className="disc">
              − {fmtNu(preview.discount.amountOffTotal)} discount → payable{" "}
              <b className="tot">
                {preview.currency} {fmtNu(preview.payable)}
              </b>
            </span>
          )}
          <span className="ln" />
          {!quiet && <span className="src">the quote will show the same figures</span>}
        </div>
      )}

      {/* A room nobody sleeps in, or a room of children with no adult — named, because the red
          cell says WHICH box and this says what it means ("UIappeal", 2026-09-30). Shown only
          where the table has no Save row; there, the faults are listed with the button. */}
      {!onSave && sealedRoomIds.some((id) => rowFault(id)) && (
        <p className="rct-refusal" role="alert" aria-live="polite" style={{ marginTop: 8, marginBottom: 0 }}>
          <span className="ic" aria-hidden="true">
            !
          </span>
          <span>
            {sealedRoomIds
              .filter((id) => rowFault(id))
              .map((id) => `Room ${roomNoOf(id)} — ${rowFault(id)}`)
              .join(" · ")}
            . The quote is refused while this stands.
          </span>
        </p>
      )}

      {/* Rates under the house floor, named — the grid's red cells say WHICH, this says what it
          means for the quote ("UIappeal", 2026-09-29). */}
      {!onSave && sealedRoomIds.some((id) => belowFloor(id, "rRoom")) && (
        <p className="rct-refusal" role="alert" aria-live="polite" style={{ marginTop: 8, marginBottom: 0 }}>
          <span className="ic" aria-hidden="true">
            !
          </span>
          <span>
            {sealedRoomIds
              .filter((id) => belowFloor(id, "rRoom"))
              .map((id) => `Room ${roomNoOf(id)} (floor ${floorOf(id)})`)
              .join(" · ")}{" "}
            — priced below the house&rsquo;s minimum sellable rate. A booking under the floor needs the GM&rsquo;s waiver
            before the quote can be generated.
          </span>
        </p>
      )}
      {!onSave && sealedRoomIds.some((id) => {
        const r = rows[id] ?? EMPTY_ROW;
        return MEAL_COLS.reduce((s, c) => s + cnt(r[c]), 0) > cnt(r.ad) + cnt(r.c6) + cnt(r.u6);
      }) && (
        <p className="rce-warns" style={{ marginBottom: 0 }}>
          A room has more guests on meal plans than guests in it — one plan per guest. The quote can't be
          saved until it fits.
        </p>
      )}
      {/* Saving the table IS pricing it — there is nowhere else a composition lives (2026-09-30).
          The button stays shut while anything above is red, and the faults are listed here in
          full, room by room, so the operator fixes them without hunting for the cell. */}
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
              {quiet
                ? "Changed since it was priced — save it"
                : "Changed since it was priced — save it, or the quotation still says the old figures."}
            </span>
          ) : quiet ? (
            <span />
          ) : (
            <span className="ok-ink" style={{ fontWeight: 700 }} role="status">
              Saved — the quotation is priced on exactly this table.
            </span>
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
                  ? "Saves this table by pricing it: the house generates the quotation from these rows"
                  : "Nothing to save — the quotation already carries this table"
            }
            onClick={() => onSave()}
          >
            {saving ? "Saving…" : !unsaved && faults.length === 0 ? "Saved" : (saveLabel ?? "Save & price it")}
          </button>
          </div>
        </div>
      )}
      {/* One line. The old version also warned that child meal discounts were "pending a backend
          update" — stale since 2026-08-04: computeRoomComposition now prices covers by age band
          (under-6 free, 6–10 at the child share), so children SHOULD be counted on the plans. */}
      {!quiet && <p className="rce-hint">
        Occ adds itself up from the guest columns · arrow keys and Enter move between cells · every figure is
        worked out by the hotel's system. Rate columns follow the meal plans in use — no plan (EP) negotiates room
        &amp; bed only, and a meal&rsquo;s rate unlocks per room once its plan includes that meal. Count
        children on the meal plans — child pricing applies automatically (under-6 free, 6–10 at the
        child rate).
      </p>}
    </div>
  );
}
