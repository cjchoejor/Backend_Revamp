"use client";

import { Route } from "lucide-react";
import { money } from "@/lib/desk/workspace";

/**
 * "How this price was resolved" — a display-only rendering of the pricing pipeline's stored
 * result (SIG-S2 §5.1). The engine writes its own audit trail onto every quotation's
 * `commercialTerms` (`resolutionPath` + the resolved/effective rates, MSR flag, agent-card
 * override); this panel translates that trail into operator language. NOTHING is recomputed
 * here — every figure is the value the backend priced with (no-money-math rule). Fields are
 * read defensively: older quotes (and card-priced ones) may lack parts of the trail.
 */

type ResolutionStep = { step: string; detail?: string };

function num(v: unknown): number | null {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && v.trim() !== "" && Number.isFinite(Number(v))) return Number(v);
  return null;
}

const PLAN_TYPE_LABEL: Record<string, string> = {
  INDIVIDUAL: "Individual",
  PROMOTIONAL: "Promotional",
  TIER: "Tier",
  CHANNEL: "Channel",
  RACK: "Rack (published)",
};

/** Friendly line per pipeline step. Unknown steps fall through with their raw key + detail. */
function stepLine(s: ResolutionStep): { text: string; warn?: boolean } {
  const detail = s.detail ?? "";
  switch (s.step) {
    case "RATE_PLAN_PRIORITY": {
      const type = /type=(\w+)/.exec(detail)?.[1];
      return { text: `Rate plan selected${type ? ` — ${PLAN_TYPE_LABEL[type] ?? type}` : ""}` };
    }
    case "DETERRENT_TIER":
      return { text: "Restricted-tier uplift applied (staff-only — never shown to the guest)", warn: true };
    case "GROUP_VOLUME_BAND":
      return { text: "Group volume adjustment applied (party of 10+)" };
    case "DISCOUNT":
      return { text: `Discount ${detail || "applied"}` };
    case "DISCOUNT_BLOCKED_AUTHORITY":
      return { text: "Discount refused — above the acting user's authority ceiling", warn: true };
    case "MSR_CHECK":
      return { text: "Priced below the minimum sell rate — GM waiver path", warn: true };
    default:
      return { text: detail ? `${s.step} — ${detail}` : s.step };
  }
}

function FactRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "150px 1fr",
        gap: 10,
        padding: "3px 0",
        fontSize: 12,
        alignItems: "baseline",
      }}
    >
      <span style={{ color: "var(--ink-3)" }}>{label}</span>
      <span style={{ color: "var(--ink)" }}>{children}</span>
    </div>
  );
}

export function PriceResolutionPanel({
  terms,
  currency,
}: {
  terms?: Record<string, unknown> | null;
  currency?: string;
}) {
  const t = terms ?? {};
  const path = Array.isArray(t.resolutionPath)
    ? (t.resolutionPath as ResolutionStep[]).filter((s) => s && typeof s.step === "string")
    : [];
  const resolvedRate = num(t.resolvedNightlyRate);
  const effectiveRate = num(t.effectiveRate);
  const discountPct =
    num(t.discountAppliedPercent) ?? num((t.requestedDiscount as { discountPercent?: unknown } | null)?.discountPercent);
  const msrValue = num(t.msrValue);
  const belowMsr = t.belowMsr === true;
  const agent = (t.agentRate ?? null) as { partyType?: string; roomRate?: unknown; source?: string } | null;
  const standard = (t.standardPricing ?? null) as Record<string, unknown> | null;
  const standardRate = standard
    ? num(standard.effectiveRate) ?? num(standard.resolvedNightlyRate) ?? num(standard.rateAmount)
    : null;
  const cur = currency ?? (typeof t.currency === "string" ? t.currency : undefined);

  const empty = path.length === 0 && resolvedRate == null && effectiveRate == null && !agent;

  return (
    <div
      style={{
        border: "1px solid var(--line)",
        borderRadius: "var(--r-md)",
        background: "var(--paper)",
        padding: "10px 14px",
        margin: "4px 0 10px",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 7, marginBottom: 6 }}>
        <Route style={{ width: 13, height: 13, color: "var(--green)" }} />
        <span style={{ fontSize: 12, fontWeight: 700, color: "var(--ink)", letterSpacing: 0.2 }}>
          How this price was resolved
        </span>
      </div>

      {empty ? (
        <p style={{ fontSize: 12, color: "var(--ink-3)", margin: 0 }}>
          This quote carries no pricing trail — it predates the recorded resolution path.
        </p>
      ) : (
        <>
          {/* Agent/corporate card override: the pipeline's answer was replaced by the negotiated
              rate — say so first, since it explains why discount/MSR lines are absent. */}
          {agent && (
            <p style={{ fontSize: 12, color: "var(--ink-2)", margin: "0 0 7px", lineHeight: 1.5 }}>
              {agent.partyType === "CORPORATE" ? "Corporate" : "Travel agent"} rate card applied —{" "}
              <b>{money(num(agent.roomRate), cur)}</b> / night, negotiated
              {standardRate != null ? (
                <span style={{ color: "var(--ink-3)" }}>
                  {" "}
                  (the standard plan would have charged {money(standardRate, cur)})
                </span>
              ) : null}
              . Card rates skip discounts and the MSR floor — the contract is the price.
            </p>
          )}

          {path.length > 0 && (
            <ol style={{ margin: "0 0 8px", padding: 0, listStyle: "none" }}>
              {path.map((s, i) => {
                const line = stepLine(s);
                return (
                  <li key={i} style={{ display: "flex", gap: 8, padding: "2.5px 0", fontSize: 12 }}>
                    <span
                      style={{
                        flex: "0 0 auto",
                        width: 16,
                        height: 16,
                        borderRadius: 999,
                        background: line.warn ? "var(--warn-t)" : "var(--green-t)",
                        color: line.warn ? "var(--warn)" : "var(--green-d)",
                        fontSize: 10,
                        fontWeight: 700,
                        display: "inline-flex",
                        alignItems: "center",
                        justifyContent: "center",
                        marginTop: 1,
                      }}
                    >
                      {i + 1}
                    </span>
                    <span style={{ color: line.warn ? "var(--warn)" : "var(--ink-2)" }}>{line.text}</span>
                  </li>
                );
              })}
            </ol>
          )}

          <div style={{ borderTop: "1px dashed var(--line)", paddingTop: 6 }}>
            {resolvedRate != null && <FactRow label="Plan rate / night">{money(resolvedRate, cur)}</FactRow>}
            {discountPct != null && discountPct > 0 && (
              <FactRow label="Discount">
                {discountPct}%
                {resolvedRate != null && effectiveRate != null && effectiveRate < resolvedRate
                  ? ` · ${money(resolvedRate, cur)} → ${money(effectiveRate, cur)}`
                  : " · requested (not applied to this rate)"}
              </FactRow>
            )}
            {effectiveRate != null && (
              <FactRow label="Effective rate / night">
                <b>{money(effectiveRate, cur)}</b>
              </FactRow>
            )}
            {msrValue != null && (
              <FactRow label="Minimum sell rate">
                {money(msrValue, cur)}
                {belowMsr ? <span style={{ color: "var(--warn)", fontWeight: 600 }}> · below floor</span> : null}
              </FactRow>
            )}
          </div>
        </>
      )}
    </div>
  );
}
