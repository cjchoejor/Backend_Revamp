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

/**
 * Open a mailbox for a look, read only, afresh: on a connection kept open, a mailbox left selected
 * does not show mail that came in since (Gmail shows it once the mailbox is opened again), so the
 * one selected is closed first. Closing a mailbox opened read only removes nothing.
 */
async function lockFresh(client: ImapFlow, box: string) {
  if (client.mailbox) {
    try {
      await client.mailboxClose();
    } catch {
      /* not open after all */
    }
  }
  return client.getMailboxLock(box, { readOnly: true });
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
  for (const raw of newPartOf(text).split(/\r?\n/)) {
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
      const lock = await lockFresh(client, "INBOX");
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

/**
 * Find one email by its Message-ID — the inbox first, then Gmail's All Mail (archived since it came
 * in) — and run `use` on it while its mailbox is open.
 */
async function withMessage<T>(
  messageId: string,
  query: Parameters<ImapFlow["fetchAll"]>[1],
  use: (client: ImapFlow, m: FetchMessageObject) => Promise<T | null>,
): Promise<T | null> {
  const id = messageId.trim();
  if (!id) return null;
  return withInbox(async (client) => {
    const look = async (box: string): Promise<T | null> => {
      const lock = await lockFresh(client, box);
      try {
        const found = await client.search({ header: { "message-id": id } }, { uid: true });
        const uids = Array.isArray(found) ? found : [];
        if (!uids.length) return null;
        const msgs = await client.fetchAll(uids.join(","), { ...query, uid: true, envelope: true }, { uid: true });
        const m = msgs.find((x) => x.envelope?.messageId?.trim() === id);
        return m ? await use(client, m) : null;
      } finally {
        lock.release();
      }
    };
    const inInbox = await look("INBOX");
    if (inInbox) return inInbox;
    try {
      const all = (await client.list()).find((b) => b.specialUse === String.raw`\All`);
      if (all) return await look(all.path);
    } catch {
      /* the inbox alone */
    }
    return null;
  });
}

export async function readInboxEmail(messageId: string): Promise<InboxEmailFull | null> {
  return withMessage(messageId, { internalDate: true, headers: HEADER_KEYS }, async (_c, m) => {
    const headers = parseHeaders(m.headers);
    const email = summary(m, headers);
    if (!email) return null;
    const refs = (headers["references"] ?? "").match(/<[^<>\s]+>/g) ?? [];
    return { ...email, references: refs.length ? refs.join(" ") : null };
  });
}

/** One email in full, to read on the desk: who it went to, all its words, its attachments' names. */
export type InboxEmailRead = InboxEmail & {
  references: string | null;
  to: string[];
  cc: string[];
  text: string;
  /** What the person wrote, and the earlier email they quoted, apart (a reply). */
  fresh: string;
  quoteHeader: string | null;
  quoted: string;
  /** The words were cut at the reading limit. */
  cut: boolean;
  attachments: Array<{ name: string; type: string; size: number | null }>;
};

const READ_LIMIT = 300_000;

function addressWords(list: Array<{ name?: string; address?: string }> | undefined): string[] {
  return (list ?? [])
    .map((a) => {
      const name = a.name?.trim() ?? "";
      const address = a.address?.trim() ?? "";
      return name && address && name.toLowerCase() !== address.toLowerCase() ? `${name} <${address}>` : address || name;
    })
    .filter(Boolean);
}

function attachmentsOf(node: MessageStructureObject | undefined): InboxEmailRead["attachments"] {
  const out: InboxEmailRead["attachments"] = [];
  const walk = (n: MessageStructureObject | undefined) => {
    if (!n) return;
    if (n.childNodes?.length) {
      for (const c of n.childNodes) walk(c);
      return;
    }
    const type = (n.type ?? "").toLowerCase();
    // An image shown inside the email (the hotel's logo, a signature picture) is not an attachment.
    if (/inline/i.test(n.disposition ?? "") && n.id && type.startsWith("image/")) return;
    const name = n.dispositionParameters?.filename ?? n.parameters?.name ?? null;
    const isAttachment = /attachment/i.test(n.disposition ?? "") || (!!name && !type.startsWith("text/"));
    if (isAttachment) out.push({ name: name ?? "unnamed", type, size: n.size ?? null });
  };
  walk(node);
  return out;
}

/** The words as written: line breaks kept, runs of blank lines and trailing spaces closed up. */
function tidyText(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t ]+\n/g, "\n")
    .replace(/[ \t ]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export async function readInboxEmailInFull(messageId: string): Promise<InboxEmailRead | null> {
  return withMessage(messageId, { internalDate: true, bodyStructure: true, headers: HEADER_KEYS }, async (client, m) => {
    const headers = parseHeaders(m.headers);
    const email = summary(m, headers);
    if (!email) return null;
    const refs = (headers["references"] ?? "").match(/<[^<>\s]+>/g) ?? [];
    const part = findTextPart(m.bodyStructure);
    let text = "";
    let cut = false;
    if (part) {
      const got = await client.fetchAll(
        String(m.uid),
        { uid: true, bodyParts: [{ key: part.key, start: 0, maxLength: READ_LIMIT }] },
        { uid: true },
      );
      const buf = got[0]?.bodyParts?.get(part.key);
      if (buf) {
        text = tidyText(decodePart(buf, part, !!got[0]?.binaryParts?.has(part.key)));
        cut = buf.length >= READ_LIMIT;
      }
    }
    const parts = splitReply(text);
    return {
      ...email,
      snippet: snippetOf(text),
      ...parts,
      references: refs.length ? refs.join(" ") : null,
      to: addressWords(m.envelope?.to),
      cc: addressWords(m.envelope?.cc),
      text,
      cut,
      attachments: attachmentsOf(m.bodyStructure),
    };
  });
}

/* ---------- watching for replies ---------- */

/** An email newly in the inbox, with what it answers (2026-11-12). */
export type ScannedEmail = InboxEmail & {
  uid: number;
  inReplyTo: string | null;
  /** In-Reply-To and References together: every email of the conversation it names. */
  answers: string[];
};

const SCAN_KEYS = [...HEADER_KEYS, "in-reply-to"];
let scanState: { uidValidity: string; lastUid: number } | null = null;

/**
 * The emails that came into the inbox since the last look — on the first look after a start, those
 * of the last `lookbackDays` days. `pick` is asked, with the mailbox still open, which of them
 * matter; only those have their first lines read. Read only, like everything here.
 */
export async function scanInboxForNew(opts: {
  lookbackDays: number;
  pick: (emails: ScannedEmail[]) => Promise<Set<string>>;
}): Promise<ScannedEmail[]> {
  return withInbox(async (client) => {
    const lock = await lockFresh(client, "INBOX");
    try {
      const box = client.mailbox as { uidValidity?: bigint; uidNext?: number } | false;
      const validity = box ? String(box.uidValidity ?? "") : "";
      const since = scanState && scanState.uidValidity === validity ? scanState.lastUid : null;
      const found =
        since != null
          ? await client.search({ uid: `${since + 1}:*` }, { uid: true })
          : await client.search({ since: new Date(Date.now() - opts.lookbackDays * 86_400_000) }, { uid: true });
      const uids = (Array.isArray(found) ? found : []).filter((u) => since == null || u > since);
      if (!uids.length) {
        if (since == null) scanState = { uidValidity: validity, lastUid: box && box.uidNext ? box.uidNext - 1 : 0 };
        return [];
      }
      const msgs = await client.fetchAll(
        uids.join(","),
        { uid: true, envelope: true, internalDate: true, bodyStructure: true, headers: SCAN_KEYS },
        { uid: true },
      );
      const items: Array<{ uid: number; email: ScannedEmail; part: TextPart | null }> = [];
      for (const m of msgs) {
        const headers = parseHeaders(m.headers);
        const base = summary(m, headers);
        if (!base) continue;
        // Machine mail is no person's reply: our own emails and out-of-office answers say so.
        const auto = (headers["auto-submitted"] ?? "").toLowerCase();
        if (auto && auto !== "no") continue;
        const ids = (s: string | undefined) => (s ?? "").match(/<[^<>\s]+>/g) ?? [];
        const inReplyTo = ids(headers["in-reply-to"])[0] ?? m.envelope?.inReplyTo?.trim() ?? null;
        const answers = [...new Set([...(inReplyTo ? [inReplyTo] : []), ...ids(headers["references"])])];
        if (!answers.length) continue;
        items.push({ uid: m.uid, email: { ...base, uid: m.uid, inReplyTo, answers }, part: findTextPart(m.bodyStructure) });
      }
      scanState = { uidValidity: validity, lastUid: Math.max(since ?? 0, ...uids) };
      if (!items.length) return [];
      const wanted = await opts.pick(items.map((i) => i.email));
      const picked = items.filter((i) => wanted.has(i.email.messageId));
      await fillSnippets(client, picked);
      return picked.map((i) => i.email);
    } finally {
      lock.release();
    }
  });
}

/** Look again from the start of the window, as after a restart (a test, or the desk's "look now"). */
export function rescanInboxFromWindow(): void {
  scanState = null;
}

/** The words a person wrote in a reply: what follows "On … wrote:" and quoted lines left out. */
export function newPartOf(text: string): string {
  return splitReply(text).fresh;
}

/**
 * A reply in two parts (2026-11-12, operator: "beautify and make it readable"): what the person
 * wrote, and the earlier email they quoted — its "On … wrote:" line and its words without the ">"
 * marks — so the desk can show the first and fold the second.
 */
export function splitReply(text: string): { fresh: string; quoteHeader: string | null; quoted: string } {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const tidy = (s: string) => s.replace(/\n{3,}/g, "\n\n").trim();
  const unquote = (rest: string[]) =>
    tidy(
      rest
        .map((l) => l.replace(/^\s*(>\s?)+/, ""))
        .join("\n"),
    );
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    const fresh = () => tidy(lines.slice(0, i).join("\n"));
    if (line.startsWith(">")) return { fresh: fresh(), quoteHeader: null, quoted: unquote(lines.slice(i)) };
    if (/^-{2,}\s*original message\s*-{2,}$/i.test(line)) {
      return { fresh: fresh(), quoteHeader: "Original message", quoted: unquote(lines.slice(i + 1)) };
    }
    // "On Thu, 12 Nov 2026 … <someone@…> wrote:" — it may wrap over two or three lines.
    if (/^on\s/i.test(line)) {
      for (let n = 0; n < 3; n++) {
        const joined = lines
          .slice(i, i + n + 1)
          .map((l) => l.trim())
          .join(" ");
        if (/^on\s[^\n]{0,300}?\bwrote:\s*$/i.test(joined)) {
          return { fresh: fresh(), quoteHeader: joined.replace(/\s+/g, " "), quoted: unquote(lines.slice(i + n + 1)) };
        }
      }
    }
  }
  return { fresh: tidy(text), quoteHeader: null, quoted: "" };
}
