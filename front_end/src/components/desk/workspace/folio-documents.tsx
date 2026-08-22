"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Eye, EyeOff, FileText, Landmark, Receipt, ScrollText } from "lucide-react";
import { toast } from "sonner";
import { useSession } from "@/hooks/use-session";
import { ApiError } from "@/lib/api/client";
import {
  getFolioDocuments,
  openFolioDocumentPdf,
  openInvoicePdf,
  type FolioDocumentEntry,
  type FolioDocumentKind,
} from "@/lib/api/documents";
import { issueFinalInvoice } from "@/lib/api/checkout";
import { dispatchInvoice } from "@/lib/api/reservation-setup";
import { PdfButton } from "./pdf-button";
import { FolioDocumentPreview, IssuedInvoicePreview } from "./quotation-preview";
import type { EntryDetail } from "@/types/api";

/**
 * Bills & statements (2026-08-22, operator request: "tentative invoice, tax invoice, master
 * invoice — all indicative in S7; final in S8"). Three documents, all VIEWS of the one folio, so
 * the block sits right under the live folio they are views of:
 *
 *   Tentative invoice  — the interim folio statement: the mid-stay handout ("where do I stand?").
 *   Master bill        — the rollup by component + settlement position: the bill signed at check-out.
 *   Tax invoice        — a DRAFT (no serial, watermark) until settlement issues the one original.
 *
 * The backend's index (`GET /api/entries/:id/folio-documents`) says what exists, in which state
 * and why — the desk prints those words, it does not derive them. Nothing here computes money.
 */

function BlockH({ children }: { children: React.ReactNode }) {
  return (
    <div className="block-h">
      {children}
      <span className="ln" />
    </div>
  );
}

const ICON: Record<FolioDocumentKind, React.ComponentType<{ style?: React.CSSProperties }>> = {
  "interim-statement": ScrollText,
  "master-bill": Receipt,
  "tax-invoice": Landmark,
};

const INVOICE_STATE_LABEL: Record<string, string> = {
  DRAFT: "Issued · ready to send",
  DISPATCHED: "Issued · sent",
  PAYMENT_TRACKED: "Issued · payment tracked",
  RECONCILED: "Issued · reconciled",
  SUPERSEDED: "Superseded",
};

function stateTag(d: FolioDocumentEntry): { label: string; ok?: boolean; warn?: boolean } {
  switch (d.state) {
    case "SNAPSHOT":
      return { label: "Snapshot · as at now" };
    case "INDICATIVE":
      return { label: "Indicative · charges still posting", warn: true };
    case "FROZEN":
      return {
        label: `Frozen at settlement${d.reprintCount != null ? ` · ${d.reprintCount} print${d.reprintCount === 1 ? "" : "s"}` : ""}`,
        ok: true,
      };
    case "DRAFT":
      return { label: "Draft · no serial yet", warn: true };
    case "ISSUED":
      return { label: INVOICE_STATE_LABEL[d.invoice?.state ?? ""] ?? `Issued · ${d.invoice?.state ?? ""}`, ok: true };
    default:
      return { label: "Not available" };
  }
}

/**
 * `stage` decides the desk's framing, never what exists (the index does):
 *   S7 — every document, a muted row explaining one that is not available yet;
 *   S8 — only what the check-out desk works with, plus the fiscal Issue / Send controls;
 *   S9 — read-only reprints of the sealed bill and the issued invoice (the Closed step keeps its
 *        own post-stay invoice controls).
 */
export function FolioDocumentsBlock({ entry, stage }: { entry: EntryDetail; stage: "S7" | "S8" | "S9" }) {
  const { session } = useSession();
  const queryClient = useQueryClient();
  const folio = entry.folio;
  // Re-read whenever the ledger moves — a posted charge, a payment, the settlement or an issued
  // invoice changes both the index and what an open preview should show. The STAGE is part of
  // the key too: the index's availability is stage-aware (the tentative invoice retires at S8),
  // and a S7→S8 transition leaves the ledger itself unchanged — without the stage in the key the
  // block kept serving the S7 answer from the cache after the move (found live 2026-08-22).
  const ledgerKey = [
    entry.currentStage,
    folio?.state ?? "",
    folio?.lines?.length ?? 0,
    String(folio?.outstandingBalance ?? ""),
    folio?.payments?.length ?? 0,
    (folio?.invoices ?? []).map((i) => `${i.id}:${i.state}`).join(","),
  ].join("|");
  const index = useQuery({
    queryKey: ["folio-documents", entry.id, ledgerKey],
    queryFn: () => getFolioDocuments(session!, entry.id),
    enabled: !!session && !!folio,
  });
  const [open, setOpen] = useState<FolioDocumentKind | null>(null);

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ["entry", entry.id] });
    void queryClient.invalidateQueries({ queryKey: ["entry-trace", entry.id] });
    void queryClient.invalidateQueries({ queryKey: ["folio-documents", entry.id] });
    // Dispatch mints a FINAL_INVOICE communication (2026-08-17) — the S9 answer block reads
    // its own feed (every-dispatch-invalidates rule).
    void queryClient.invalidateQueries({ queryKey: ["entry-communications", entry.id] });
  };
  const issueM = useMutation({
    mutationFn: () => issueFinalInvoice(session!, folio!.id, entry.id),
    onSuccess: () => {
      toast.success("Tax invoice issued — dispatch it to the guest next");
      invalidate();
    },
    onError: (e: unknown) => toast.error(e instanceof ApiError ? e.message : "Could not issue the tax invoice"),
  });
  const dispatchM = useMutation({
    mutationFn: (invoiceId: string) => dispatchInvoice(session!, invoiceId),
    onSuccess: () => {
      toast.success("Tax invoice dispatched");
      invalidate();
    },
    onError: (e: unknown) => toast.error(e instanceof ApiError ? e.message : "Dispatch failed"),
  });

  if (!folio || !session) return null;

  const docs = index.data?.documents ?? [];
  // S7 shows every document (a muted row explains one that is not available yet); S8 shows
  // only what the check-out desk works with — the interim statement's job ended at the stay.
  const rows = stage === "S7" ? docs : docs.filter((d) => d.available);
  const sealed = !!index.data?.sealedAt;

  return (
    <div className="block">
      <BlockH>
        <FileText style={{ width: 13, height: 13 }} />
        {stage === "S8" ? "Bills for check-out" : "Bills & statements"}
      </BlockH>
      <p style={{ fontSize: 11.5, color: "var(--ink-3)", margin: "0 0 9px", lineHeight: 1.55 }}>
        {stage === "S7" ? (
          <>
            Every bill here is a <b>view of the live folio above</b> — nothing is numbered or stored, each print is a
            snapshot as at now. Hand the guest the <b>tentative invoice</b>; the tax invoice stays a draft until
            settlement issues the one original at check-out.
          </>
        ) : sealed ? (
          <>
            Settlement sealed the folio: the <b>master bill</b> is frozen (reprints carry an ordinal) and the{" "}
            <b>tax invoice</b> is issued once, then served only from its stored original.
          </>
        ) : (
          <>
            Before money is taken: print the <b>master bill</b> for the guest&rsquo;s signature and check the tax
            invoice <b>draft</b> — its particulars become the one original at settlement.
          </>
        )}
      </p>

      {index.isLoading && <p style={{ fontSize: 11.5, color: "var(--ink-3)" }}>Reading the folio…</p>}
      {index.isError && (
        <p style={{ fontSize: 11.5, color: "var(--warn)" }}>
          {index.error instanceof Error ? index.error.message : "Could not read the folio documents."}
        </p>
      )}

      <div style={{ display: "grid", gap: 8 }}>
        {rows.map((d) => {
          const Icon = ICON[d.kind];
          const tag = stateTag(d);
          const isOpen = open === d.kind;
          const issued = d.state === "ISSUED" && d.invoice;
          const refreshKey = `${ledgerKey}|${index.data?.asAt ?? ""}`;
          return (
            <div key={d.kind}>
              <div
                className={`fact ${d.available ? "b-transit" : ""}`}
                style={{
                  padding: "7px 11px",
                  fontSize: 12,
                  justifyContent: "space-between",
                  width: "100%",
                  opacity: d.available ? 1 : 0.7,
                }}
              >
                <span style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                  <Icon style={{ width: 13, height: 13 }} />
                  <b>{d.title}</b>
                  {issued && <span className="mono">{d.invoice!.invoiceNumber}</span>}
                  <span style={{ color: "var(--ink-3)" }}>{d.subtitle}</span>
                </span>
                <span style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                  <span className={`tag${tag.ok ? " ok" : tag.warn ? " warn" : ""}`}>{tag.label}</span>
                  {d.available && (
                    <button
                      type="button"
                      className="btn btn-ghost btn-sm"
                      onClick={() => setOpen(isOpen ? null : d.kind)}
                      title={issued ? "Show the issued document right here" : "Show the document right here — no PDF needed"}
                    >
                      {isOpen ? <EyeOff style={{ width: 14, height: 14 }} /> : <Eye style={{ width: 14, height: 14 }} />}
                      {isOpen ? "Hide" : "View"}
                    </button>
                  )}
                  {d.available && issued && <PdfButton label="PDF" open={() => openInvoicePdf(session, d.invoice!.id)} />}
                  {d.available && !issued && (
                    <PdfButton
                      label={d.state === "FROZEN" ? "Print" : "PDF"}
                      open={() => openFolioDocumentPdf(session, entry.id, d.kind).then(() => invalidate())}
                    />
                  )}
                  {/* The fiscal issue happens at check-out, after the seal (stage S8, folio settled). */}
                  {stage === "S8" && d.kind === "tax-invoice" && d.state === "DRAFT" && sealed && (
                    <button type="button" className="btn btn-primary btn-sm" disabled={issueM.isPending} onClick={() => issueM.mutate()}>
                      {issueM.isPending ? "Issuing…" : "Issue tax invoice"}
                    </button>
                  )}
                  {stage === "S8" && issued && d.invoice!.state === "DRAFT" && (
                    <button
                      type="button"
                      className="btn btn-primary btn-sm"
                      disabled={dispatchM.isPending}
                      onClick={() => dispatchM.mutate(d.invoice!.id)}
                    >
                      {dispatchM.isPending ? "Sending…" : "Send to guest"}
                    </button>
                  )}
                </span>
              </div>
              <p style={{ fontSize: 11, color: "var(--ink-3)", margin: "3px 0 0 4px", lineHeight: 1.5 }}>
                {d.available ? d.purpose : d.unavailableReason}
              </p>
              {isOpen && d.available && (issued ? (
                <IssuedInvoicePreview invoiceId={d.invoice!.id} />
              ) : (
                <FolioDocumentPreview entryId={entry.id} kind={d.kind} title={d.title} refreshKey={refreshKey} />
              ))}
            </div>
          );
        })}
      </div>
    </div>
  );
}
