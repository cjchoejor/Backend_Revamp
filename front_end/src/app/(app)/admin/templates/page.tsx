"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  deactivateCommunicationTemplate,
  deactivateInvoiceTemplate,
  listCommunicationTemplates,
  listHandoffTemplates,
  listInvoiceTemplates,
} from "@/lib/api/admin";
import { useSession } from "@/hooks/use-session";
import { ApiError } from "@/lib/api/client";

export default function AdminTemplatesPage() {
  const { session } = useSession();
  const queryClient = useQueryClient();

  const commQuery = useQuery({
    queryKey: ["admin", "templates", "communication"],
    queryFn: () => listCommunicationTemplates(session!),
    enabled: !!session && session.actorLevel === "L4",
  });

  const handoffQuery = useQuery({
    queryKey: ["admin", "templates", "handoff"],
    queryFn: () => listHandoffTemplates(session!),
    enabled: !!session && session.actorLevel === "L4",
  });

  const invoiceQuery = useQuery({
    queryKey: ["admin", "templates", "invoice"],
    queryFn: () => listInvoiceTemplates(session!),
    enabled: !!session && session.actorLevel === "L4",
  });

  const deactivateCommMutation = useMutation({
    mutationFn: (id: string) => deactivateCommunicationTemplate(session!, id),
    onSuccess: () => {
      toast.success("Template deactivated");
      void queryClient.invalidateQueries({ queryKey: ["admin", "templates", "communication"] });
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : "Deactivate failed"),
  });

  const deactivateInvoiceMutation = useMutation({
    mutationFn: (id: string) => deactivateInvoiceTemplate(session!, id),
    onSuccess: () => {
      toast.success("Invoice template deactivated");
      void queryClient.invalidateQueries({ queryKey: ["admin", "templates", "invoice"] });
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : "Deactivate failed"),
  });

  return (
    <div className="space-y-8 pb-16">
      <div>
        <p className="admin-eyebrow mb-2">Domain 05 · Communications</p>
        <h1 className="admin-display text-3xl">Templates</h1>
        <p className="admin-muted mt-2 text-sm">Deactivate templates you no longer need. Handoff templates are versioned — save a new version to replace an active one.</p>
      </div>

      <section className="admin-panel p-5">
        <h2 className="admin-display mb-3 text-lg">Communication templates</h2>
        <ul className="space-y-2 text-sm">
          {(commQuery.data?.items ?? []).map((t) => (
            <li key={t.id} className="flex items-center justify-between gap-3 font-mono text-xs text-[var(--admin-ink-soft)]">
              <span>
                {t.templateKey} · {t.channel} · {t.templateType}{" "}
                {t.isActive ? "" : <span className="admin-tag-warn admin-tag ml-1">inactive</span>}
              </span>
              {t.isActive && (
                <button
                  type="button"
                  className="admin-btn shrink-0 text-[10px]"
                  onClick={() => {
                    if (window.confirm(`Deactivate template "${t.templateKey}"?`)) deactivateCommMutation.mutate(t.id);
                  }}
                >
                  Deactivate
                </button>
              )}
            </li>
          ))}
        </ul>
      </section>

      <section className="admin-panel p-5">
        <h2 className="admin-display mb-3 text-lg">Handoff checklists</h2>
        <ul className="space-y-2 text-sm">
          {(handoffQuery.data?.items ?? []).map((t) => (
            <li key={t.id} className="font-mono text-xs text-[var(--admin-ink-soft)]">
              {t.handoffType} v{t.version} {t.isActive ? <span className="admin-tag-ok admin-tag ml-1">active</span> : ""}
            </li>
          ))}
        </ul>
        <p className="admin-muted mt-2 text-xs">To retire an active handoff checklist, save a new version for that handoff type.</p>
      </section>

      <section className="admin-panel p-5">
        <h2 className="admin-display mb-3 text-lg">Invoice templates</h2>
        <ul className="space-y-2 text-sm">
          {(invoiceQuery.data?.items ?? []).map((t) => (
            <li key={t.id} className="flex items-center justify-between gap-3 font-mono text-xs text-[var(--admin-ink-soft)]">
              <span>
                {t.templateKey} · {t.invoiceType} · {t.title}
                {!t.isActive && <span className="admin-tag-warn admin-tag ml-1">inactive</span>}
              </span>
              {t.isActive && (
                <button
                  type="button"
                  className="admin-btn shrink-0 text-[10px]"
                  onClick={() => {
                    if (window.confirm(`Deactivate invoice template "${t.templateKey}"?`)) deactivateInvoiceMutation.mutate(t.id);
                  }}
                >
                  Deactivate
                </button>
              )}
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
