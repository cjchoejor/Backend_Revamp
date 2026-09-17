"use client";

/**
 * Booking details — "what the booking is" (prototype, the Booking details tab): the three
 * parties, the stay, the numbers the booking carries, the thread, and the papers. Figures are
 * the backend's own; nothing is edited here except, at Inquiry, through the intake.
 */
import Link from "next/link";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/design-system";
import { usePaymentStatus } from "@/hooks/use-payment-status";
import type { EntryBillingSummary } from "@/lib/api/entries";
import { JourneySummaryBlock } from "@/components/desk/workspace/journey-summary";
import { channelWord } from "@/lib/ds/status";
import { fmtRange, money, nightsOf, plural } from "@/lib/ds/format";
import { guestName } from "@/lib/desk/model";
import { liveQuotesThisPass, reservedThisPass } from "@/lib/desk/workspace";
import { Fact, FactBox, Facts, PapersCard, StepCard } from "@/components/ds/steps/kit";
import type { EntryDetail } from "@/types/api";

const BILLING_WORD: Record<string, string> = {
  TOUR_OPERATOR_VOUCHER: "The package to the account · anything beyond it to the guest",
  DIRECT_BILL: "Everything to the account",
  GUEST_PAY: "Everything to the guest",
};

type Scalars = { corporateClientRef?: string | null; notes?: string | null };
type Contact = { contactPersonName?: string | null; contactPersonPhone?: string | null };

export function DetailsView({
  entry,
  booker,
  custodian,
  billing,
}: {
  entry: EntryDetail;
  booker: string | null;
  custodian: string | null;
  billing: EntryBillingSummary | null;
}) {
  const router = useRouter();
  const pay = usePaymentStatus(entry.id, { enabled: !!entry.folio });
  const [journey, setJourney] = useState(false);
  const g = entry.guestProfile ?? entry.inquiry?.guestProfile ?? null;
  const inq = (entry.inquiry ?? {}) as Scalars;
  const contact = entry as EntryDetail & Contact;
  const editable = entry.currentStage === "S1" && entry.status === "ACTIVE";
  const cur = billing?.currency ?? "BTN";

  const co = entry.actualCheckOutDate ?? entry.checkOutDate;
  const nights = nightsOf(entry.checkInDate, co);
  const rooms = Array.from(new Set((entry.roomAssignments ?? []).map((a) => a.room?.roomNumber).filter((x): x is string => !!x))).sort((a, b) =>
    a.localeCompare(b, "en", { numeric: true }),
  );
  const types = Array.from(new Set((entry.roomAssignments ?? []).map((a) => (a.room as { roomType?: { name?: string } } | undefined)?.roomType?.name).filter(Boolean)));
  const ages = entry.childAges?.length ? ` (ages ${entry.childAges.join(", ")})` : "";
  const party =
    [entry.adultCount ? plural(entry.adultCount, "adult") : null, entry.childCount ? `${plural(entry.childCount, "child", "children")}${ages}` : null].filter(Boolean).join(" · ") ||
    (entry.guestCount ? plural(entry.guestCount, "guest") : "");
  const beds = entry.bedTypeRequest
    ? Object.entries(entry.bedTypeRequest)
        .filter(([, n]) => n > 0)
        .map(([t, n]) => `${n} ${t.charAt(0) + t.slice(1).toLowerCase()}`)
        .join(" · ")
    : "";
  const res = reservedThisPass(entry) ? entry.reservation : null;
  const quotes = liveQuotesThisPass(entry);
  const quote = quotes.find((q) => q.state === "ACCEPTED") ?? quotes[0] ?? null;
  const invoices = entry.folio?.invoices ?? [];
  const proforma = invoices.filter((i) => i.invoiceType === "PROFORMA" && i.state !== "SUPERSEDED").sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  const tax = invoices.filter((i) => i.invoiceType === "FINAL" && i.state !== "SUPERSEDED").sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  const model = entry.folio?.billingModel ?? null;

  return (
    <>
      <h3>
        Booking details <span className="need">what the booking is</span>
      </h3>
      <div className="steps-canvas">
        <StepCard
          title="The three parties"
          right={
            <Button
              kind="secondary"
              compact
              state={editable ? "default" : "inert"}
              title={editable ? undefined : "after the inquiry, dates and party change through a re-entry"}
              onClick={() => router.push(`/bookings/new?edit=${encodeURIComponent(entry.id)}`)}
            >
              Edit booking details
            </Button>
          }
        >
          <div className="grid3">
            <FactBox
              k="Guest"
              v={g?.id ? <Link href={`/guests/${g.id}`}>{guestName(g)}</Link> : <span className="name-i">to come from the agent</span>}
              meta={[g?.phone, g?.email].filter(Boolean).join(" · ") || "no contact of their own on file"}
            />
            <FactBox k="Booked by" v={booker ?? channelWord(entry.inquiry?.sourceChannel)} meta={booker ? channelWord(entry.inquiry?.sourceChannel) : undefined} />
            <FactBox k="Billed to" v={model ? BILLING_WORD[model] ?? model : "not set yet"} meta={model ? undefined : "chosen at Set up"} />
          </div>
          <Facts wide style={{ marginTop: 10 }}>
            <Fact k="Arriving">{[contact.contactPersonName, contact.contactPersonPhone].filter(Boolean).join(" · ")}</Fact>
            <Fact k="Custodian">{custodian}</Fact>
            {g?.vipTier ? <Fact k="VIP">{g.vipTier}</Fact> : null}
          </Facts>
        </StepCard>

        <StepCard title="The stay">
          <Facts wide>
            <Fact k="Dates">{`${fmtRange(entry.checkInDate, co)}${nights ? ` · ${plural(nights, "night")}` : ""}`}</Fact>
            <Fact k="Rooms" meta={beds ? `asked for ${beds}` : undefined}>
              {rooms.length ? `${rooms.length} · ${rooms.join(", ")}${types.length ? ` · ${types.join(", ")}` : ""}` : `${entry.numberOfRooms ?? "—"} · not yet assigned`}
            </Fact>
            <Fact k="Guests">{party}</Fact>
            <Fact k="Rate" meta={res ? "as reserved" : quote ? "as quoted" : undefined}>
              {res ? `${money(res.frozenRate, cur)} / night` : null}
            </Fact>
            <Fact k="Total" meta={billing?.headline.frozen ? "as confirmed" : billing?.headline.kind === "BILLED_SO_FAR" ? "billed so far" : billing ? "indicative" : undefined}>
              {billing?.headline.amount != null ? money(billing.headline.amount, cur) : null}
            </Fact>
            <Fact k="Advance" meta={pay.data ? `${money(pay.data.totalReceived, cur)} received` : undefined}>
              {pay.data ? (pay.data.requiredAmount > 0 ? money(pay.data.requiredAmount, cur) : "none asked") : null}
            </Fact>
            {billing?.folio?.outstandingBalance != null ? <Fact k="Still owed">{money(billing.folio.outstandingBalance, cur)}</Fact> : null}
          </Facts>
        </StepCard>

        <StepCard title="Numbers">
          <Facts wide>
            <Fact k="Booking">{entry.id}</Fact>
            <Fact k="Quotation">{quote?.referenceNumber}</Fact>
            <Fact k="Proforma">{proforma?.invoiceNumber ?? proforma?.id}</Fact>
            <Fact k="Reservation">{res?.id}</Fact>
            {tax ? <Fact k="Tax invoice">{tax.invoiceNumber ?? tax.id}</Fact> : null}
            <Fact k="Their reference">{inq.corporateClientRef}</Fact>
            {(entry.segmentNumber ?? 1) > 1 ? <Fact k="Pass">{entry.segmentNumber}</Fact> : null}
          </Facts>
        </StepCard>

        <StepCard title="The thread">
          <p className={inq.notes ? "sm" : "meta"}>{inq.notes || "Nothing written yet — the line above the steps holds what the guest asked for."}</p>
        </StepCard>

        <StepCard
          title="Everything chosen so far"
          right={
            <Button kind="quiet" compact onClick={() => setJourney((v) => !v)}>
              {journey ? "Hide" : "Show"}
            </Button>
          }
          meta="The journey from Inquiry to Reserve in one read — dates, party, rooms, the quote, the hold, the money."
        >
          {journey ? (
            <div className="desk-root tool">
              <JourneySummaryBlock entryId={entry.id} />
            </div>
          ) : null}
        </StepCard>

        <PapersCard entry={entry} />
      </div>
    </>
  );
}
