"use client";

/**
 * A page of settings (2026-11-02). One row per setting with its value in words, so the whole page can
 * be read at a glance; a row opens its form in place, and the rows around it stay where they are.
 * Several may be open at once, and a change not saved stays on its row, marked, until it is saved or
 * put back. `?key=` opens one and brings it into view, which is how the side list's search lands here.
 * A setting nothing reads yet goes in a group of its own at the foot, so it is never mistaken for one
 * that changes how the hotel runs.
 */
import { Suspense, useEffect, useMemo, useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useSearchParams } from "next/navigation";
import { toast } from "sonner";
import { Help } from "@/components/ds/help";
import { SettingForm } from "@/components/admin/setting-form";
import { useSession } from "@/hooks/use-session";
import { getSettingDef, type SettingDef } from "@/lib/admin/setting-forms";
import { routeFor } from "@/lib/admin/setting-routes";
import { emptyValueOf, errorsOf, summarise } from "@/lib/admin/setting-fields";
import { listPolicies } from "@/lib/api/admin";
import { ApiError } from "@/lib/api/client";
import type { Session } from "@/types/session";

const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

/** Words for a setting no form is written for: never raw braces. */
function looseSummary(v: unknown): string {
  if (v === null || v === undefined || v === "") return "Not set";
  if (typeof v === "boolean") return v ? "On" : "Off";
  if (typeof v === "number" || typeof v === "string") return String(v);
  if (Array.isArray(v)) return v.length === 0 ? "None" : `${v.length} item${v.length === 1 ? "" : "s"}`;
  const n = Object.keys(v as object).length;
  return n === 0 ? "None" : `${n} value${n === 1 ? "" : "s"}`;
}

/** A house rule that, while it is on, decides this setting instead. */
function DecidedBy({ def, session }: { def: SettingDef; session: Session }) {
  const policies = useQuery({
    queryKey: ["admin", "policies"],
    queryFn: () => listPolicies(session),
    enabled: !!def.decidedBy,
    staleTime: 5_000,
  });
  if (!def.decidedBy) return null;
  const row = policies.data?.items.find((p) => p.isActive && p.policyId === def.decidedBy!.policyId);
  const d = (row?.policyDefinition ?? null) as Record<string, unknown> | null;
  if (!row || d?.enabled === false) return null;
  const now = def.decidedBy.read?.(d ?? {});
  return (
    <p className="set-note" role="status">
      {def.decidedBy.lead ?? "While the house rule"} <a href={`/admin/policies?key=${encodeURIComponent(def.decidedBy.policyId)}`}>{def.decidedBy.title}</a> is on, it decides this
      {now ? <> — <b>{now}</b></> : null}. {def.decidedBy.rest ?? "What you save here applies only when that rule is off."}
    </p>
  );
}

function SettingRow({ settingKey, session, open, onToggle }: { settingKey: string; session: Session; open: boolean; onToggle: () => void }) {
  const def = getSettingDef(settingKey);
  const queryClient = useQueryClient();
  const route = useMemo(() => routeFor(session, settingKey), [session, settingKey]);
  const queryKey = useMemo(() => ["admin", "setting", settingKey], [settingKey]);
  const load = useQuery({
    queryKey,
    queryFn: async () => {
      const fresh = () => (def?.form ? def.fresh ?? emptyValueOf(def.form) : null);
      try {
        const r = await route.load(queryClient);
        return r.value === undefined ? { ...r, value: fresh(), isNew: true } : r;
      } catch (e) {
        if (e instanceof ApiError && e.status === 404) return { value: fresh(), isNew: true };
        throw e;
      }
    },
  });

  const [draft, setDraft] = useState<unknown>(undefined);
  const [note, setNote] = useState("");
  const [refused, setRefused] = useState<string | null>(null);
  const [everOpen, setEverOpen] = useState(open);
  useEffect(() => {
    if (open) setEverOpen(true);
  }, [open]);

  const saved = load.data?.value;
  const current = draft === undefined ? saved : draft;
  const dirty = draft !== undefined && !same(draft, saved);
  const fieldErrors = def?.form && load.data ? errorsOf(def.form, current) : [];
  const crossError = def?.check && load.data ? def.check(current) : null;
  const canSave = dirty && fieldErrors.length === 0 && !crossError;

  const save = useMutation({
    mutationFn: () => route.save(def?.normalise ? def.normalise(current) : current, note.trim() || null),
    onSuccess: async () => {
      toast.success(`${def?.title ?? settingKey} saved`);
      setRefused(null);
      setNote("");
      await Promise.all([queryClient.invalidateQueries({ queryKey }), ...(route.invalidates ?? []).map((k) => queryClient.invalidateQueries({ queryKey: k }))]);
      setDraft(undefined);
    },
    onError: (e) => setRefused(e instanceof ApiError ? e.message : "It could not be saved. Try again."),
  });

  const title = def?.title ?? settingKey;
  const words = !load.data
    ? load.isError
      ? "Could not be read"
      : "Reading…"
    : def?.summary
      ? def.summary(current)
      : def?.form
        ? summarise(def.form, current)
        : looseSummary(current);
  const isEmpty = !load.data || words === "Not set" || words === "None";

  return (
    <div className={`set-row${open ? " open" : ""}`} data-setting={settingKey}>
      <div className="set-row-head">
        <div className="set-row-name">
          <span>{title}</span>
          <Help label={title}>
            {def?.about}
            {def?.unused ? <span style={{ display: "block", marginTop: 8, fontWeight: 700 }}>{def.unused}</span> : null}
            <span style={{ display: "block", marginTop: 8, color: "var(--ink-3)", fontSize: "var(--t-meta)" }}>Setting name: {settingKey}</span>
          </Help>
        </div>
        <div className={`set-row-value${isEmpty ? " empty" : ""}`}>{words}</div>
        <div className="set-row-acts">
          {dirty ? <span className="admin-tag admin-tag-warn">Not saved</span> : null}
          {load.data?.warning ? <span className="admin-tag admin-tag-warn">Needs you</span> : null}
          <button type="button" className="admin-btn text-[10px]" aria-expanded={open} onClick={onToggle}>
            {open ? "Close" : "Change"}
          </button>
        </div>
      </div>
      {everOpen && load.data ? (
        <div className="set-row-body" hidden={!open} data-edit-form>
          {load.data.warning ? (
            <p className="set-refused" role="alert">
              {load.data.warning}
            </p>
          ) : null}
          {def?.decidedBy ? <DecidedBy def={def} session={session} /> : null}
          {def?.unused ? <p className="set-off">{def.unused}</p> : null}
          {load.data.isNew && !load.data.warning ? <p className="set-off">Nothing is saved for this yet. Saving creates it.</p> : null}
          {def?.form ? (
            <SettingForm
              form={def.form}
              value={current}
              onChange={(v) => {
                setDraft(v);
                setRefused(null);
              }}
            />
          ) : (
            <p className="set-off">This one has no form yet. Its value is {looseSummary(current)}.</p>
          )}
          {crossError ? (
            <p className="set-refused" role="alert">
              {crossError}
            </p>
          ) : null}
          {refused ? (
            <p className="set-refused" role="alert">
              {refused}
            </p>
          ) : null}
          {def?.form ? (
            <div className="set-save">
              <label className="field">
                <span className="sf-label">
                  Why the change <span className="admin-muted" style={{ fontWeight: 400 }}>· optional, kept in the audit trail</span>
                </span>
                <input className="admin-input" value={note} onChange={(e) => setNote(e.target.value)} />
              </label>
              {dirty ? (
                <button
                  type="button"
                  className="admin-btn text-[10px]"
                  onClick={() => {
                    setDraft(undefined);
                    setRefused(null);
                  }}
                >
                  Put it back
                </button>
              ) : null}
              <button type="button" className={`admin-btn${canSave ? " go" : ""}`} disabled={!canSave || save.isPending} onClick={() => save.mutate()}>
                {save.isPending ? "Saving…" : "Save"}
              </button>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

export type SettingGroup = { title?: string; help?: ReactNode; keys: string[] };

const NOT_USED_HELP = "These are saved, but nothing in the system reads them yet, so changing one changes nothing. They are kept for when that part is built.";

export function SettingsList({ groups }: { groups: SettingGroup[] }) {
  const { session } = useSession();
  const params = useSearchParams();
  const asked = params.get("key");
  const [open, setOpen] = useState<Set<string>>(() => new Set(asked ? [asked] : []));

  // Asked for by name, from the search or a link: open it and go there, once.
  useEffect(() => {
    if (!asked) return;
    setOpen((cur) => new Set(cur).add(asked));
    let settled = 0;
    let ticks = 0;
    const stop = () => {
      clearInterval(t);
      window.removeEventListener("wheel", stop);
      window.removeEventListener("mousedown", stop);
      window.removeEventListener("keydown", stop);
    };
    // Rows draw and fill as their values arrive; the person moving the page ends it at once.
    const t = setInterval(() => {
      ticks += 1;
      const el = document.querySelector(`[data-setting="${CSS.escape(asked)}"]`);
      if (el instanceof HTMLElement) {
        const off = el.getBoundingClientRect().top - 68;
        if (Math.abs(off) > 4) {
          window.scrollTo({ top: window.scrollY + off });
          settled = 0;
        } else settled += 1;
      }
      if (settled >= 4 || ticks >= 40) stop();
    }, 100);
    window.addEventListener("wheel", stop, { passive: true });
    window.addEventListener("mousedown", stop);
    window.addEventListener("keydown", stop);
    return stop;
  }, [asked]);

  if (!session) return null;

  const isUnused = (k: string) => !!getSettingDef(k)?.unused;
  const live = groups.map((g) => ({ ...g, keys: g.keys.filter((k) => !isUnused(k)) })).filter((g) => g.keys.length > 0);
  const unused = groups.flatMap((g) => g.keys).filter(isUnused);
  const shown: SettingGroup[] = unused.length ? [...live, { title: "Saved, but not used yet", help: NOT_USED_HELP, keys: unused }] : live;

  return (
    <>
      {shown.map((g, i) => (
        <section className="set-group" key={g.title ?? i}>
          {g.title ? (
            <h2>
              {g.title}
              {g.help ? <Help label={g.title}>{g.help}</Help> : null}
            </h2>
          ) : null}
          <div className="set-rows">
            {g.keys.map((k) => (
              <SettingRow
                key={k}
                settingKey={k}
                session={session}
                open={open.has(k)}
                onToggle={() =>
                  setOpen((cur) => {
                    const next = new Set(cur);
                    if (next.has(k)) next.delete(k);
                    else next.add(k);
                    return next;
                  })
                }
              />
            ))}
          </div>
        </section>
      ))}
    </>
  );
}

/** A page's heading: where it sits, its name, and what it is for behind a "?". */
export function SettingsPageHead({ eyebrow, title, about }: { eyebrow?: string; title: string; about?: ReactNode }) {
  return (
    <header className="set-head">
      {eyebrow ? <span className="eyebrow">{eyebrow}</span> : null}
      <div className="title">
        <h1>{title}</h1>
        {about ? <Help label={title}>{about}</Help> : null}
      </div>
    </header>
  );
}

/** A plain page of settings: a heading and its groups. */
export function SettingsPage({ eyebrow, title, about, groups }: { eyebrow?: string; title: string; about?: ReactNode; groups: SettingGroup[] }) {
  return (
    <div className="set-page">
      <SettingsPageHead eyebrow={eyebrow} title={title} about={about} />
      <Suspense>
        <SettingsList groups={groups} />
      </Suspense>
    </div>
  );
}

/** A list on a page that nothing reads: said plainly, above the list. */
export function NotUsedYet({ children }: { children: ReactNode }) {
  return (
    <p className="set-off" role="note">
      <b>Not used yet.</b> {children}
    </p>
  );
}
