"use client";

/**
 * One stay's negotiation table: what it is priced on, what the desk has changed, and how it is saved.
 * Read by the one-stay table at Negotiation and by each stay of the table the stays share
 * (2026-11-09), so the two cannot price a stay differently. Every figure is the backend's.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useSession } from "@/hooks/use-session";
import { useHotelClock } from "@/hooks/use-hotel-clock";
import { useBookingRooms } from "@/hooks/use-booking-rooms";
import { createQuotation, getQuoteValidityWindow, supersedeQuotation, type RoomCompositionInput } from "@/lib/api/quotations";
import { nightOverridesCanon } from "@/components/desk/workspace/room-compositions-table";
import { Help } from "@/components/ds/help";
import { Button } from "@/design-system";
import { liveQuotesThisPass } from "@/lib/desk/workspace";
import { operativeRoomCompositions, roomNightsByRoom, roomStayRangesByRoom } from "@/lib/desk/party-rooms";
import { fmtDateTime, plural } from "@/lib/ds/format";
import { optionSelectedRoomIds, preferredHoldRoomId, type EntryDetail, type QuotationSummary } from "@/types/api";
import { DsDialog, useBedPlan } from "./kit";
import { passesOf } from "./s2-shared";

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;

export type RecordedDiscount = { unit: "percent" | "amount"; value: number; basis: string };

export function readDiscount(q: QuotationSummary | undefined | null): RecordedDiscount | null {
  const terms = q?.commercialTerms as Record<string, unknown> | null | undefined;
  const d = terms?.requestedDiscount as { discountPercent?: unknown; discountAmount?: unknown; discountBasis?: unknown } | undefined;
  if (!d) return null;
  const basis = typeof d.discountBasis === "string" && d.discountBasis.trim() ? d.discountBasis : "negotiation";
  if (typeof d.discountPercent === "number" && d.discountPercent > 0) return { unit: "percent", value: d.discountPercent, basis };
  if (typeof d.discountAmount === "number" && d.discountAmount > 0) return { unit: "amount", value: d.discountAmount, basis };
  return null;
}

/**
 * Is the table still what the quotation was priced on? Compared field by field over what the
 * grid actually controls, so a stored row carrying extra keys — or a rate stored as a string —
 * does not read as a change. Nothing else is inferred: no quotation at all means unsaved by
 * definition, since there is nothing for the table to match.
 */
export function canonComps(list: readonly RoomCompositionInput[] | undefined): string {
  const n = (v: unknown) => (v == null || v === "" ? "" : String(Number(v)));
  return [...(list ?? [])]
    .map((c) =>
      [
        c.roomId,
        n(c.adultCount ?? 0),
        n(c.cnb6To10Count ?? 0),
        n(c.cnbUnder6Count ?? 0),
        n(c.extraBedCount ?? 0),
        n(c.mealPlanCpCount ?? 0),
        n(c.mealPlanMaplCount ?? 0),
        n(c.mealPlanMapdCount ?? 0),
        n(c.mealPlanApCount ?? 0),
        n(c.mealPlanOthersCount ?? 0),
        n(c.othersBreakfastPax),
        n(c.othersLunchPax),
        n(c.othersDinnerPax),
        n(c.negotiatedRoomRate),
        n(c.negotiatedExtraBedRate),
        n(c.negotiatedBreakfastRate),
        n(c.negotiatedLunchRate),
        n(c.negotiatedDinnerRate),
        c.serviceChargeApplies === false ? "0" : "1",
        c.gstApplies === false ? "0" : "1",
        c.isFoc === true ? "1" : "0",
        nightOverridesCanon(c.nightMealOverrides),
      ].join("~"),
    )
    .sort()
    .join("//");
}

/** The quotation a stay shows: accepted, else the one being worked on, else this pass's newest. */
export function shownQuotation(entry: EntryDetail): QuotationSummary | null {
  const passId = passesOf(entry).current?.id ?? null;
  const qs = (entry.quotations ?? []).filter((q) => !passId || q.segmentId === passId);
  return qs.find((q) => q.state === "ACCEPTED") ?? qs.find((q) => q.state === "DRAFT") ?? qs.find((q) => q.state === "SENT") ?? qs[0] ?? null;
}

type StoredExtra = { v: 1; basis: string; discountValue: string; discountUnit: "percent" | "amount"; valid: string | null };

/** The discount and the validity not saved yet, kept like the table's own cells (2026-11-09). */
function readStoredExtra(key: string, basis: string): StoredExtra | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = localStorage.getItem(key);
    const v = raw ? (JSON.parse(raw) as StoredExtra) : null;
    return v && v.v === 1 && v.basis === basis ? v : null;
  } catch {
    return null;
  }
}

export function useStayTable(entry: EntryDetail, opts: { past: boolean; allowParked?: boolean }) {
  const { session } = useSession();
  const clock = useHotelClock(30_000);
  const bookingRooms = useBookingRooms(entry);
  const passes = useMemo(() => passesOf(entry), [entry.segments]); // eslint-disable-line react-hooks/exhaustive-deps
  const passId = passes.current?.id ?? null;
  const editable =
    !opts.past && entry.currentStage === "S2" && (entry.status === "ACTIVE" || (!!opts.allowParked && entry.status === "PARKED"));

  /* ---- the quotations of this pass ---- */
  const quotations = useMemo(() => (entry.quotations ?? []).filter((q) => !passId || q.segmentId === passId), [entry.quotations, passId]);
  const draft = quotations.find((q) => q.state === "DRAFT");
  const sent = quotations.find((q) => q.state === "SENT");
  const accepted = quotations.find((q) => q.state === "ACCEPTED");
  const working = draft ?? sent;
  const shown = accepted ?? working ?? quotations[0] ?? null;
  const persistBasis = (working ?? accepted)?.id ?? "none";

  // The table opens on the terms the live quote was priced on (2026-09-18). Without a seed it
  // restored only this browser's unsaved edits, so on another terminal — or once the browser's
  // storage was cleared — it opened with the party auto-distributed and NO meals, and "Generate
  // the quote again" would have re-priced the stay without the meals the guest was quoted.
  // After a re-entry it starts from the last terms in force. Read once, at the table's mount.
  // A booking split off another (2026-10-14) and never priced starts from what its rooms carried —
  // their guests, meals, extra beds and the rates they kept.
  const seedCompositions = useMemo(
    () =>
      operativeRoomCompositions(entry) ??
      ((entry.carryOver?.compositions?.length ? entry.carryOver.compositions : null) as ReturnType<typeof operativeRoomCompositions>) ??
      undefined,
    [entry.id], // eslint-disable-line react-hooks/exhaustive-deps
  );
  /**
   * What the QUOTATION is priced on right now — re-read on every refresh, unlike the seed above,
   * which is deliberately read once so a save does not yank the operator's grid out from under
   * them. This is the baseline the table is compared against to decide whether it has unsaved
   * changes (2026-09-30).
   */
  const pricedCompositions = useMemo(() => operativeRoomCompositions(entry) ?? [], [entry]);

  /* ---- the rooms chosen at Inquiry ---- */
  const sealedPreferred = (entry.availabilityConfigs ?? []).find((c) => c.sealedAt && c.optionSelected);
  const sealedRoomIds = useMemo(() => optionSelectedRoomIds(sealedPreferred?.optionSelected), [sealedPreferred?.optionSelected]);
  const beds = useBedPlan(entry.id, entry.updatedAt);
  const anchorRoomId = preferredHoldRoomId(sealedPreferred?.optionSelected ?? null);
  /**
   * What the composition table says is wrong with itself (2026-09-30). The table is the ONE
   * judge of whether the configuration may be priced — the step reads its verdict rather than
   * re-deriving one, so the grid's red cells and this page's shut doors always agree.
   */
  const [tableFaults, setTableFaults] = useState<string[]>([]);
  /**
   * Which nights each chosen room actually holds (2026-09-30, operator). Derived HERE rather than
   * in the grid because this is where the booking is: `roomStayRangesByRoom` reads the newest
   * sealed pick, then dated assignment rows, then falls back to the whole stay for a uniform plan.
   */
  const roomDates = useMemo(() => {
    // `dates` lets the table reconcile per NIGHT — on a booking that moves rooms mid-stay the
    // rooms are not in use together, so their guests are the same people (2026-10-06).
    const nights = roomNightsByRoom(entry);
    const out: Record<string, { label: string; nights: number; dates?: string[] }> = {};
    for (const [roomId, r] of roomStayRangesByRoom(entry)) {
      out[roomId] = { label: r.label, nights: r.nightCount, dates: nights.get(roomId) ?? [] };
    }
    return out;
  }, [entry]);

  /** Once this pass's proforma exists, the quotation's terms are final (2026-08-06 ruling). */
  const proformaLocked = useMemo(() => {
    const start = passes.startedAt ? new Date(passes.startedAt).getTime() : null;
    return (entry.folio?.invoices ?? []).some(
      (inv) =>
        inv.invoiceType === "PROFORMA" &&
        inv.state !== "SUPERSEDED" &&
        !inv.supersededById &&
        (start == null || new Date(inv.createdAt).getTime() >= start),
    );
  }, [entry.folio?.invoices, passes.startedAt]);

  /* ---- what the table holds ---- */
  const extraKey = `desk:rextra:${entry.id}`;
  const stored = useRef<StoredExtra | null | undefined>(undefined);
  if (stored.current === undefined) stored.current = readStoredExtra(extraKey, persistBasis);
  const [roomCompositions, setRoomCompositions] = useState<RoomCompositionInput[]>([]);
  const [discountValue, setDiscountValue] = useState(stored.current?.discountValue ?? "");
  const [discountUnit, setDiscountUnit] = useState<"percent" | "amount">(stored.current?.discountUnit ?? "percent");
  const [discountBasis, setDiscountBasis] = useState("negotiation");
  const recordedDiscount = useMemo(() => readDiscount(working ?? accepted), [working, accepted]);
  // `undefined` until the first run: with no quotation yet the id is null, and starting at null
  // skipped the first run, so a discount carried from another booking never reached the table.
  const seededFor = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    const id = (working ?? accepted)?.id ?? null;
    if (seededFor.current === id) return;
    const first = seededFor.current === undefined;
    seededFor.current = id;
    // The desk's own unfinished work outranks the seed, on the same quotation.
    if (first && stored.current) return;
    if (recordedDiscount) {
      setDiscountValue(String(recordedDiscount.value));
      setDiscountUnit(recordedDiscount.unit);
      setDiscountBasis(recordedDiscount.basis);
    } else if (!id && entry.carryOver?.discount?.discountPercent) {
      // Not priced yet, split off a booking that had a percentage off: it carries.
      setDiscountValue(String(entry.carryOver.discount.discountPercent));
      setDiscountUnit("percent");
      setDiscountBasis(entry.carryOver.discount.discountBasis || "negotiation");
    }
  }, [working, accepted, recordedDiscount]); // eslint-disable-line react-hooks/exhaustive-deps

  /**
   * The discount rides on the same save, so a changed one counts as an unsaved change — the
   * quotation would otherwise still carry the old concession while the bar shows the new one.
   */
  const discountMoved =
    (discountValue.trim() === "" ? null : Number(discountValue)) !== (recordedDiscount?.value ?? null) ||
    (recordedDiscount != null && discountUnit !== recordedDiscount.unit);
  const tableUnsaved = !working || canonComps(roomCompositions) !== canonComps(pricedCompositions) || discountMoved;

  /** A blank or zero figure is "no discount"; clearing a recorded one must be said as `null`. */
  const discountPayload = (() => {
    const n = Number(discountValue);
    if (!discountValue.trim() || !Number.isFinite(n) || n <= 0) return null;
    const basis = discountBasis.trim() || "negotiation";
    return discountUnit === "amount" ? { discountAmount: n, discountBasis: basis } : { discountPercent: n, discountBasis: basis };
  })();
  const discountForPreview = (() => {
    const n = Number(discountValue);
    return discountValue.trim() && Number.isFinite(n) && n > 0 ? (discountUnit === "amount" ? { amount: n } : { percent: n }) : null;
  })();

  /* ---- validity: up to check-in, in days; in hours when check-in is today. The rule is the server's. ---- */
  const validityQuery = useQuery({
    queryKey: ["quote-validity", entry.id, entry.checkInDate],
    queryFn: () => getQuoteValidityWindow(session!, entry.id),
    enabled: !!session,
    staleTime: 30_000,
    refetchInterval: 60_000,
  });
  const validWindow = validityQuery.data ?? null;
  const inHours = validWindow?.mode === "HOURS";
  const validUnitMs = inHours ? HOUR_MS : DAY_MS;
  const validUnit = inHours ? "hour" : "day";
  const maxValid = validWindow?.max ?? 0;
  const [validCount, setValidCount] = useState(stored.current?.valid ?? "");
  /**
   * The validity is written by the Save, so changing it after the quote was priced is an unsaved
   * change too (2026-10-12) — without this the Save stayed on "Saved" and the new validity could
   * never be applied. Cleared when a save lands.
   */
  const [validTouched, setValidTouched] = useState(!!stored.current?.valid);
  const changeValid = (v: string) => {
    setValidCount(v);
    setValidTouched(true);
  };
  // It starts as long as it may stand (2026-11-05, operator: "the validity of the quote will be till the
  // check in date"), or at what is left of the quotation on file: a shorter time set stays shorter.
  const offerUntil = liveQuotesThisPass(entry)[0]?.validUntil ?? null;
  useEffect(() => {
    if (!validWindow || validTouched) return;
    const left = offerUntil ? Math.ceil((new Date(offerUntil).getTime() - clock.now) / validUnitMs) : 0;
    setValidCount(String(left >= 1 ? Math.min(left, validWindow.max) : validWindow.max));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [validWindow?.mode, validWindow?.max, offerUntil, validTouched]);
  const validNumber = (() => {
    const n = Number(validCount);
    return validWindow && validCount !== "" && Number.isInteger(n) && n >= 1 ? Math.min(n, maxValid) : null;
  })();
  const validityEnd = validNumber == null ? null : clock.now + validNumber * validUnitMs;
  const validityBody = () => (validNumber == null ? {} : inHours ? { validHours: validNumber } : { validDays: validNumber });

  // What is typed and not saved stays with the booking, whichever view it was typed in.
  const firstWrite = useRef(true);
  useEffect(() => {
    if (firstWrite.current) {
      firstWrite.current = false;
      return;
    }
    try {
      if (!discountMoved && !validTouched) localStorage.removeItem(extraKey);
      else localStorage.setItem(extraKey, JSON.stringify({ v: 1, basis: persistBasis, discountValue, discountUnit, valid: validTouched ? validCount : null } satisfies StoredExtra));
    } catch {
      /* non-fatal — the edits just won't survive navigation */
    }
  }, [discountMoved, validTouched, discountValue, discountUnit, validCount, persistBasis, extraKey]);

  const createBody = () => ({
    ...validityBody(),
    requestedDiscount: discountPayload ?? undefined,
    roomCompositions: roomCompositions.length > 0 ? roomCompositions : undefined,
  });
  const supersedeBody = () => ({
    ...validityBody(),
    requestedDiscount: discountPayload ?? (recordedDiscount ? null : undefined),
    roomCompositions: roomCompositions.length > 0 ? roomCompositions : undefined,
  });
  /** Saving the table IS pricing it: a first quotation, or the next version of the one on file. */
  const save = () => (working ? supersedeQuotation(session!, working.id, supersedeBody()) : createQuotation(session!, entry.id, createBody()));

  const tableOpen = editable && !accepted && !proformaLocked && !!sealedPreferred;

  return {
    editable,
    passes,
    passId,
    quotations,
    accepted,
    working,
    shown,
    persistBasis,
    seedCompositions,
    pricedCompositions,
    sealedPreferred,
    sealedRoomIds,
    beds,
    anchorRoomId,
    bookingRooms,
    tableFaults,
    setTableFaults,
    roomDates,
    proformaLocked,
    roomCompositions,
    setRoomCompositions,
    discountValue,
    setDiscountValue,
    discountUnit,
    setDiscountUnit,
    recordedDiscount,
    discountPayload,
    discountForPreview,
    tableUnsaved,
    validWindow,
    inHours,
    validUnit,
    maxValid,
    validCount,
    validTouched,
    setValidTouched,
    changeValid,
    validNumber,
    validityEnd,
    tz: clock.tz,
    createBody,
    supersedeBody,
    save,
    tableOpen,
  };
}

export type StayTable = ReturnType<typeof useStayTable>;

/** How long a stay's quote stands, in a small button: the table of several stays keeps its band to one line. */
export function ValidityChip({ t }: { t: StayTable }) {
  const [open, setOpen] = useState(false);
  const end = t.validNumber == null ? null : fmtDateTime(t.validityEnd, t.tz).split(",")[0];
  return (
    <>
      <button
        type="button"
        className={`rct-mini-btn${end ? "" : " bad"}`}
        title="How long the guest has to accept this stay's price"
        onClick={() => setOpen(true)}
      >
        {end ? `Valid to ${end}` : "Set validity"}
      </button>
      <DsDialog
        open={open}
        onClose={() => setOpen(false)}
        title="How long the quote is valid"
        footer={
          <Button kind="quiet" onClick={() => setOpen(false)}>
            Done
          </Button>
        }
      >
        <div className="desk-root">
          <QuoteValidityField t={t} />
        </div>
      </DsDialog>
    </>
  );
}

/**
 * A field that reads as one (2026-10-12, operator: "valid for 2 days doesn't seem like something that
 * can be edited at first glance"): a bordered box with − and +, the end date it gives beside it, and
 * the rule behind a "?".
 */
export function QuoteValidityField({ t }: { t: StayTable }) {
  const { editable, validWindow, validNumber, validUnit, maxValid, validCount, changeValid, inHours, validityEnd, tz } = t;
  return (
    <div className="rct-valid">
      <span className="lbl">Quote valid for</span>
      <span className={`stepper${validNumber == null ? " bad" : ""}`}>
        <button
          type="button"
          aria-label={`One ${validUnit} less`}
          disabled={!editable || validNumber == null || validNumber <= 1}
          onClick={() => changeValid(String(Math.max(1, (validNumber ?? 2) - 1)))}
        >
          −
        </button>
        <input
          inputMode="numeric"
          aria-label={`Quote valid for, in ${validUnit}s`}
          value={validCount}
          readOnly={!editable || !validWindow}
          onChange={(e) => {
            const v = e.target.value.replace(/\D/g, "");
            changeValid(v !== "" && Number(v) > maxValid ? String(maxValid) : v);
          }}
        />
        <span className="unit">{validNumber === 1 ? validUnit : `${validUnit}s`}</span>
        <button
          type="button"
          aria-label={`One ${validUnit} more`}
          disabled={!editable || (validNumber ?? maxValid) >= maxValid}
          onClick={() => changeValid(String(Math.min(maxValid, (validNumber ?? 0) + 1)))}
        >
          +
        </button>
      </span>
      <span className={`until${validWindow && validNumber == null ? " stop-ink" : ""}`}>
        {!validWindow ? null : validNumber == null ? (
          `Enter 1 to ${maxValid}`
        ) : (
          <>
            until <b>{fmtDateTime(validityEnd, tz)}</b>
          </>
        )}
      </span>
      <Help label="About how long the quote is valid">
        <p>How long the guest has to accept this price. The time starts when the table is saved. Sending the quote later does not restart it.</p>
        <p>
          {inHours
            ? `Check-in is today, so it is set in hours, up to ${plural(maxValid, "hour")}: the rest of today.`
            : `It runs up to check-in, ${plural(maxValid, "day")} from today. It can be made shorter, not longer.`}
        </p>
      </Help>
    </div>
  );
}
