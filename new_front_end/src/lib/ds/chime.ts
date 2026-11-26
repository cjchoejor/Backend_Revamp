/**
 * The bell's sound (2026-11-26, operator: "for cases like these where it needs higher authority
 * intervention, when notification comes, can't it make a notification sound as well").
 *
 * Two soft notes made by the browser — no sound file to load. A browser plays nothing until the
 * person has pressed or typed on the page once, so the sound is readied on the first press; a page
 * just reloaded and never touched stays quiet until then. On or off is kept for this browser.
 */

const KEY = "desk:bell-sound";

let ctx: AudioContext | null = null;
let readied = false;

function audio(): AudioContext | null {
  if (typeof window === "undefined") return null;
  if (!ctx) {
    const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return null;
    try {
      ctx = new Ctor();
    } catch {
      return null;
    }
  }
  return ctx;
}

/** Ready the sound on the first press or key on the page. Safe to call more than once. */
export function readyChimeOnFirstTouch() {
  if (readied || typeof window === "undefined") return;
  readied = true;
  const wake = () => {
    const a = audio();
    if (a && a.state === "suspended") void a.resume().catch(() => undefined);
  };
  window.addEventListener("pointerdown", wake, { capture: true });
  window.addEventListener("keydown", wake, { capture: true });
}

export function chimeOn(): boolean {
  try {
    return window.localStorage.getItem(KEY) !== "off";
  } catch {
    return true;
  }
}

export function setChimeOn(on: boolean) {
  try {
    window.localStorage.setItem(KEY, on ? "on" : "off");
  } catch {
    /* a private window keeps no setting — the sound stays as it was for this page */
  }
}

/** Two notes, rising — a few tenths of a second, quiet. Nothing when the sound is off or not readied. */
export function playChime(force = false) {
  if (!force && !chimeOn()) return;
  const a = audio();
  if (!a || a.state !== "running") return;
  const start = a.currentTime + 0.02;
  const note = (freq: number, at: number, length: number) => {
    const osc = a.createOscillator();
    const gain = a.createGain();
    osc.type = "sine";
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0.0001, at);
    gain.gain.exponentialRampToValueAtTime(0.18, at + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, at + length);
    osc.connect(gain).connect(a.destination);
    osc.start(at);
    osc.stop(at + length + 0.05);
  };
  note(880, start, 0.35); // A5
  note(1318.5, start + 0.18, 0.5); // E6
}
