"use client";

import { SettingsPage } from "@/components/admin/settings-list";

export default function AdminTimeLimitsPage() {
  return (
    <SettingsPage
      eyebrow="Money and daily running"
      title="Time limits"
      about="How long things can wait before the system lets them go, warns someone or reminds them."
      groups={[
        {
          title: "How long a booking can wait",
          keys: [
            "expiry.s1.defaultTtlSeconds",
            "expiry.s2.negotiationTtlSeconds",
            "expiry.s2.speculativeHoldTtlSeconds",
            "expiry.s3.committedHoldTtlSeconds",
            "expiry.parking.followUpDays",
            "preArrival.windowDays",
            "stayExtension.holdTtlSeconds",
            "availability.staleness.ttlSeconds",
          ],
        },
        { title: "Warnings", keys: ["stageDwell.thresholds"] },
        {
          title: "Other clocks",
          keys: [
            "deficientResolution.deadlineHours",
            "lostFound.retention.warningOffsetDays",
            "followUp.deadlineDays",
            "feedback.solicitation.delaySeconds",
            "commission.rateMissing.resolutionSeconds",
            "noShow.awaitingConfirmationWindowMinutes",
            "availability.conferenceSpace.turnaroundBufferMinutes",
          ],
        },
      ]}
    />
  );
}
