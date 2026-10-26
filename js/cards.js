// Card faces and backs, drawn with HTML + CSS (no images). Every size inside
// a card is in em, and a card's font-size is its width (--w).
import { cardName, isWild, CARD_COLORS } from './game.js';

const NS = 'http://www.w3.org/2000/svg';

function el(tag, cls, parent) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (parent) parent.append(e);
  return e;
}

function icon(kind) {
  const s = document.createElementNS(NS, 'svg');
  s.setAttribute('viewBox', '0 0 24 24');
  s.setAttribute('class', 'ico');
  s.setAttribute('aria-hidden', 'true');
  const add = (name, attrs) => {
    const n = document.createElementNS(NS, name);
    for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
    s.append(n);
  };
  const line = { fill: 'none', stroke: 'currentColor', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' };
  if (kind === 'skip') {
    add('circle', { cx: 12, cy: 12, r: 8.2, ...line, 'stroke-width': 3.2 });
    add('path', { d: 'M6.4 17.6 17.6 6.4', ...line, 'stroke-width': 3.2 });
  } else if (kind === 'rev') {
    add('path', { d: 'M4 9h12.5M13 5l4 4-4 4', ...line, 'stroke-width': 2.8 });
    add('path', { d: 'M20 15H7.5M11 11l-4 4 4 4', ...line, 'stroke-width': 2.8 });
  }
  return s;
}

// What goes in the middle and the corners for a value.
function label(v, parent, corner) {
  if (v === 'skip' || v === 'rev') parent.append(icon(v));
  else if (v === 'wild') {
    if (corner) el('span', 'mini-wild', parent);
  } else parent.textContent = v === 'd2' ? '+2' : v === 'd4' ? '+4' : v;
  if (v === '6' || v === '9') parent.classList.add('under');
}

// A card face. `tag` is 'button' for cards in your hand.
export function cardEl(card, tag = 'div') {
  const node = el(tag, `card c-${card.c} v-${card.v}`);
  if (tag === 'button') node.type = 'button';
  node.dataset.id = card.id;
  const name = cardName(card) + (card.w ? ` (${CARD_COLORS[card.w].name})` : '');
  node.setAttribute('aria-label', name);
  if (tag !== 'button') node.setAttribute('role', 'img');
  if (card.w) {
    node.classList.add('chosen');
    node.style.setProperty('--wc', CARD_COLORS[card.w].main);
  }
  const face = el('span', 'face', node);
  el('span', isWild(card) ? 'oval quad' : 'oval', face);
  label(card.v, el('span', 'mid', face), false);
  label(card.v, el('span', 'cnr tl', face), true);
  label(card.v, el('span', 'cnr br', face), true);
  return node;
}

export function backEl() {
  const node = el('div', 'card back');
  node.setAttribute('aria-hidden', 'true');
  const face = el('span', 'face', node);
  el('span', 'oval', face);
  el('span', 'word', face).textContent = 'UNO';
  return node;
}
