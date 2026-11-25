"use client";

/**
 * An apartment stay at Inquiry (2026-11-25, operator: "in the stay section show option to choose
 * monthly or weekly plan, when doing that on the right hand side, show the packages of weekly and
 * monthly rate both"; "the house section will only show the room types listed there in the apartment
 * section and also rooms listed there only").
 *
 * - `ApartmentPlanField` — Monthly · Weekly beside the dates; which the stay may take is the server's
 *   (`/lookups/apartment-plans`): monthly for at least a whole month, weekly for at least a week;
 *   under a week, by the night.
 * - `ApartmentHouse` — The house for an apartment stay: the packages and their apartments, free or
 *   taken for the stay, ticked and saved whole (a 2 BHK's rooms together).
 * - `ApartmentRatesCard` — every package's weekly and monthly rate (what the guest pays), and what it
 *   comes to for this stay under each plan. Every figure is the server's.
 */
import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { Button } from "@/design-system";
import { Help } from "@/components/ds/help";
import { StayDates } from "@/components/ds/stay-dates";
import { useSession } from "@/hooks/use-session";
import {
  PLAN_WORD,
  getApartmentPackagesForDates,
  getApartmentPlans,
  getEntryApartments,
  pickApartments,
  type ApartmentPackageForStay,
  type ApartmentPlan,
  type RentForStay,
} from "@/lib/api/apartments";
import { fmtDate, money, plural } from "@/lib/ds/format";
import type { EntryDetail } from "@/types/api";
import { StepCard, toastRefusal, useOpenFileTab, useRefreshEntry, useStepFlow } from "./kit";
import { MakeRoomDialog } from "./s1-apartment-make-room";

const BED: Record<string, string> = { KING: "King", TWIN: "Twin", QUEEN: "Queen", SINGLE: "Single" };

/** Which plans the dates may take — the server's rule. */
export function useApartmentPlans(checkIn: string | null | undefined, checkOut: string | null | undefined) {
  const { session } = useSession();
  return useQuery({
    queryKey: ["lookup", "apartment-plans", checkIn, checkOut],
    queryFn: () => getApartmentPlans(session!, checkIn!, checkOut!),
    enabled: !!session && !!checkIn && !!checkOut && checkOut > checkIn,
    staleTime: 600_000,
  });
}

/** Why the stay cannot be saved with this plan, in words; null when it can. */
export function apartmentPlanProblem(
  plan: ApartmentPlan | "" | null | undefined,
  plans: { monthly: boolean; weekly: boolean; firstMonthEnds: string; nights: number } | null | undefined,
): string | null {
  if (!plans) return null;
  if (!plan) return plans.weekly ? "say how the apartment is let — monthly or weekly" : null;
  if (plan === "MONTHLY" && !plans.monthly) return `under a month — monthly needs the stay to run to ${fmtDate(plans.firstMonthEnds)}`;
  if (plan === "WEEKLY" && !plans.weekly) return "under a week — it is charged by the night";
  return null;
}

/** Monthly · Weekly, each shut with its reason when the dates cannot take it. */
export function ApartmentPlanField({
  checkIn,
  checkOut,
  plan,
  onPlan,
  ro,
}: {
  checkIn: string | null | undefined;
  checkOut: string | null | undefined;
  plan: ApartmentPlan | "" | null;
  onPlan: (p: ApartmentPlan | "") => void;
  ro?: boolean;
}) {
  const q = useApartmentPlans(checkIn, checkOut);
  const plans = q.data ?? null;
  const problem = apartmentPlanProblem(plan, plans);
  const why = (p: ApartmentPlan) =>
    !plans
      ? "Put in the dates first"
      : p === "MONTHLY" && !plans.monthly
        ? `A month runs to the same date the month after — this stay would need to run to ${fmtDate(plans.firstMonthEnds)}`
        : p === "WEEKLY" && !plans.weekly
          ? "Under seven nights is charged by the night"
          : null;
  return (
    <div className="wide field apt-plan">
      <label>
        Let by
        <Help label="How an apartment is let">
          A month runs from the check-in date to the same date the month after; a week is seven nights. Nights left over after the whole months are
          charged as their share of the next month (a month&rsquo;s rate ÷ its nights × the nights left); after whole weeks, a seventh of a week&rsquo;s
          rate a night. Monthly needs at least a whole month, weekly at least a week; a shorter stay is charged by the night at the ordinary rates.
        </Help>
      </label>
      {plans && !plans.weekly ? (
        <span className="hint">
          {plural(plans.nights, "night")} — under a week, so it is charged by the night
          {plan ? (
            <>
              {" "}
              ·{" "}
              <Button kind="quiet" compact state={ro ? "inert" : "default"} onClick={() => onPlan("")}>
                Take {PLAN_WORD[plan as ApartmentPlan].toLowerCase()} off
              </Button>
            </>
          ) : null}
        </span>
      ) : (
        <div className="filters choice">
          {(["MONTHLY", "WEEKLY"] as const).map((p) => {
            const shut = why(p);
            return (
              <Button
                key={p}
                kind={plan === p ? "secondary" : "quiet"}
                compact
                aria-pressed={plan === p}
                state={ro || (shut && plan !== p) ? "inert" : "default"}
                reason={shut ?? undefined}
                title={shut ?? undefined}
                onClick={ro || shut ? undefined : () => onPlan(p)}
              >
                {PLAN_WORD[p]}
              </Button>
            );
          })}
        </div>
      )}
      {problem && plans?.weekly ? <span className={plan ? "hint stop-ink" : "hint warn-ink"}>{problem}</span> : null}
    </div>
  );
}

function RentLines({ rent }: { rent: RentForStay }) {
  return (
    <ul className="apt-periods">
      {rent.periods.map((p) => (
        <li key={p.from}>
          <span>
            <StayDates checkIn={p.from} checkOut={p.to} compact /> {p.whole ? `· a ${rent.plan === "MONTHLY" ? "month" : "week"}` : `· ${p.nights} of ${p.ofNights} nights`}
          </span>
          <b>{money(p.total)}</b>
        </li>
      ))}
    </ul>
  );
}

/** Every package's rates, and what each comes to for the stay under each plan. */
export function ApartmentRatesList({ packages, plan, nights }: { packages: ApartmentPackageForStay[]; plan: ApartmentPlan | "" | null; nights: number | null }) {
  const [open, setOpen] = useState<string | null>(null);
  return (
    <div className="apt-rates-list">
      {packages.map((p) => {
        const forPlan = plan && p.forStay ? p.forStay[plan] : null;
        return (
          <div key={p.id} className="apt-rate">
            <div className="apt-rate-head">
              <b>{p.name}</b>
              {p.carpetAreaSqft ? <span className="meta">{p.carpetAreaSqft.toLocaleString("en-GB")} sq ft</span> : null}
              {p.units ? <span className="meta">{plural(p.units.length, "apartment")}</span> : null}
            </div>
            <table className="apt-rate-table">
              <tbody>
                <tr className={plan === "WEEKLY" ? "on" : undefined}>
                  <td>A week</td>
                  <td className="num">{money(p.weekly.total)}</td>
                  <td className="num">{p.forStay?.WEEKLY ? <>this stay {money(p.forStay.WEEKLY.total)}</> : nights != null ? <span className="meta">—</span> : null}</td>
                </tr>
                <tr className={plan === "MONTHLY" ? "on" : undefined}>
                  <td>A month</td>
                  <td className="num">{money(p.monthly.total)}</td>
                  <td className="num">{p.forStay?.MONTHLY ? <>this stay {money(p.forStay.MONTHLY.total)}</> : nights != null ? <span className="meta">—</span> : null}</td>
                </tr>
              </tbody>
            </table>
            {forPlan ? (
              <Button kind="quiet" compact onClick={() => setOpen((x) => (x === p.id ? null : p.id))}>
                {open === p.id ? "Hide" : "Show"} the {plural(forPlan.periods.length, "period")}
              </Button>
            ) : null}
            {forPlan && open === p.id ? <RentLines rent={forPlan} /> : null}
          </div>
        );
      })}
    </div>
  );
}

function ratesNote(nights: number | null, plan: ApartmentPlan | "" | null) {
  if (nights == null) return "Put in the dates to see what the stay comes to";
  if (nights < 7) return `${plural(nights, "night")} — under a week, charged by the night`;
  return plan ? `Let ${PLAN_WORD[plan as ApartmentPlan].toLowerCase()} · ${plural(nights, "night")}` : `${plural(nights, "night")} · say how it is let in The stay`;
}

/** The booking file's Apartments: what is offered, for this booking's stay. */
export function EntryApartmentRates({ entry }: { entry: EntryDetail }) {
  const { session } = useSession();
  const q = useQuery({
    queryKey: ["entry-apartments", entry.id, entry.version],
    queryFn: () => getEntryApartments(session!, entry.id),
    enabled: !!session,
    placeholderData: (prev) => prev,
  });
  const d = q.data;
  return (
    <StepCard
      title="Apartments"
      status={<span>{ratesNote(d?.stay?.nights ?? null, d?.plan ?? null)}</span>}
      meta="Each package's rate for a week and for a month, as the guest pays them (service charge and GST in), and what each comes to for this stay."
    >
      {q.isError ? <p className="stop-ink">The apartments could not be read</p> : null}
      {d ? <ApartmentRatesList packages={d.packages} plan={d.plan} nights={d.stay?.nights ?? null} /> : <p className="meta">Reading the apartments…</p>}
    </StepCard>
  );
}

/** The new inquiry's Apartments: no booking yet, so the dates typed. */
export function IntakeApartmentRates({ checkIn, checkOut, plan }: { checkIn: string; checkOut: string; plan: ApartmentPlan | "" }) {
  const { session } = useSession();
  const q = useQuery({
    queryKey: ["lookup", "apartment-packages", checkIn, checkOut],
    queryFn: () => getApartmentPackagesForDates(session!, checkIn, checkOut),
    enabled: !!session,
    placeholderData: (prev) => prev,
  });
  const d = q.data;
  return (
    <StepCard
      title="Apartments"
      status={<span>{ratesNote(d?.stay?.nights ?? null, plan)}</span>}
      meta="Each package's rate for a week and for a month, as the guest pays them (service charge and GST in), and what each comes to for these dates."
    >
      {d ? <ApartmentRatesList packages={d.packages} plan={plan} nights={d.stay?.nights ?? null} /> : <p className="meta">Reading the apartments…</p>}
    </StepCard>
  );
}

/** The house for an apartment stay: whole apartments, free or taken for the stay, ticked and saved. */
export function ApartmentHouse({ entry, editable }: { entry: EntryDetail; editable: boolean }) {
  const { session } = useSession();
  const refresh = useRefreshEntry(entry.id);
  const flow = useStepFlow();
  const openFile = useOpenFileTab();
  const q = useQuery({
    queryKey: ["entry-apartments", entry.id, entry.version],
    queryFn: () => getEntryApartments(session!, entry.id),
    enabled: !!session && !!entry.checkInDate,
    placeholderData: (prev) => prev,
  });
  const d = q.data;
  const savedIds = useMemo(() => new Set((d?.packages ?? []).flatMap((p) => p.units.filter((u) => u.picked).map((u) => u.id))), [d]);
  const [ticked, setTicked] = useState<Set<string>>(new Set());
  /** The taken apartment the desk is making room in (2026-11-25). */
  const [makeRoom, setMakeRoom] = useState<{ unitId: string; label: string } | null>(null);
  const savedKey = [...savedIds].sort().join(",");
  useEffect(() => setTicked(new Set(savedIds)), [savedKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const changed = [...ticked].sort().join(",") !== savedKey;
  const units = (d?.packages ?? []).flatMap((p) => p.units.map((u) => ({ ...u, packageName: p.name })));
  const room = units.filter((u) => ticked.has(u.id)).reduce((n, u) => n + u.maxOccupants, 0);
  const guests = d?.guests ?? 0;
  const why = !ticked.size
    ? "Tick the apartments"
    : guests > room
      ? `${plural(ticked.size, "apartment")} take at most ${plural(room, "guest")}; this booking has ${guests}`
      : !changed
        ? "Saved"
        : null;

  const save = useMutation({
    mutationFn: () => pickApartments(session!, entry.id, [...ticked]),
    onSuccess: (r) => {
      toast.success(`${r.apartments.length === 1 ? `Apartment ${r.apartments[0]}` : `Apartments ${r.apartments.join(", ")}`} chosen`, {
        description: `Rooms ${r.rooms.join(", ")}, every night of the stay`,
      });
      refresh();
      flow.done("house", { next: "wrap" });
    },
    onError: (e) => toastRefusal(e, "The apartments could not be saved"),
  });

  const pickedLabels = units.filter((u) => savedIds.has(u.id)).map((u) => u.label);
  return (
    <StepCard
      flow="house"
      flowAfter="stay"
      flowAfterOnly
      revealAtTop
      title={
        <>
          The apartments{entry.checkInDate ? <> · <StayDates checkIn={entry.checkInDate} checkOut={entry.checkOutDate} /></> : null}
        </>
      }
      meta="The apartments on the admin console, free or taken for these dates. An apartment of several rooms is let whole."
      status={
        d?.plan ? (
          <span>
            Let {PLAN_WORD[d.plan].toLowerCase()} · {plural(guests, "guest")}
          </span>
        ) : d?.stay && d.stay.nights < 7 ? (
          <span>Under a week — charged by the night · {plural(guests, "guest")}</span>
        ) : (
          <span className="warn-ink">Say how the apartment is let in The stay</span>
        )
      }
      summary={pickedLabels.length ? <b>{pickedLabels.length === 1 ? `Apartment ${pickedLabels[0]}` : `Apartments ${pickedLabels.join(", ")}`}</b> : <b>no apartment chosen</b>}
      noDoneBar
    >
      {!entry.checkInDate ? <p className="meta">Put in the stay&rsquo;s dates first.</p> : null}
      {q.isError ? <p className="stop-ink">The apartments could not be read</p> : null}
      {d ? (
        <div className="apt-house">
          {/* The same table as the normal house (2026-11-25, operator: "can this be shown properly like how
              it was shown in normal ones"): a header with the count, each package named once beside its
              apartments, and the free / taken chips the room types carry. */}
          <div className="bt-scroll">
            <table className="table compact house-types by-type-grid apt-grid">
              <thead>
                <tr>
                  <th className="bt-typeh">
                    Package
                    <Help label="About the apartments">
                      The apartments on the admin console, free or taken for the whole stay. An apartment of several rooms is let
                      whole. What the stay comes to is the rent with service charge and GST, for how the apartment is let.
                    </Help>
                  </th>
                  <th>Apartment</th>
                  <th>Rooms</th>
                  <th className="num">
                    <span className="bt-day">Up to</span>
                    <small className="apt-grid-sub">guests</small>
                  </th>
                  <th className="num">
                    <span className="bt-day">This stay</span>
                    {d.plan ? <small className="apt-grid-sub">{PLAN_WORD[d.plan].toLowerCase()} · with taxes</small> : null}
                  </th>
                  <th className="every">
                    <span className="bt-day">For the stay{d.stay ? ` · ${plural(d.stay.nights, "night")}` : ""}</span>
                    <span className={`bt-tally ${ticked.size && room >= guests ? "done" : "short"}`} title="Guests the apartments ticked can take, of the booking's guests">
                      <span className={`bt-tick${ticked.size && room >= guests ? "" : " off"}`} aria-hidden>
                        ✓
                      </span>
                      {Math.min(room, guests)} of {plural(guests, "guest")}
                    </span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {d.packages.map((p) => {
                  const rent = d.plan && p.forStay ? p.forStay[d.plan] : null;
                  return p.units.map((u, i) => {
                    const on = ticked.has(u.id);
                    const shut = !u.free && !on;
                    const holder = u.takenBy[0];
                    return (
                      <tr key={u.id} className={`${on ? "apt-on" : ""}${i === 0 ? " apt-first" : ""}`}>
                        {i === 0 ? (
                          <td className="bt-type apt-pkg" rowSpan={p.units.length}>
                            {p.name}
                            {p.carpetAreaSqft ? <small>{p.carpetAreaSqft.toLocaleString("en-GB")} sq ft</small> : null}
                          </td>
                        ) : null}
                        <td className="apt-no">{u.label}</td>
                        <td className="apt-rooms">
                          {u.rooms.length > 1 ? `${u.rooms.map((r) => r.roomNumber).join(" + ")} · ` : ""}
                          {u.rooms.map((r) => BED[r.bedType ?? ""] ?? r.roomTypeName).join(" + ")}
                        </td>
                        <td className="num" title={`Up to ${plural(u.maxOccupants, "guest")}`}>
                          {u.maxOccupants}
                        </td>
                        {i === 0 ? (
                          <td className="num apt-rent" rowSpan={p.units.length}>
                            {rent ? <b>{money(rent.total)}</b> : <span className="meta" title="Under a week the apartment is charged by the night">by the night</span>}
                          </td>
                        ) : null}
                        <td>
                          {/* Three fixed slots (2026-11-25, operator: "make room button to be properly aligned
                              always"): the chip, the words (cut with … when long, whole on hover), and the act
                              at the right end, so every row's button lines up. */}
                          <div className={`apt-state${on ? " picked" : ""}`}>
                            {u.free ? (
                              <span className="bt-free plenty">free</span>
                            ) : (
                              <span className="bt-free none">{u.outOfService.length ? "out of service" : "taken"}</span>
                            )}
                            {u.free || on ? (
                              <label className="apt-take">
                                <span className="bt-take">take</span>
                                <input
                                  type="checkbox"
                                  checked={on}
                                  disabled={!editable || shut}
                                  aria-label={`Take apartment ${u.label}`}
                                  onChange={(e) =>
                                    setTicked((s) => {
                                      const n = new Set(s);
                                      if (e.target.checked) n.add(u.id);
                                      else n.delete(u.id);
                                      return n;
                                    })
                                  }
                                />
                              </label>
                            ) : (
                              <span
                                className="apt-held"
                                title={
                                  u.outOfService.length
                                    ? u.outOfService[0]
                                    : holder
                                      ? `${holder.guestName ?? holder.entryId} · ${holder.entryId} · ${fmtDate(holder.from)} – ${fmtDate(holder.to)}`
                                      : undefined
                                }
                              >
                                {u.outOfService.length
                                  ? u.outOfService[0]
                                  : holder
                                    ? `${holder.guestName ?? holder.entryId} · ${fmtDate(holder.from)} – ${fmtDate(holder.to)}`
                                    : null}
                              </span>
                            )}
                            <span className="apt-act">
                              {!u.free && !on && editable && !u.outOfService.length ? (
                                <button type="button" className="apt-make-room" onClick={() => setMakeRoom({ unitId: u.id, label: u.label })}>
                                  Make room
                                </button>
                              ) : null}
                            </span>
                          </div>
                        </td>
                      </tr>
                    );
                  });
                })}
              </tbody>
            </table>
          </div>
          {makeRoom ? <MakeRoomDialog entryId={entry.id} unitId={makeRoom.unitId} label={makeRoom.label} onClose={() => setMakeRoom(null)} /> : null}
          {editable ? (
            <div className="apt-house-save">
              {why && why !== "Saved" ? <span className={guests > room && ticked.size ? "stop-ink" : "meta"}>{why}</span> : null}
              <Button
                kind="primary"
                className={why ? undefined : "go"}
                state={save.isPending ? "working" : why ? "inert" : "default"}
                reason={why ?? undefined}
                workingLabel="Saving…"
                onClick={() => save.mutate()}
              >
                {why === "Saved" ? "Saved" : "Save the apartments"}
              </Button>
              <Button kind="quiet" compact onClick={() => openFile("money", "package")}>
                Their rates
              </Button>
            </div>
          ) : null}
        </div>
      ) : entry.checkInDate ? (
        <p className="meta">Asking the house…</p>
      ) : null}
    </StepCard>
  );
}
