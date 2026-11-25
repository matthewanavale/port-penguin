// G-SEC-2: maps keyed by player text have no prototype, so a key such as
// `__proto__` or `constructor` is an ordinary key and never reaches Object.prototype.
// (The file is not called nul.ts: NUL is a reserved device name on Windows.)

/** A new prototype-less map holding the own entries of `src`. */
export function nul<T = string>(
  src?: Record<string, T> | null,
): Record<string, T> {
  const o = Object.create(null) as Record<string, T>;
  if (src) for (const k of Object.keys(src)) o[k] = src[k];
  return o;
}
