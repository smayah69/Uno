// UI pieces: avatars, the turn timer ring, status badges, the scoreboard.
import { SEAT_COLORS, playerBySeat, gameTime, formatTime, sortHand } from './game.js';
import { cardEl } from './cards.js';

export const seatColor = (seat) => SEAT_COLORS[seat] || '#9a9ab0';

function hash(str) {
  let h = 2166136261;
  for (const ch of str) { h ^= ch.codePointAt(0); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

export function initials(name) {
  const words = String(name || '?').trim().split(/\s+/).filter(Boolean);
  const first = (w) => (Array.from(w)[0] || '').toUpperCase();
  return words.length > 1 ? first(words[0]) + first(words[1]) : Array.from(words[0] || '?').slice(0, 2).join('').toUpperCase();
}

// Round avatar with the player's initials, in their seat color (or a color
// picked from the name before seats are known).
export function avatar(name, seat = -1, { bot = false } = {}) {
  const a = document.createElement('span');
  a.className = 'av';
  a.style.setProperty('--c', seat >= 0 ? seatColor(seat) : SEAT_COLORS[hash(String(name).toLowerCase()) % SEAT_COLORS.length]);
  a.textContent = bot ? '🤖' : initials(name);
  if (bot) a.classList.add('is-bot');
  a.setAttribute('aria-hidden', 'true');
  return a;
}

export function badge(text, cls) {
  const b = document.createElement('span');
  b.className = `badge ${cls}`;
  b.textContent = text;
  return b;
}

// Countdown ring around an avatar (stroke-dashoffset animates 0 -> 100).
export function ringSVG() {
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', '0 0 100 100');
  svg.setAttribute('class', 'ring');
  svg.setAttribute('aria-hidden', 'true');
  const c = document.createElementNS(NS, 'circle');
  for (const [k, v] of Object.entries({ cx: 50, cy: 50, r: 47, pathLength: 100 })) c.setAttribute(k, v);
  svg.append(c);
  return svg;
}

// Restart (or stop) a countdown ring. ms <= 0 stops it.
export function setRing(holder, ms, total) {
  const ring = holder.querySelector('.ring circle');
  if (!ring) return;
  if (ms > 0) {
    ring.style.transition = 'none';
    ring.style.strokeDashoffset = String(100 * (1 - ms / total));
    void ring.getBoundingClientRect();
    ring.style.transition = `stroke-dashoffset ${ms}ms linear`;
    ring.style.strokeDashoffset = '100';
    holder.classList.add('timing');
  } else {
    ring.style.transition = 'none';
    ring.style.strokeDashoffset = '100';
    holder.classList.remove('timing');
  }
}

export function statusLabel(state, p) {
  if (state.phase === 'ended' && p.seat === state.winner) return ['winner', 'win'];
  if (p.bot && !p.cpu) return ['bot', 'bot'];
  if (!p.connected && !p.bot) return ['away', 'away'];
  if (p.afk) return ['afk', 'afk'];
  if (state.phase === 'playing' && state.uno[p.seat]) return ['uno!', 'uno'];
  return null;
}

// End of round: rank, player (with the cards they were left holding), cards,
// points in hand, points over all rounds. Returns the table, a plain-text
// version to share, and the game time.
export function scoreboard(state, { me = null, now = Date.now() } = {}) {
  const total = gameTime(state, now);
  const table = document.createElement('table');
  table.className = 'scoreboard';
  const head = table.createTHead().insertRow();
  for (const h of ['', 'Player', 'Cards', 'Points', 'Total']) {
    const th = document.createElement('th');
    th.textContent = h;
    th.scope = 'col';
    head.append(th);
  }
  const body = table.createTBody();
  const lines = [`Uno, round ${state.round} (${formatTime(total)})`];
  state.ranks.forEach((seat, i) => {
    const p = playerBySeat(state, seat);
    if (!p) return;
    const hand = sortHand((state.hands && state.hands[seat]) || []);
    const pts = state.scores[seat] || 0;
    const sum = state.totals[p.id] || 0;
    const tr = body.insertRow();
    if (i === 0) tr.className = 'winner';
    tr.style.setProperty('--c', seatColor(seat));
    tr.insertCell().textContent = i === 0 ? '🏆' : String(i + 1);
    const who = document.createElement('div');
    who.className = 'sb-player';
    tr.insertCell().append(who);
    const info = document.createElement('div');
    info.className = 'sb-info';
    const name = document.createElement('span');
    name.className = 'sb-name';
    name.textContent = p.name + (p.id === me ? ' (you)' : '');
    info.append(name);
    if (hand.length) {
      const strip = document.createElement('span');
      strip.className = 'sb-hand';
      for (const c of hand.slice(0, 14)) strip.append(cardEl(c));
      if (hand.length > 14) strip.append(`+${hand.length - 14}`);
      info.append(strip);
    }
    who.append(avatar(p.name, seat, { bot: !!p.cpu }), info);
    tr.insertCell().textContent = String(hand.length);
    tr.insertCell().textContent = i === 0 ? `+${state.roundPoints}` : String(pts);
    tr.insertCell().textContent = String(sum);
    lines.push(i === 0
      ? `1. ${p.name}: out first, +${state.roundPoints} points (total ${sum})`
      : `${i + 1}. ${p.name}: ${hand.length} card${hand.length === 1 ? '' : 's'} left, ${pts} points (total ${sum})`);
  });
  return { table, text: lines.join('\n'), total };
}
