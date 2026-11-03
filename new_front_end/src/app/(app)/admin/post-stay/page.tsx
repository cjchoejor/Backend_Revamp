"use client";

import { AdmField } from "@/components/admin/field-title";
import { Suspense, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { NotUsedYet, SettingsList } from "@/components/admin/settings-list";
import { Control } from "@/components/admin/setting-form";
import { PAGE_KEYS } from "@/lib/admin/setting-forms";
import { useSession } from "@/hooks/use-session";
import {
  createFeedbackTemplate,
  deactivateFeedbackTemplate,
  listFeedbackTemplates,
  reactivateFeedbackTemplate,
  type FeedbackTemplateAdmin,
} from "@/lib/api/admin";
import { ApiError } from "@/lib/api/client";

export default function AdminPostStayPage() {
  const { session } = useSession();
  const queryClient = useQueryClient();
  const [form, setForm] = useState<{ templateKey: string; title: string; questions: string[] }>({ templateKey: "", title: "", questions: [] });
  const enabled = !!session && session.actorLevel === "L4";

  const templatesQuery = useQuery({
    queryKey: ["admin", "post-stay", "feedback-templates"],
    queryFn: () => listFeedbackTemplates(session!),
    enabled,
  });

  const createMutation = useMutation({
    mutationFn: () => createFeedbackTemplate(session!, { templateKey: form.templateKey, title: form.title, questions: form.questions.map((text) => ({ text })) }),
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
        <p className="admin-eyebrow mb-2">After the stay</p>
        <h1 className="admin-display text-3xl">Feedback and records</h1>
      </div>

      <Suspense>
        <SettingsList groups={[{ keys: PAGE_KEYS.postStay }]} />
      </Suspense>

      <div className="admin-panel space-y-3 p-5">
        <h2 className="admin-display text-lg">Feedback surveys</h2>
        <NotUsedYet>The feedback email is built in, so nothing reads these surveys yet.</NotUsedYet>
        <div className="grid gap-3 md:grid-cols-2">
          <AdmField label="A short name">
            <input className="admin-input" value={form.templateKey} onChange={(e) => setForm({ ...form, templateKey: e.target.value })} />
          </AdmField>
          <AdmField label="Title">
            <input className="admin-input" value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} />
          </AdmField>
        </div>
        <div className="sf-field">
          <span className="sf-label">Questions</span>
          <Control f={{ kind: "tags", label: "Questions", placeholder: "How was your stay?", addLabel: "Add" }} value={form.questions} onChange={(v) => setForm({ ...form, questions: v as string[] })} />
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

    </div>
  );
}
