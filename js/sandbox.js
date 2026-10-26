// /sandbox: try the game alone. The same rules engine and table as the real
// game, run locally: pick the seat you play, give anyone any card, set up
// situations, fire the effects and sounds.
import {
  COLOR_KEYS, CARD_COLORS, RULE_KEYS, MAX_PLAYERS, MIN_PLAYERS, createLobby, startGame, play, draw, pass, callUno,
  catchUno, autoMove, viewFor, playerBySeat, canJump, sortHand, isWild, topCard, cardName,
} from './game.js';
import { TableView, awayPlayers } from './table.js';
import { cardEl } from './cards.js';
import { avatar, badge, scoreboard, seatColor } from './parts.js';
import { sound } from './sound.js';

const $ = (sel) => document.querySelector(sel);
const NAMES = ['Hana', 'Ali', 'Bea', 'Chloé', 'Dris', 'Emma', 'Farid', 'Gus'];
const BOT_MS = 1100;
const VALUES = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9', 'skip', 'rev', 'd2'];

let s = null;            // engine state (everything, every hand)
let as = 0;              // the seat you play
let target = 1;          // seat that "Give a card" and the effects aim at, or 'pile'
let nextId = 1000;       // ids for cards made out of thin air
let botTimer = null;
let jumpTimer = null;
let jumpFor = null;
let catchTimer = null;
let catchFor = null;

function toast(text) {
  const t = $('#toast');
  t.textContent = text;
  t.classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => t.classList.remove('show'), 2400);
}

const act = (fn) => {
  try { fn(); } catch (err) { toast(err.message); }
  render();
};

const table = new TableView({
  actions: {
    play: (ids, color) => act(() => play(s, as, ids, color)),
    draw: () => act(() => draw(s, as)),
    pass: () => act(() => pass(s, as)),
    uno: () => act(() => callUno(s, as)),
    catch: (seat) => act(() => catchUno(s, as, seat)),
  },
  toast,
});

// ---- the game ----
function newGame(n = s ? s.players.length : 4, rules = s ? s.rules : { jumpIn: true, multi: true, stack: true }) {
  clearTimers();
  const totals = s ? s.totals : {};
  const round = s ? s.round : 0;
  const eventId = s ? s.eventId : 0;
  s = createLobby(rules);
  s.totals = totals;
  s.round = round;
  s.eventId = eventId;
  for (let i = 0; i < n; i++) s.players.push({ id: `p${i}`, name: NAMES[i], seat: -1, connected: true, host: i === 0 });
  startGame(s);
  if (as >= n) as = 0;
  if (target !== 'pile' && target >= n) target = (as + 1) % n;
  $('#overlay').hidden = true;
  render();
}

// Take a card with this color and value out of the draw pile, or make one.
function takeCard(c, v) {
  const i = s.deck.findIndex((x) => x.c === c && x.v === v);
  return i >= 0 ? s.deck.splice(i, 1)[0] : { id: nextId++, c, v };
}

// 'r7', 'bskip', 'gd2', 'wwild', 'wd4' -> a card
const spec = (str) => takeCard(str[0], str.slice(1));

function giveTo(seat, card) {
  s.hands[seat].push(card);
  if (s.hands[seat].length > 1) { s.uno[seat] = false; delete s.exposed[seat]; }
}

function putOnPile(card, color = card.c) {
  const c = isWild(card) ? (COLOR_KEYS.includes(color) ? color : 'r') : card.c;
  s.discard.push(isWild(card) ? { ...card, w: c } : card);
  s.color = c;
  s.by = -1;
  s.drawn = null;
}

function setHand(seat, specs) {
  s.deck.unshift(...s.hands[seat]);
  s.hands[seat] = specs.map(spec);
  s.uno[seat] = false;
  delete s.exposed[seat];
  s.armed[seat] = false;
}

function setTurn(seat) {
  s.turn = seat;
  s.drawn = null;
}

// Sandbox-only changes (giving cards, setups) don't go through the engine:
// bump the counters so everything redraws.
function changed(note) {
  if (note) s.note = note;
  s.seq += 1;
  render();
}

// Push a visual-only event so the table plays its animation and sound.
function fire(e) {
  s.eventId += 1;
  s.events.push({ id: s.eventId, ...e });
  if (s.events.length > 16) s.events.shift();
  render();
}

// ---- the other players ----
function clearTimers() {
  clearTimeout(botTimer);
  clearTimeout(jumpTimer);
  clearTimeout(catchTimer);
  jumpFor = catchFor = null;
}

function botsOn() {
  return $('#sb-auto').checked && s.phase === 'playing' && !awayPlayers(s).length;
}

function scheduleBots() {
  clearTimeout(botTimer);
  if (!botsOn()) return;
  // Someone forgot to say UNO: a bot may notice (Contre-UNO).
  const exposed = Object.keys(s.exposed).map(Number);
  const key = exposed.join(',') || null;
  if (key !== catchFor) {
    catchFor = key;
    clearTimeout(catchTimer);
    const victim = exposed[0];
    const catcher = s.players.map((p) => p.seat).find((x) => x !== as && x !== victim);
    if (key && catcher !== undefined && Math.random() < 0.8) {
      catchTimer = setTimeout(() => {
        if (!botsOn() || !s.exposed[victim]) return;
        act(() => catchUno(s, catcher, victim));
      }, 2200 + Math.random() * 2500);
    }
  }
  // Saute mouton: a bot with the same card jumps in.
  const top = topCard(s);
  const jkey = s.rules.jumpIn ? `${top.id}|${s.by}` : null;
  if (jkey !== jumpFor) {
    jumpFor = jkey;
    clearTimeout(jumpTimer);
    const jumper = s.players.map((p) => p.seat).find((x) => x !== as && s.hands[x].some((c) => canJump(s, x, c)));
    if (jkey && jumper !== undefined && Math.random() < 0.7) {
      jumpTimer = setTimeout(() => {
        const card = botsOn() && s.hands[jumper].find((c) => canJump(s, jumper, c));
        if (!card) return;
        if (s.hands[jumper].length === 2 && Math.random() < 0.8) callUno(s, jumper);
        act(() => play(s, jumper, [card.id]));
      }, 700 + Math.random() * 900);
    }
  }
  if (s.turn === as) return;
  botTimer = setTimeout(() => {
    if (!botsOn() || s.turn === as) return;
    const seat = s.turn;
    const m = autoMove(s, seat);
    act(() => {
      if (m.kind === 'play') {
        if (s.hands[seat].length - m.ids.length === 1 && Math.random() < 0.8) callUno(s, seat);
        play(s, seat, m.ids, m.color);
      } else if (m.kind === 'draw') draw(s, seat);
      else pass(s, seat);
    });
  }, BOT_MS);
}

// ---- situations ----
const SETUPS = [
  ['Say UNO', 'You have 2 cards. Press UNO first, then play one.', () => {
    putOnPile(takeCard('r', '5'));
    setHand(as, ['r7', 'b5']);
    setTurn(as);
  }],
  ['Catch someone', `They're down to one card and forgot UNO. Hit Contre-UNO! before a bot does.`, () => {
    const other = (as + 1) % s.players.length;
    setHand(other, ['g4']);
    s.exposed[other] = true;
    setTurn(as);
  }],
  ['You forgot UNO', 'You have one card and never said UNO. Wait: a bot will catch you.', () => {
    putOnPile(takeCard('b', '3'));
    setHand(as, ['y8']);
    s.exposed[as] = true;
    setTurn((as + 1) % s.players.length);
  }],
  ['Jump in', 'Someone threw a red 7 and you have one too: throw it now (saute mouton).', () => {
    s.rules.jumpIn = true;
    const n = s.players.length;
    putOnPile(takeCard('r', '7'));
    s.by = (as + 1) % n;
    setHand(as, ['r7', 'g2', 'bskip', 'y9']);
    setTurn(n > 2 ? (as + 2) % n : (as + 1) % n);
  }],
  ['Doubles', 'Tap a 7, then the other 7s, then Play: they all go down together.', () => {
    s.rules.multi = true;
    putOnPile(takeCard('g', '7'));
    setHand(as, ['r7', 'b7', 'y7', 'g2', 'yrev']);
    setTurn(as);
  }],
  ['+2 combo', '+4 is stacked on you: answer with a +2 to pass it on, or draw.', () => {
    s.rules.stack = true;
    putOnPile(takeCard('r', 'd2'));
    s.pending = 4;
    setHand(as, ['bd2', 'g5', 'y1']);
    setHand((as + 1) % s.players.length, ['gd2', 'r3', 'b4']);
    setTurn(as);
  }],
  ['Specials', 'Every special card in your hand: Skip, Reverse, +2, Wild, Wild +4.', () => {
    putOnPile(takeCard('b', '5'));
    setHand(as, ['rskip', 'brev', 'gd2', 'yskip', 'yrev', 'wwild', 'wd4']);
    setTurn(as);
  }],
  ['Reverse', 'Play the Reverse: the arrows around the table flip.', () => {
    putOnPile(takeCard('y', '2'));
    setHand(as, ['yrev', 'brev', 'g3']);
    setTurn(as);
  }],
  ['Last card', "You said UNO and your last card fits: play it to see the round's end.", () => {
    putOnPile(takeCard('g', '1'));
    setHand(as, ['g9']);
    s.uno[as] = true;
    setTurn(as);
  }],
  ['Reshuffle', 'One card left in the deck: draw twice to see the discards shuffled back.', () => {
    const moved = s.deck.splice(1);
    const top = s.discard.pop();
    s.discard.push(...moved, top);
    setTurn(as);
  }],
  ['Big hand', '25 cards, to see how a full hand fits.', () => {
    setHand(as, []);
    for (let i = 0; i < 25 && s.deck.length; i++) giveTo(as, s.deck.pop());
    setTurn(as);
  }],
];

const EFFECTS = [
  ['UNO!', () => fire({ kind: 'uno', seat: seatTarget() })],
  ['Contre-UNO!', () => fire({ kind: 'catch', seat: (seatTarget() + 1) % s.players.length, target: seatTarget() })],
  ['+2', () => fire({ kind: 'draw', seat: seatTarget(), n: 2 })],
  ['+4', () => fire({ kind: 'draw', seat: seatTarget(), n: 4 })],
  ['Skip', () => fire({ kind: 'skip', seat: seatTarget() })],
  ['Reverse', () => { s.dir = -s.dir; fire({ kind: 'reverse', dir: s.dir }); }],
  ['Saute mouton', () => fire({ kind: 'play', seat: seatTarget(), cards: [{ ...topCard(s) }], jump: true })],
  ['Deal', () => fire({ kind: 'start', seat: s.turn })],
  ['Shuffle', () => fire({ kind: 'shuffle' })],
  ['Chat', () => table.bubble(seatTarget(), 'good luck everyone!', 'say')],
];

const SOUNDS = ['card', 'draw', 'shuffle', 'turn', 'armed', 'uno', 'caught', 'forgot', 'skip', 'reverse', 'penalty', 'wild', 'jump', 'chat', 'win', 'lose'];

const seatTarget = () => (target === 'pile' ? (as + 1) % s.players.length : target);

// ---- rendering ----
function render() {
  const me = playerBySeat(s, as);
  table.render(viewFor(s, as), me.id, { turnMs: 0 });
  renderPanel();
  const chips = [['jumpIn', '≡ Jump in'], ['multi', '×2 Doubles'], ['stack', '+2 Combo']].filter(([k]) => s.rules[k]);
  $('#rule-chips').replaceChildren(...chips.map(([, t]) => badge(t, 'rule')));
  if (s.phase === 'ended' && $('#overlay').hidden && !render.endShown) {
    render.endShown = true;
    const winner = playerBySeat(s, s.winner);
    setTimeout(() => (s.winner === as ? sound.win() : sound.lose()), 500);
    setTimeout(() => {
      if (s.phase !== 'ended') return;
      const sb = scoreboard(viewFor(s, as), { me: me.id });
      $('#overlay-title').textContent = s.winner === as ? 'You win the round! 🎉' : `${winner.name} wins the round`;
      $('#overlay-sub').textContent = `Round ${s.round} · the winner scores the points left in everyone's hands`;
      $('#overlay-board').replaceChildren(sb.table);
      $('#overlay').hidden = false;
    }, 1700);
  }
  if (s.phase !== 'ended') render.endShown = false;
  scheduleBots();
}

function seg(el, items, current, onPick) {
  el.replaceChildren(...items.map(([value, label, extra]) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'seg-btn' + (value === current ? ' on' : '');
    if (extra) b.append(extra);
    b.append(label);
    b.addEventListener('click', () => onPick(value));
    return b;
  }));
}

function renderPanel() {
  const n = s.players.length;
  seg($('#sb-count'), Array.from({ length: MAX_PLAYERS - MIN_PLAYERS + 1 }, (_, i) => [i + MIN_PLAYERS, String(i + MIN_PLAYERS)]), n, (k) => newGame(k));
  seg($('#sb-as'), s.players.map((p) => [p.seat, p.name, avatar(p.name, p.seat)]), as, (seat) => {
    as = seat;
    if (target === as) target = (as + 1) % n;
    table.seatsKey = null; // re-seat everyone around the new "you"
    render();
  });
  for (const input of document.querySelectorAll('#panel [data-rule]')) input.checked = !!s.rules[input.dataset.rule];
  seg($('#sb-target'), [...s.players.map((p) => [p.seat, p.seat === as ? `${p.name} (you)` : p.name]), ['pile', 'Pile']], target, (t) => { target = t; renderPanel(); });
  seg($('#sb-color'), COLOR_KEYS.map((c) => [c, CARD_COLORS[c].name]), s.color, (c) => { s.color = c; changed(); });
  for (const b of $('#sb-color').children) b.classList.add(`c-${COLOR_KEYS[[...b.parentNode.children].indexOf(b)]}`, 'color-seg');

  $('#sb-hands').replaceChildren(...s.players.map((p) => {
    const li = document.createElement('li');
    li.className = 'sb-hand-row' + (p.seat === s.turn && s.phase === 'playing' ? ' turn' : '');
    li.style.setProperty('--c', seatColor(p.seat));
    const head = document.createElement('div');
    head.className = 'sb-hand-head';
    const name = document.createElement('b');
    name.textContent = `${p.name}${p.seat === as ? ' (you)' : ''}`;
    const count = document.createElement('span');
    count.className = 'muted small';
    count.textContent = `${s.hands[p.seat].length} card${s.hands[p.seat].length === 1 ? '' : 's'}`;
    head.append(avatar(p.name, p.seat), name, count);
    if (s.uno[p.seat]) head.append(badge('uno', 'uno'));
    if (s.exposed[p.seat]) head.append(badge('forgot uno', 'afk'));
    const tools = document.createElement('span');
    tools.className = 'sb-tools';
    const btn = (label, title, fn) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.className = 'btn small';
      b.textContent = label;
      b.title = title;
      b.addEventListener('click', fn);
      tools.append(b);
    };
    btn('▶', `Make it ${p.name}'s turn`, () => { setTurn(p.seat); changed(`${p.name}'s turn`); });
    const status = !p.connected ? 'away' : p.afk ? 'afk' : p.bot ? 'bot' : 'here';
    btn(status, 'Cycle: here, afk, bot, away', () => {
      const next = { here: 'afk', afk: 'bot', bot: 'away', away: 'here' }[status];
      Object.assign(p, { connected: next !== 'away', afk: next === 'afk', bot: next === 'bot' });
      changed();
    });
    btn('✕', 'Empty this hand', () => { setHand(p.seat, []); changed(); });
    head.append(tools);
    const cards = document.createElement('div');
    cards.className = 'sb-cards';
    for (const c of sortHand(s.hands[p.seat])) {
      const b = cardEl(c, 'button');
      b.title = `${cardName(c)}: put back in the deck`;
      b.addEventListener('click', () => {
        s.hands[p.seat] = s.hands[p.seat].filter((x) => x.id !== c.id);
        s.deck.unshift(c);
        changed();
      });
      cards.append(b);
    }
    li.append(head, cards);
    return li;
  }));
}

// ---- controls ----
function build() {
  $('#sb-new').addEventListener('click', () => newGame());
  $('#sb-auto').addEventListener('change', () => render());
  for (const input of document.querySelectorAll('#panel [data-rule]')) {
    input.addEventListener('change', () => { s.rules[input.dataset.rule] = input.checked; changed(); });
  }
  $('#sb-setups').replaceChildren(...SETUPS.map(([label, hint, fn]) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'btn small';
    b.textContent = label;
    b.addEventListener('click', () => {
      if (s.phase !== 'playing') newGame();
      s.pending = 0;
      fn();
      $('#sb-hint').hidden = false;
      $('#sb-hint').textContent = hint;
      table.selected = [];
      changed(`Sandbox: ${label}`);
    });
    return b;
  }));
  const palette = $('#sb-palette');
  for (const c of COLOR_KEYS) {
    for (const v of VALUES) palette.append(paletteCard(c, v));
  }
  palette.append(paletteCard('w', 'wild'), paletteCard('w', 'd4'));
  $('#sb-effects').replaceChildren(...EFFECTS.map(([label, fn]) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'btn small';
    b.textContent = label;
    b.addEventListener('click', fn);
    return b;
  }));
  $('#sb-sounds').replaceChildren(...SOUNDS.map((name) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'btn small';
    b.textContent = name;
    b.addEventListener('click', () => sound[name]());
    return b;
  }));
  $('#btn-again').addEventListener('click', () => newGame());
  $('#btn-close').addEventListener('click', () => { $('#overlay').hidden = true; });
  const soundBtn = $('#btn-sound');
  soundBtn.classList.toggle('muted', sound.muted);
  soundBtn.addEventListener('click', () => soundBtn.classList.toggle('muted', sound.toggle()));
  // Phones: the controls slide over the table.
  $('#btn-panel').addEventListener('click', () => {
    const open = $('#panel').classList.toggle('open');
    $('#btn-panel').setAttribute('aria-expanded', String(open));
  });
}

function paletteCard(c, v) {
  const card = { id: -1, c, v };
  const b = cardEl(card, 'button');
  b.title = `Give ${cardName(card)}`;
  b.addEventListener('click', () => {
    if (!s || s.phase !== 'playing') return;
    const real = takeCard(c, v);
    if (target === 'pile') putOnPile(real, s.color);
    else giveTo(target, real);
    sound.card();
    changed(`Sandbox: ${cardName(card)} → ${target === 'pile' ? 'the pile' : playerBySeat(s, target).name}`);
  });
  return b;
}

build();
newGame(4);
