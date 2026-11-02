"use client";

import { SettingsPage } from "@/components/admin/settings-list";
import { PAGE_KEYS } from "@/lib/admin/setting-forms";

export default function AdminChannelsPage() {
  return <SettingsPage eyebrow="Messages" title="Channels and replies" about="How long the desk waits for an answer, and the ways of reaching a guest." groups={[{ keys: PAGE_KEYS.communication }]} />;
}
