"use client";

import { SettingsPage } from "@/components/admin/settings-list";

export default function AdminVipArrivalsPage() {
  return (
    <SettingsPage
      eyebrow="Messages"
      title="VIP arrivals"
      about="Who has to be told when a VIP arrives, before they can check in."
      groups={[{ keys: ["registry.vip.notificationRoutingPerTier", "vipNotification.routingPerTier", "registry.vipArrivalAck.seconds"] }]}
    />
  );
}
