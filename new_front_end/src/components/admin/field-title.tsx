"use client";

import type { CSSProperties, ReactNode } from "react";
import { Help } from "@/components/ds/help";

/** The longest note that still sits beside a field's title. A longer one goes behind a "?". */
const BESIDE_THE_TITLE = 30;

/**
 * A field's title (2026-11-03, operator: "if it is a title of a field, make them prominent; the short
 * info, keep at the side in grey; if long, make it into the question mark"). `hint` follows that rule
 * by its length; `help` always goes behind the "?".
 */
export function FieldTitle({ label, hint, help, required }: { label: string; hint?: string; help?: ReactNode; required?: boolean }) {
  const long = !!hint && hint.length > BESIDE_THE_TITLE;
  return (
    <span className="adm-field-title">
      <span>
        {label}
        {required ? <span className="adm-field-req"> *</span> : null}
      </span>
      {long ? <Help label={label}>{hint}</Help> : null}
      {help ? <Help label={label}>{help}</Help> : null}
      {hint && !long ? <span className="adm-field-hint">{hint}</span> : null}
    </span>
  );
}

/** A title and its control. `group` is for several controls together (ticks), which a label cannot hold. */
export function AdmField({
  label,
  hint,
  help,
  required,
  group,
  className,
  style,
  children,
}: {
  label: string;
  hint?: string;
  help?: ReactNode;
  required?: boolean;
  group?: boolean;
  className?: string;
  style?: CSSProperties;
  children: ReactNode;
}) {
  const Box = group ? "div" : "label";
  return (
    <Box className={`adm-field${className ? ` ${className}` : ""}`} style={style}>
      <FieldTitle label={label} hint={hint} help={help} required={required} />
      {children}
    </Box>
  );
}
