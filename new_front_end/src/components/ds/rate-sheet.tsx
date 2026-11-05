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
import { useEffect } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useSession } from "@/hooks/use-session";
import { getRateSheet, type RateSheet } from "@/lib/api/inquiries";
import { money } from "@/lib/ds/format";
import type { EntryDetail } from "@/types/api";
import { StepCard } from "@/components/ds/steps/kit";

export type RateChoice = {
  travelAgentId?: string | null;
  corporateAccountId?: string | null;
  ratePackageId?: string | null;
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

/** The card itself, for a choice as it stands: a new inquiry's, or a booking's. */
export function RateSheetCard({
  choice,
  checkIn,
  checkOut,
  notSaved = false,
}: {
  choice: RateChoice;
  checkIn?: string | null;
  checkOut?: string | null;
  notSaved?: boolean;
}) {
  const { session } = useSession();
  const q = useQuery({
    queryKey: ["rate-sheet", choice.travelAgentId ?? null, choice.corporateAccountId ?? null, choice.ratePackageId ?? null, checkIn ?? null, checkOut ?? null],
    queryFn: () => getRateSheet(session!, { ...choice, checkIn, checkOut }),
    enabled: !!session,
    staleTime: 30_000,
    placeholderData: (prev) => prev,
  });
  const sheet = q.data;
  return (
    <StepCard
      title="Package"
      status={sheet ? sourceWords(sheet, notSaved) : undefined}
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
  };
  return (
    <RateSheetCard
      choice={unsaved ?? onRecord}
      notSaved={!!unsaved}
      checkIn={entry.checkInDate ? String(entry.checkInDate).slice(0, 10) : null}
      checkOut={entry.checkOutDate ? String(entry.checkOutDate).slice(0, 10) : null}
    />
  );
}
