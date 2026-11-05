"use client";

import { useEffect, useState } from "react";
import { AdmField } from "@/components/admin/field-title";

/**
 * A travel agent's or company's own advance, as a percentage of the stay (2026-11-05, operator: "in
 * each of the travel agent we can set the advance percentage there"). Empty is not set, which asks
 * nothing. The text is held here so "30." can be typed on the way to "30.5".
 */
export function AdvancePercentField({
  value,
  onChange,
  whose,
}: {
  value: number | null | undefined;
  onChange: (v: number | null) => void;
  whose: string;
}) {
  const stored = value == null ? "" : String(value);
  const [text, setText] = useState(stored);
  // Another party opened, or a save come back: only when it is not what is being typed.
  useEffect(() => {
    setText((t) => (t !== "" && Number(t) === Number(value ?? Number.NaN) ? t : stored));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stored]);
  return (
    <AdmField
      label="Advance"
      hint={text.trim() ? "of the stay's total" : "not set"}
      help={`What a booking through ${whose} is asked to pay ahead, as a share of the stay's total. Left empty, nothing is asked unless the desk sets it on the booking. It is worked out when a booking reaches Set up, so changing it here leaves bookings already past that point as they are.`}
    >
      <span className="flex items-center gap-2">
        <input
          className="admin-input"
          style={{ width: 96 }}
          inputMode="decimal"
          value={text}
          onChange={(e) => {
            const v = e.target.value.trim();
            if (!/^\d{0,3}(\.\d{0,2})?$/.test(v)) return;
            if (v !== "" && Number(v) > 100) return;
            setText(v);
            onChange(v === "" || v === "." ? null : Number(v));
          }}
        />
        <span aria-hidden="true">%</span>
      </span>
    </AdmField>
  );
}
