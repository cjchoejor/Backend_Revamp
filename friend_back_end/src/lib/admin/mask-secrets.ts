const SECRET_FIELD_PATTERN = /(apikey|api_key|secret|token|password|credential|privatekey|private_key)/i;

/**
 * Recursively replaces any field whose name looks like a secret with a `{ __set: boolean }`
 * marker so the value is never returned after save (ACIG §6.2.16 / §6.2.24).
 */
export function maskSecrets<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((v) => maskSecrets(v)) as unknown as T;
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (SECRET_FIELD_PATTERN.test(k)) {
        out[k] = { __set: v !== undefined && v !== null && v !== "" };
      } else {
        out[k] = maskSecrets(v);
      }
    }
    return out as unknown as T;
  }
  return value;
}

/**
 * Merge incoming values over stored values, but when an incoming secret field carries the
 * `{ __set: ... }` placeholder (i.e. the client echoed back a masked value) keep the stored secret.
 */
export function mergePreservingSecrets(incoming: unknown, stored: unknown): unknown {
  if (incoming && typeof incoming === "object" && !Array.isArray(incoming)) {
    const storedObj = stored && typeof stored === "object" && !Array.isArray(stored) ? (stored as Record<string, unknown>) : {};
    const out: Record<string, unknown> = { ...storedObj };
    for (const [k, v] of Object.entries(incoming as Record<string, unknown>)) {
      if (SECRET_FIELD_PATTERN.test(k)) {
        const isPlaceholder = v && typeof v === "object" && "__set" in (v as Record<string, unknown>);
        if (isPlaceholder) continue; // keep stored secret
        out[k] = v;
      } else {
        out[k] = mergePreservingSecrets(v, storedObj[k]);
      }
    }
    return out;
  }
  return incoming;
}
