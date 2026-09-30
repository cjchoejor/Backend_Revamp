"use client";

/**
 * "Change configuration" — the rooms and the party, changed at Negotiation (2026-09-30,
 * operator ruling). Before this, dropping two rooms and two guests after the quote was priced
 * meant a re-entry to Inquiry, which reads to the desk like starting the enquiry again.
 *
 * The screen runs in the order the operator described it: edit the stay, ask the house, then
 * tick and untick the rooms already chosen.
 *
 *   1. The stay — adults, children and their ages, the rooms asked for. EDITABLE (operator:
 *      "this shouldn't be read only, the user can edit the adults, number of room, children
 *      and ages here and then click ask the house").
 *   2. Ask the house — the same search the Inquiry step runs, over the SAME dates.
 *   3. The rooms — the same table, already ticked with what the booking holds today, so the
 *      change is a tick or an untick rather than a fresh pick.
 *
 * DATES ARE NOT HERE, deliberately. A date change moves availability, the quote's validity,
 * the no-show cut-off and the hold window at once, so it stays on the re-entry to Inquiry
 * (operator: "if dates needs to be changed then going back to s1 is mandatory").
 *
 * Everything is sent as ONE governed act — `POST /entries/:id/negotiation-amendment` — so the
 * backend can own the consequences the desk must not invent: retiring the quotations this
 * change makes untrue, and moving the provisional block to the new rooms with its original
 * deadline. Nothing here writes to the booking on its own.
 */
import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { toast } from "sonner";
import { Button } from "@/design-system";
import { useSession } from "@/hooks/use-session";
import {
  queryAvailabilityByEntry,
  roomsFromResultSet,
  type AvailabilityQueryResponse,
} from "@/lib/api/availability";
import { amendNegotiationConfiguration } from "@/lib/api/entries";
import { getAllowedRoomCounts } from "@/lib/api/child-policy";
import { listRooms } from "@/lib/api/rooms";
import { RoomStatusTable, roomStatusRows } from "@/components/desk/workspace/room-status-table";
import { currentPassConfigs } from "@/lib/desk/workspace";
import { fmtRange, plural } from "@/lib/ds/format";
import { optionSelectedRoomIds, type AvailabilityOptionSelected, type EntryDetail } from "@/types/api";
import { Tool, toastRefusal } from "./kit";
import { enumerateNights, useRoomSelection } from "./use-room-selection";

/**
 * A count field that may be emptied while typing — "0" and "" are different answers. A keystroke
 * the field refuses SAYS so ("UIappeal"): a number that silently fails to appear reads as a
 * broken input. The real ceiling for a party is the house's own, which the backend answers with;
 * these caps are only there to stop a typo becoming a 900-guest lookup.
 */
function Count({
  label,
  value,
  onChange,
  min = 0,
  max = 200,
  hint,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  min?: number;
  max?: number;
  hint?: string;
}) {
  const [capped, setCapped] = useState(false);
  return (
    <div className="field">
      <label>{label}</label>
      <input
        className="input"
        inputMode="numeric"
        value={value}
        onChange={(e) => {
          const v = e.target.value.replace(/\D/g, "");
          if (v === "") {
            setCapped(false);
            return onChange("");
          }
          const n = Number(v);
          if (n > max) {
            setCapped(true);
            window.setTimeout(() => setCapped(false), 4000);
            return;
          }
          setCapped(false);
          onChange(String(Math.max(min, n)));
        }}
      />
      {capped ? (
        <span className="hint stop-ink" role="alert">
          at most {max} here
        </span>
      ) : hint ? (
        <span className="hint">{hint}</span>
      ) : null}
    </div>
  );
}

export function ChangeConfiguration({
  entry,
  onClose,
  onDone,
}: {
  entry: EntryDetail;
  onClose: () => void;
  onDone: () => void;
}) {
  const { session } = useSession();

  /* ---- 1. the stay, as the operator may now retype it -------------------------- */
  const [adults, setAdults] = useState(String(entry.adultCount ?? entry.guestCount ?? 1));
  const [children, setChildren] = useState(String(entry.childCount ?? 0));
  const [ages, setAges] = useState<string[]>(() => (entry.childAges ?? []).map(String));
  const [rooms, setRooms] = useState(String(entry.numberOfRooms ?? 1));
  const [reason, setReason] = useState("");

  const childCount = Number(children || "0");
  const adultCount = Number(adults || "0");
  const roomCount = Math.max(1, Number(rooms || "1"));
  const agesReady = ages.slice(0, childCount).every((a) => a !== "" && Number(a) >= 0);
  /** Every age the party needs — the grid grows and shrinks with the count. */
  const ageInputs = useMemo(
    () => Array.from({ length: childCount }, (_, i) => ages[i] ?? ""),
    [childCount, ages],
  );

  /** The house's own envelope for this party — the same lookup the intake screen asks. */
  const envelope = useQuery({
    queryKey: ["allowed-room-counts", adultCount, ageInputs.join(",")],
    queryFn: () =>
      getAllowedRoomCounts(session!, {
        adults: adultCount,
        childAges: ageInputs.filter((a) => a !== "").map(Number),
      }),
    enabled: !!session && adultCount > 0 && agesReady,
    staleTime: 30_000,
  });
  const env = envelope.data;
  /** The house's room-count envelope for this party — `allowedRoomCounts` on the response. */
  const envMin = env?.allowedRoomCounts?.min ?? null;
  const envMax = env?.allowedRoomCounts?.max ?? null;

  /* ---- 2. the house's answer ---------------------------------------------------- */
  const [result, setResult] = useState<AvailabilityQueryResponse | null>(null);
  const ask = useMutation({
    mutationFn: async () => {
      const ci = entry.checkInDate?.slice(0, 10);
      const co = entry.checkOutDate?.slice(0, 10);
      if (!ci || !co) throw new Error("This booking has no dates");
      return queryAvailabilityByEntry(session!, entry.id, {
        checkInDate: ci,
        checkOutDate: co,
        guestCount: adultCount + childCount,
        useType: entry.useType ?? undefined,
      });
    },
    onSuccess: (data) => {
      setResult(data);
      toast.success("The house has answered — tick or untick the rooms below");
    },
    onError: (e) => toastRefusal(e, "The house could not be asked"),
  });

  const catalog =
    useQuery({
      queryKey: ["rooms"],
      queryFn: () => listRooms(session!),
      enabled: !!session,
      staleTime: 60_000,
    }).data?.items ?? [];

  const configId = result?.configurationId ?? null;
  const { available, deficient, unavailable, perDate } = useMemo(() => {
    const src = result?.results ?? null;
    const r = src ? roomsFromResultSet(src) : { availableRooms: [], deficientRooms: [], unavailableRooms: [] };
    return {
      available: r.availableRooms,
      deficient: r.deficientRooms,
      unavailable: r.unavailableRooms,
      perDate: Array.isArray(src?.perDate) ? src.perDate : undefined,
    };
  }, [result]);

  const extBeds = useMemo(
    () => new Map(catalog.filter((r) => typeof r.roomType?.maxExtraBeds === "number").map((r) => [r.id, r.roomType!.maxExtraBeds!])),
    [catalog],
  );
  const bedOf = useMemo(() => new Map(catalog.filter((r) => r.bedType).map((r) => [r.id, r.bedType!])), [catalog]);
  const rows = useMemo(
    () => roomStatusRows(available, deficient, unavailable, extBeds, bedOf),
    [available, deficient, unavailable, extBeds, bedOf],
  );

  const stayNights = useMemo(
    () => enumerateNights(entry.checkInDate, entry.checkOutDate),
    [entry.checkInDate, entry.checkOutDate],
  );
  const displayNights = useMemo(() => (perDate?.length ? perDate.map((p) => p.date) : stayNights), [perDate, stayNights]);

  /* ---- 3. the rooms, seeded from what the booking holds TODAY -------------------- */
  const sealed = currentPassConfigs(entry).find((c) => c.sealedAt && c.optionSelected) ?? null;
  const savedOption = (sealed?.optionSelected ?? null) as AvailabilityOptionSelected | null;
  const priorRoomIds = useMemo(() => optionSelectedRoomIds(savedOption), [savedOption]);
  const sel = useRoomSelection({
    // A key of its own: these picks are the amendment's, and must not overwrite the Inquiry
    // step's in-progress selection stored under the booking's own key.
    entryId: `${entry.id}:amend`,
    numberOfRooms: roomCount,
    savedOption,
    displayNights,
    stayNights,
  });

  /**
   * Lowering the room count leaves more rooms ticked than the booking now asks for. The extra
   * ones are dropped from the END of the pick rather than left over the cap, so the table can
   * never show three ticks under a heading that says one — the operator re-ticks whichever they
   * meant to keep.
   */
  useEffect(() => {
    if (sel.base.length > roomCount) sel.setBase(sel.base.slice(0, roomCount));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roomCount]);

  const roomNo = (id: string) => catalog.find((r) => r.id === id)?.roomNumber ?? id.slice(0, 6);
  const picked = sel.allPicked;
  const dropped = priorRoomIds.filter((id) => !picked.includes(id));
  const added = picked.filter((id) => !priorRoomIds.includes(id));
  const roomsMoved = dropped.length > 0 || added.length > 0;
  const partyMoved =
    adultCount !== (entry.adultCount ?? 0) ||
    childCount !== (entry.childCount ?? 0) ||
    roomCount !== (entry.numberOfRooms ?? 0) ||
    ageInputs.join(",") !== (entry.childAges ?? []).join(",");

  /**
   * Changing the room COUNT without re-picking would leave the booking asking for one room while
   * two are still sealed — the count is the ask, the seal is the pick, and the composition table
   * below prices the seal. So a changed count must be answered with a fresh pick of exactly that
   * many rooms; the save says so rather than writing the two into disagreement.
   */
  const countMoved = roomCount !== priorRoomIds.length;
  const pickComplete = picked.length === roomCount;
  const needsRepick = countMoved && (!configId || !pickComplete);

  const overCapacity = !!env && env.exceedsHotelCapacity;
  const roomsOutOfRange = !!env && envMin != null && envMax != null && (roomCount < envMin || roomCount > envMax);

  const save = useMutation({
    mutationFn: () => {
      const body: Parameters<typeof amendNegotiationConfiguration>[2] = {
        reason: reason.trim(),
        expectedVersion: entry.version,
      };
      if (partyMoved) {
        body.party = {
          adultCount,
          childCount,
          childAges: ageInputs.filter((a) => a !== "").map(Number),
          numberOfRooms: roomCount,
        };
      }
      if (roomsMoved && configId) {
        const p = sel.payload();
        body.rooms = {
          configurationId: configId,
          roomIds: p.perNight ? undefined : p.roomIds,
          perNight: p.perNight,
        };
      }
      return amendNegotiationConfiguration(session!, entry.id, body);
    },
    onSuccess: (o) => {
      toast.success(`The configuration is changed — ${o.summary}`);
      if (o.quotationsInvalidated.length > 0) {
        toast.info(
          `${plural(o.quotationsInvalidated.length, "quotation")} retired — price it again before moving to Set up.`,
        );
      }
      if (o.hold?.action === "REPLACED") toast.info("The provisional block moved to the new rooms, keeping its deadline.");
      if (o.hold?.action === "RELEASED") toast.warning(o.hold.note);
      try {
        localStorage.removeItem(`desk:rst-sel:${entry.id}:amend`);
      } catch {
        /* a blocked store must not break the save */
      }
      onDone();
    },
    onError: (e) => toastRefusal(e, "The configuration could not be changed"),
  });

  const nothingMoved = !partyMoved && !roomsMoved;
  const blocked =
    !reason.trim() ||
    nothingMoved ||
    overCapacity ||
    roomsOutOfRange ||
    needsRepick ||
    !agesReady ||
    adultCount < 1 ||
    (roomsMoved && !configId) ||
    save.isPending;

  return (
    <div className="cfg-change">
      <div className="cfg-head">
        <div>
          <b>Change the rooms and the party</b>
          <div className="meta">
            The dates stay as they are — {fmtRange(entry.checkInDate, entry.checkOutDate)}. To change them, re-enter to
            Inquiry.
          </div>
        </div>
        <Button kind="quiet" compact onClick={onClose}>
          Cancel
        </Button>
      </div>

      {/* 1 ---------------------------------------------------------------- the stay */}
      <section>
        <b className="cfg-n">1 · The stay</b>
        <div className="form2" style={{ marginTop: 8 }}>
          <Count label="Adults" value={adults} onChange={setAdults} min={1} />
          <Count
            label="Children"
            value={children}
            onChange={(v) => {
              setChildren(v);
              const n = Number(v || "0");
              setAges((prev) => Array.from({ length: n }, (_, i) => prev[i] ?? ""));
            }}
          />
          <Count
            label="Rooms"
            value={rooms}
            onChange={setRooms}
            min={1}
            hint={
              envMin != null && envMax != null
                ? envMin === envMax
                  ? `${plural(envMin, "room")} for this party`
                  : `${envMin}–${envMax} rooms fit this party`
                : undefined
            }
          />
          <div className="field">
            <label>Their ages</label>
            {childCount === 0 ? (
              <input className="input" readOnly value="no children" />
            ) : (
              <div className="row-acts" style={{ flexWrap: "wrap" }}>
                {ageInputs.map((a, i) => (
                  <span key={i} className="count-in sm">
                    <input
                      className="input"
                      inputMode="numeric"
                      aria-label={`Child ${i + 1}'s age`}
                      value={a}
                      onChange={(e) => {
                        const v = e.target.value.replace(/\D/g, "").slice(0, 2);
                        setAges((prev) => {
                          const next = [...prev];
                          next[i] = v;
                          return next;
                        });
                      }}
                    />
                    {`child ${i + 1}`}
                  </span>
                ))}
              </div>
            )}
          </div>
        </div>
        {overCapacity && (
          <p className="cfg-stop" role="alert">
            This party cannot be accommodated — the house sleeps {env?.hotelMaxOccupants} across its {env?.hotelRoomCount} rooms.
          </p>
        )}
        {!overCapacity && roomsOutOfRange && env && (
          <p className="cfg-stop" role="alert">
            {roomCount < envMin
              ? `${plural(env.chargeableOccupants, "chargeable guest")} will not fit in ${plural(roomCount, "room")} — ask for at least ${envMin}.`
              : `${plural(roomCount, "room")} is more than this party needs — at most ${envMax}.`}
          </p>
        )}
      </section>

      {/* 2 ---------------------------------------------------------------- the house */}
      <section>
        <b className="cfg-n">2 · Ask the house</b>
        <div className="row-acts" style={{ marginTop: 8 }}>
          <Button kind="secondary" compact onClick={() => ask.mutate()} state={ask.isPending ? "inert" : "default"}>
            {result ? "Ask again" : "Ask the house"}
          </Button>
          <span className="meta">
            {result
              ? `${plural(available.length, "room")} free over these nights`
              : "the same dates, the party above — the free rooms come back below"}
          </span>
        </div>
      </section>

      {/* 3 ---------------------------------------------------------------- the rooms */}
      <section>
        <b className="cfg-n">3 · The rooms</b>
        {!result ? (
          <p className="meta" style={{ marginTop: 6 }}>
            Ask the house first. The rooms this booking holds today —{" "}
            {priorRoomIds.length ? priorRoomIds.map(roomNo).join(", ") : "none"} — come back ticked, so a change is a
            tick or an untick.
          </p>
        ) : (
          <>
            <div className="row-acts" style={{ margin: "8px 0" }}>
              <span className={pickComplete ? "ok-ink" : "stop-ink"} style={{ fontWeight: 700 }}>
                {picked.length} of {plural(roomCount, "room")} chosen
              </span>
              {roomsMoved ? (
                <span className="meta">
                  {dropped.length ? `dropping ${dropped.map(roomNo).join(", ")}` : ""}
                  {dropped.length && added.length ? " · " : ""}
                  {added.length ? `adding ${added.map(roomNo).join(", ")}` : ""}
                </span>
              ) : (
                <span className="meta">the same rooms as now</span>
              )}
            </div>
            <Tool>
              <RoomStatusTable
                rows={rows}
                nights={displayNights}
                perDate={perDate}
                selectedIds={sel.base}
                perNightSel={sel.effectiveByNight}
                referenceIds={sel.commonPlan}
                maxSelect={roomCount}
                onToggle={sel.toggleRow}
                onToggleCell={sel.toggleCell}
                onSelectAllNights={sel.reportSelectAll}
                onCappedClick={() =>
                  toast.info(`All ${plural(roomCount, "room")} are chosen — untick one first to swap it.`)
                }
                disabled={save.isPending}
              />
            </Tool>
          </>
        )}
      </section>

      {/* ------------------------------------------------------------------ the save */}
      <section>
        <div className="field">
          <label>Why the change</label>
          <input
            className="input"
            value={reason}
            placeholder="the guest's party shrank — two rooms no longer needed"
            onChange={(e) => setReason(e.target.value)}
          />
          <span className="hint">it goes on the booking&rsquo;s record with your name</span>
        </div>
        <div className="row-acts" style={{ marginTop: 10 }}>
          <Button
            kind="primary"
            onClick={() => save.mutate()}
            state={blocked ? "inert" : "default"}
            reason={
              nothingMoved
                ? "Nothing has changed yet"
                : needsRepick
                  ? !configId
                    ? `The rooms asked for changed to ${roomCount} — ask the house and pick them`
                    : `Pick ${plural(roomCount, "room")} below — ${picked.length} ${picked.length === 1 ? "is" : "are"} ticked`
                  : !reason.trim()
                    ? "Type why the configuration is changing"
                    : !agesReady
                      ? "Every child needs an age"
                      : roomsMoved && !configId
                        ? "Ask the house before saving rooms"
                        : undefined
            }
          >
            {save.isPending ? "Saving…" : "Save the configuration"}
          </Button>
          <span className="meta">
            {partyMoved && roomsMoved
              ? "the party and the rooms change together, as one record"
              : partyMoved
                ? "the party changes; the rooms stay as they are"
                : roomsMoved
                  ? "the rooms change; the party stays as it is"
                  : "change the party above, or tick a different room"}
          </span>
        </div>
        <p className="meta" style={{ marginTop: 8 }}>
          Saving retires any quotation already priced on the old configuration — price it again before moving to Set up.
          A provisional block moves to the new rooms and keeps its original deadline.
        </p>
      </section>
    </div>
  );
}
