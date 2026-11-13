"use client";

/**
 * The Package sub-tab of Charges & payments (2026-11-05, operator: "when a travel agent or anything
 * is chosen, they have their package rate right, on the right panel the tab can be switched to charges
 * and add a new sub tab and name it as package, there you can show the package in tabular form").
 *
 * Every figure is the server's (`GET /lookups/rate-sheet`, which asks the resolvers the quotation asks);
 * nothing is worked out here. On a booking at Inquiry the caller card publishes what it holds before it
 * is saved, so the sheet follows a tick or a pick at once, as The price follows the picks.
 */
import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useSession } from "@/hooks/use-session";
import { getRateSheet, type RateSheet } from "@/lib/api/inquiries";
import { money } from "@/lib/ds/format";
import type { EntryDetail } from "@/types/api";
import { StepCard, SubTabs } from "@/components/ds/steps/kit";

export type RateChoice = {
  travelAgentId?: string | null;
  corporateAccountId?: string | null;
  ratePackageId?: string | null;
  /** Every package chosen, the primary first (2026-11-13): one sub-tab each. */
  ratePackageIds?: string[] | null;
};

const MEAL_WORD: Record<RateSheet["meals"][number]["key"], string> = { breakfast: "Breakfast", lunch: "Lunch", dinner: "Dinner" };
const PLAN_WORD: Record<RateSheet["plans"][number]["key"], string> = {
  cp: "CP · breakfast",
  mapLunch: "MAP · breakfast and lunch",
  mapDinner: "MAP · breakfast and dinner",
  ap: "AP · all meals",
};

const choiceKey = (entryId: string) => ["rate-choice", entryId] as const;

/** A caller card with a change not saved says what it holds. Null when it matches what is on record. */
export function usePublishRateChoice(entryId: string, choice: RateChoice | null) {
  const qc = useQueryClient();
  const key = choice ? JSON.stringify(choice) : "";
  useEffect(() => {
    qc.setQueryData(choiceKey(entryId), choice);
    return () => {
      qc.setQueryData(choiceKey(entryId), null);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entryId, key]);
}

function Row({ label, rate, withTax, blank, currency, note }: { label: string; rate: string | null; withTax: string | null; blank: string; currency: string; note?: string | null }) {
  return (
    <tr>
      <td>
        {label}
        {note ? <span className="rate-sheet-note">{note}</span> : null}
      </td>
      {rate == null ? (
        <td colSpan={2} className="rate-sheet-blank">
          {blank}
        </td>
      ) : (
        <>
          <td className="num">{money(rate, currency)}</td>
          <td className="num">{money(withTax, currency)}</td>
        </>
      )}
    </tr>
  );
}

function SheetTable({ sheet }: { sheet: RateSheet }) {
  const cur = sheet.currency;
  // A blank on a package is what was agreed: nothing. On the house's own list it is simply not set.
  const blank = sheet.source === "PUBLISHED" || sheet.source === "NO_PACKAGE" ? "not set · no charge" : "none agreed · no charge";
  const taxWord = `With SC ${sheet.serviceChargePercent}% + GST ${sheet.gstPercent}%`;
  return (
    <div className="rate-sheet-wrap">
      <table className="rate-sheet">
        <thead>
          <tr>
            <th scope="col">Rooms, a night</th>
            <th scope="col" className="num">
              Rate
            </th>
            <th scope="col" className="num">
              {taxWord}
            </th>
          </tr>
        </thead>
        <tbody>
          {sheet.rooms.map((r) => (
            <Row key={r.roomTypeId} label={r.name} rate={r.rate} withTax={r.withTax} blank="no rate set" currency={cur} />
          ))}
        </tbody>
        <tbody>
          <tr className="grp">
            <th scope="colgroup" colSpan={3}>
              Extra bed, a night
            </th>
          </tr>
          <Row label="Extra bed" rate={sheet.extraBed.rate} withTax={sheet.extraBed.withTax} blank={blank} currency={cur} />
        </tbody>
        <tbody>
          <tr className="grp">
            <th scope="colgroup" colSpan={3}>
              Meals, a guest
            </th>
          </tr>
          {sheet.meals.map((m) => (
            <Row key={m.key} label={MEAL_WORD[m.key]} rate={m.rate} withTax={m.withTax} blank={blank} currency={cur} />
          ))}
        </tbody>
        <tbody>
          <tr className="grp">
            <th scope="colgroup" colSpan={3}>
              Meal plans, a guest a night
            </th>
          </tr>
          {sheet.plans.map((p) => (
            <Row
              key={p.key}
              label={PLAN_WORD[p.key]}
              rate={p.rate}
              withTax={p.withTax}
              blank={blank}
              currency={cur}
              note={p.fromMeals ? "what its meals add up to" : p.mealsAddUpTo ? `its meals add up to ${money(p.mealsAddUpTo, cur)}` : null}
            />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function sourceWords(sheet: RateSheet, notSaved: boolean) {
  const party = sheet.party?.name;
  return (
    <>
      {sheet.source === "PACKAGE" ? (
        <>
          <b>{sheet.packageName}</b> · {party}&rsquo;s package
        </>
      ) : sheet.source === "COMMON" ? (
        <>
          <b>The hotel&rsquo;s common package</b>
          {party ? <> · {party} has none of its own</> : null}
        </>
      ) : sheet.source === "NO_PACKAGE" ? (
        <>
          <b>Published rates</b> · {party} has no package, and the hotel has no common one
        </>
      ) : (
        <b>Published rates and the house tariff</b>
      )}
      {notSaved ? <span className="warn-ink"> · not saved yet</span> : null}
    </>
  );
}

/**
 * The card itself, for a choice as it stands: a new inquiry's, or a booking's. With several packages
 * chosen (2026-11-13, operator: "in the right panel under package, it can show sub tabs of package
 * name and their details"), one sub-tab each, named by the package, each with the room types it
 * prices on the booking.
 */
export function RateSheetCard({
  choice,
  checkIn,
  checkOut,
  notSaved = false,
  typesOn,
}: {
  choice: RateChoice;
  checkIn?: string | null;
  checkOut?: string | null;
  notSaved?: boolean;
  /** On a booking: the room types each package prices, by package id ("rest" = the primary's others). */
  typesOn?: (packageId: string, sheet: RateSheet) => string | null;
}) {
  const ids = choice.ratePackageIds ?? [];
  const [open, setOpen] = useState<string | null>(null);
  if (ids.length < 2) return <OneRateSheet choice={choice} checkIn={checkIn} checkOut={checkOut} notSaved={notSaved} typesOn={typesOn} />;
  return (
    <PackageTabs
      ids={ids}
      choice={choice}
      open={open && ids.includes(open) ? open : ids[0]}
      onOpen={setOpen}
      checkIn={checkIn}
      checkOut={checkOut}
      notSaved={notSaved}
      typesOn={typesOn}
    />
  );
}

/** One sub-tab per package, its name read from its own sheet. */
function PackageTabs({
  ids,
  choice,
  open,
  onOpen,
  checkIn,
  checkOut,
  notSaved,
  typesOn,
}: {
  ids: string[];
  choice: RateChoice;
  open: string;
  onOpen: (id: string) => void;
  checkIn?: string | null;
  checkOut?: string | null;
  notSaved: boolean;
  typesOn?: (packageId: string, sheet: RateSheet) => string | null;
}) {
  const { session } = useSession();
  const qc = useQueryClient();
  const nameOf = (id: string) => {
    const s = qc.getQueryData<RateSheet>(sheetKey({ ...choice, ratePackageId: id }, checkIn, checkOut));
    return s?.packageName ?? "Package";
  };
  // The names need the sheets; reading them here keeps the tab labels right on the first draw.
  useQuery({
    queryKey: ["rate-sheet-names", ids.join(","), choice.travelAgentId ?? null, choice.corporateAccountId ?? null, checkIn ?? null, checkOut ?? null],
    queryFn: async () => {
      await Promise.all(
        ids.map((id) =>
          qc.fetchQuery({
            queryKey: sheetKey({ ...choice, ratePackageId: id }, checkIn, checkOut),
            queryFn: () => getRateSheet(session!, { ...choice, ratePackageId: id, checkIn, checkOut }),
            staleTime: 30_000,
          }),
        ),
      );
      return true;
    },
    enabled: !!session,
    staleTime: 30_000,
  });
  return (
    <SubTabs
      label="The rate packages"
      value={open}
      onPick={onOpen}
      tabs={ids.map((id, i) => ({
        key: id,
        label: `${nameOf(id)}${i === 0 ? " · first" : ""}`,
        content: <OneRateSheet choice={{ ...choice, ratePackageId: id }} checkIn={checkIn} checkOut={checkOut} notSaved={notSaved} typesOn={typesOn} />,
      }))}
    />
  );
}

const sheetKey = (choice: RateChoice, checkIn?: string | null, checkOut?: string | null) =>
  ["rate-sheet", choice.travelAgentId ?? null, choice.corporateAccountId ?? null, choice.ratePackageId ?? null, checkIn ?? null, checkOut ?? null] as const;

function OneRateSheet({
  choice,
  checkIn,
  checkOut,
  notSaved = false,
  typesOn,
}: {
  choice: RateChoice;
  checkIn?: string | null;
  checkOut?: string | null;
  notSaved?: boolean;
  typesOn?: (packageId: string, sheet: RateSheet) => string | null;
}) {
  const { session } = useSession();
  const q = useQuery({
    queryKey: sheetKey(choice, checkIn, checkOut),
    queryFn: () => getRateSheet(session!, { ...choice, checkIn, checkOut }),
    enabled: !!session,
    staleTime: 30_000,
    placeholderData: (prev) => prev,
  });
  const sheet = q.data;
  const on = sheet && typesOn && choice.ratePackageId ? typesOn(choice.ratePackageId, sheet) : null;
  return (
    <StepCard
      title="Package"
      status={
        sheet ? (
          <>
            {sourceWords(sheet, notSaved)}
            {on ? <span className="rate-sheet-on"> · prices {on}</span> : null}
          </>
        ) : undefined
      }
      meta="What the booking is priced on before anything is agreed at Negotiation. A rate typed on the table there beats these. A guest on a meal plan pays the plan in place of its meals."
    >
      {sheet ? (
        <SheetTable sheet={sheet} />
      ) : q.isError ? (
        <p className="stop-ink">The rates could not be read. Try the tab again.</p>
      ) : (
        <p className="meta">Reading the rates…</p>
      )}
    </StepCard>
  );
}

/** The Package sub-tab on a booking: what the caller card holds, else what is on record. */
export function BookingRateSheet({ entry }: { entry: EntryDetail }) {
  const inq = entry.inquiry;
  const unsaved = useQuery<RateChoice | null>({
    queryKey: choiceKey(entry.id),
    queryFn: () => null,
    enabled: false,
    staleTime: Infinity,
  }).data;
  const onRecord: RateChoice = {
    travelAgentId: inq?.travelAgent?.id ?? inq?.travelAgentId ?? null,
    corporateAccountId: inq?.corporateAccount?.id ?? inq?.corporateAccountId ?? null,
    ratePackageId: inq?.ratePackageId ?? null,
    ratePackageIds: inq?.ratePackageIds?.length ? inq.ratePackageIds : inq?.ratePackageId ? [inq.ratePackageId] : [],
  };
  const chosen = unsaved ?? onRecord;
  /**
   * Which room types each package prices on this stay (2026-11-13): those the stay put on it, and on the
   * first package every other room type. Only said with several packages.
   */
  const byType = (entry.ratePackageByRoomType ?? {}) as Record<string, string>;
  const ids = chosen.ratePackageIds ?? [];
  const typesOn =
    ids.length > 1 && !unsaved
      ? (packageId: string, sheet: RateSheet) => {
          const named = sheet.rooms.filter((r) => byType[r.roomTypeId] === packageId && ids.includes(packageId)).map((r) => r.name);
          if (packageId !== ids[0]) return named.length ? named.join(", ") : "no room type yet";
          const others = Object.keys(byType).filter((t) => ids.includes(byType[t]) && byType[t] !== ids[0]);
          return named.length ? `${named.join(", ")} and every room type not given another` : others.length ? "every room type not given another" : "every room type";
        }
      : undefined;
  return (
    <RateSheetCard
      choice={chosen}
      typesOn={typesOn}
      notSaved={!!unsaved}
      checkIn={entry.checkInDate ? String(entry.checkInDate).slice(0, 10) : null}
      checkOut={entry.checkOutDate ? String(entry.checkOutDate).slice(0, 10) : null}
    />
  );
}
