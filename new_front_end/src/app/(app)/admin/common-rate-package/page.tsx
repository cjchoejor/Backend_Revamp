"use client";

import { Help } from "@/components/ds/help";
import { useSession } from "@/hooks/use-session";
import { RatePackagesEditor } from "@/components/admin/rate-packages-editor";

/**
 * The common (fallback) rate package.
 *
 * Used when a travel agent or corporate account has no package of its own — so an agency that
 * walks in today, unregistered and with nothing negotiated, can still be quoted immediately
 * instead of pricing at zero.
 *
 * Its own page rather than a section on the travel-agents screen: it is a hotel-wide setting,
 * not a property of any one agency, and burying it in another page's empty state made it
 * effectively undiscoverable. Same reasoning as the house tariff having its own page.
 */
export default function AdminCommonRatePackagePage() {
  const { session } = useSession();
  if (!session || session.actorLevel !== "L4") return null;

  return (
    <div className="space-y-6 pb-16">
      <div>
        <p className="admin-eyebrow mb-2">Rates and limits</p>
        <h1 className="admin-display flex items-center gap-2 text-3xl">
          Common rate package
          <Help label="Common rate package">
            The rate used when a travel agent or corporate account has <strong>no package of their own</strong> —
          typically an agency the hotel has just started dealing with. Without this they would price at zero, so
          front desk can quote them the moment they call and the negotiated rates can be entered later. This is not the walk-in rate: a guest booking
          directly, with no agency behind them, prices from Rate plans plus the House tariff. Once an agency has a package of its own under Travel agents,
          that package takes over and this one stops applying to them.
          </Help>
        </h1>
      </div>

      {/* Owner deliberately empty — that is what makes it the COMMON package. */}
      <RatePackagesEditor owner={{}} ownerLabel="the common package" />
    </div>
  );
}
