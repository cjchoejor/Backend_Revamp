"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { KeyedConfigPanel } from "@/components/admin/keyed-config-panel";
import { useSession } from "@/hooks/use-session";
import {
  createFeedbackTemplate,
  deactivateFeedbackTemplate,
  getPostStayValue,
  listFeedbackTemplates,
  reactivateFeedbackTemplate,
  setPostStayValue,
  type FeedbackTemplateAdmin,
} from "@/lib/api/admin";
import { ApiError } from "@/lib/api/client";
import { SmartConfigEditor } from "@/components/admin/smart-config-editor";

export default function AdminPostStayPage() {
  const { session } = useSession();
  const queryClient = useQueryClient();
  const [form, setForm] = useState<{ templateKey: string; title: string; questions: unknown }>({ templateKey: "", title: "", questions: [] });
  const enabled = !!session && session.actorLevel === "L4";

  const templatesQuery = useQuery({
    queryKey: ["admin", "post-stay", "feedback-templates"],
    queryFn: () => listFeedbackTemplates(session!),
    enabled,
  });

  const createMutation = useMutation({
    mutationFn: () => createFeedbackTemplate(session!, { templateKey: form.templateKey, title: form.title, questions: form.questions }),
    onSuccess: () => {
      toast.success("Feedback template created");
      setForm({ templateKey: "", title: "", questions: [] });
      void queryClient.invalidateQueries({ queryKey: ["admin", "post-stay", "feedback-templates"] });
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : "Create failed"),
  });

  const deactivateMutation = useMutation({
    mutationFn: (id: string) => deactivateFeedbackTemplate(session!, id),
    onSuccess: () => {
      toast.success("Template deactivated");
      void queryClient.invalidateQueries({ queryKey: ["admin", "post-stay", "feedback-templates"] });
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : "Deactivate failed"),
  });

  const reactivateMutation = useMutation({
    mutationFn: (id: string) => reactivateFeedbackTemplate(session!, id),
    onSuccess: () => {
      toast.success("Template reactivated");
      void queryClient.invalidateQueries({ queryKey: ["admin", "post-stay", "feedback-templates"] });
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : "Reactivate failed"),
  });

  if (!session || session.actorLevel !== "L4") return null;
  const templates = templatesQuery.data?.items ?? [];

  return (
    <div className="space-y-6 pb-16">
      <div>
        <p className="admin-eyebrow mb-2">Domain 07 · Post-stay &amp; governance</p>
        <h1 className="admin-display text-3xl">Post-stay &amp; governance</h1>
      </div>

      <div className="admin-panel space-y-3 p-5">
        <p className="admin-eyebrow">Feedback survey templates</p>
        <div className="grid gap-3 md:grid-cols-2">
          <input className="admin-input" placeholder="Template key" value={form.templateKey} onChange={(e) => setForm({ ...form, templateKey: e.target.value })} />
          <input className="admin-input" placeholder="Title" value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} />
        </div>
        <div>
          <p className="admin-muted mb-1 text-xs">Survey questions</p>
          <SmartConfigEditor value={form.questions} onChange={(v) => setForm({ ...form, questions: v })} />
        </div>
        <button type="button" className="admin-btn w-fit" disabled={createMutation.isPending || !form.templateKey} onClick={() => createMutation.mutate()}>
          Create template
        </button>

        <table className="admin-table mt-3">
          <thead><tr><th>Key</th><th>Title</th><th>Status</th><th /></tr></thead>
          <tbody>
            {templates.length === 0 && <tr><td colSpan={4} className="admin-muted">No feedback templates.</td></tr>}
            {templates.map((t: FeedbackTemplateAdmin) => (
              <tr key={t.id}>
                <td className="font-mono text-xs">{t.templateKey}</td>
                <td>{t.title}</td>
                <td>{t.isActive ? <span className="admin-tag admin-tag-ok">active</span> : <span className="admin-tag admin-tag-warn">inactive</span>}</td>
                <td className="text-right">
                  {t.isActive ? (
                    <button type="button" className="admin-btn text-[10px]" onClick={() => deactivateMutation.mutate(t.id)}>Deactivate</button>
                  ) : (
                    <button type="button" className="admin-btn admin-btn-success text-[10px]" disabled={reactivateMutation.isPending} onClick={() => reactivateMutation.mutate(t.id)}>Reactivate</button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <KeyedConfigPanel title="Online review platform links" queryKey={["admin", "post-stay", "platform-links"]} enabled={enabled} load={async () => (await getPostStayValue(session, "platform-links")).value} save={(v) => setPostStayValue(session, "platform-links", v)} />
      <KeyedConfigPanel title="Government portal submission config" queryKey={["admin", "post-stay", "government-portal"]} enabled={enabled} load={async () => (await getPostStayValue(session, "government-portal")).value} save={(v) => setPostStayValue(session, "government-portal", v)} />
      <KeyedConfigPanel title="Commission calculation basis" queryKey={["admin", "post-stay", "commission-basis"]} enabled={enabled} load={async () => (await getPostStayValue(session, "commission-basis")).value} save={(v) => setPostStayValue(session, "commission-basis", v)} />
      <div className="admin-panel border-amber-500/30 bg-amber-500/5 p-3 text-xs text-[var(--admin-ink-soft)]">
        <p>
          <strong>Heads up:</strong> &ldquo;Identity document types&rdquo; lists the kinds of ID your hotel accepts
          (Passport, National ID, …) &mdash; <em>not</em> attributes captured about each guest. Each entry has a fixed
          shape (<span className="font-mono">documentTypeCode</span>, <span className="font-mono">documentTypeName</span>,{" "}
          <span className="font-mono">isActive</span>) that operational code matches against. If you want to capture
          something like gender or date of birth, that&rsquo;s a Guest Profile field &mdash; not a document type.
        </p>
      </div>
      <KeyedConfigPanel title="Identity document types" description="Catalogue of accepted ID document types. Array of { documentTypeCode, documentTypeName, isActive }." queryKey={["admin", "post-stay", "identity-document-types"]} enabled={enabled} load={async () => (await getPostStayValue(session, "identity-document-types")).value} save={(v) => setPostStayValue(session, "identity-document-types", v)} />
      <KeyedConfigPanel title="Identity retention period (days)" description="Retention per document type (JSON object)." queryKey={["admin", "post-stay", "identity-retention"]} enabled={enabled} load={async () => (await getPostStayValue(session, "identity-retention")).value} save={(v) => setPostStayValue(session, "identity-retention", v)} />
    </div>
  );
}
