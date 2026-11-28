// Country calling codes (ITU-T E.164). They are a prefix code: no code is the start of another,
// so the first 1, 2 or 3 digits after '+' name the country (or the +1 / +7 numbering plan).
// Only +1 and +7 are one digit; the two-digit ones are listed; every other code has three.

const TWO = new Set([
  20, 27, 30, 31, 32, 33, 34, 36, 39, 40, 41, 43, 44, 45, 46, 47, 48, 49, 51, 52, 53, 54, 55, 56, 57, 58,
  60, 61, 62, 63, 64, 65, 66, 81, 82, 84, 86, 90, 91, 92, 93, 94, 95, 98,
].map(String));

export const CALLING_CODE_RE = /^\+[1-9]\d{0,2}$/;

/** '+447700900123' -> '+44'; null for anything that is not an E.164 number. */
export function callingCode(number) {
  const m = /^\+([1-9]\d{6,14})$/.exec(String(number || ''));
  if (!m) return null;
  const d = m[1];
  if (d[0] === '1' || d[0] === '7') return `+${d[0]}`;
  return TWO.has(d.slice(0, 2)) ? `+${d.slice(0, 2)}` : `+${d.slice(0, 3)}`;
}
