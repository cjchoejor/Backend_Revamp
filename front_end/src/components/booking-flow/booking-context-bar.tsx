"use client";

import { Calendar, DoorOpen, FileText, Mail, Phone, User, Users } from "lucide-react";
import type { AvailabilityConfigSummary, EntryDetail, QuotationSummary } from "@/types/api";
import { GroupBadge } from "@/components/entries/group-badge";

type Props = {
  entry: EntryDetail;
  sealedConfig: AvailabilityConfigSummary | null;
  acceptedQuotation: QuotationSummary | null;
};

/**
 * Sticky context bar shown at the top of the booking flow page once an inquiry/entry
 * has been created. As steps complete, their crucial facts collapse here as chips so
 * the operator can see the whole booking at a glance even when scrolled deep into the
 * currently-active step.
 */
export function BookingContextBar({ entry, sealedConfig, acceptedQuotation }: Props) {
  // entry.inquiry's runtime shape is wider than the exported type — read display fields loosely.
  const inquiry = entry.inquiry as unknown as
    | {
        referenceNumber?: string;
        sourceChannel?: string;
        guestProfile?: { firstName?: string | null; lastName?: string | null; email?: string | null; phone?: string | null } | null;
        travelAgent?: { displayName?: string };
        corporateAccount?: { displayName?: string };
      }
    | null
    | undefined;
  const guest = entry.guestProfile ?? inquiry?.guestProfile ?? null;
  const guestName = guest
    ? `${guest.firstName ?? ""} ${guest.lastName ?? ""}`.trim() || "Guest"
    : "Guest";

  const checkIn = entry.checkInDate?.slice(0, 10);
  const checkOut = entry.checkOutDate?.slice(0, 10);
  const nights =
    checkIn && checkOut
      ? Math.max(1, Math.round((new Date(checkOut).getTime() - new Date(checkIn).getTime()) / 86400_000))
      : null;

  const adults = entry.adultCount ?? null;
  const childCount = entry.childCount ?? null;
  const childAges = (entry.childAges as number[] | undefined) ?? [];
  const guestCount = entry.guestCount ?? (adults ?? 0) + (childCount ?? 0);

  const agentLabel =
    inquiry?.travelAgent?.displayName ?? inquiry?.corporateAccount?.displayName ?? null;

  const roomId = sealedConfig?.optionSelected?.roomId as string | undefined;

  return (
    <div className="sticky top-0 z-30 -mx-4 border-b border-border bg-card/95 px-4 py-2 shadow-sm backdrop-blur supports-[backdrop-filter]:bg-card/80 sm:-mx-6 sm:px-6">
      <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-3 gap-y-1.5 text-sm">
        {/* Guest identity (always visible once entry exists) */}
        <span className="flex items-center gap-1.5 font-medium">
          <User className="h-4 w-4 text-muted-foreground" />
          {guestName}
        </span>
        <span className="font-mono text-[11px] text-muted-foreground">
          {inquiry?.referenceNumber ?? entry.id}
        </span>

        {/* Contact chips — email / phone */}
        {guest?.email && (
          <Chip icon={<Mail className="h-3.5 w-3.5" />}>{guest.email}</Chip>
        )}
        {guest?.phone && (
          <Chip icon={<Phone className="h-3.5 w-3.5" />}>{guest.phone}</Chip>
        )}

        {agentLabel && (
          <Chip>
            <span className="text-muted-foreground">via</span> {agentLabel}
          </Chip>
        )}

        {/* Stay dates */}
        {checkIn && checkOut && (
          <Chip icon={<Calendar className="h-3.5 w-3.5" />}>
            {checkIn} → {checkOut}
            {nights && (
              <span className="ml-1 text-muted-foreground">
                · {nights}n
              </span>
            )}
          </Chip>
        )}

        {/* Guest composition — explicit "Adults: N · Children: M" with ages in parens */}
        {guestCount > 0 && (
          <Chip icon={<Users className="h-3.5 w-3.5" />}>
            {adults != null && childCount != null ? (
              <>
                <span className="text-muted-foreground">Adults:</span> {adults}
                {childCount > 0 && (
                  <>
                    <span className="mx-1 text-muted-foreground">·</span>
                    <span className="text-muted-foreground">Children:</span> {childCount}
                    {childAges.length > 0 && (
                      <span className="ml-1 text-muted-foreground">
                        (ages {childAges.join(", ")})
                      </span>
                    )}
                  </>
                )}
              </>
            ) : (
              <>{guestCount} guests</>
            )}
          </Chip>
        )}

        {/* Sealed room (step 2) */}
        {roomId && (
          <Chip icon={<DoorOpen className="h-3.5 w-3.5" />} tone="emerald">
            Room {roomId.slice(0, 10)}…
          </Chip>
        )}

        {/* Quotation (step 3) */}
        {acceptedQuotation && (
          <Chip icon={<FileText className="h-3.5 w-3.5" />} tone="emerald">
            Quote {acceptedQuotation.referenceNumber}
            <span className="ml-1 text-muted-foreground">
              {Number(acceptedQuotation.totalAmount).toFixed(0)} {acceptedQuotation.currency}
            </span>
          </Chip>
        )}

        {/* Group flag — visible signal that Policy 64 auto-classified this booking as a group */}
        <GroupBadge groupBillingMode={entry.groupBillingMode} compact />

        {/* Stage indicator on the far right */}
        <span className="ml-auto rounded-full bg-primary/15 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-primary">
          {entry.currentStage}
        </span>
      </div>
    </div>
  );
}

function Chip({
  icon,
  children,
  tone = "default",
}: {
  icon?: React.ReactNode;
  children: React.ReactNode;
  tone?: "default" | "emerald";
}) {
  const toneClass =
    tone === "emerald"
      ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-800 dark:text-emerald-300"
      : "border-border bg-muted/50 text-foreground";
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-xs ${toneClass}`}
    >
      {icon}
      {children}
    </span>
  );
}
