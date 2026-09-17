"use client";

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
        <p className="admin-eyebrow mb-2">Domain 03 · Commercial</p>
        <h1 className="admin-display text-3xl">Common rate package</h1>
        <p className="admin-muted mt-2 max-w-3xl text-sm">
          The rate used when a travel agent or corporate account has <strong>no package of their own</strong> —
          typically an agency the hotel has just started dealing with. Without this they would price at zero, so
          front desk can quote them the moment they call and the negotiated rates can be entered later.
        </p>
      </div>

      <div className="admin-panel p-4 text-xs leading-relaxed">
        <p className="admin-muted">
          <strong>This is not the walk-in rate.</strong> A guest booking directly, with no agency behind them,
          prices from <a className="underline" href="/admin/rate-plans">Rate plans</a> plus the{" "}
          <a className="underline" href="/admin/house-tariff">House tariff</a>. The common package applies only to
          agent and corporate bookings.
        </p>
        <p className="admin-muted mt-2">
          Once an agency has its own package on{" "}
          <a className="underline" href="/admin/travel-agents">Travel agents &amp; rate packages</a>, that package
          takes over and this one stops applying to them.
        </p>
      </div>

      {/* Owner deliberately empty — that is what makes it the COMMON package. */}
      <RatePackagesEditor owner={{}} ownerLabel="the common package" />
    </div>
  );
}
