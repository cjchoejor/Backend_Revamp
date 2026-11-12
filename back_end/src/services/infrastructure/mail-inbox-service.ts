/**
 * THE HOTEL'S MAILBOX, READ (2026-11-12, operator: "suppose say a guest or travel agent sends an
 * email with stay details, when we send an email like quotation and other papers, how can we send
 * it in that same thread of the first email guest sent"; ruled the same day: "we will only use one
 * email and we permit email reads").
 *
 * The system sends from one mailbox (SMTP_USER) and guests write to that same mailbox, so it reads
 * it over IMAP with the same sign-in unless IMAP_* says otherwise. Read only: it opens the inbox
 * read-only and never marks, moves or deletes anything.
 *
 *   - `listInboxEmails` — the recent emails the desk can pick from: who wrote, the subject, when,
 *     and the first lines. Newsletters and machine mail (List-Unsubscribe, List-Id, Precedence bulk,
 *     Auto-Submitted) are left out unless asked for.
 *   - `readInboxEmail` — one email by its Message-ID, read again from the mailbox when the desk links
 *     it, so what the enquiry keeps is the mailbox's, never what a browser sent.
 */
import { ImapFlow, type FetchMessageObject, type MessageStructureObject } from "imapflow";
import { AppError } from "../../lib/errors.js";

export type InboxEmail = {
  messageId: string;
  subject: string;
  fromName: string | null;
  fromAddress: string | null;
  receivedAt: string | null;
  snippet: string;
  /** A newsletter or machine mail (only listed when asked for). */
  bulk: boolean;
};

export type InboxEmailFull = InboxEmail & {
  /** The email's own References header — the conversation before it. */
  references: string | null;
};

/** The mailbox cannot be read: no sign-in set, or the mail server refused or did not answer. */
export class MailboxUnavailableError extends AppError {
  constructor(message: string) {
    super(503, { error: "MailboxUnavailable", message });
  }
}

function inboxConfig() {
  const user = (process.env.IMAP_USER ?? process.env.SMTP_USER ?? "").trim();
  const pass = (process.env.IMAP_PASS ?? process.env.SMTP_PASS ?? "").trim();
  const smtpHost = (process.env.SMTP_HOST ?? "").trim();
  const host =
    (process.env.IMAP_HOST ?? "").trim() ||
    (/gmail\.com$/i.test(smtpHost) ? "imap.gmail.com" : smtpHost.replace(/^smtp\./i, "imap."));
  const port = Number(process.env.IMAP_PORT ?? 993) || 993;
  const disabled = (process.env.INBOX_DISABLE ?? "").toLowerCase() === "true";
  return { user, pass, host, port, disabled };
}

/** The address the hotel's mailbox reads, for the words on the desk. */
export function inboxAddress(): string | null {
  return inboxConfig().user || null;
}

/*
 * One connection, kept open a short while between uses (signing in takes ~3 s; a search takes
 * 0.3 s), so opening the list and then picking from it signs in once. Uses run one at a time.
 */
const KEEP_OPEN_MS = 45_000;
let shared: ImapFlow | null = null;
let closeTimer: ReturnType<typeof setTimeout> | null = null;
let queue: Promise<unknown> = Promise.resolve();

function dropShared() {
  const c = shared;
  shared = null;
  if (c) {
    c.logout().catch(() => c.close());
  }
}

async function withInbox<T>(fn: (c: ImapFlow) => Promise<T>): Promise<T> {
  const run = queue.then(async () => {
    if (closeTimer) clearTimeout(closeTimer);
    closeTimer = null;
    const client = shared && shared.usable ? shared : await openClient();
    shared = client;
    try {
      return await fn(client);
    } catch (e) {
      // A broken connection is not kept for the next use.
      if (!client.usable) shared = null;
      throw e;
    } finally {
      closeTimer = setTimeout(dropShared, KEEP_OPEN_MS);
      closeTimer.unref?.();
    }
  });
  queue = run.catch(() => undefined);
  return run;
}

async function openClient(): Promise<ImapFlow> {
  const cfg = inboxConfig();
  if (cfg.disabled) throw new MailboxUnavailableError("Reading the hotel's mailbox is switched off on this server");
  if (!cfg.user || !cfg.pass || !cfg.host) {
    throw new MailboxUnavailableError("The hotel's mailbox is not set up on this server — no sign-in for it");
  }
  const client = new ImapFlow({
    host: cfg.host,
    port: cfg.port,
    secure: cfg.port === 993,
    auth: { user: cfg.user, pass: cfg.pass },
    logger: false,
    connectionTimeout: 15_000,
    greetingTimeout: 10_000,
    socketTimeout: 60_000,
    disableAutoIdle: true,
  });
  // An error event with no listener would take the process down.
  client.on("error", (e: unknown) => console.error("[inbox]", e instanceof Error ? e.message : e));
  client.on("close", () => {
    if (shared === client) shared = null;
  });
  try {
    await client.connect();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new MailboxUnavailableError(
      (e as { authenticationFailed?: boolean } | null)?.authenticationFailed || /auth|credential|password|login/i.test(msg)
        ? "The hotel's mailbox refused the sign-in — check the mail password on this server"
        : "The hotel's mailbox did not answer — try again in a moment",
    );
  }
  return client;
}

/* ---------- reading a message's parts ---------- */

function parseHeaders(buf: Buffer | undefined): Record<string, string> {
  if (!buf) return {};
  const out: Record<string, string> = {};
  const text = buf.toString("utf8").replace(/\r?\n[ \t]+/g, " ");
  for (const line of text.split(/\r?\n/)) {
    const i = line.indexOf(":");
    if (i <= 0) continue;
    const k = line.slice(0, i).trim().toLowerCase();
    const v = line.slice(i + 1).trim();
    out[k] = out[k] ? `${out[k]} ${v}` : v;
  }
  return out;
}

function isBulk(h: Record<string, string>): boolean {
  if (h["list-unsubscribe"] || h["list-id"]) return true;
  if (/bulk|list|junk/i.test(h["precedence"] ?? "")) return true;
  const auto = (h["auto-submitted"] ?? "").toLowerCase();
  return !!auto && auto !== "no";
}

type TextPart = { key: string; encoding: string; charset: string; html: boolean };

function findTextPart(node: MessageStructureObject | undefined): TextPart | null {
  if (!node) return null;
  const plain: TextPart[] = [];
  const html: TextPart[] = [];
  const walk = (n: MessageStructureObject) => {
    if (n.childNodes?.length) {
      for (const c of n.childNodes) walk(c);
      return;
    }
    if (/attachment/i.test(n.disposition ?? "")) return;
    const type = (n.type ?? "").toLowerCase();
    const part: TextPart = {
      key: n.part ?? "1",
      encoding: (n.encoding ?? "7bit").toLowerCase(),
      charset: n.parameters?.charset ?? "utf-8",
      html: type === "text/html",
    };
    if (type === "text/plain") plain.push(part);
    else if (type === "text/html") html.push(part);
  };
  walk(node);
  return plain[0] ?? html[0] ?? null;
}

function decodeQuotedPrintable(raw: string): Buffer {
  const s = raw.replace(/=\r?\n/g, "");
  const bytes: number[] = [];
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === "=" && /^[0-9A-Fa-f]{2}$/.test(s.slice(i + 1, i + 3))) {
      bytes.push(parseInt(s.slice(i + 1, i + 3), 16));
      i += 2;
    } else {
      bytes.push(s.charCodeAt(i) & 0xff);
    }
  }
  return Buffer.from(bytes);
}

function decodePart(buf: Buffer, part: TextPart, alreadyDecoded: boolean): string {
  let bytes = buf;
  if (!alreadyDecoded) {
    if (part.encoding === "base64") {
      const s = buf.toString("ascii").replace(/[^A-Za-z0-9+/]/g, "");
      bytes = Buffer.from(s.slice(0, s.length - (s.length % 4)), "base64");
    } else if (part.encoding === "quoted-printable") {
      bytes = decodeQuotedPrintable(buf.toString("latin1"));
    }
  }
  let text: string;
  try {
    text = new TextDecoder(part.charset || "utf-8", { fatal: false }).decode(bytes);
  } catch {
    text = bytes.toString("utf8");
  }
  if (part.html) {
    text = text
      // A part cut short may end inside a style block: drop it to the end.
      .replace(/<(style|script|head)\b[\s\S]*?(<\/\1>|$)/gi, " ")
      .replace(/<!--[\s\S]*?(-->|$)/g, " ")
      .replace(/<br\s*\/?>|<\/p>|<\/div>/gi, "\n")
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/gi, " ")
      .replace(/&amp;/gi, "&")
      .replace(/&lt;/gi, "<")
      .replace(/&gt;/gi, ">")
      .replace(/&quot;/gi, '"')
      .replace(/&#39;|&apos;/gi, "'");
  }
  return text;
}

/** The first lines a person wrote: quoted earlier mail and signatures' dashes left out. */
function snippetOf(text: string): string {
  const lines: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith(">")) continue;
    if (/^on .+ wrote:$/i.test(line) || line === "--") break;
    lines.push(line);
    if (lines.join(" ").length > 260) break;
  }
  const s = lines.join(" ").replace(/\s+/g, " ").trim();
  return s.length > 240 ? `${s.slice(0, 237)}…` : s;
}

function summary(m: FetchMessageObject, headers: Record<string, string>): InboxEmail | null {
  const id = m.envelope?.messageId?.trim();
  if (!id) return null;
  const from = m.envelope?.from?.[0];
  const when = m.envelope?.date ?? m.internalDate ?? null;
  return {
    messageId: id,
    subject: (m.envelope?.subject ?? "").trim() || "(no subject)",
    fromName: from?.name?.trim() || null,
    fromAddress: from?.address?.trim().toLowerCase() || null,
    receivedAt: when ? new Date(when).toISOString() : null,
    snippet: "",
    bulk: isBulk(headers),
  };
}

const HEADER_KEYS = ["list-unsubscribe", "list-id", "precedence", "auto-submitted", "references"];

/** Fill each email's first lines, one fetch per part number. */
async function fillSnippets(
  client: ImapFlow,
  items: Array<{ uid: number; email: InboxEmail; part: TextPart | null }>,
): Promise<void> {
  const byKey = new Map<string, typeof items>();
  for (const it of items) {
    if (!it.part) continue;
    const list = byKey.get(it.part.key) ?? [];
    list.push(it);
    byKey.set(it.part.key, list);
  }
  for (const [key, group] of byKey) {
    const got = await client.fetchAll(
      group.map((g) => g.uid).join(","),
      { uid: true, bodyParts: [{ key, start: 0, maxLength: 12000 }] },
      { uid: true },
    );
    const byUid = new Map(got.map((m) => [m.uid, m]));
    for (const g of group) {
      const m = byUid.get(g.uid);
      const buf = m?.bodyParts?.get(key);
      if (!buf || !g.part) continue;
      try {
        g.email.snippet = snippetOf(decodePart(buf, g.part, !!m?.binaryParts?.has(key)));
      } catch {
        /* a part that will not decode leaves the line empty */
      }
    }
  }
}

/* ---------- listing ---------- */

const listCache = new Map<string, { at: number; value: InboxEmail[] }>();
const LIST_CACHE_MS = 30_000;

export async function listInboxEmails(opts: {
  q?: string | null;
  days?: number;
  limit?: number;
  includeBulk?: boolean;
  /** Read the mailbox again rather than the list kept for half a minute. */
  fresh?: boolean;
} = {}): Promise<InboxEmail[]> {
  const days = Math.min(60, Math.max(1, Math.round(opts.days ?? 14)));
  const limit = Math.min(60, Math.max(1, Math.round(opts.limit ?? 30)));
  const q = (opts.q ?? "").trim().toLowerCase();
  const includeBulk = !!opts.includeBulk;
  const cacheKey = JSON.stringify([days, includeBulk]);
  const cached = listCache.get(cacheKey);
  let all: InboxEmail[];
  if (cached && !opts.fresh && Date.now() - cached.at < LIST_CACHE_MS) {
    all = cached.value;
  } else {
    all = await withInbox(async (client) => {
      const lock = await client.getMailboxLock("INBOX", { readOnly: true });
      try {
        const since = new Date(Date.now() - days * 86_400_000);
        const found = await client.search({ since }, { uid: true });
        const uids = Array.isArray(found) ? found.slice(-250) : [];
        if (!uids.length) return [];
        const msgs = await client.fetchAll(
          uids.join(","),
          { uid: true, envelope: true, internalDate: true, bodyStructure: true, headers: HEADER_KEYS },
          { uid: true },
        );
        const items: Array<{ uid: number; email: InboxEmail; part: TextPart | null }> = [];
        for (const m of msgs) {
          const email = summary(m, parseHeaders(m.headers));
          if (!email) continue;
          if (email.bulk && !includeBulk) continue;
          items.push({ uid: m.uid, email, part: findTextPart(m.bodyStructure) });
        }
        items.sort((a, b) => (b.email.receivedAt ?? "").localeCompare(a.email.receivedAt ?? ""));
        const top = items.slice(0, 120);
        await fillSnippets(client, top);
        return top.map((t) => t.email);
      } finally {
        lock.release();
      }
    });
    listCache.set(cacheKey, { at: Date.now(), value: all });
  }
  const hit = q
    ? all.filter((e) =>
        [e.fromName, e.fromAddress, e.subject, e.snippet].some((v) => (v ?? "").toLowerCase().includes(q)),
      )
    : all;
  return hit.slice(0, limit);
}

/** Forget the cached list (after a link, so the next look is fresh). */
export function forgetInboxList(): void {
  listCache.clear();
}

/* ---------- one email ---------- */

export async function readInboxEmail(messageId: string): Promise<InboxEmailFull | null> {
  const id = messageId.trim();
  if (!id) return null;
  return withInbox(async (client) => {
    const look = async (box: string): Promise<InboxEmailFull | null> => {
      const lock = await client.getMailboxLock(box, { readOnly: true });
      try {
        const found = await client.search({ header: { "message-id": id } }, { uid: true });
        const uids = Array.isArray(found) ? found : [];
        if (!uids.length) return null;
        const msgs = await client.fetchAll(
          uids.join(","),
          { uid: true, envelope: true, internalDate: true, headers: HEADER_KEYS },
          { uid: true },
        );
        const m = msgs.find((x) => x.envelope?.messageId?.trim() === id);
        if (!m) return null;
        const headers = parseHeaders(m.headers);
        const email = summary(m, headers);
        if (!email) return null;
        const refs = (headers["references"] ?? "").match(/<[^<>\s]+>/g) ?? [];
        return { ...email, references: refs.length ? refs.join(" ") : null };
      } finally {
        lock.release();
      }
    };
    const inInbox = await look("INBOX");
    if (inInbox) return inInbox;
    // Archived since it came in: Gmail's All Mail still holds it.
    try {
      const all = (await client.list()).find((b) => b.specialUse === "\\All");
      if (all) return await look(all.path);
    } catch {
      /* the inbox alone */
    }
    return null;
  });
}
