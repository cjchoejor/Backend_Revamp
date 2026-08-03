import { clearStaleAuth } from "./session";

/** Hard navigation to login so the browser loads fresh JS/CSS chunks (fixes dev 404s). */
export async function redirectToLogin(): Promise<void> {
  await clearStaleAuth();
  if (typeof window === "undefined") return;

  const { pathname, origin } = window.location;
  if (pathname === "/login") {
    window.history.replaceState(null, "", "/login");
    window.location.reload();
    return;
  }
  window.location.replace(`${origin}/login`);
}

/** Hard navigation after successful sign-in. */
export function redirectAfterLogin(path = "/dashboard"): void {
  if (typeof window !== "undefined") {
    window.location.replace(path);
  }
}
