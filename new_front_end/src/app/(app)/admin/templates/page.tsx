"use client";

import { AdmField } from "@/components/admin/field-title";
import { Suspense, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import {
  createCommunicationTemplate,
  createInvoiceTemplate,
  createWorkOrderTemplate,
  deactivateCommunicationTemplate,
  deactivateInvoiceTemplate,
  deactivateWorkOrderTemplate,
  listCommunicationTemplates,
  listInvoiceTemplates,
  listWorkOrderTemplates,
  reactivateCommunicationTemplate,
  reactivateInvoiceTemplate,
  reactivateWorkOrderTemplate,
  updateCommunicationTemplate,
  updateInvoiceTemplate,
  updateWorkOrderTemplate,
} from "@/lib/api/admin";
import { useSession } from "@/hooks/use-session";
import { ApiError } from "@/lib/api/client";
import { useConfirm } from "@/components/providers/dialog-provider";
import type { Session } from "@/types/session";
import { Help } from "@/components/ds/help";
import { NotUsedYet, SettingsList } from "@/components/admin/settings-list";
import { Control } from "@/components/admin/setting-form";
import { codeWords } from "@/lib/admin/setting-fields";
import { PAGE_KEYS } from "@/lib/admin/setting-forms";

const err = (e: unknown, fallback: string) => toast.error(e instanceof ApiError ? e.message : fallback);
function CommunicationTemplates({ session }: { session: Session }) {
  const qc = useQueryClient();
  const confirm = useConfirm();
  const key = ["admin", "templates", "communication"];
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState({ templateKey: "", channel: "EMAIL", templateType: "QUOTATION", subjectTemplate: "", bodyTemplate: "" });
  const reset = () => {
    setForm({ templateKey: "", channel: "EMAIL", templateType: "QUOTATION", subjectTemplate: "", bodyTemplate: "" });
    setEditingId(null);
  };

  const query = useQuery({ queryKey: key, queryFn: () => listCommunicationTemplates(session) });
  const saveMutation = useMutation({
    mutationFn: () =>
      editingId
        ? updateCommunicationTemplate(session, editingId, {
            channel: form.channel,
            templateType: form.templateType,
            subjectTemplate: form.subjectTemplate || null,
            bodyTemplate: form.bodyTemplate,
          })
        : createCommunicationTemplate(session, {
            templateKey: form.templateKey,
            channel: form.channel,
            templateType: form.templateType,
            subjectTemplate: form.subjectTemplate || null,
            bodyTemplate: form.bodyTemplate,
          }),
    onSuccess: () => {
      toast.success(editingId ? "Template updated" : "Template created");
      reset();
      void qc.invalidateQueries({ queryKey: key });
    },
    onError: (e) => err(e, "Save failed"),
  });
  const deactivateMutation = useMutation({
    mutationFn: (id: string) => deactivateCommunicationTemplate(session, id),
    onSuccess: () => {
      toast.success("Deactivated");
      void qc.invalidateQueries({ queryKey: key });
    },
    onError: (e) => err(e, "Deactivate failed"),
  });
  const reactivateMutation = useMutation({
    mutationFn: (id: string) => reactivateCommunicationTemplate(session, id),
    onSuccess: () => {
      toast.success("Reactivated");
      void qc.invalidateQueries({ queryKey: key });
    },
    onError: (e) => err(e, "Reactivate failed"),
  });

  const items = query.data?.items ?? [];
  return (
    <section className="admin-panel space-y-4 p-5">
      <h2 className="admin-display text-lg">Message templates</h2>
      <NotUsedYet>The emails the desk sends are built in, so nothing reads these yet.</NotUsedYet>
      <div className="grid gap-3 md:grid-cols-3" data-edit-form>
        <AdmField label="Template key">
          <input className="admin-input" value={form.templateKey} disabled={!!editingId} onChange={(e) => setForm({ ...form, templateKey: e.target.value })} />
        </AdmField>
        <AdmField label="Sent by">
          <select className="admin-select" value={form.channel} onChange={(e) => setForm({ ...form, channel: e.target.value })}>
            <option value="EMAIL">Email</option>
            <option value="WHATSAPP">WhatsApp</option>
          </select>
        </AdmField>
        <AdmField label="Kind of message">
          <input className="admin-input" value={form.templateType} onChange={(e) => setForm({ ...form, templateType: e.target.value })} />
        </AdmField>
        <AdmField label="Subject" hint="optional" className="md:col-span-3">
          <input className="admin-input" value={form.subjectTemplate} onChange={(e) => setForm({ ...form, subjectTemplate: e.target.value })} />
        </AdmField>
        <AdmField label="Body template" hint="takes {{tokens}}" className="md:col-span-3">
          <textarea className="admin-input font-mono text-xs" rows={3} value={form.bodyTemplate} onChange={(e) => setForm({ ...form, bodyTemplate: e.target.value })} />
        </AdmField>
      </div>
      <div className="flex gap-2">
        <button type="button" className="admin-btn w-fit" disabled={saveMutation.isPending || !form.templateKey || !form.bodyTemplate} onClick={() => saveMutation.mutate()}>
          {editingId ? "Save changes" : "Create template"}
        </button>
        {editingId && <button type="button" className="admin-btn w-fit" onClick={reset}>Cancel</button>}
      </div>

      <table className="admin-table">
        <thead><tr><th>Key</th><th>Channel</th><th>Type</th><th>Status</th><th /></tr></thead>
        <tbody>
          {items.length === 0 && <tr><td colSpan={5} className="admin-muted">No communication templates.</td></tr>}
          {items.map((t) => (
            <tr key={t.id}>
              <td className="font-mono text-xs">{t.templateKey}</td>
              <td>{codeWords(t.channel)}</td>
              <td>{codeWords(t.templateType)}</td>
              <td>{t.isActive ? <span className="admin-tag admin-tag-ok">active</span> : <span className="admin-tag admin-tag-warn">inactive</span>}</td>
              <td className="text-right">
                <div className="flex justify-end gap-1">
                  <button type="button" className="admin-btn text-[10px]" onClick={() => { setEditingId(t.id); setForm({ templateKey: t.templateKey, channel: t.channel, templateType: t.templateType, subjectTemplate: "", bodyTemplate: t.bodyTemplate }); }}>Edit</button>
                  {t.isActive ? (
                    <button type="button" className="admin-btn text-[10px]" onClick={async () => {
                      const ok = await confirm({
                        title: "Deactivate template",
                        message: `Deactivate "${t.templateKey}"? Sent communications carry a frozen snapshot and are unaffected. New sends will use the next active version (if any).`,
                        confirmLabel: "Deactivate",
                        variant: "danger",
                      });
                      if (ok) deactivateMutation.mutate(t.id);
                    }}>Deactivate</button>
                  ) : (
                    <button type="button" className="admin-btn admin-btn-success text-[10px]" disabled={reactivateMutation.isPending} onClick={() => reactivateMutation.mutate(t.id)}>Reactivate</button>
                  )}
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

function InvoiceTemplates({ session }: { session: Session }) {
  const qc = useQueryClient();
  const confirm = useConfirm();
  const key = ["admin", "templates", "invoice"];
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState({ templateKey: "", invoiceType: "FINAL" as "PROFORMA" | "FINAL", title: "", bodyTemplate: "" });
  const reset = () => { setForm({ templateKey: "", invoiceType: "FINAL", title: "", bodyTemplate: "" }); setEditingId(null); };

  const query = useQuery({ queryKey: key, queryFn: () => listInvoiceTemplates(session) });
  const saveMutation = useMutation({
    mutationFn: () =>
      editingId
        ? updateInvoiceTemplate(session, editingId, { title: form.title, bodyTemplate: form.bodyTemplate })
        : createInvoiceTemplate(session, { templateKey: form.templateKey, invoiceType: form.invoiceType, title: form.title, bodyTemplate: form.bodyTemplate }),
    onSuccess: () => { toast.success(editingId ? "Updated" : "Created"); reset(); void qc.invalidateQueries({ queryKey: key }); },
    onError: (e) => err(e, "Save failed"),
  });
  const deactivateMutation = useMutation({
    mutationFn: (id: string) => deactivateInvoiceTemplate(session, id),
    onSuccess: () => { toast.success("Deactivated"); void qc.invalidateQueries({ queryKey: key }); },
    onError: (e) => err(e, "Deactivate failed"),
  });
  const reactivateMutation = useMutation({
    mutationFn: (id: string) => reactivateInvoiceTemplate(session, id),
    onSuccess: () => { toast.success("Reactivated"); void qc.invalidateQueries({ queryKey: key }); },
    onError: (e) => err(e, "Reactivate failed"),
  });

  const items = query.data?.items ?? [];
  return (
    <section className="admin-panel space-y-4 p-5">
      <h2 className="admin-display text-lg">Invoice templates</h2>
      <NotUsedYet>The bills' layouts are built in, so nothing reads these yet.</NotUsedYet>
      <div className="grid gap-3 md:grid-cols-3" data-edit-form>
        <AdmField label="Template key">
          <input className="admin-input" value={form.templateKey} disabled={!!editingId} onChange={(e) => setForm({ ...form, templateKey: e.target.value })} />
        </AdmField>
        <AdmField label="Kind of bill">
          <select className="admin-select" value={form.invoiceType} disabled={!!editingId} onChange={(e) => setForm({ ...form, invoiceType: e.target.value as "PROFORMA" | "FINAL" })}>
            <option value="PROFORMA">Proforma</option>
            <option value="FINAL">Tax invoice</option>
          </select>
        </AdmField>
        <AdmField label="Title">
          <input className="admin-input" value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} />
        </AdmField>
        <AdmField label="Body template" className="md:col-span-3">
          <textarea className="admin-input font-mono text-xs" rows={3} value={form.bodyTemplate} onChange={(e) => setForm({ ...form, bodyTemplate: e.target.value })} />
        </AdmField>
      </div>
      <div className="flex gap-2">
        <button type="button" className="admin-btn w-fit" disabled={saveMutation.isPending || !form.templateKey || !form.title} onClick={() => saveMutation.mutate()}>{editingId ? "Save changes" : "Create template"}</button>
        {editingId && <button type="button" className="admin-btn w-fit" onClick={reset}>Cancel</button>}
      </div>

      <table className="admin-table">
        <thead><tr><th>Key</th><th>Type</th><th>Title</th><th>Status</th><th /></tr></thead>
        <tbody>
          {items.length === 0 && <tr><td colSpan={5} className="admin-muted">No invoice templates.</td></tr>}
          {items.map((t) => (
            <tr key={t.id}>
              <td className="font-mono text-xs">{t.templateKey}</td>
              <td>{t.invoiceType === "FINAL" ? "Tax invoice" : "Proforma"}</td>
              <td>{t.title}</td>
              <td>{t.isActive ? <span className="admin-tag admin-tag-ok">active</span> : <span className="admin-tag admin-tag-warn">inactive</span>}</td>
              <td className="text-right">
                <div className="flex justify-end gap-1">
                  <button type="button" className="admin-btn text-[10px]" onClick={() => { setEditingId(t.id); setForm({ templateKey: t.templateKey, invoiceType: t.invoiceType as "PROFORMA" | "FINAL", title: t.title, bodyTemplate: "" }); }}>Edit</button>
                  {t.isActive ? (
                    <button type="button" className="admin-btn text-[10px]" onClick={async () => {
                      const ok = await confirm({
                        title: "Deactivate template",
                        message: `Deactivate "${t.templateKey}"? Sent communications carry a frozen snapshot and are unaffected. New sends will use the next active version (if any).`,
                        confirmLabel: "Deactivate",
                        variant: "danger",
                      });
                      if (ok) deactivateMutation.mutate(t.id);
                    }}>Deactivate</button>
                  ) : (
                    <button type="button" className="admin-btn admin-btn-success text-[10px]" disabled={reactivateMutation.isPending} onClick={() => reactivateMutation.mutate(t.id)}>Reactivate</button>
                  )}
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

function WorkOrderTemplates({ session }: { session: Session }) {
  const qc = useQueryClient();
  const confirm = useConfirm();
  const key = ["admin", "templates", "work-order"];
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState({ templateKey: "", title: "", useType: "", todoItems: [] as string[] });
  const reset = () => { setForm({ templateKey: "", title: "", useType: "", todoItems: [] }); setEditingId(null); };

  const query = useQuery({ queryKey: key, queryFn: () => listWorkOrderTemplates(session) });
  const saveMutation = useMutation({
    mutationFn: () => {
      const todoItems = form.todoItems.map((description) => ({ description }));
      return editingId
        ? updateWorkOrderTemplate(session, editingId, { title: form.title, todoItems })
        : createWorkOrderTemplate(session, { templateKey: form.templateKey, title: form.title, useType: form.useType || null, todoItems });
    },
    onSuccess: () => { toast.success(editingId ? "Updated" : "Created"); reset(); void qc.invalidateQueries({ queryKey: key }); },
    onError: (e) => err(e, "Save failed"),
  });
  const deactivateMutation = useMutation({
    mutationFn: (id: string) => deactivateWorkOrderTemplate(session, id),
    onSuccess: () => { toast.success("Deactivated"); void qc.invalidateQueries({ queryKey: key }); },
    onError: (e) => err(e, "Deactivate failed"),
  });
  const reactivateMutation = useMutation({
    mutationFn: (id: string) => reactivateWorkOrderTemplate(session, id),
    onSuccess: () => { toast.success("Reactivated"); void qc.invalidateQueries({ queryKey: key }); },
    onError: (e) => err(e, "Reactivate failed"),
  });

  const items = query.data?.items ?? [];
  return (
    <section className="admin-panel space-y-4 p-5">
      <h2 className="admin-display text-lg">Work order templates</h2>
      <NotUsedYet>Nothing makes a work order from these yet.</NotUsedYet>
      <div className="grid gap-3 md:grid-cols-3" data-edit-form>
        <AdmField label="Template key">
          <input className="admin-input" value={form.templateKey} disabled={!!editingId} onChange={(e) => setForm({ ...form, templateKey: e.target.value })} />
        </AdmField>
        <AdmField label="Title">
          <input className="admin-input" value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} />
        </AdmField>
        <AdmField label="Use type" hint="optional">
          <input className="admin-input" value={form.useType} disabled={!!editingId} onChange={(e) => setForm({ ...form, useType: e.target.value })} />
        </AdmField>
        <div className="sf-field md:col-span-3">
          <span className="sf-label">To do</span>
          <Control f={{ kind: "tags", label: "To do", placeholder: "Check the minibar", addLabel: "Add" }} value={form.todoItems} onChange={(v) => setForm({ ...form, todoItems: v as string[] })} />
        </div>
      </div>
      <div className="flex gap-2">
        <button type="button" className="admin-btn w-fit" disabled={saveMutation.isPending || !form.templateKey || !form.title} onClick={() => saveMutation.mutate()}>{editingId ? "Save changes" : "Create template"}</button>
        {editingId && <button type="button" className="admin-btn w-fit" onClick={reset}>Cancel</button>}
      </div>

      <table className="admin-table">
        <thead><tr><th>Key</th><th>Title</th><th>Use type</th><th>Status</th><th /></tr></thead>
        <tbody>
          {items.length === 0 && <tr><td colSpan={5} className="admin-muted">No work order templates.</td></tr>}
          {items.map((t) => (
            <tr key={t.id}>
              <td className="font-mono text-xs">{t.templateKey}</td>
              <td>{t.title}</td>
              <td>{t.useType ?? "—"}</td>
              <td>{t.isActive ? <span className="admin-tag admin-tag-ok">active</span> : <span className="admin-tag admin-tag-warn">inactive</span>}</td>
              <td className="text-right">
                <div className="flex justify-end gap-1">
                  <button type="button" className="admin-btn text-[10px]" onClick={() => { setEditingId(t.id); setForm({ templateKey: t.templateKey, title: t.title, useType: t.useType ?? "", todoItems: Array.isArray(t.todoItems) ? (t.todoItems as Array<{ description?: string }>).map((i) => i.description ?? "").filter(Boolean) : [] }); }}>Edit</button>
                  {t.isActive ? (
                    <button type="button" className="admin-btn text-[10px]" onClick={async () => {
                      const ok = await confirm({
                        title: "Deactivate template",
                        message: `Deactivate "${t.templateKey}"? Sent communications carry a frozen snapshot and are unaffected. New sends will use the next active version (if any).`,
                        confirmLabel: "Deactivate",
                        variant: "danger",
                      });
                      if (ok) deactivateMutation.mutate(t.id);
                    }}>Deactivate</button>
                  ) : (
                    <button type="button" className="admin-btn admin-btn-success text-[10px]" disabled={reactivateMutation.isPending} onClick={() => reactivateMutation.mutate(t.id)}>Reactivate</button>
                  )}
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

export default function AdminTemplatesPage() {
  const { session } = useSession();
  if (!session || session.actorLevel !== "L4") return null;

  return (
    <div className="space-y-8 pb-16">
      <div>
        <p className="admin-eyebrow mb-2">Messages</p>
        <h1 className="admin-display flex items-center gap-2 text-3xl">
          Templates
          <Help label="Templates">The checklists the desk uses at each handoff, and the layouts kept on file.</Help>
        </h1>
      </div>
      <Suspense>
        <SettingsList groups={[{ title: "Handoff checklists", keys: PAGE_KEYS.handoffs }]} />
      </Suspense>
      <CommunicationTemplates session={session} />
      <InvoiceTemplates session={session} />
      <WorkOrderTemplates session={session} />
    </div>
  );
}
