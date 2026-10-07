import type { ReactNode } from "react";
// The same stylesheets as the desk's (ds) layout, in the same order — but no AppShell: the second
// screen is a board, not a place to work, so it carries no navigation of its own.
import "@/design-system/styles/fonts.css";
import "@/design-system/styles/tokens.css";
import "@/design-system/styles/components.css";
import "@/styles/desk-theme.css";
import "@/design-system/styles/legacy-bridge.css";
import "@/design-system/styles/frame.css";

export default function SecondScreenLayout({ children }: { children: ReactNode }) {
  return <>{children}</>;
}
