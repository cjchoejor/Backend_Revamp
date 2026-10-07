"use client";

/**
 * Open the board on the second monitor.
 *
 * Chrome and Edge can say which monitors are attached (the Window Management API — it asks the
 * person once), so the board opens filling the monitor the desk is NOT on. Elsewhere it opens as
 * a normal window to drag across once. Pressing the button again brings the open board forward
 * instead of opening a second one.
 */

const WINDOW_NAME = "legphel-second-screen";
export const SECOND_SCREEN_PATH = "/second-screen";

type ScreenLike = { availLeft: number; availTop: number; availWidth: number; availHeight: number };
type ScreenDetailsLike = { screens: ScreenLike[]; currentScreen: ScreenLike };

let board: Window | null = null;

async function otherScreen(): Promise<ScreenLike | null> {
  const w = window as unknown as {
    getScreenDetails?: () => Promise<ScreenDetailsLike>;
    screen: Screen & { isExtended?: boolean };
  };
  if (typeof w.getScreenDetails !== "function" || w.screen.isExtended === false) return null;
  try {
    const details = await w.getScreenDetails();
    return details.screens.find((s) => s !== details.currentScreen) ?? null;
  } catch {
    // the person said no, or the browser refused — open it where the browser likes
    return null;
  }
}

/** Returns false when the browser blocked the window (pop-ups not allowed for this site). */
export async function openSecondScreen(): Promise<boolean> {
  if (board && !board.closed) {
    board.focus();
    return true;
  }
  const s = await otherScreen();
  const features = s
    ? `popup=yes,left=${s.availLeft},top=${s.availTop},width=${s.availWidth},height=${s.availHeight}`
    : "popup=yes,width=1440,height=900";
  board = window.open(SECOND_SCREEN_PATH, WINDOW_NAME, features);
  board?.focus();
  return !!board;
}
