"use client";

import { SettingsPage } from "@/components/admin/settings-list";

export default function AdminDailySchedulePage() {
  return (
    <SettingsPage
      eyebrow="Money and daily running"
      title="Daily schedule"
      about="The times of day the hotel runs on."
      groups={[
        { title: "Times of day", keys: ["checkIn.standardTime", "checkout.cutoffTime", "noShow.cutoffWindowMinutes", "nightAudit.scheduleTime", "nightAudit.schedule"] },
        { title: "Rooms", keys: ["housekeeping.sla.windowMinutes", "inspection.postCheckout.windowHours"] },
        { title: "Night audit", keys: ["nightAudit.expectedDailyFAndBCharge"] },
        { keys: ["room.readiness.slaWindow", "nightAudit.expectedChargesRules", "roomAssignment.priorityRules"] },
      ]}
    />
  );
}
