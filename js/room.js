// Private rooms: /itc1 and /itc2 are fixed game addresses that only the owner
// can open (password checked by api/itc.js). Players type their name and join;
// their browser checks with the server that the host really is the owner.
//
// In ?local=1 test mode there is no server: any password works and every host
// passes. That only affects tabs of your own browser.

import { isLocalMode } from './net.js';

export const ROOMS = ['itc1', 'itc2'];
export const isRoom = (code) => ROOMS.includes(code);
export const codeLabel = (code) => code.toUpperCase(); // 'itc1' -> 'ITC1', PINs unchanged
const TICKET_KEY = 'itc.ticket';

// The room this page is for (/itc1 -> 'itc1'), or null on the normal site.
export function roomFromPath(path = location.pathname) {
  const m = /^\/(itc\d)\/?$/i.exec(path);
  return m && isRoom(m[1].toLowerCase()) ? m[1].toLowerCase() : null;
}

export function roomLink(code) {
  const u = new URL(`/${code}`, location.href);
  if (isLocalMode) u.searchParams.set('local', '1');
  return u.toString();
}

async function api(body) {
  const r = await fetch('/api/itc', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  let d = {};
  try { d = await r.json(); } catch { /* not JSON */ }
  if (!r.ok) throw Object.assign(new Error(d.error || `Server error (${r.status})`), { status: r.status });
  return d;
}

// Owner's login, kept in this browser until it expires.
export function savedTicket() {
  try {
    const t = localStorage.getItem(TICKET_KEY);
    return t && Number(t.split('.')[0]) * 1000 > Date.now() ? t : null;
  } catch { return null; }
}

export function forgetTicket() {
  try { localStorage.removeItem(TICKET_KEY); } catch { /* storage blocked */ }
}

export async function login(password) {
  const ticket = isLocalMode ? `${Math.floor(Date.now() / 1000) + 86400}.local` : (await api({ op: 'login', password })).ticket;
  try { localStorage.setItem(TICKET_KEY, ticket); } catch { /* storage blocked */ }
  return ticket;
}

// Host: answer a player's challenge.
export async function prove(ticket, room, nonce) {
  if (isLocalMode) return 'local';
  return (await api({ op: 'prove', ticket, room, nonce })).proof;
}

// Player: is this answer from the real owner?
export async function check(room, nonce, proof) {
  if (isLocalMode) return true;
  if (typeof proof !== 'string') return false;
  return (await api({ op: 'check', room, nonce, proof })).ok === true;
}
