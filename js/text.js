// Text sanitizing shared by the host, the UI and the game-code parser.
export const MAX_NAME = 16;
export const MAX_CHAT = 200;

// Control, zero-width and bidi-override characters (they can spoof or hide text).
const INVISIBLE = /[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁠-⁩﻿]/g;

function clean(raw, max) {
  if (typeof raw !== 'string') return '';
  const s = raw.replace(INVISIBLE, '').replace(/\s+/g, ' ').trim();
  return Array.from(s).slice(0, max).join('').trim();
}

export const sanitizeName = (raw) => clean(raw, MAX_NAME);
export const sanitizeChat = (raw) => clean(raw, MAX_CHAT);
