"use client";

import { Suspense } from "react";
import { useQuery } from "@tanstack/react-query";
import { SettingsList, SettingsPageHead } from "@/components/admin/settings-list";
import { getSettingDef } from "@/lib/admin/setting-forms";
import { listConfigurationKeys } from "@/lib/api/admin";
import { useSession } from "@/hooks/use-session";

/** Not listed here: the old names of settings that live elsewhere now, the walk-in plan, chosen on Rate plans, and the food check removed 2026-11-03, whose saved row stays on file. */
const LEFT_BEHIND = new Set([
  "availability.walkIn.ratePlanId",
  "expiry.defaults",
  "feedback.platform.links",
  "feedback.survey.templates",
  "government.submission.config",
  "identity.document.retentionPeriodDays",
  "nightAudit.expectedDailyFAndBCharge",
  "ota_email_poll_interval_seconds",
  "pricing.ratePlans",
]);

export default function AdminOtherSettingsPage() {
  const { session } = useSession();
  const keys = useQuery({
    queryKey: ["admin", "config-keys"],
    queryFn: () => listConfigurationKeys(session!),
    enabled: !!session && session.actorLevel === "L4",
  });
  // Anything saved that no page knows about still shows here, so it can be seen.
  const others = (keys.data?.keys ?? []).filter((k) => !getSettingDef(k) && !LEFT_BEHIND.has(k));

  return (
    <div className="set-page">
      <SettingsPageHead eyebrow="Everything else" title="Other settings" about="Settings that do not belong to another page." />
      <Suspense>
        <SettingsList
          groups={[
            { title: "Money", keys: ["earlyDeparture.penalty", "interimPayment.schedule", "interimPayment.reminder", "billingModel.availablePerSource", "paymentMilestone.scheduleTemplates"] },
            { title: "Lists the desk picks from", keys: ["guestRequest.kinds", "deficientCondition.categories"] },
            { title: "Who looks after what", keys: ["ownership.assignmentRules", "notification.routing.stageDwell", "notification.routing.operatorExpiry", "handoff.H1.autoFulfil.enabled", "ownership.s4.sameTeamAutoFulfilH1"] },
            { title: "Rooms and groups", keys: ["groupDetection.guestCountThreshold", "housekeeping.sla.readinessWindowMinutes", "availability.shadowInventory.visibilityRules", "availability.bookablePhysicalStates"] },
            { keys: ["quotation.document.templateKey", "confirmation.document.templateKey", "paymentMilestone.warningOffsetDays", "overbooking.otaConflictRules"] },
            { title: "Others on file", keys: others },
          ]}
        />
      </Suspense>
    </div>
  );
}
