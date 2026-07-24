/**
 * Document storage abstraction — dev uses local disk, prod can swap for S3 / GCS without
 * touching any calling code.
 *
 * Path shape: `documents/YYYY/MM/<KIND>/<READABLE_ID>.pdf`.
 *   YYYY/MM = calendar month of `renderedAt` — makes archival + retention windows trivial.
 *   KIND    = "quotation" | "proforma-invoice" | "confirmation-voucher" | "room-invoice".
 *   ID      = the readable business ID (QUO-20260714-0001, INV-…, RES-…).
 *
 * Immutability: writes go to a temp file first and rename atomically. Never open an existing
 * file for update — the storage layer treats every key as write-once. Callers that need to
 * "replace" an artifact must issue a new key (typically via versionNumber bump on the parent
 * row); the old file stays on disk forever.
 *
 * Checksums: `hashSha256(bytes)` is a plain helper — call it, record the hex string on the
 * parent row, and the integrity worker can recompute + compare later.
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, rename, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

/** Kinds of documents currently persisted. Add here when a new bill type joins the roster. */
export type DocumentKind =
  | "quotation"
  | "proforma-invoice"
  | "confirmation-voucher"
  | "room-invoice";

const STORAGE_ROOT = resolve(process.env.STORAGE_ROOT_DIR ?? "./storage");

/**
 * Compose the storage key for a given document. `at` is the render time (used for the
 * YYYY/MM partitioning). Keys are relative to STORAGE_ROOT so the same string can be handed
 * to any backend (local FS today, S3 tomorrow) without alteration.
 */
export function buildStorageKey(kind: DocumentKind, readableId: string, at: Date = new Date()): string {
  const y = at.getUTCFullYear();
  const m = String(at.getUTCMonth() + 1).padStart(2, "0");
  return `documents/${y}/${m}/${kind}/${readableId}.pdf`;
}

/** SHA-256 hex digest of a buffer. Used for integrity checksums. */
export function hashSha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * Write bytes under `key`. Fails if the key already exists — writes are one-shot to guarantee
 * the file the guest received is the file that stays on disk.
 *
 * Returns the absolute path so callers can trace-log it.
 */
export async function writeDocument(key: string, bytes: Buffer): Promise<string> {
  const abs = join(STORAGE_ROOT, key);
  // Reject re-writes explicitly — invoice artifacts are append-only.
  try {
    await stat(abs);
    throw new Error(`Document already exists at ${key}. Storage layer is write-once. Bump the parent version to produce a new artifact.`);
  } catch (e) {
    const err = e as NodeJS.ErrnoException;
    if (err.code !== "ENOENT") throw e;
  }
  await mkdir(dirname(abs), { recursive: true });
  // Write atomically: bytes → temp → rename. Prevents readers seeing half-written PDFs.
  const tmp = abs + ".tmp";
  await writeFile(tmp, bytes);
  await rename(tmp, abs);
  return abs;
}

/** Read bytes from `key`. Throws if missing — callers decide how to surface 404. */
export async function readDocument(key: string): Promise<Buffer> {
  const abs = join(STORAGE_ROOT, key);
  return readFile(abs);
}

/** True when `key` resolves to a file on disk. */
export async function documentExists(key: string): Promise<boolean> {
  const abs = join(STORAGE_ROOT, key);
  try {
    await stat(abs);
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw e;
  }
}

/**
 * Verify that the file at `key` still hashes to `expected`. Returns `{ ok, actual }` — callers
 * decide whether a mismatch is a tamper alert or a soft warning.
 */
export async function verifyChecksum(key: string, expected: string): Promise<{ ok: boolean; actual: string }> {
  const bytes = await readDocument(key);
  const actual = hashSha256(bytes);
  return { ok: actual === expected, actual };
}

/**
 * Escape hatch for test cleanup ONLY. Not exported through any operational path. Remove-file
 * on a real artifact would violate the storage contract — only call from test teardown.
 */
export async function __testOnlyDeleteDocument(key: string): Promise<void> {
  if (process.env.NODE_ENV === "production") throw new Error("__testOnlyDeleteDocument is not permitted in production.");
  const abs = join(STORAGE_ROOT, key);
  await unlink(abs).catch(() => {});
}
