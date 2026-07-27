"use client";

/**
 * Every surface under (app) now brings its own shell: the front-desk (/desk)
 * via DeskShell and the admin console (/admin) via AdminShell. This layout is a
 * thin pass-through kept so the (app) route group can host shared providers
 * (ZoneTransitionProvider) above the per-surface shells.
 */
export function AppOrAdminLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
