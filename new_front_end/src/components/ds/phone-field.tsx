"use client";

import { useEffect, useRef, useState } from "react";
import { usePhoneRules } from "@/hooks/use-phone-rules";
import { digitsWanted, formatPhone, parsePhone, phoneProblem, type PhoneRules } from "@/lib/ds/phone";

const seed = (value: string | null | undefined, rules: PhoneRules, fallback: string) => {
  const p = parsePhone(value, rules);
  if (!p) return { code: fallback, number: "" };
  return { code: p.code, number: p.number };
};

/**
 * A phone number as two fields, the desk's and the admin console's one way to ask for one (2026-11-05,
 * operator: "keep a separate field for country code, and based on that set the phone number field to
 * accept exactly the right amount of digits"). The parent holds one value, "+975 17882104".
 *
 * The number takes digits only and stops at what its code allows. A whole number pasted with its
 * code fills both fields. While short it counts up; left short it says so in red. A number already on
 * file that fits nothing keeps its digits and says what is wrong, so a person can put it right.
 */
export function PhoneField({
  value,
  onChange,
  inputClass = "input",
  ariaLabel = "Phone",
  disabled,
  readOnly,
  defaultCode = "+975",
  autoFocus,
}: {
  value: string | null | undefined;
  onChange: (value: string) => void;
  /** The text box's class: `input` on the desk, `admin-input` in the admin console. */
  inputClass?: string;
  ariaLabel?: string;
  disabled?: boolean;
  readOnly?: boolean;
  defaultCode?: string;
  autoFocus?: boolean;
}) {
  const rules = usePhoneRules();
  const [{ code, number }, setParts] = useState(() => seed(value, rules, defaultCode));
  const [typedCode, setTypedCode] = useState(false);
  const [focused, setFocused] = useState(false);
  // What this field last said, so a value from outside is told apart from its own echo.
  const said = useRef(value ?? "");
  useEffect(() => {
    if ((value ?? "") === said.current) return;
    said.current = value ?? "";
    setParts((cur) => (value ? seed(value, rules, cur.code) : { code: cur.code, number: "" }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);
  // The full table arrives a moment after the first draw: a stored number is read again against it.
  useEffect(() => {
    if (!(value ?? "").trim()) return;
    setParts((cur) => seed(value, rules, cur.code));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rules]);

  const tell = (c: string, n: string) => {
    setParts({ code: c, number: n });
    const v = formatPhone(c, n);
    said.current = v;
    onChange(v);
  };
  const want = digitsWanted(rules, code);
  const listed = rules.codes.some((c) => c.code === code);
  const inert = disabled || readOnly;

  const split = (p: { code: string; number: string }) => {
    setTypedCode(!rules.codes.some((c) => c.code === p.code));
    tell(p.code, p.number);
  };
  const onNumber = (raw: string) => {
    const digits = raw.replace(/\D/g, "");
    // A whole number with its code, pasted or typed key by key: both fields take their part. Until
    // the digits say which code it is, the box keeps what was typed.
    if (raw.trim().startsWith("+")) {
      const p = parsePhone(raw, rules);
      if (p?.sure === "CLEAR") return split(p);
      return tell(code, `+${digits}`);
    }
    // The code typed in front of the number, with no plus: "97517882104" under +975.
    const own = code.slice(1);
    if (own && digits.startsWith(own)) {
      if (digits.length === want.max + own.length) return tell(code, digits.slice(own.length));
      if (digits.length < want.max + own.length && digits.length > want.max) return tell(code, digits);
    }
    if (digits.length > want.max) {
      // More than one digit at once is a paste: it may be a whole number for another code.
      const p = digits.length > number.length + 1 ? parsePhone(raw, rules) : null;
      if (p && p.sure !== "UNCLEAR") return split(p);
      // One key too many stops at what the code allows; a number on file that is already too long
      // can only get shorter.
      if (digits.length >= number.length) return tell(code, number);
    }
    tell(code, digits);
  };

  const typingWhole = number.startsWith("+");
  const problem = number && !typingWhole ? phoneProblem(rules, code, number) : null;
  const counting = !!problem && focused && !!code && number.length < want.min;
  return (
    <span className="phone-wrap">
      <span className="phone-field">
        {typedCode ? (
          <>
            <input
              className={`${inputClass} phone-code-typed`}
              aria-label="Country code"
              placeholder="+__"
              maxLength={5}
              disabled={disabled}
              readOnly={readOnly}
              value={code}
              onChange={(e) => {
                const v = e.target.value.replace(/[^\d+]/g, "");
                tell(v && !v.startsWith("+") ? `+${v}` : v, number);
              }}
            />
            {inert ? null : (
              <button
                type="button"
                className="phone-other"
                title="Back to the list of codes"
                aria-label="Back to the list of codes"
                onClick={() => {
                  setTypedCode(false);
                  tell(defaultCode, number);
                }}
              >
                ↺
              </button>
            )}
          </>
        ) : (
          <>
            <span className="phone-code">
              <select
                className={inputClass}
                aria-label="Country code"
                value={code}
                disabled={inert}
                onChange={(e) => tell(e.target.value, number)}
              >
                {code ? null : (
                  <option value="" disabled>
                    no code yet
                  </option>
                )}
                {code && !listed ? <option value={code}>{code}</option> : null}
                {rules.codes.map((c) => (
                  <option key={c.code} value={c.code}>
                    {c.code} {c.country}
                  </option>
                ))}
              </select>
              <span className="phone-code-shown" aria-hidden>
                {code || "code"}
              </span>
            </span>
            {inert ? null : (
              <button
                type="button"
                className="phone-other"
                title="A code that is not on the list"
                aria-label="A code that is not on the list"
                onClick={() => {
                  setTypedCode(true);
                  tell("", number);
                }}
              >
                +
              </button>
            )}
          </>
        )}
        <input
          className={`${inputClass}${problem && !counting ? " invalid" : ""} phone-number`}
          inputMode="numeric"
          aria-label={ariaLabel}
          aria-invalid={problem && !counting ? true : undefined}
          placeholder={code ? `${want.words} digits` : "the number"}
          disabled={disabled}
          readOnly={readOnly}
          autoFocus={autoFocus}
          value={number}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          onChange={(e) => onNumber(e.target.value)}
        />
      </span>
      {typingWhole ? (
        <span className="phone-count">finish the number, its code first</span>
      ) : counting ? (
        <span className="phone-count">
          {number.length} of {want.words} digits
        </span>
      ) : problem ? (
        <span className="phone-problem">{problem}</span>
      ) : null}
    </span>
  );
}

/** Several numbers, each with its own code: an agency's or a company's contact numbers. */
export function PhoneListField({
  value,
  onChange,
  inputClass = "admin-input",
  addLabel = "+ Add number",
}: {
  value: string[];
  onChange: (next: string[]) => void;
  inputClass?: string;
  addLabel?: string;
}) {
  return (
    <span className="phone-list">
      {value.map((n, i) => (
        <span key={i} className="phone-list-row">
          <PhoneField value={n} inputClass={inputClass} ariaLabel={`Number ${i + 1}`} onChange={(v) => onChange(value.map((x, j) => (j === i ? v : x)))} />
          <button type="button" className="admin-btn admin-btn-ghost admin-btn-sm" onClick={() => onChange(value.filter((_, j) => j !== i))}>
            Remove
          </button>
        </span>
      ))}
      <span>
        <button type="button" className="admin-btn admin-btn-ghost admin-btn-sm" onClick={() => onChange([...value, ""])}>
          {addLabel}
        </button>
      </span>
    </span>
  );
}
