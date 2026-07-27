"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { KeyedConfigPanel } from "@/components/admin/keyed-config-panel";
import { SmartConfigEditor } from "@/components/admin/smart-config-editor";
import { useSession } from "@/hooks/use-session";
import {
  getAcknowledgementWindow,
  listCommunicationChannels,
  setAcknowledgementWindow,
  updateCommunicationChannel,
} from "@/lib/api/admin";
import { ApiError } from "@/lib/api/client";

export default function AdminCommunicationConfigPage() {
  const { session } = useSession();
  const queryClient = useQueryClient();
  const [channelId, setChannelId] = useState("");
  const [channelValue, setChannelValue] = useState<unknown>({ enabled: true });
  const enabled = !!session && session.actorLevel === "L4";

  const channelsQuery = useQuery({
    queryKey: ["admin", "comm", "channels"],
    queryFn: () => listCommunicationChannels(session!),
    enabled,
  });

  const updateMutation = useMutation({
    mutationFn: () => updateCommunicationChannel(session!, channelId.trim(), (channelValue ?? {}) as Record<string, unknown>),
    onSuccess: () => {
      toast.success("Channel saved");
      void queryClient.invalidateQueries({ queryKey: ["admin", "comm", "channels"] });
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : "Save failed"),
  });

  if (!session || session.actorLevel !== "L4") return null;
  const channels = channelsQuery.data?.channels ?? {};

  return (
    <div className="space-y-6 pb-16">
      <div>
        <p className="admin-eyebrow mb-2">Domain 05 · Communications</p>
        <h1 className="admin-display text-3xl">Communication channels</h1>
        <p className="admin-muted mt-1">
          Credentials are stored as secrets and shown masked as <code>{"{ __set: true }"}</code>. Resending a masked
          value keeps the stored secret.
        </p>
      </div>

      <div className="admin-panel space-y-3 p-5">
        <p className="admin-eyebrow">Configured channels (masked)</p>
        <pre className="admin-input overflow-x-auto whitespace-pre-wrap font-mono text-xs">{JSON.stringify(channels, null, 2)}</pre>
      </div>

      <div className="admin-panel space-y-3 p-5">
        <p className="admin-eyebrow">Update / add a channel</p>
        <input className="admin-input md:w-64" placeholder="Channel id (e.g. EMAIL, WHATSAPP)" value={channelId} onChange={(e) => setChannelId(e.target.value)} />
        <SmartConfigEditor value={channelValue} onChange={setChannelValue} />
        <button type="button" className="admin-btn w-fit" disabled={updateMutation.isPending || !channelId.trim()} onClick={() => updateMutation.mutate()}>
          Save channel
        </button>
      </div>

      <KeyedConfigPanel
        title="Acknowledgement window per type"
        description="Seconds allowed before each communication type's acknowledgement times out (W22). Read by every stage when computing follow-up timer SLAs."
        queryKey={["admin", "comm", "ack-window"]}
        enabled={enabled}
        configKey="acknowledgement.windowPerType"
        load={async () => (await getAcknowledgementWindow(session)).value}
        save={(v) => setAcknowledgementWindow(session, v)}
      />
    </div>
  );
}
