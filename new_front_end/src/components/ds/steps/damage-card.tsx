"use client";

/**
 * Damage found — the room inspections' damage, and how each is answered (2026-10-26, operator: "I
 * marked room 304 as damaged, yet nothing appeared on S9 while sealing and closing it — nothing to
 * waive or ask for payment for the damage").
 *
 * Each damage is charged (with or without service charge and GST — the desk ticks which), waived
 * (the FOM's, with the reason) or left to decide after departure (Check-out only). The bill is not
 * settled, and the booking does not leave Check-out, while a damage has no answer; the record is
 * not sealed until each is charged or waived. Every figure is the server's; the backend says which
 * answers are open and whose they are.
 */

import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Button, Chip } from "@/design-system";
import { Help } from "@/components/ds/help";
import { useBookingDamages } from "@/hooks/use-booking-damages";
import { useHotelClock } from "@/hooks/use-hotel-clock";
import { useSession } from "@/hooks/use-session";
import { answerDamage, previewDamageCharge, type BookingDamage, type BookingDamages, type DamageWay } from "@/lib/api/damages";
import { fmtDateTime, money } from "@/lib/ds/format";
import type { EntryDetail } from "@/types/api";
import { DsDialog, NotNow, ReasonDialog, StepCard, atLeast, toastRefusal, useRefreshEntry } from "./kit";

function roomWords(numbers: string[]) {
  if (numbers.length === 1) return `Room ${numbers[0]}`;
  return `Rooms ${numbers.slice(0, -1).join(", ")} and ${numbers[numbers.length - 1]}`;
}

function taxWords(c: { withServiceCharge: boolean; withGst: boolean }) {
  if (c.withServiceCharge && c.withGst) return "with service charge and GST";
  if (c.withServiceCharge) return "with service charge, no GST";
  if (c.withGst) return "with GST, no service charge";
  return "no service charge or GST";
}

const pct = (r: number) => `${(r * 100).toFixed(r * 100 === Math.round(r * 100) ? 0 : 2)}%`;

/** What a way says when it is shut to this person: the backend's reason, or whose it is. */
function shutWhy(way: DamageWay, fom: boolean, whose: string): string | undefined {
  if (!way.open) return way.why ?? "not open here";
  if (way.level === "L2" && !fom) return whose;
  return undefined;
}

export function DamageCard({ entry, live, atClosed = false }: { entry: EntryDetail; live: boolean; atClosed?: boolean }) {
  const q = useBookingDamages(entry);
  const data = q.data;
  if (!data || !data.damages.length) return null;
  const unanswered = data.damages.filter((d) => !d.answer).map((d) => d.roomNumber);
  const undecided = data.damages.filter((d) => d.answer !== "CHARGED" && d.answer !== "WAIVED").map((d) => d.roomNumber);
  const status = unanswered.length ? (
    <span className="stop-ink">
      {roomWords(unanswered)} — the damage needs an answer {atClosed ? "before the record is sealed" : "before the bill is settled"}
    </span>
  ) : undecided.length ? (
    <span className="warn-ink">{roomWords(undecided)} — to charge or waive before the record is sealed</span>
  ) : (
    <span className="ok-ink">Every damage charged or waived</span>
  );
  return (
    <StepCard
      flow="damage"
      title={data.damages.length > 1 ? "Damage found" : `Damage found in Room ${data.damages[0].roomNumber}`}
      meta="What the room inspections found damaged. Charge it to the bill — with or without service charge and GST — waive it, or decide after departure."
      status={status}
    >
      <div className="dmg-list">
        {data.damages.map((d) => (
          <DamageRow key={d.inspectionId} entry={entry} data={data} d={d} live={live} />
        ))}
      </div>
    </StepCard>
  );
}

function DamageRow({ entry, data, d, live }: { entry: EntryDetail; data: BookingDamages; d: BookingDamage; live: boolean }) {
  const { session } = useSession();
  const { tz } = useHotelClock(60_000);
  const fom = atLeast(session?.actorLevel, "L2");
  const qc = useQueryClient();
  const refresh = useRefreshEntry(entry.id);
  const [open, setOpen] = useState<null | "charge" | "waive" | "later">(null);
  const decided = d.answer === "CHARGED" || d.answer === "WAIVED";
  const after = () => {
    setOpen(null);
    void qc.invalidateQueries({ queryKey: ["damages", entry.id] });
    void qc.invalidateQueries({ queryKey: ["billing-summary", entry.id] });
    refresh();
  };
  const settle = useMutation({
    mutationFn: (body: Parameters<typeof answerDamage>[3]) => answerDamage(session!, entry.id, d.inspectionId, body),
    onSuccess: (_r, body) => {
      toast.success(
        body.answer === "CHARGE"
          ? `Room ${d.roomNumber}'s damage is on the bill`
          : body.answer === "WAIVE"
            ? `Room ${d.roomNumber}'s damage is waived`
            : `Room ${d.roomNumber}'s damage is left to decide after departure`,
      );
      after();
    },
    onError: (e) => toastRefusal(e, `Room ${d.roomNumber}'s damage could not be answered`),
  });

  const state =
    d.answer === "CHARGED" ? (
      <span className="ok-ink">
        <b>Charged{d.charge ? ` ${money(d.charge.amount)}` : ""}</b>
        {d.charge ? ` · ${taxWords(d.charge)}` : ""}
      </span>
    ) : d.answer === "WAIVED" ? (
      <span className="ok-ink">
        <b>Waived</b>
        {d.answerNote ? ` — ${d.answerNote}` : ""}
      </span>
    ) : d.answer === "LATER" ? (
      <span className="warn-ink">
        <b>Decide after departure</b>
        {d.answerNote ? ` — ${d.answerNote}` : ""}
      </span>
    ) : (
      <span className="stop-ink">
        <b>Needs an answer</b>
      </span>
    );

  const chargeWhy = shutWhy(data.ways.charge, fom, "A charge after departure is the FOM's");
  const waiveWhy = shutWhy(data.ways.waive, fom, "Waiving a damage is the FOM's — it gives up the charge");
  const laterOpen = data.ways.later.open && !d.answer;

  return (
    <div className={`dmg-row${d.answer ? "" : " todo"}`}>
      <div className="dmg-what">
        <b>Room {d.roomNumber}</b>
        <span>{d.damageNotes ?? "damage noted"}</span>
        <span className="meta">
          found {fmtDateTime(d.inspectedAt, tz)}
          {d.faultId ? " · out of service — a fault report was raised" : ""}
        </span>
      </div>
      <div className="dmg-state">{state}</div>
      {live && !decided ? (
        <div className="row-acts dmg-acts">
          <Button kind="primary" compact state={chargeWhy ? "inert" : "default"} reason={chargeWhy} onClick={() => setOpen("charge")}>
            Charge it…
          </Button>
          <Button kind="secondary" compact state={waiveWhy ? "inert" : "default"} reason={waiveWhy} onClick={() => setOpen("waive")}>
            Waive it…
          </Button>
          {laterOpen ? (
            <Button kind="quiet" compact onClick={() => setOpen("later")}>
              Decide after departure…
            </Button>
          ) : null}
        </div>
      ) : null}

      {open === "charge" ? (
        <ChargeDamageDialog
          entry={entry}
          d={d}
          rates={data.rates}
          busy={settle.isPending}
          onClose={() => setOpen(null)}
          onConfirm={(body) => settle.mutate({ answer: "CHARGE", ...body })}
        />
      ) : null}
      <ReasonDialog
        open={open === "waive"}
        onClose={() => setOpen(null)}
        title={`Waive Room ${d.roomNumber}'s damage`}
        caseLines={[d.damageNotes ?? "damage noted"]}
        lead="Nothing is charged for it. The reason is kept on the booking."
        reasonLabel="Why it is waived"
        placeholder="e.g. wear and tear, not the guest's doing"
        confirmLabel="Waive it"
        busy={settle.isPending}
        onConfirm={(note) => settle.mutate({ answer: "WAIVE", note })}
      />
      <ReasonDialog
        open={open === "later"}
        onClose={() => setOpen(null)}
        title={`Decide Room ${d.roomNumber}'s damage after departure`}
        caseLines={[d.damageNotes ?? "damage noted"]}
        lead="The bill can be settled and the guest can leave. The damage is charged or waived on the Closed step — the record is not sealed until it is."
        reasonLabel="What was said · optional"
        placeholder="e.g. waiting for the repair quote"
        minLength={0}
        confirmLabel="Decide after departure"
        busy={settle.isPending}
        onConfirm={(note) => settle.mutate({ answer: "LATER", note: note || undefined })}
      />
    </div>
  );
}

function ChargeDamageDialog({
  entry,
  d,
  rates,
  busy,
  onClose,
  onConfirm,
}: {
  entry: EntryDetail;
  d: BookingDamage;
  rates: { serviceChargeRate: number; gstRate: number };
  busy: boolean;
  onClose: () => void;
  onConfirm: (body: { amount: number; serviceCharge: boolean; gst: boolean; description?: string; note?: string }) => void;
}) {
  const { session } = useSession();
  const [amount, setAmount] = useState("");
  const [sc, setSc] = useState(false);
  const [gst, setGst] = useState(false);
  const [description, setDescription] = useState("");
  const [note, setNote] = useState("");
  // The figures are the server's, asked a moment after typing stops.
  const [asked, setAsked] = useState<number | null>(null);
  useEffect(() => {
    const n = Number.parseFloat(amount);
    const t = setTimeout(() => setAsked(Number.isFinite(n) && n > 0 ? n : null), 350);
    return () => clearTimeout(t);
  }, [amount]);
  const preview = useQuery({
    queryKey: ["damage-preview", entry.id, asked, sc, gst],
    queryFn: () => previewDamageCharge(session!, entry.id, { amount: asked!, serviceCharge: sc, gst }),
    enabled: asked != null && !!session,
    placeholderData: (prev) => prev,
  });
  const typed = Number.parseFloat(amount);
  const fresh = preview.data && asked === typed && Number(preview.data.amount) === typed;
  const fig = fresh ? preview.data : null;
  const missing = !(Number.isFinite(typed) && typed > 0) ? "type the charge" : !fig ? "working out the figures" : undefined;
  const defaultDescription = `Damage · Room ${d.roomNumber}${d.damageNotes ? ` — ${d.damageNotes}` : ""}`;

  return (
    <DsDialog
      open
      onClose={onClose}
      busy={busy}
      title={`Charge Room ${d.roomNumber}'s damage`}
      caseLines={[d.damageNotes ?? "damage noted"]}
      help="The charge goes on the bill against the room. Tick service charge and GST only when they apply to this charge."
      footer={
        <>
          <NotNow onClick={onClose} busy={busy} />
          <Button
            kind="primary"
            state={busy ? "working" : missing ? "inert" : "default"}
            reason={missing}
            workingLabel="Charging…"
            onClick={() =>
              onConfirm({
                amount: typed,
                serviceCharge: sc,
                gst,
                description: description.trim() || undefined,
                note: note.trim() || undefined,
              })
            }
          >
            {fig ? `Charge ${money(fig.total)}` : "Charge it"}
          </Button>
        </>
      }
    >
      <div style={{ display: "grid", gap: 12 }}>
        <div className="field">
          <label>The charge · before service charge and GST</label>
          <input className="input" inputMode="decimal" autoFocus value={amount} placeholder="e.g. 1500" onChange={(e) => setAmount(e.target.value)} />
        </div>
        <div className="dmg-ticks" role="group" aria-label="Taxes on this charge">
          <label className="sm">
            <input type="checkbox" checked={sc} onChange={(e) => setSc(e.target.checked)} />
            Add service charge ({pct(rates.serviceChargeRate)})
          </label>
          <label className="sm">
            <input type="checkbox" checked={gst} onChange={(e) => setGst(e.target.checked)} />
            Add GST ({pct(rates.gstRate)})
            <Help label="About GST here">GST is worked out on the charge plus any service charge on it.</Help>
          </label>
        </div>
        {fig ? (
          <div className="bill-band" role="group" aria-label="What the guest is charged">
            <div className="bb-cell">
              <span className="bb-k">Charge</span>
              <span className="bb-v money">{money(fig.amount)}</span>
            </div>
            <div className="bb-cell">
              <span className="bb-k">Service charge</span>
              <span className="bb-v money">{sc ? money(fig.serviceCharge) : "none"}</span>
            </div>
            <div className="bb-cell">
              <span className="bb-k">GST</span>
              <span className="bb-v money">{gst ? money(fig.gst) : "none"}</span>
            </div>
            <div className="bb-cell owed">
              <span className="bb-k">On the bill</span>
              <span className="bb-v money">{money(fig.total)}</span>
            </div>
          </div>
        ) : null}
        <div className="field">
          <label>What the bill says · optional</label>
          <input className="input" value={description} maxLength={300} placeholder={defaultDescription} onChange={(e) => setDescription(e.target.value)} />
        </div>
        <div className="field">
          <label>Note · optional</label>
          <input className="input" value={note} maxLength={1000} placeholder="e.g. the guest agreed at the desk" onChange={(e) => setNote(e.target.value)} />
        </div>
      </div>
    </DsDialog>
  );
}

/** The damage card's own words for the to-do and the settle button: the rooms still unanswered. */
export function useUnansweredDamage(entry: EntryDetail | null | undefined, enabled = true) {
  const q = useBookingDamages(entry, enabled);
  const damages = q.data?.damages ?? [];
  return {
    loaded: !!q.data,
    any: damages.length > 0,
    unanswered: damages.filter((d) => !d.answer).map((d) => d.roomNumber),
    undecided: damages.filter((d) => d.answer !== "CHARGED" && d.answer !== "WAIVED").map((d) => d.roomNumber),
  };
}

