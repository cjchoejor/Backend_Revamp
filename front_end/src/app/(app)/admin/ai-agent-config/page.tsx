"use client";

import { KeyedConfigPanel } from "@/components/admin/keyed-config-panel";
import { useSession } from "@/hooks/use-session";
import {
  getAiAgentConfig,
  getProcessingLockTtls,
  setProcessingLockTtls,
  updateAiAgentConfig,
} from "@/lib/api/admin";

export default function AdminAiAgentConfigPage() {
  const { session } = useSession();
  const enabled = !!session && session.actorLevel === "L4";
  if (!session || session.actorLevel !== "L4") return null;

  return (
    <div className="space-y-6 pb-16">
      <div>
        <p className="admin-eyebrow mb-2">Domain 08 · OTA &amp; AI</p>
        <h1 className="admin-display text-3xl">AI agent configuration</h1>
        <p className="admin-muted mt-1">
          Trust levels, confidence thresholds, and credentials. Secret fields (api keys, tokens) are never returned —
          leave the masked placeholder to keep the stored value.
        </p>
      </div>

      <KeyedConfigPanel
        title="AI agent config"
        description="LLM credentials, per-category trust levels, confidence thresholds, escalation routing (JSON)."
        queryKey={["admin", "ai-agent", "config"]}
        enabled={enabled}
        load={async () => (await getAiAgentConfig(session)).value}
        save={(v) => updateAiAgentConfig(session, (v ?? {}) as Record<string, unknown>)}
      />
      <KeyedConfigPanel
        title="Processing lock TTL per channel"
        description="Required for all four channels: EMAIL_AI, WHATSAPP_AI, FRONT_DESK, PHONE (JSON of seconds)."
        queryKey={["admin", "ai-agent", "processing-lock-ttl"]}
        enabled={enabled}
        load={async () => (await getProcessingLockTtls(session)).value}
        save={(v) => setProcessingLockTtls(session, (v ?? {}) as Record<string, number>)}
      />
    </div>
  );
}
