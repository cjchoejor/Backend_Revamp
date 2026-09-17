import React from "react";

/* ------------------------------------------------------------------
   LEGPHEL PMS design system — primitives
   Every class name here is defined in styles/components.css, which is
   the locked gallery's own CSS. A screen composes from these; it never
   restyles them (README, "what a screen may never override").
   ------------------------------------------------------------------ */

export type IconName =
  | "check" | "circle" | "x" | "lock" | "lock-open" | "clock" | "alert" | "info" | "person"
  | "pen" | "equals" | "spark" | "ai" | "auto" | "bell" | "file" | "print" | "send" | "eye"
  | "key" | "bed" | "broom" | "wrench" | "offline" | "history" | "more" | "chev" | "question" | "retry";

export function Icon({ name, size = "sm", className = "" }: { name: IconName; size?: "sm" | "lg" | "xl"; className?: string }) {
  const cls = ["ic", size === "lg" ? "lg" : size === "xl" ? "xl" : "", className].filter(Boolean).join(" ");
  return (
    <svg className={cls} aria-hidden="true">
      <use href={`#i-${name}`} />
    </svg>
  );
}

/* ---------- button (states: default · hover/pressed/focus by CSS · inert · faulty · working) ---------- */
export type ButtonKind = "primary" | "secondary" | "quiet" | "danger";
export type ButtonState = "default" | "inert" | "faulty" | "working";

export interface ButtonProps extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, "disabled"> {
  kind?: ButtonKind;
  solid?: boolean;          // danger only: solid inside its own consequence dialog
  compact?: boolean;
  iconOnly?: boolean;
  icon?: IconName;
  state?: ButtonState;
  /** One line in operator words, applying the rule to this case. Required when state is inert or faulty. */
  reason?: React.ReactNode;
  /** The role that unlocks an inert control — e.g. "FOM". Rendered inside the reason line. */
  unlockRole?: string;
  /** "why?" opens the hotel's reason for the rule. Never volunteered; shown only when supplied. */
  onWhy?: () => void;
  workingLabel?: string;
}

export function Button({ kind = "primary", solid, compact, iconOnly, icon, state = "default", reason, unlockRole, onWhy, workingLabel, className = "", children, onClick, type, ...rest }: ButtonProps) {
  const cls = ["btn", `btn-${kind}`, solid ? "solid" : "", compact ? "compact" : "", iconOnly ? "icon-only" : "", state === "inert" ? "inert" : "", state === "faulty" ? "faulty" : "", className].filter(Boolean).join(" ");
  // Inert stays focusable (aria-disabled, not disabled) so its reason can be read by keyboard;
  // the click is swallowed so nothing executes (DSS §6).
  const inert = state === "inert" || state === "faulty" || state === "working";
  const button = (
    <button
      type={type ?? "button"}
      className={cls}
      aria-disabled={inert || undefined}
      aria-busy={state === "working" || undefined}
      {...rest}
      onClick={inert ? (e: React.MouseEvent<HTMLButtonElement>) => { e.preventDefault(); e.stopPropagation(); } : onClick}
    >
      {state === "working" ? <span className="spin" style={kind === "primary" ? { borderTopColor: "#fff", borderColor: "rgba(255,255,255,.35)" } : undefined} /> : state === "faulty" ? <Icon name="alert" /> : icon ? <Icon name={icon} /> : null}
      {state === "working" ? (workingLabel ?? children) : children}
    </button>
  );
  if (!reason && !unlockRole) return button;
  return (
    <span className="control-wrap">
      {button}
      <ControlNote tone={state === "faulty" ? "fault" : unlockRole ? "role" : "default"} onWhy={onWhy}>
        {reason}{reason && unlockRole ? " · " : null}{unlockRole ? <>needs the {unlockRole}</> : null}
      </ControlNote>
    </span>
  );
}

export function ControlNote({ tone = "default", onWhy, children }: { tone?: "default" | "role" | "fault"; onWhy?: () => void; children: React.ReactNode }) {
  return (
    <span className={`control-note${tone === "role" ? " role" : tone === "fault" ? " fault" : ""}`}>
      {children}
      {onWhy ? <a className="why" href="#why" onClick={(e: React.MouseEvent<HTMLElement>) => { e.preventDefault(); onWhy(); }}>why?</a> : null}
    </span>
  );
}

/* ---------- chip: one shape for every named standing ---------- */
export type ChipTone = "default" | "solid" | "accent" | "danger" | "warning" | "success" | "quiet";
export function Chip({ tone = "default", icon, tier, qualifier, children }: { tone?: ChipTone; icon?: IconName; tier?: boolean; qualifier?: React.ReactNode; children: React.ReactNode }) {
  const cls = ["chip", tone === "default" ? "" : tone, tier ? "tier" : ""].filter(Boolean).join(" ");
  return (
    <span className={cls}>
      {icon ? <Icon name={icon} /> : null}
      {children}
      {qualifier ? <span className="qual">{qualifier}</span> : null}
    </span>
  );
}

/* ---------- fields (states: default · focus · invalid · readonly · bound) ---------- */
interface FieldBase { label: React.ReactNode; hint?: React.ReactNode; error?: React.ReactNode; style?: React.CSSProperties; className?: string }

export function Field({ label, hint, error, style, className = "", children }: FieldBase & { children: React.ReactNode }) {
  return (
    <div className={`field ${className}`} style={style}>
      <label>{label}</label>
      {children}
      {error ? <span className="error"><Icon name="alert" className="ic-13" />{error}</span> : hint ? <span className="hint">{hint}</span> : null}
    </div>
  );
}

export interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> { invalid?: boolean; bound?: boolean; money?: boolean }
export function Input({ invalid, bound, money, className = "", ...rest }: InputProps) {
  const cls = ["input", invalid ? "invalid" : "", bound ? "bound" : "", money ? "money" : "", className].filter(Boolean).join(" ");
  return <input className={cls} readOnly={bound || rest.readOnly} aria-invalid={invalid || undefined} {...rest} />;
}

export function MoneyInput(props: InputProps) {
  return (
    <div className="prefix">
      <span>Nu.</span>
      <Input money inputMode="decimal" {...props} />
    </div>
  );
}

export function Select({ className = "", children, ...rest }: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return <select className={`input ${className}`} {...rest}>{children}</select>;
}

/* ---------- tabs: sequenced work inside one job; a plain grey count is information, not an alert ---------- */
export function Tabs({ items, selected, onSelect }: { items: { id: string; label: React.ReactNode; count?: number }[]; selected: string; onSelect: (id: string) => void }) {
  return (
    <div className="tabs" role="tablist">
      {items.map((t) => (
        <button key={t.id} type="button" role="tab" className="tab" aria-selected={t.id === selected} onClick={() => onSelect(t.id)}>
          {t.label}{typeof t.count === "number" ? <span className="meta">{t.count}</span> : null}
        </button>
      ))}
    </div>
  );
}

/* ---------- card ---------- */
export function Card({ sealed, className = "", style, children }: { sealed?: boolean; className?: string; style?: React.CSSProperties; children: React.ReactNode }) {
  return <div className={["card", sealed ? "sealed" : "", className].filter(Boolean).join(" ")} style={style}>{children}</div>;
}

/* ---------- feedback ---------- */
export function Toast({ partial, title, children }: { partial?: boolean; title: React.ReactNode; children?: React.ReactNode }) {
  return (
    <div className={`toast${partial ? " partial" : ""}`} role="status">
      <Icon name={partial ? "alert" : "check"} />
      <div><b>{title}</b>{children ? <span className="rest">{children}</span> : null}</div>
    </div>
  );
}

export function NotificationCount({ count, onClick }: { count: number; onClick?: () => void }) {
  return (
    <button type="button" className="notif" onClick={onClick} aria-label={`${count} notifications`}>
      <Icon name="bell" size="lg" />
      <span className={`count${count === 0 ? " zero" : ""}`}>{count}</span>
    </button>
  );
}

export function EmptyState({ title, children, style }: { title: React.ReactNode; children?: React.ReactNode; style?: React.CSSProperties }) {
  return <div className="empty" style={style}><b>{title}</b>{children}</div>;
}

/** The one wording for a screen ahead of its backend. */
export function NotAvailableYet({ what }: { what: React.ReactNode }) {
  return <EmptyState title="Not available yet">{what} will appear here once the backend reports it.</EmptyState>;
}

export function Spinner() { return <span className="spin" aria-hidden="true" />; }

export function Skeleton({ lines = 3 }: { lines?: number }) {
  const widths = ["60%", "100%", "80%", "40%", "90%"];
  return <div className="skeleton" aria-busy="true">{Array.from({ length: lines }).map((_, i) => <span key={i} style={{ width: widths[i % widths.length] }} />)}</div>;
}

export function Progress({ label, percent }: { label: React.ReactNode; percent: number }) {
  return (
    <div className="progress" role="progressbar" aria-valuenow={percent} aria-valuemin={0} aria-valuemax={100}>
      <span>{label}</span>
      <div className="bar"><i style={{ width: `${Math.max(0, Math.min(100, percent))}%` }} /></div>
    </div>
  );
}

export function OfflineBanner({ since, onCheck }: { since: string; onCheck?: () => void }) {
  return (
    <div className="banner offline" role="alert">
      <Icon name="offline" size="lg" />
      <div><b>Can't reach the hotel server since {since}.</b> What you see is as of then. Nothing can be saved until it's back — the desk keeps checking every 10 seconds.</div>
      <Button kind="secondary" compact icon="retry" onClick={onCheck} style={{ marginLeft: "auto" }}>Check now</Button>
    </div>
  );
}
