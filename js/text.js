// Text sanitizing shared by the host, the UI and the game-code parser.
export const MAX_NAME = 16;
export const MAX_CHAT = 200;

// Control and format characters (zero-width, bidi overrides, tag characters,
// soft hyphens…) can hide or spoof text. The others are letters and symbols
// that draw nothing: Hangul fillers and the blank Braille pattern. Tabs and
// line breaks aren't removed here: they become plain spaces below.
const INVISIBLE = /(?!\s)[\p{Cc}\p{Cf}\u115F\u1160\u3164\uFFA0\u2800]/gu;
// A name has to show something: at least one letter, digit, symbol or mark of punctuation.
const VISIBLE = /[\p{L}\p{N}\p{S}\p{P}]/u;

function clean(raw, max, form) {
  if (typeof raw !== 'string') return '';
  const s = raw.normalize(form).replace(INVISIBLE, '').replace(/\s+/g, ' ').trim();
  return Array.from(s).slice(0, max).join('').trim();
}

// NFKC folds look-alikes such as fullwidth "Ｂｏｂ" into "Bob", so nobody can
// pass for someone else (names are also compared case-insensitively).
export function sanitizeName(raw) {
  const name = clean(raw, MAX_NAME, 'NFKC');
  return VISIBLE.test(name) ? name : '';
}

export const sanitizeChat = (raw) => clean(raw, MAX_CHAT, 'NFC');
