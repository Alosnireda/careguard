/**
 * Input sanitizer for user-supplied strings crossing API boundaries.
 *
 * Strips control characters, enforces a maximum length, and restricts
 * the character set to safe characters. Used to prevent injection of
 * newlines, Unicode RTL marks, and other characters that can break
 * downstream UI parsing (receipts, PDFs, TxLink displays).
 */

const MAX_LENGTH = 80;

// Allowed: alphanumeric, space, hyphen, parentheses
const SAFE_PATTERN = /[^a-zA-Z0-9 \-()]/g;

// Control characters (U+0000–U+001F except tab/LF/CR, U+007F, U+0080–U+009F)
const CONTROL_CHARS = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F\x80-\x9F]/g;

// Bidi embedding/override/isolate marks, which can visually reorder text
const BIDI_CONTROLS = /[‪-‮⁦-⁩]/g;

export function sanitizeUserString(input: unknown): string {
  if (typeof input !== "string") return "";
  let s = input.replace(CONTROL_CHARS, "");
  // Strip any remaining disallowed characters
  s = s.replace(SAFE_PATTERN, "");
  // Trim whitespace
  s = s.trim();
  // Cap length
  if (s.length > MAX_LENGTH) s = s.slice(0, MAX_LENGTH);
  return s;
}

/**
 * Sanitizer for sentence-like free text (e.g. handoff notes, #1180) where
 * punctuation must survive. Strips control characters and bidi marks and
 * collapses all whitespace, including newlines, to single spaces. Length
 * limits are left to the caller's validation so oversized input is rejected
 * rather than silently truncated.
 */
export function sanitizeFreeText(input: unknown): string {
  if (typeof input !== "string") return "";
  return input
    .replace(CONTROL_CHARS, "")
    .replace(BIDI_CONTROLS, "")
    .replace(/\s+/g, " ")
    .trim();
}
