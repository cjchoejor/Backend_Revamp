"use client";

import { useState } from "react";
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
  listHandoffTemplates,
  listInvoiceTemplates,
  listWorkOrderTemplates,
  reactivateCommunicationTemplate,
  reactivateInvoiceTemplate,
  reactivateWorkOrderTemplate,
  saveHandoffTemplate,
  updateCommunicationTemplate,
  updateInvoiceTemplate,
  updateWorkOrderTemplate,
} from "@/lib/api/admin";
import { useSession } from "@/hooks/use-session";
import { ApiError } from "@/lib/api/client";
import type { Session } from "@/types/session";

const err = (e: unknown, fallback: string) => toast.error(e instanceof ApiError ? e.message : fallback);
const linesToItems = (text: string) =>
  text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

function CommunicationTemplates({ session }: { session: Session }) {
  const qc = useQueryClient();
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
      <h2 className="admin-display text-lg">Communication templates</h2>
      <div className="grid gap-3 md:grid-cols-3">
        <input className="admin-input" placeholder="Template key" value={form.templateKey} disabled={!!editingId} onChange={(e) => setForm({ ...form, templateKey: e.target.value })} />
        <select className="admin-select" value={form.channel} onChange={(e) => setForm({ ...form, channel: e.target.value })}>
          <option value="EMAIL">EMAIL</option>
          <option value="WHATSAPP">WHATSAPP</option>
        </select>
        <input className="admin-input" placeholder="Type (e.g. QUOTATION)" value={form.templateType} onChange={(e) => setForm({ ...form, templateType: e.target.value })} />
        <input className="admin-input md:col-span-3" placeholder="Subject (optional)" value={form.subjectTemplate} onChange={(e) => setForm({ ...form, subjectTemplate: e.target.value })} />
        <textarea className="admin-input md:col-span-3 font-mono text-xs" rows={3} placeholder="Body template — supports {{tokens}}" value={form.bodyTemplate} onChange={(e) => setForm({ ...form, bodyTemplate: e.target.value })} />
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
              <td>{t.channel}</td>
              <td>{t.templateType}</td>
              <td>{t.isActive ? <span className="admin-tag admin-tag-ok">active</span> : <span className="admin-tag admin-tag-warn">inactive</span>}</td>
              <td className="text-right">
                <div className="flex justify-end gap-1">
                  <button type="button" className="admin-btn text-[10px]" onClick={() => { setEditingId(t.id); setForm({ templateKey: t.templateKey, channel: t.channel, templateType: t.templateType, subjectTemplate: "", bodyTemplate: t.bodyTemplate }); }}>Edit</button>
                  {t.isActive ? (
                    <button type="button" className="admin-btn text-[10px]" onClick={() => { if (window.confirm(`Deactivate "${t.templateKey}"?`)) deactivateMutation.mutate(t.id); }}>Deactivate</button>
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

function HandoffTemplates({ session }: { session: Session }) {
  const qc = useQueryClient();
  const key = ["admin", "templates", "handoff"];
  const [handoffType, setHandoffType] = useState<"H1" | "H2" | "H3" | "H4">("H1");
  const [items, setItems] = useState("Confirmation voucher on file\nAdvance payment status reviewed");

  const query = useQuery({ queryKey: key, queryFn: () => listHandoffTemplates(session) });
  const saveMutation = useMutation({
    mutationFn: () =>
      saveHandoffTemplate(session, {
        handoffType,
        checklistItems: linesToItems(items).map((description, i) => ({ itemKey: `item_${i + 1}`, description, isRequired: true })),
      }),
    onSuccess: () => {
      toast.success(`${handoffType} checklist saved (new version)`);
      void qc.invalidateQueries({ queryKey: key });
    },
    onError: (e) => err(e, "Save failed"),
  });

  const rows = query.data?.items ?? [];
  return (
    <section className="admin-panel space-y-4 p-5">
      <h2 className="admin-display text-lg">Handoff checklists</h2>
      <p className="admin-muted text-xs">Checklists are versioned — saving creates a new active version for that handoff type.</p>
      <div className="grid gap-3 md:grid-cols-[160px_1fr]">
        <select className="admin-select" value={handoffType} onChange={(e) => setHandoffType(e.target.value as typeof handoffType)}>
          {(["H1", "H2", "H3", "H4"] as const).map((h) => <option key={h} value={h}>{h}</option>)}
        </select>
        <textarea className="admin-input font-mono text-xs" rows={4} placeholder="One checklist item per line" value={items} onChange={(e) => setItems(e.target.value)} />
      </div>
      <button type="button" className="admin-btn w-fit" disabled={saveMutation.isPending} onClick={() => saveMutation.mutate()}>Save {handoffType} version</button>

      <table className="admin-table">
        <thead><tr><th>Type</th><th>Version</th><th>Items</th><th>Status</th></tr></thead>
        <tbody>
          {rows.length === 0 && <tr><td colSpan={4} className="admin-muted">No handoff checklists.</td></tr>}
          {rows.map((t) => (
            <tr key={t.id}>
              <td className="font-mono text-xs">{t.handoffType}</td>
              <td>v{t.version}</td>
              <td className="text-xs">{Array.isArray(t.checklistItems) ? (t.checklistItems as Array<{ description?: string }>).map((i) => i.description).filter(Boolean).join(", ") : "—"}</td>
              <td>{t.isActive ? <span className="admin-tag admin-tag-ok">active</span> : <span className="admin-tag admin-tag-warn">superseded</span>}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}

function InvoiceTemplates({ session }: { session: Session }) {
  const qc = useQueryClient();
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
      <p className="admin-muted text-xs">At least one active PROFORMA and one active FINAL template are required before S3 / S8.</p>
      <div className="grid gap-3 md:grid-cols-3">
        <input className="admin-input" placeholder="Template key" value={form.templateKey} disabled={!!editingId} onChange={(e) => setForm({ ...form, templateKey: e.target.value })} />
        <select className="admin-select" value={form.invoiceType} disabled={!!editingId} onChange={(e) => setForm({ ...form, invoiceType: e.target.value as "PROFORMA" | "FINAL" })}>
          <option value="PROFORMA">PROFORMA</option>
          <option value="FINAL">FINAL</option>
        </select>
        <input className="admin-input" placeholder="Title" value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} />
        <textarea className="admin-input md:col-span-3 font-mono text-xs" rows={3} placeholder="Body template" value={form.bodyTemplate} onChange={(e) => setForm({ ...form, bodyTemplate: e.target.value })} />
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
              <td>{t.invoiceType}</td>
              <td>{t.title}</td>
              <td>{t.isActive ? <span className="admin-tag admin-tag-ok">active</span> : <span className="admin-tag admin-tag-warn">inactive</span>}</td>
              <td className="text-right">
                <div className="flex justify-end gap-1">
                  <button type="button" className="admin-btn text-[10px]" onClick={() => { setEditingId(t.id); setForm({ templateKey: t.templateKey, invoiceType: t.invoiceType as "PROFORMA" | "FINAL", title: t.title, bodyTemplate: "" }); }}>Edit</button>
                  {t.isActive ? (
                    <button type="button" className="admin-btn text-[10px]" onClick={() => { if (window.confirm(`Deactivate "${t.templateKey}"?`)) deactivateMutation.mutate(t.id); }}>Deactivate</button>
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
  const key = ["admin", "templates", "work-order"];
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState({ templateKey: "", title: "", useType: "", todoItems: "" });
  const reset = () => { setForm({ templateKey: "", title: "", useType: "", todoItems: "" }); setEditingId(null); };

  const query = useQuery({ queryKey: key, queryFn: () => listWorkOrderTemplates(session) });
  const saveMutation = useMutation({
    mutationFn: () => {
      const todoItems = linesToItems(form.todoItems).map((description) => ({ description }));
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
      <div className="grid gap-3 md:grid-cols-3">
        <input className="admin-input" placeholder="Template key" value={form.templateKey} disabled={!!editingId} onChange={(e) => setForm({ ...form, templateKey: e.target.value })} />
        <input className="admin-input" placeholder="Title" value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} />
        <input className="admin-input" placeholder="Use type (optional)" value={form.useType} disabled={!!editingId} onChange={(e) => setForm({ ...form, useType: e.target.value })} />
        <textarea className="admin-input md:col-span-3 font-mono text-xs" rows={3} placeholder="One to-do item per line" value={form.todoItems} onChange={(e) => setForm({ ...form, todoItems: e.target.value })} />
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
                  <button type="button" className="admin-btn text-[10px]" onClick={() => { setEditingId(t.id); setForm({ templateKey: t.templateKey, title: t.title, useType: t.useType ?? "", todoItems: Array.isArray(t.todoItems) ? (t.todoItems as Array<{ description?: string }>).map((i) => i.description ?? "").join("\n") : "" }); }}>Edit</button>
                  {t.isActive ? (
                    <button type="button" className="admin-btn text-[10px]" onClick={() => { if (window.confirm(`Deactivate "${t.templateKey}"?`)) deactivateMutation.mutate(t.id); }}>Deactivate</button>
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
        <p className="admin-eyebrow mb-2">Domain 05 · Communications</p>
        <h1 className="admin-display text-3xl">Templates</h1>
        <p className="admin-muted mt-2 text-sm">Create, edit, and retire communication, handoff, invoice, and work-order templates.</p>
      </div>
      <CommunicationTemplates session={session} />
      <HandoffTemplates session={session} />
      <InvoiceTemplates session={session} />
      <WorkOrderTemplates session={session} />
    </div>
  );
}
