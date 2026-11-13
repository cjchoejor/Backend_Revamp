"use client";

import { SettingsPage } from "@/components/admin/settings-list";
import { PAGE_KEYS } from "@/lib/admin/setting-forms";

const REPLIES_HELP =
  "Must be noted: the desk asks for the reply, and what it holds waits for it. Not needed: nothing waits, no reply clock shows and the desk does not ask, though a reply can still be noted under Papers, Sent & answers. Turning one off changes no booking. Turn it back on and papers sent before it went off wait again; those sent while it was off stay exempt.";

export default function AdminChannelsPage() {
  return <SettingsPage eyebrow="Messages" title="Channels and replies" about="Whether the desk waits for the guest's reply to each email, how long it waits, the ways of reaching a guest, and whether an agency's papers may go with room types."
      groups={[
        { title: "The guest's reply to each email", help: REPLIES_HELP, keys: PAGE_KEYS.communication.filter((k) => k.startsWith("guestReply.")) },
        { title: "Papers to an agency or a company", keys: PAGE_KEYS.communication.filter((k) => k.startsWith("papers.")) },
        { title: "Waiting, and reaching a guest", keys: PAGE_KEYS.communication.filter((k) => !k.startsWith("guestReply.") && !k.startsWith("papers.")) },
      ]} />;
}
