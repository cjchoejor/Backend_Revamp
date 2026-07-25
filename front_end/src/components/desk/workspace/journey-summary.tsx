"use client";

import { useQuery } from "@tanstack/react-query";
import { ClipboardList, User } from "lucide-react";
import { useSession } from "@/hooks/use-session";
import { getJourneySummary, type BookingJourneySummary, type JourneyRoomRef, type JourneySectionStatus } from "@/lib/api/entries";
import { moneyOrDash } from "@/lib/desk/workspace";

/**
 * Booking journey summary — the "S1–S4 handoff summary". A read-only recap of everything the
 * customer chose or did from Inquiry through Confirmation, rendered from the backend aggregation
 * at GET /api/entries/:id/journey-summary. Nothing is derived here; every value comes from the API
 * (money included — see CLAUDE.md money rule). Dropped onto the Confirm step so the operator can
 * review the whole booking before freezing.
 */

const STATUS_STYLE: Record<JourneySectionStatus, { bg: string; fg: string; label: string }> = {
  COMPLETE: { bg: "var(--green-t)", fg: "var(--green)", label: "Done" },
  IN_PROGRESS: { bg: "var(--warn-t)", fg: "var(--warn)", label: "In progress" },
  NOT_STARTED: { bg: "var(--cream-2)", fg: "var(--ink-3)", label: "Not started" },
};

function Pill({ status }: { status: JourneySectionStatus }) {
  const s = STATUS_STYLE[status];
  return (
    <span
      style={{
        fontSize: 10.5,
        fontWeight: 600,
        letterSpacing: 0.3,
        textTransform: "uppercase",
        padding: "2px 8px",
        borderRadius: 999,
        background: s.bg,
        color: s.fg,
      }}
    >
      {s.label}
    </span>
  );
}

function Card({
  title,
  status,
  children,
}: {
  title: string;
  status?: JourneySectionStatus;
  children: React.ReactNode;
}) {
  return (
    <div
      style={{
        border: "1px solid var(--line)",
        borderRadius: "var(--r-md)",
        background: "var(--paper)",
        padding: "12px 14px",
        marginTop: 10,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
        <div style={{ fontSize: 12.5, fontWeight: 700, color: "var(--ink)", letterSpacing: 0.2 }}>{title}</div>
        {status ? <Pill status={status} /> : null}
      </div>
      {children}
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "132px 1fr",
        gap: 10,
        padding: "4px 0",
        borderBottom: "1px dashed var(--line)",
        fontSize: 12.5,
        alignItems: "baseline",
      }}
    >
      <div style={{ color: "var(--ink-3)" }}>{label}</div>
      <div style={{ color: "var(--ink)", wordBreak: "break-word" }}>{children ?? "—"}</div>
    </div>
  );
}

function dash(v: string | number | null | undefined): string {
  if (v === null || v === undefined || v === "") return "—";
  return String(v);
}

function fmtDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  const dd = String(d.getDate()).padStart(2, "0");
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  return `${dd}/${mm}/${d.getFullYear()}`;
}

function fmtDateTime(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  const hh = String(d.getHours()).padStart(2, "0");
  const min = String(d.getMinutes()).padStart(2, "0");
  return `${fmtDate(iso)} ${hh}:${min}`;
}

function roomLabel(r: JourneyRoomRef): string {
  const type = r.roomTypeName ?? r.roomTypeCode ?? null;
  if (r.roomNumber && type) return `${r.roomNumber} · ${type}`;
  if (r.roomNumber) return r.roomNumber;
  if (type) return type;
  return r.roomId.slice(0, 8);
}

export function JourneySummaryPanel({ entryId }: { entryId: string }) {
  const { session } = useSession();
  const q = useQuery({
    queryKey: ["journey-summary", entryId],
    queryFn: () => getJourneySummary(session!, entryId),
    enabled: !!session,
  });

  if (q.isLoading) {
    return <div style={{ fontSize: 12.5, color: "var(--ink-3)", padding: "8px 0" }}>Loading booking journey…</div>;
  }
  if (q.isError || !q.data) {
    return (
      <div style={{ fontSize: 12.5, color: "var(--stop)", padding: "8px 0" }}>
        Couldn&rsquo;t load the booking journey summary.
      </div>
    );
  }

  const s = q.data;
  const s1 = s.s1Inquiry;
  const s2 = s.s2Quote;
  const s3 = s.s3Setup;
  const s4 = s.s4Confirmation;
  const cur = s2.currency;

  const partyText = [
    s1.party.adults != null ? `${s1.party.adults} adult${s1.party.adults === 1 ? "" : "s"}` : null,
    s1.party.children ? `${s1.party.children} child${s1.party.children === 1 ? "" : "ren"}` : null,
  ]
    .filter(Boolean)
    .join(", ");
  const agesText = s1.party.childAges.length ? ` (ages ${s1.party.childAges.join(", ")})` : "";

  const rateLine =
    s2.nightlyRate != null
      ? `${moneyOrDash(s2.nightlyRate, cur)}/night${s2.roomCount && s2.roomCount > 1 ? ` × ${s2.roomCount} rooms` : ""}${
          s2.nights ? ` × ${s2.nights} night${s2.nights === 1 ? "" : "s"}` : ""
        }`
      : "—";

  return (
    <div>
      {/* Guest header */}
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 2 }}>
        <User style={{ width: 14, height: 14, color: "var(--green)" }} />
        <span style={{ fontSize: 13.5, fontWeight: 700, color: "var(--ink)" }}>{dash(s.guest.name)}</span>
        {s.guest.vipTier ? (
          <span style={{ fontSize: 10.5, fontWeight: 600, color: "var(--terra-d)", background: "var(--terra-t)", padding: "1px 7px", borderRadius: 999 }}>
            VIP · {s.guest.vipTier}
          </span>
        ) : null}
        {s.inquiryReference ? (
          <span style={{ fontSize: 11, color: "var(--ink-3)", fontFamily: "var(--deskmono)" }}>{s.inquiryReference}</span>
        ) : null}
      </div>
      <div style={{ fontSize: 11.5, color: "var(--ink-3)", marginBottom: 4 }}>
        {[dash(s.guest.phone), s.guest.email ?? null, s.guest.nationality ?? null].filter((x) => x && x !== "—").join(" · ")}
      </div>

      {/* S1 — Inquiry */}
      <Card title="Inquiry — what they asked for" status={s1.status}>
        <Row label="Came in as">{dash(s1.sourceChannel)}</Row>
        <Row label="Dates">
          {s1.dates.checkIn || s1.dates.checkOut
            ? `${fmtDate(s1.dates.checkIn)} → ${fmtDate(s1.dates.checkOut)}${s1.dates.nights ? ` · ${s1.dates.nights} night${s1.dates.nights === 1 ? "" : "s"}` : ""}`
            : "—"}
        </Row>
        <Row label="Party">{partyText ? `${partyText}${agesText}` : dash(s1.party.totalGuests ? `${s1.party.totalGuests} guests` : null)}</Row>
        <Row label="Rooms requested">{dash(s1.party.roomsRequested)}</Row>
        <Row label="Contact person">
          {s1.contactPerson.name || s1.contactPerson.phone
            ? `${dash(s1.contactPerson.name)}${s1.contactPerson.phone ? ` · ${s1.contactPerson.phone}` : ""}`
            : "—"}
        </Row>
        {s1.commercialContext.type !== "NONE" ? (
          <Row label={s1.commercialContext.type === "TRAVEL_AGENT" ? "Travel agent" : "Corporate"}>
            {dash(s1.commercialContext.partyName)}
            {s1.commercialContext.coordinator ? ` · coord. ${s1.commercialContext.coordinator}` : ""}
            {s1.commercialContext.contractRef ? ` · ref ${s1.commercialContext.contractRef}` : ""}
            {s1.commercialContext.gstNumber ? ` · GST ${s1.commercialContext.gstNumber}` : ""}
          </Row>
        ) : null}
        <Row label="Room selection">
          {s1.roomSelection.rooms.length ? (
            <span>
              {s1.roomSelection.rooms.map(roomLabel).join(", ")}
              {s1.roomSelection.shape === "per-night" ? " · varies per night" : ""}
              {s1.roomSelection.anyDeficient ? (
                <span style={{ color: "var(--warn)", fontWeight: 600 }}> · deficient room accepted</span>
              ) : null}
            </span>
          ) : (
            "—"
          )}
        </Row>
        {s.groupBillingMode === "GROUP_MASTER" ? (
          <Row label="Group booking">
            <span style={{ color: "var(--green)", fontWeight: 600 }}>Group master folio</span>
          </Row>
        ) : null}
        {s1.notes ? <Row label="Notes">{s1.notes}</Row> : null}
      </Card>

      {/* S2 — Quote */}
      <Card title="Quote — the price they agreed to" status={s2.status}>
        <Row label="Quotation">
          {s2.reference ? `${s2.reference}${s2.versionNumber ? ` · v${s2.versionNumber}` : ""}${s2.state ? ` · ${s2.state}` : ""}` : "—"}
        </Row>
        <Row label="Rate">{rateLine}</Row>
        <Row label="Total">{moneyOrDash(s2.total, cur)}</Row>
        {s2.mealPlan ? <Row label="Meal plan">{s2.mealPlan}</Row> : null}
        {s2.inclusions.length ? <Row label="Inclusions">{s2.inclusions.join(", ")}</Row> : null}
        {s2.agentRate ? <Row label="Negotiated rate">Agent/corporate rate card applied</Row> : null}
        {s2.belowMsr ? (
          <Row label="Below MSR">
            <span style={{ color: "var(--warn)", fontWeight: 600 }}>Yes — GM waiver path</span>
          </Row>
        ) : null}
        {s2.focRoomsRequested ? <Row label="FOC rooms">{s2.focRoomsRequested}</Row> : null}
        <Row label="Valid until">{fmtDate(s2.validUntil)}</Row>
        <Row label="Accepted">
          {s2.acceptedAt ? `${fmtDateTime(s2.acceptedAt)}${s2.acceptedBy ? ` · ${s2.acceptedBy}` : ""}` : "Not yet accepted"}
        </Row>
        {s2.lines.length ? (
          <div style={{ marginTop: 8 }}>
            <div style={{ fontSize: 11, color: "var(--ink-3)", marginBottom: 4 }}>Per-night breakdown</div>
            <div style={{ fontSize: 11.5, fontFamily: "var(--deskmono)" }}>
              {s2.lines.map((l, i) => (
                <div key={i} style={{ display: "flex", justifyContent: "space-between", padding: "2px 0", color: "var(--ink-2)" }}>
                  <span>
                    {fmtDate(l.date)}
                    {l.occupants ? ` · ${l.occupants}` : ""}
                    {l.mealPlan ? ` · ${l.mealPlan}` : ""}
                    {l.extraBeds && l.extraBeds !== "None" ? ` · ${l.extraBeds}` : ""}
                  </span>
                  <span>{moneyOrDash(l.amount, cur)}</span>
                </div>
              ))}
            </div>
          </div>
        ) : null}
      </Card>

      {/* S3 — Set up */}
      <Card title="Set up — billing & holds" status={s3.status}>
        <Row label="Billing model">{dash(s3.billingModel)}</Row>
        <Row label="Folio">{dash(s3.folioState)}</Row>
        <Row label="Committed hold">
          {s3.committedHold
            ? `${dash(s3.committedHold.state)}${s3.committedHold.rooms.length ? ` · ${s3.committedHold.rooms.map(roomLabel).join(", ")}` : ""}`
            : "—"}
        </Row>
        <Row label="Advance payment">
          {s3.advancePayment ? (
            <span>
              {moneyOrDash(s3.advancePayment.totalReceived, cur)} of {moneyOrDash(s3.advancePayment.requiredAmount, cur)}
              {s3.advancePayment.satisfied ? (
                <span style={{ color: "var(--ok)", fontWeight: 600 }}> · satisfied</span>
              ) : (
                <span style={{ color: "var(--warn)", fontWeight: 600 }}> · short {moneyOrDash(s3.advancePayment.shortfall, cur)}</span>
              )}
              {s3.advancePayment.creditExtensionActive
                ? ` · credit ceiling ${moneyOrDash(s3.advancePayment.ceilingAmount, cur)}`
                : ""}
            </span>
          ) : (
            "—"
          )}
        </Row>
        <Row label="Cancellation">
          {s3.cancellation?.disclosed
            ? `Disclosed${s3.cancellation.disclosedAt ? ` ${fmtDate(s3.cancellation.disclosedAt)}` : ""}${
                s3.cancellation.noShowTreatment ? ` · ${s3.cancellation.noShowTreatment}` : ""
              }`
            : "Not disclosed"}
        </Row>
        {s3.proformaInvoiceRef ? <Row label="Proforma invoice">{s3.proformaInvoiceRef}</Row> : null}
        {s3.coordinator ? <Row label="Coordinator">{s3.coordinator}</Row> : null}
      </Card>

      {/* S4 — Confirmation */}
      <Card title="Confirmation — the frozen commitment" status={s4.status}>
        {s4.confirmed ? (
          <>
            <Row label="Reservation">{dash(s4.reservationId)}</Row>
            <Row label="Frozen rate">{moneyOrDash(s4.frozenRate, cur)}</Row>
            <Row label="Frozen dates">
              {`${fmtDate(s4.frozenCheckIn)} → ${fmtDate(s4.frozenCheckOut)}`}
            </Row>
            <Row label="Frozen billing">{dash(s4.frozenBillingModel)}</Row>
            <Row label="Frozen guests">{dash(s4.frozenGuestCount)}</Row>
            {s4.creditCeilingIfExtended != null ? (
              <Row label="Credit ceiling">{moneyOrDash(s4.creditCeilingIfExtended, cur)}</Row>
            ) : null}
            <Row label="Confirmed">
              {s4.confirmedAt ? `${fmtDateTime(s4.confirmedAt)}${s4.confirmedBy ? ` · ${s4.confirmedBy}` : ""}` : "—"}
            </Row>
            <Row label="Voucher sent">{s4.voucherSent ? "Yes" : "No"}</Row>
          </>
        ) : (
          <div style={{ fontSize: 12.5, color: "var(--ink-3)" }}>Not yet confirmed — this is what freezing will lock in.</div>
        )}
      </Card>
    </div>
  );
}

/** Section header matching the Confirm step's other blocks, with the panel below. */
export function JourneySummaryBlock({ entryId }: { entryId: string }) {
  return (
    <div className="block">
      <div className="block-h">
        <ClipboardList style={{ width: 13, height: 13 }} />
        Booking journey — everything chosen so far
        <span className="ln" />
      </div>
      <JourneySummaryPanel entryId={entryId} />
    </div>
  );
}
