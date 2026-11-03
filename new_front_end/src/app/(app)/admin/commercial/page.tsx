"use client";

import { SettingsPage } from "@/components/admin/settings-list";

export default function AdminLimitsPage() {
  return (
    <SettingsPage
      eyebrow="Rates and limits"
      title="Limits"
      about="How far each person may go: discounts, credit, free rooms, overbooking and write-offs."
      groups={[
        { title: "Discounts", keys: ["discount.fom.maxPercentage", "discount.gm.maxPercentage"] },
        { title: "Credit", keys: ["creditCeiling.proximityThresholds", "creditCeiling.clientTier.thresholds"] },
        { title: "Rooms", keys: ["confirmation.authorityThresholds", "speculativeHold.placementThresholds", "foc.configuration", "overbooking.maxAllowedRooms"] },
        { title: "Write-offs", keys: ["writeOff.authority.thresholds"] },
      ]}
    />
  );
}
