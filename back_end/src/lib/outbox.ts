/**
 * Emails go out after the desk has its answer (2026-11-10, operator: "settling payment, sending
 * emails are taking time, look into it and make the time less").
 *
 * Measured on the test trip: a settle's own work took under half a second, then the desk waited
 * 9.5 seconds for the mail server to take the tax invoice's email. Nothing the desk shows depends on
 * the mail server's answer arriving inside the request — every send is already best-effort, its
 * outcome recorded as a trace (`…_EMAIL.SENT / SKIPPED / ERROR`) — so the send runs right after the
 * request instead of inside it.
 *
 * - Only the API server turns this on (`sendEmailsAfterAnswer(true)` at start-up). A script, a
 *   test or a one-off repair keeps sending in place, so nothing exits with an email half sent.
 * - Sends for one booking run one after another, in the order they were asked for: the first email
 *   of a booking anchors its Gmail thread, and two at once could both think they were first.
 * - On shutdown the server waits for what is still on its way (`flushOutbox`) before it exits.
 */

let afterAnswer = false;
const pending = new Set<Promise<void>>();
const chains = new Map<string, Promise<void>>();

export function sendEmailsAfterAnswer(on: boolean): void {
  afterAnswer = on;
}

export function emailsGoAfterAnswer(): boolean {
  return afterAnswer;
}

/**
 * Runs `task` now and waits for it — or, on the API server, queues it behind the booking's earlier
 * sends and returns at once. A task never throws out of here; a failure is the task's to record.
 */
export async function runAfterAnswer(key: string, label: string, task: () => Promise<void>): Promise<void> {
  if (!afterAnswer) {
    await task();
    return;
  }
  const before = chains.get(key) ?? Promise.resolve();
  const run = before
    .then(task)
    .catch((e) => {
      console.error(`[outbox] ${label} failed:`, e instanceof Error ? e.message : e);
    })
    .finally(() => {
      pending.delete(run);
      if (chains.get(key) === run) chains.delete(key);
    });
  chains.set(key, run);
  pending.add(run);
}

/** How many sends are still on their way. */
export function outboxSize(): number {
  return pending.size;
}

/** Waits for every send still on its way, up to `timeoutMs`. */
export async function flushOutbox(timeoutMs = 20_000): Promise<void> {
  if (!pending.size) return;
  await Promise.race([Promise.allSettled([...pending]), new Promise((r) => setTimeout(r, timeoutMs))]);
}
