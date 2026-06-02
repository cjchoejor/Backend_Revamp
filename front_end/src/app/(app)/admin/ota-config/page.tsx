"use client";

import { KeyedConfigPanel } from "@/components/admin/keyed-config-panel";
import { useSession } from "@/hooks/use-session";
import {
  getOtaConfig,
  setOtaConfigValue,
  setOtaNoShowCutoff,
  setOtaPollingInterval,
} from "@/lib/api/admin";

export default function AdminOtaConfigPage() {
  const { session } = useSession();
  const enabled = !!session && session.actorLevel === "L4";
  if (!session || session.actorLevel !== "L4") return null;

  return (
    <div className="space-y-6 pb-16">
      <div>
        <p className="admin-eyebrow mb-2">Domain 08 · OTA &amp; AI</p>
        <h1 className="admin-display text-3xl">OTA configuration</h1>
        <p className="admin-muted mt-1">Source flags, polling cadence, conflict rules, and no-show handling.</p>
      </div>

      <KeyedConfigPanel
        title="Source flag config"
        description="Which OTA sources are enabled (JSON object)."
        queryKey={["admin", "ota", "source-flags"]}
        enabled={enabled}
        load={async () => (await getOtaConfig(session, "source-flags")).value}
        save={(v) => setOtaConfigValue(session, "source-flags", v)}
      />
      <KeyedConfigPanel
        title="Inbox polling interval (seconds)"
        queryKey={["admin", "ota", "polling-interval"]}
        mode="number"
        enabled={enabled}
        load={async () => (await getOtaConfig(session, "polling-interval")).seconds}
        save={(v) => setOtaPollingInterval(session, Number(v))}
      />
      <KeyedConfigPanel
        title="Conflict trigger rules"
        description="Rules used to flag OTA conflict overbookings (JSON)."
        queryKey={["admin", "ota", "conflict-rules"]}
        enabled={enabled}
        load={async () => (await getOtaConfig(session, "conflict-rules")).value}
        save={(v) => setOtaConfigValue(session, "conflict-rules", v)}
      />
      <KeyedConfigPanel
        title="No-show cutoff (minutes)"
        queryKey={["admin", "ota", "no-show-cutoff"]}
        mode="number"
        enabled={enabled}
        load={async () => (await getOtaConfig(session, "no-show-cutoff")).minutes}
        save={(v) => setOtaNoShowCutoff(session, Number(v))}
      />
      <KeyedConfigPanel
        title="No-show penalty structure"
        description="Penalty per source/tier combination (JSON). All combinations must be covered."
        queryKey={["admin", "ota", "no-show-penalty"]}
        enabled={enabled}
        load={async () => (await getOtaConfig(session, "no-show-penalty")).value}
        save={(v) => setOtaConfigValue(session, "no-show-penalty", v)}
      />
    </div>
  );
}
