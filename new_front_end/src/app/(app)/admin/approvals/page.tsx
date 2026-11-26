"use client";

import { SettingsPage } from "@/components/admin/settings-list";

/** Who may approve what (2026-11-26): one row per act, a toggle per role. An admin always may. */
export default function AdminApprovalsPage() {
  return (
    <SettingsPage
      eyebrow="Rules"
      title="Who approves"
      about="For each act that needs someone's approval, who may do it themselves. Anyone else asks them from the desk, and the bell rings for those who may. An admin always may."
      groups={[
        { title: "Rooms", keys: ["approvals.roomAdd.roles", "approvals.roomRemove.roles"] },
        { title: "Leaving early", keys: ["approvals.leavingEarly.roles", "approvals.waiveEarlyFee.roles"] },
        { title: "Money", keys: ["approvals.leaveOwing.roles", "approvals.checkInPayLater.roles", "approvals.chargeCorrection.roles"] },
        { title: "Negotiation", keys: ["approvals.negotiationChange.roles"] },
      ]}
    />
  );
}
