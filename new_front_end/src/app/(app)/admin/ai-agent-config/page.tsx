"use client";

import { SettingsPage } from "@/components/admin/settings-list";
import { PAGE_KEYS } from "@/lib/admin/setting-forms";

export default function AdminAiAgentPage() {
  return <SettingsPage eyebrow="Online bookings and AI" title="AI agent" about="What the AI may do by itself, and how long a booking stays locked to whoever is working it." groups={[{ keys: PAGE_KEYS.ai }]} />;
}
