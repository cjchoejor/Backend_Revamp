"use client";

import { SettingsPage } from "@/components/admin/settings-list";
import { PAGE_KEYS } from "@/lib/admin/setting-forms";

export default function AdminOnlineBookingSitesPage() {
  return <SettingsPage eyebrow="Online bookings and AI" title="Online booking sites" about="Bookings that come from online booking sites, and what a no-show pays." groups={[{ keys: PAGE_KEYS.ota }]} />;
}
