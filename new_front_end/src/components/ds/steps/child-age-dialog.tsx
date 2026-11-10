"use client";

/**
 * A child's age, put right at Arrival or Check-in (2026-11-10, operator: "sometimes the ages are not
 * exactly like how the guest said before so we have to change it … it should notify the user about
 * the hotel's policy … if that room already has 2 adults an extra bed is needed … or move the child
 * to that room along with the meal plan").
 *
 * The server says everything: the hotel's rule for the new age, which way the room can take the
 * child (stay, with an extra bed when they are now a third adult; or move to another room of the
 * booking with their meal plan), and the stay's total after each, its own figures. Changing it walks
 * the booking through the governed re-price, which makes the papers again and holds them.
 */
import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Button } from "@/design-system";
import { useSession } from "@/hooks/use-session";
import { changeChildAge, previewChildAge, type ChildAgeChoice, type ChildAgeMealPlan } from "@/lib/api/entries";
import { money } from "@/lib/ds/format";
import type { EntryDetail } from "@/types/api";
import { Choice, DsDialog, NotNow, toastRefusal, useRefreshEntry } from "./kit";

const PLAN_WORDS: Record<ChildAgeMealPlan, string> = {
  CP: "CP · breakfast",
  MAPL: "MAP+L",
  MAPD: "MAP+D",
  AP: "AP · all meals",
  EP: "Room only",
};

const keyOf = (c: ChildAgeChoice) => (c.kind === "STAY" ? "STAY" : `MOVE:${c.roomId}`);

function changeWords(change: number | null): string | null {
  if (change == null) return null;
  if (Math.abs(change) < 0.005) return "the price stays the same";
  return change > 0 ? `${money(change)} more` : `${money(-change)} less`;
}

export function ChildAgeDialog({
  entry,
  childIndex,
  startAge,
  onClose,
}: {
  entry: EntryDetail;
  childIndex: number;
  /** The age to start on — the recorded one, or the one a date of birth says. */
  startAge: number;
  onClose: () => void;
}) {
  const { session } = useSession();
  const qc = useQueryClient();
  const refresh = useRefreshEntry(entry.id);
  const recorded = (entry.childAges ?? [])[childIndex] ?? startAge;
  const [age, setAge] = useState(startAge);
  const [picked, setPicked] = useState<string | null>(null);
  const [mealPlan, setMealPlan] = useState<ChildAgeMealPlan | null>(null);
  const preview = useQuery({
    queryKey: ["child-age-preview", entry.id, childIndex, age, mealPlan, entry.updatedAt],
    queryFn: () => previewChildAge(session!, entry.id, { childIndex, newAge: age, mealPlan }),
    enabled: !!session && age !== recorded,
    staleTime: 0,
  });
  const pv = age === recorded ? null : preview.data ?? null;
  const choices = pv?.choices ?? [];
  // The first way the room can take them is picked to start; the desk can pick another.
  useEffect(() => {
    if (!choices.length) {
      setPicked(null);
      return;
    }
    if (!picked || !choices.some((c) => keyOf(c) === picked && c.possible)) {
      const first = choices.find((c) => c.possible);
      setPicked(first ? keyOf(first) : null);
    }
  }, [choices, picked]);
  const choice = choices.find((c) => keyOf(c) === picked) ?? null;

  const go = useMutation({
    mutationFn: () =>
      changeChildAge(session!, entry.id, {
        childIndex,
        newAge: age,
        ...(choice ? { placement: choice.kind, toRoomId: choice.kind === "MOVE" ? choice.roomId : null, mealPlan: choice.mealPlan } : {}),
      }),
    onSuccess: (r) => {
      if (r.ageOnly) toast.success(`Child ${childIndex + 1} is now ${r.newAge} — nothing is priced differently`);
      else {
        const stopped = r.walk?.walk?.blocked;
        if (stopped) toast.warning(`Child ${childIndex + 1} is now ${r.newAge}, but the booking stopped at ${stopped.atStep}: ${stopped.message}`, { duration: 10000 });
        else
          toast.success(`Child ${childIndex + 1} is now ${r.newAge}. ${r.choice?.summary ?? ""}`, {
            description: `The stay is now ${r.choice?.totalAfter != null ? money(r.choice.totalAfter) : "priced again"}. The voucher and the proforma were made again — send them from Papers when you are ready.`,
            duration: 9000,
          });
      }
      void qc.invalidateQueries({ queryKey: ["identity-proofs", entry.id] });
      void qc.invalidateQueries({ queryKey: ["party-seating", entry.id] });
      void qc.invalidateQueries({ queryKey: ["held-documents", entry.id] });
      refresh();
      onClose();
    },
    onError: (e) => toastRefusal(e, "The age could not be changed"),
  });

  const ready = age !== recorded && !!pv && !pv.refusal && (pv.ageOnly || (!!choice && choice.possible));
  const adultRate = pv?.newBand === "ADULT";
  const ages = Array.from({ length: 18 }, (_, i) => i);

  return (
    <DsDialog
      open
      onClose={onClose}
      busy={go.isPending}
      closeX
      title={`Child ${childIndex + 1}'s age`}
      caseLines={[entry.id, `Recorded as ${recorded}`]}
      footer={
        <>
          <NotNow onClick={onClose} busy={go.isPending} />
          <Button
            className={ready ? "go" : undefined}
            state={go.isPending ? "working" : ready ? "default" : "inert"}
            title={
              age === recorded
                ? "pick the age they really are"
                : !pv
                  ? "reading what it changes"
                  : pv.refusal ?? (!pv.ageOnly && !choice?.possible ? "pick where they sleep" : undefined)
            }
            workingLabel="Changing…"
            onClick={() => go.mutate()}
          >
            Change the age
          </Button>
        </>
      }
    >
      <div className="field">
        <label>Their age</label>
        <select
          className="input"
          value={age}
          onChange={(e) => {
            setAge(Number(e.target.value));
            setPicked(null);
            setMealPlan(null);
          }}
          style={{ maxWidth: 160 }}
          autoFocus
        >
          {ages.map((a) => (
            <option key={a} value={a}>
              {a} {a === 1 ? "year" : "years"}
              {a === recorded ? " · as recorded" : ""}
            </option>
          ))}
        </select>
      </div>

      {age !== recorded && preview.isLoading ? <p className="sm meta">Reading what it changes…</p> : null}
      {pv?.refusal ? (
        <div role="alert" className="rct-refusal" style={{ margin: "8px 0 0" }}>
          <span className="ic">!</span>
          <span>{pv.refusal}</span>
        </div>
      ) : null}
      {pv && !pv.refusal ? (
        <>
          <div className={`notice ${adultRate ? "age-adult" : "next"}`} role="status" data-age-policy>
            <span>
              {adultRate ? <b>Charged as an adult. </b> : null}
              {pv.policy}
            </span>
          </div>
          {pv.ageOnly ? (
            <p className="sm">Only the age is recorded — nothing is priced differently.</p>
          ) : (
            <>
              {pv.room ? (
                <p className="sm" style={{ marginTop: 0 }}>
                  Child {childIndex + 1} sleeps in <b>Room {pv.room.roomNumber}</b> with {pv.room.guests}
                  {pv.totalBefore != null ? <> · the stay is {money(pv.totalBefore)} now</> : null}.
                </p>
              ) : null}
              <div className="age-choices" role="radiogroup" aria-label="Where they sleep">
                {choices.map((c) => {
                  const on = keyOf(c) === picked;
                  return (
                    <button
                      key={keyOf(c)}
                      type="button"
                      role="radio"
                      aria-checked={on}
                      className={`age-choice${on ? " on" : ""}${c.possible ? "" : " shut"}`}
                      disabled={!c.possible}
                      onClick={() => setPicked(keyOf(c))}
                    >
                      <span className="dot" aria-hidden />
                      <span className="what">
                        <b>{c.summary}</b>
                        {c.possible ? (
                          <span className="sub">
                            {changeWords(c.change)}
                            {c.totalAfter != null ? ` · the stay ${money(c.totalAfter)}` : ""}
                          </span>
                        ) : (
                          <span className="sub why">{c.why}</span>
                        )}
                      </span>
                    </button>
                  );
                })}
              </div>
              {choice?.kind === "MOVE" && pv.mealPlans.length > 1 ? (
                <div className="field" style={{ marginTop: 10 }}>
                  <label>Their meal plan goes with them</label>
                  <Choice
                    options={pv.mealPlans.map((p) => [p, PLAN_WORDS[p]] as const)}
                    value={choice.mealPlan ?? mealPlan}
                    onChange={(p) => setMealPlan(p)}
                  />
                </div>
              ) : null}
              <p className="sm meta" style={{ marginBottom: 0 }}>
                The booking is priced again: a new quotation, and the voucher and the proforma made again and held for you to send or not.
                Nothing goes to the guest.
              </p>
            </>
          )}
        </>
      ) : null}
    </DsDialog>
  );
}
