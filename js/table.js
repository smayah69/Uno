// The game table: seats around it, the discard pile, the deck, your hand and
// the buttons, plus the card animations. It renders a player's view (see
// viewFor in game.js) and reports what you do through `actions`, so the
// online game and the /sandbox page drive it the same way.
import {
  CARD_COLORS, playerBySeat, canStart, canJump, companions, couldGoToOne, sortHand, isNumber, isWild,
} from './game.js';
import { cardEl, backEl } from './cards.js';
import { avatar, ringSVG, setRing, seatColor, statusLabel } from './parts.js';
import { sound } from './sound.js';

const $ = (sel) => document.querySelector(sel);
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

// Players who dropped and haven't been handed to the auto-player.
export const awayPlayers = (s) => (s.phase === 'playing' ? s.players.filter((p) => !p.connected && !p.bot) : []);

// Where a card sits on the discard pile: a little messy, like a real one.
const jitter = (id) => ({ x: ((id * 13) % 9) - 4, y: ((id * 7) % 7) - 3, r: ((id * 47) % 29) - 14 });

export class TableView {
  // actions: { play(ids, color), draw(), pass(), uno(), catch(seat), replaceWithBot(player) }
  // toast(text): shows a short message.
  constructor({ actions, toast = () => {}, turnTotal = 25000 }) {
    this.actions = actions;
    this.toast = toast;
    this.turnTotal = turnTotal;
    this.state = null;
    this.me = null;
    this.mySeat = -1;
    this.isHost = false;
    this.paused = false;
    this.selected = [];        // card ids picked for a doubles play, in order
    this.sentAt = 0;           // last play sent; clicks wait for the answer
    this.lastEventId = null;   // newest event already shown
    this.hidden = new Set();   // card ids hidden until their flying copy lands
    this.seatEls = new Map();  // seat -> elements around the table
    this.seatsKey = null;
    this.lastTurnSeat = null;
    this.bind();
  }

  bind() {
    $('#hand').addEventListener('click', (e) => {
      const c = e.target.closest('.card');
      if (c) this.cardClicked(Number(c.dataset.id));
    });
    $('#deck').addEventListener('click', () => this.drawClicked());
    $('#btn-pass').addEventListener('click', () => { if (this.ready()) { this.sentAt = Date.now(); this.actions.pass(); } });
    $('#btn-play').addEventListener('click', () => this.playSelected());
    $('#btn-clear').addEventListener('click', () => { this.selected = []; this.rerender(); });
    $('#btn-uno').addEventListener('click', () => this.unoClicked());
    $('#btn-catch').addEventListener('click', () => this.catchClicked());
    for (const b of document.querySelectorAll('#color-picker [data-color]')) {
      b.addEventListener('click', () => {
        const cb = this.pickCb;
        this.closePicker();
        if (cb) cb(b.dataset.color);
      });
    }
    $('#btn-pick-cancel').addEventListener('click', () => this.closePicker());
    $('#color-picker').addEventListener('click', (e) => { if (e.target === e.currentTarget) this.closePicker(); });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') this.closePicker();
      // Keys (when you're not typing): U says UNO, D draws, C calls Contre-UNO.
      if (/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement.tagName) || !this.state || this.state.phase === 'lobby') return;
      if (!$('#table').offsetParent) return; // table not on screen
      const k = e.key.toLowerCase();
      if (k === 'u') this.unoClicked();
      else if (k === 'd') this.drawClicked();
      else if (k === 'c') this.catchClicked();
    });
    new ResizeObserver(() => this.fitHand()).observe($('#hand-wrap'));
    // Table pieces scale with the table (CSS reads --m).
    new ResizeObserver(([e]) => {
      const { width, height } = e.contentRect;
      $('#table').style.setProperty('--m', `${Math.round(Math.min(width, height))}px`);
      this.positionSeats();
    }).observe($('#table'));
    $('#deck .deck-stack').append(backEl(), backEl(), backEl());
  }

  // Forget everything about the last game (leaving, or a new sandbox table).
  reset() {
    this.state = null;
    this.lastEventId = null;
    this.seatsKey = null;
    this.lastTurnSeat = null;
    this.selected = [];
    this.hidden.clear();
    this.closePicker();
  }

  // players: the list to show (the host may be shown as away), turnMs: time
  // left on the turn timer, or null to leave the rings alone.
  render(state, me, { players = state.players, isHost = false, turnMs = null } = {}) {
    this.state = state;
    this.me = me;
    this.isHost = isHost;
    this.sentAt = 0;
    this.players = players;
    this.draw(turnMs);
  }

  rerender() {
    if (this.state && this.state.phase !== 'lobby') this.draw(null);
  }

  draw(turnMs) {
    const state = this.state;
    const players = this.players;
    const view = { ...state, players };
    const paused = awayPlayers(view).length > 0;
    const mine = players.find((p) => p.id === this.me);
    const mySeat = mine ? mine.seat : -1;
    this.mySeat = mySeat;
    this.paused = paused;
    const myTurn = state.phase === 'playing' && state.turn === mySeat && !paused;

    const fresh = this.takeEvents(state);
    const before = fresh.length ? this.handRects() : null;
    if (!myTurn || state.pending > 0) this.selected = [];
    this.selected = this.selected.filter((id) => state.hand.some((c) => c.id === id));
    if (!myTurn) this.closePicker();

    this.layoutSeats(players, mySeat);
    this.renderSeats(view, mySeat, turnMs, paused);
    this.renderCenter(state, myTurn);
    this.renderHand(state, mySeat, myTurn, paused);
    this.renderActions(view, mySeat, myTurn, paused);
    this.renderStatus(view, mySeat, myTurn, paused);
    if (state.phase === 'playing' && state.turn !== this.lastTurnSeat) {
      if (state.turn === mySeat && this.lastTurnSeat !== null) sound.turn();
      this.lastTurnSeat = state.turn;
    }
    if (fresh.length) this.animate(fresh, before);
  }

  // Events newer than the last ones shown. Cards that are about to fly in
  // stay hidden until they land.
  takeEvents(state) {
    const last = this.lastEventId;
    this.lastEventId = state.eventId;
    if (last === null || state.eventId < last) return [];
    const fresh = state.events.filter((e) => e.id > last);
    if (fresh.length > 12) return [];
    if (!reducedMotion.matches) {
      for (const e of fresh) {
        if (e.kind === 'play') for (const c of e.cards) this.hidden.add(c.id);
        else if (e.kind === 'draw' && e.seat === this.mySeat && e.cards) for (const c of e.cards) this.hidden.add(c.id);
        else if (e.kind === 'start') for (const c of state.hand) this.hidden.add(c.id);
      }
    }
    return fresh;
  }

  handRects() {
    const out = new Map();
    for (const n of $('#hand').children) out.set(Number(n.dataset.id), n.getBoundingClientRect());
    return out;
  }

  // Seats around the table: you at the bottom, everyone else spread evenly
  // (by distance along the rim) over the rest of it, in turn order (clockwise).
  seatSpots(n, mySeat) {
    const t = $('#table');
    const ratio = t.clientHeight ? t.clientWidth / t.clientHeight : 1.6;
    const rx = window.innerWidth < 600 ? 42 : 45;
    const ry = 42;
    const at = (deg) => {
      const r = (deg * Math.PI) / 180;
      return { x: 50 + rx * Math.cos(r), y: 50 + ry * Math.sin(r) };
    };
    // Walk the rim from 140deg to 400deg, measuring length in screen proportions.
    const from = 140, to = 400, steps = 260;
    const lens = [0];
    let prev = at(from);
    for (let i = 1; i <= steps; i++) {
      const p = at(from + ((to - from) * i) / steps);
      lens.push(lens[i - 1] + Math.hypot((p.x - prev.x) * ratio, p.y - prev.y));
      prev = p;
    }
    const total = lens[steps];
    const spots = new Map();
    for (let k = 0; k < n; k++) {
      const seat = (Math.max(mySeat, 0) + k) % n;
      if (k === 0 && mySeat >= 0) { spots.set(seat, at(90)); continue; }
      const want = (total * (k - 0.5)) / Math.max(n - 1, 1);
      const i = lens.findIndex((l) => l >= want);
      spots.set(seat, at(from + ((to - from) * Math.max(i, 0)) / steps));
    }
    return spots;
  }

  positionSeats() {
    if (!this.seatEls.size) return;
    const spots = this.seatSpots(this.seatEls.size, this.mySeat);
    for (const [seat, s] of this.seatEls) {
      const p = spots.get(seat);
      if (!p) continue;
      s.root.style.left = `${p.x.toFixed(2)}%`;
      s.root.style.top = `${p.y.toFixed(2)}%`;
    }
  }

  layoutSeats(players, mySeat) {
    const key = `${mySeat}:${this.isHost}:${players.map((p) => `${p.id}@${p.seat}`).join(',')}`;
    if (key === this.seatsKey) return;
    this.seatsKey = key;
    const layer = $('#seats');
    layer.replaceChildren();
    this.seatEls.clear();
    for (const p of players) {
      const el = (tag, cls, parent) => {
        const e = document.createElement(tag);
        e.className = cls;
        parent.append(e);
        return e;
      };
      const root = el('div', 'seat', layer);
      if (p.seat === mySeat) root.classList.add('mine');
      root.style.setProperty('--c', seatColor(p.seat));
      const face = el('div', 'seat-face', root);
      face.append(ringSVG());
      const pic = el('div', 'seat-pic', face);
      const count = el('div', 'seat-count', face);
      if (p.host) el('span', 'crown', face).title = 'Host';
      const info = el('div', 'seat-info', root);
      const name = el('span', 'seat-name', info);
      const meta = el('span', 'seat-meta', info);
      const flag = el('span', 'badge', meta);
      const pts = el('span', 'seat-pts', meta);
      const fan = el('div', 'fan', root);
      const catchBtn = el('button', 'seat-catch', root);
      catchBtn.type = 'button';
      catchBtn.textContent = 'Contre-UNO!';
      catchBtn.title = `${p.name} forgot to say UNO: catch them (+2)`;
      catchBtn.addEventListener('click', () => this.catchClicked(p.seat));
      let botBtn = null;
      if (this.isHost && this.actions.replaceWithBot && !p.host && !p.cpu) {
        botBtn = el('button', 'seat-bot', face);
        botBtn.type = 'button';
        botBtn.textContent = '🤖';
        botBtn.title = `Replace ${p.name} with a bot`;
        botBtn.setAttribute('aria-label', botBtn.title);
        botBtn.addEventListener('click', () => this.actions.replaceWithBot(p));
      }
      this.seatEls.set(p.seat, { root, face, pic, count, name, flag, pts, fan, catchBtn, botBtn, n: -1, who: null });
    }
    this.positionSeats();
  }

  renderSeats(view, mySeat, turnMs, paused) {
    const playing = view.phase === 'playing';
    const exposed = view.exposed || {};
    for (const p of view.players) {
      const s = this.seatEls.get(p.seat);
      if (!s) continue;
      const pic = `${p.name}|${!!p.cpu}`;
      if (s.who !== pic) {
        s.who = pic;
        s.pic.replaceChildren(avatar(p.name, p.seat, { bot: !!p.cpu }));
        s.name.textContent = p.seat === mySeat ? 'You' : p.name;
        s.root.title = p.name;
      }
      const active = playing && p.seat === view.turn;
      s.root.classList.toggle('active', active);
      s.root.classList.toggle('away', !p.connected && !p.bot);
      s.root.classList.toggle('bot', !!p.bot && !p.cpu);
      s.root.classList.toggle('uno', playing && !!view.uno[p.seat]);
      s.root.classList.toggle('exposed', playing && !!exposed[p.seat]);
      const label = statusLabel(view, p);
      s.flag.hidden = !label;
      if (label) { s.flag.textContent = label[0]; s.flag.className = `badge ${label[1]}`; }
      s.pts.textContent = `${view.totals[p.id] || 0} pts`;
      const n = view.counts[p.seat] || 0;
      s.count.textContent = String(n);
      if (s.n !== n && p.seat !== mySeat) {
        s.n = n;
        const shown = Math.min(n, 10);
        s.fan.replaceChildren(...Array.from({ length: shown }, (_, i) => {
          const b = backEl();
          b.style.setProperty('--i', String(i - (shown - 1) / 2));
          return b;
        }));
      }
      s.catchBtn.hidden = !(playing && !paused && exposed[p.seat] && p.seat !== mySeat && mySeat >= 0);
      if (s.botBtn) s.botBtn.hidden = !playing || !!p.bot;
      if (turnMs !== null) setRing(s.face, active && !paused && turnMs > 0 ? turnMs : 0, this.turnTotal);
    }
  }

  renderCenter(state, myTurn) {
    const table = $('#table');
    const color = CARD_COLORS[state.color];
    table.style.setProperty('--cc', color ? color.main : '#ffd400');
    table.classList.toggle('ccw', state.dir === -1);
    // The draw pile sits next to your UNO button: tap it to draw.
    $('#deck-count').textContent = String(state.deckCount);
    const canDraw = myTurn && state.drawn === null && !this.selected.length;
    const deck = $('#deck');
    deck.disabled = !canDraw;
    deck.classList.toggle('ready', canDraw);
    deck.classList.toggle('hint', canDraw && (state.pending > 0 ? !state.hand.some((c) => c.v === 'd2') : !state.hand.some((c) => canStart(state, c))));
    deck.setAttribute('aria-label', state.pending > 0 ? `Draw ${state.pending} cards` : `Draw a card (${state.deckCount} left)`);
    const tag = $('#deck-tag');
    tag.textContent = state.pending > 0 ? `Draw +${state.pending}` : 'Draw';
    tag.classList.toggle('penalty', state.pending > 0);

    $('#pile').replaceChildren(...state.discard.map((c) => {
      const node = cardEl(c);
      const j = jitter(c.id);
      node.style.setProperty('--jx', j.x);
      node.style.setProperty('--jy', j.y);
      node.style.setProperty('--jr', j.r);
      if (this.hidden.has(c.id)) node.classList.add('hidden');
      return node;
    }));
    const pending = $('#pending');
    pending.hidden = !(state.pending > 0 && state.phase === 'playing');
    pending.textContent = `+${state.pending}`;
    $('#color-name').textContent = color ? color.name : '';
  }

  renderHand(state, mySeat, myTurn, paused) {
    const wrap = $('#hand');
    const hand = sortHand(state.hand);
    const live = state.phase === 'playing' && !paused;
    const first = this.selected.length ? state.hand.find((c) => c.id === this.selected[0]) : null;
    const old = new Map([...wrap.children].map((n) => [Number(n.dataset.id), n]));
    hand.forEach((c, i) => {
      let node = old.get(c.id);
      if (!node) node = cardEl(c, 'button');
      old.delete(c.id);
      const sel = this.selected.indexOf(c.id);
      const playable = live && myTurn && !first && canStart(state, c);
      const jumpable = live && !myTurn && canJump(state, mySeat, c);
      const addable = live && myTurn && !!first && sel < 0 && isNumber(c) && c.v === first.v;
      node.classList.toggle('playable', playable);
      node.classList.toggle('jumpable', jumpable);
      node.classList.toggle('addable', addable);
      node.classList.toggle('selected', sel >= 0);
      node.classList.toggle('dim', live && myTurn && !playable && !addable && sel < 0);
      node.classList.toggle('hidden', this.hidden.has(c.id));
      if (sel >= 0) node.dataset.order = String(sel + 1);
      else delete node.dataset.order;
      node.disabled = !(playable || jumpable || addable || sel >= 0);
      if (wrap.children[i] !== node) wrap.insertBefore(node, wrap.children[i] || null);
    });
    for (const n of old.values()) n.remove();
    this.fitHand();
  }

  // Overlap the cards so the whole hand fits; scroll only when it really can't.
  fitHand() {
    const wrap = $('#hand-wrap');
    const hand = $('#hand');
    const n = hand.children.length;
    if (!n) return;
    const w = hand.children[0].offsetWidth;
    const room = wrap.clientWidth - 16;
    let ov = 6;
    if (n > 1 && n * (w + 6) > room) ov = Math.max((room - w) / (n - 1) - w, -w * 0.68);
    hand.style.setProperty('--ov', `${ov.toFixed(1)}px`);
  }

  exposedOthers(view = this.state) {
    if (!view || view.phase !== 'playing' || this.mySeat < 0) return [];
    return Object.keys(view.exposed || {}).map(Number).filter((seat) => seat !== this.mySeat);
  }

  renderActions(view, mySeat, myTurn, paused) {
    const live = view.phase === 'playing' && !paused;
    const choosing = this.selected.length > 0;
    $('#btn-pass').hidden = !(live && myTurn && view.drawn !== null && !choosing);
    $('#btn-play').hidden = !(live && myTurn && choosing);
    $('#btn-play').textContent = this.selected.length > 1 ? `Play ${this.selected.length} cards` : 'Play 1 card';
    $('#btn-clear').hidden = !(live && myTurn && choosing);
    // Contre-UNO: someone went down to one card without saying UNO.
    const targets = live ? this.exposedOthers(view) : [];
    const catchBtn = $('#btn-catch');
    catchBtn.hidden = !targets.length;
    if (targets.length) {
      const who = playerBySeat(view, targets[0]);
      catchBtn.textContent = `Contre-UNO! ${who ? who.name : ''}`;
    }
    // UNO: must be said before the play that leaves you with one card.
    const uno = $('#btn-uno');
    const said = view.armed || (live && !!view.uno[mySeat]);
    const needed = live && !said && couldGoToOne(view, mySeat, view.hand);
    uno.disabled = !needed;
    uno.classList.toggle('ready', needed);
    uno.classList.toggle('said', said);
    uno.firstChild.textContent = said ? 'UNO ✓' : 'UNO!';
    $('#me-bar').classList.toggle('my-turn', myTurn);
  }

  renderStatus(view, mySeat, myTurn, paused) {
    const s = view;
    const turnP = playerBySeat(s, s.turn);
    const sayUno = !s.armed && couldGoToOne(s, mySeat, s.hand);
    const forgot = s.phase === 'playing' && (s.exposed || {})[mySeat];
    let text = '';
    if (s.phase === 'ended') text = 'Round over';
    else if (paused) text = 'Paused';
    else if (myTurn) {
      if (s.pending > 0) text = s.hand.some((c) => c.v === 'd2') ? `+${s.pending} on you! Stack a +2, or tap the deck to draw ${s.pending}` : `+${s.pending} on you: tap the deck to draw ${s.pending}`;
      else if (sayUno) text = 'Almost out! Press UNO before you play';
      else if (s.drawn !== null) text = 'You drew a card you can play: play it, or keep it';
      else if (this.selected.length) text = 'Doubles: tap more cards with the same number, then Play';
      else if (s.hand.some((c) => canStart(s, c))) text = 'Your turn: play a card';
      else text = 'Your turn: nothing matches, tap the deck to draw';
    } else if (s.hand.some((c) => canJump(s, mySeat, c))) text = sayUno ? 'Saute mouton! Press UNO, then throw it' : 'Saute mouton! Same card: throw it now';
    else if (turnP) text = `${turnP.name}'s turn${s.pending > 0 ? ` (+${s.pending} on them)` : ''}`;
    $('#turn-text').textContent = text;
    $('#turn-text').style.color = paused || s.phase !== 'playing' ? '' : myTurn ? 'var(--yellow)' : seatColor(s.turn);
    $('#note-text').textContent = forgot ? "You forgot to say UNO… hope nobody calls Contre-UNO!" : s.note || '';
    $('#note-text').classList.toggle('warn', !!forgot);
  }

  // ---- input ----
  ready() {
    const s = this.state;
    return s && s.phase === 'playing' && !this.paused && Date.now() - this.sentAt > 800;
  }

  sendPlay(ids, color = null) {
    this.sentAt = Date.now();
    this.selected = [];
    if (color) sound.wild();
    this.actions.play(ids, color);
  }

  unoClicked() {
    const b = $('#btn-uno');
    if (!this.state || b.disabled) return;
    sound.armed();
    b.classList.add('said'); // instant feedback; the game confirms
    this.actions.uno();
  }

  catchClicked(seat = this.exposedOthers()[0]) {
    if (!this.state || this.paused || seat === undefined || !(this.state.exposed || {})[seat]) return;
    this.actions.catch(seat);
  }

  cardClicked(id) {
    if (!this.ready()) return;
    const s = this.state;
    const card = s.hand.find((c) => c.id === id);
    if (!card) return;
    if (s.turn !== this.mySeat) {
      if (canJump(s, this.mySeat, card)) this.sendPlay([id]);
      return;
    }
    if (this.selected.length) {
      const first = s.hand.find((c) => c.id === this.selected[0]);
      if (this.selected.includes(id)) {
        // Tap the only selected card again: play just that one.
        if (this.selected.length === 1) return this.sendPlay([id]);
        this.selected = this.selected.filter((x) => x !== id);
        // The first card must still be one that can be played.
        const ok = this.selected.findIndex((x) => canStart(s, s.hand.find((c) => c.id === x)));
        if (ok < 0) this.selected = [];
        else if (ok > 0) this.selected.unshift(...this.selected.splice(ok, 1));
        return this.rerender();
      }
      if (isNumber(card) && card.v === first.v) {
        this.selected.push(id);
        return this.rerender();
      }
      this.selected = [];
    }
    if (!canStart(s, card)) return;
    if (isWild(card)) return this.pickColor((color) => this.ready() && this.sendPlay([id], color));
    if (s.rules.multi && s.pending === 0 && companions(s.hand, card).length) {
      this.selected = [id];
      return this.rerender();
    }
    this.sendPlay([id]);
  }

  playSelected() {
    if (this.ready() && this.selected.length) this.sendPlay([...this.selected]);
  }

  drawClicked() {
    const s = this.state;
    if (!this.ready() || s.turn !== this.mySeat || s.drawn !== null) return;
    this.sentAt = Date.now();
    this.selected = [];
    this.actions.draw();
  }

  pickColor(cb) {
    this.pickCb = cb;
    $('#color-picker').hidden = false;
    $('#color-picker [data-color]').focus();
  }

  closePicker() {
    this.pickCb = null;
    $('#color-picker').hidden = true;
  }

  // ---- animation ----
  rectOf(sel) {
    const n = typeof sel === 'string' ? $(sel) : sel;
    return n ? n.getBoundingClientRect() : null;
  }

  seatRect(seat) {
    const s = this.seatEls.get(seat);
    return s ? s.face.getBoundingClientRect() : null;
  }

  reveal(id) {
    this.hidden.delete(id);
    for (const n of document.querySelectorAll(`#hand [data-id="${id}"], #pile [data-id="${id}"]`)) {
      if (!n.classList.contains('hidden')) continue;
      n.classList.remove('hidden');
      if (n.closest('#hand')) {
        n.classList.add('flip-in');
        n.addEventListener('animationend', () => n.classList.remove('flip-in'), { once: true });
      }
    }
  }

  // A copy of the card flies from one spot on the screen to another.
  fly(node, from, to, { delay = 0, rot = 0, ms = 420, onLand = null } = {}) {
    if (!from || !to || !to.width) { if (onLand) onLand(); return; }
    node.classList.add('flying');
    node.style.setProperty('--w', `${to.width}px`);
    node.style.left = `${to.left}px`;
    node.style.top = `${to.top}px`;
    $('#fx').append(node);
    const scale = from.width / to.width;
    const dx = from.left + from.width / 2 - (to.left + to.width / 2);
    const dy = from.top + from.height / 2 - (to.top + to.height / 2);
    const anim = node.animate([
      { transform: `translate(${dx}px, ${dy}px) scale(${scale}) rotate(${rot > 0 ? -25 : 25}deg)` },
      { transform: `rotate(${rot}deg)` },
    ], { duration: ms, delay, easing: 'cubic-bezier(.25, .8, .3, 1)', fill: 'both' });
    let done = false;
    const land = () => {
      if (done) return;
      done = true;
      node.remove();
      if (onLand) onLand();
    };
    anim.onfinish = land;
    anim.oncancel = land;
    setTimeout(land, delay + ms + 500); // background tabs may never finish the animation
  }

  flyToPile(card, from, delay) {
    const pile = this.rectOf('#pile');
    const j = jitter(card.id);
    const to = pile && { left: pile.left + (j.x / 100) * pile.width, top: pile.top + (j.y / 100) * pile.height, width: pile.width, height: pile.height };
    this.fly(cardEl(card), from, to, { delay, rot: j.r, onLand: () => this.reveal(card.id) });
  }

  flyToHand(card, delay) {
    const target = $(`#hand [data-id="${card.id}"]`);
    this.fly(backEl(), this.rectOf('#deck .card:last-child'), target && target.getBoundingClientRect(), { delay, onLand: () => this.reveal(card.id) });
  }

  flyToSeat(seat, delay) {
    const s = this.seatEls.get(seat);
    const target = s && (s.fan.lastElementChild || s.face);
    const to = target && target.getBoundingClientRect();
    const box = to && { left: to.left, top: to.top, width: Math.max(to.width, 18), height: Math.max(to.width, 18) * 1.5 };
    this.fly(backEl(), this.rectOf('#deck .card:last-child'), box, { delay, ms: 380 });
  }

  bubble(seat, text, cls, delay = 0) {
    const s = this.seatEls.get(seat);
    if (!s) return;
    setTimeout(() => {
      const b = document.createElement('div');
      b.className = `bubble ${cls}`;
      b.textContent = text;
      if (cls === 'say') for (const old of s.root.querySelectorAll('.bubble.say')) old.remove();
      s.root.append(b);
      setTimeout(() => b.remove(), cls === 'say' ? 4000 : 1800);
    }, delay);
  }

  animate(events, before) {
    const motion = !reducedMotion.matches;
    const later = (ms, fn) => setTimeout(fn, ms);
    let t = 0;
    for (const e of events) {
      if (e.kind === 'start') {
        sound.shuffle();
        if (!motion) continue;
        sortHand(this.state.hand).forEach((c, i) => this.flyToHand(c, 350 + i * 70));
        for (const [seat] of this.seatEls) if (seat !== this.mySeat) for (let i = 0; i < 3; i++) this.flyToSeat(seat, 350 + i * 120);
        t += 900;
      } else if (e.kind === 'play') {
        e.cards.forEach((c, i) => {
          const from = (e.seat === this.mySeat && before && before.get(c.id)) || this.seatRect(e.seat);
          if (motion) this.flyToPile(c, from, t + i * 130);
          else this.reveal(c.id);
          later(t + i * 130 + 250, () => sound.card());
        });
        const last = e.cards[e.cards.length - 1];
        if (isWild(last) && e.seat !== this.mySeat) later(t, () => sound.wild());
        if (e.jump) {
          this.bubble(e.seat, 'Saute mouton!', 'jump', t);
          later(t, () => sound.jump());
          if (motion) $('#pile').animate([{ transform: 'scale(1.12)' }, { transform: 'none' }], { duration: 350, delay: t + 300 });
        }
        if (e.cards.length > 1) this.bubble(e.seat, `×${e.cards.length}`, 'multi', t);
        t += 320 + (e.cards.length - 1) * 130;
      } else if (e.kind === 'draw') {
        for (let i = 0; i < e.n; i++) {
          if (e.seat === this.mySeat && e.cards) {
            if (motion) this.flyToHand(e.cards[i], t + i * 110);
            else this.reveal(e.cards[i].id);
          } else if (motion) this.flyToSeat(e.seat, t + i * 110);
          later(t + i * 110, () => sound.draw());
        }
        if (e.n >= 2) {
          this.bubble(e.seat, `+${e.n}`, 'penalty', t);
          later(t + 100, () => sound.penalty(e.n));
        }
        t += 200 + Math.min(e.n, 8) * 110;
      } else if (e.kind === 'skip') {
        this.bubble(e.seat, '⊘ Skipped', 'skip', t);
        later(t, () => sound.skip());
      } else if (e.kind === 'reverse') {
        later(t, () => {
          sound.reverse();
          const ring = $('#dir-ring');
          ring.classList.remove('flip');
          void ring.getBoundingClientRect();
          ring.classList.add('flip');
        });
      } else if (e.kind === 'uno') {
        this.bubble(e.seat, 'UNO!', 'uno', t);
        later(t, () => sound.uno());
      } else if (e.kind === 'catch') {
        this.bubble(e.seat, 'Contre-UNO!', 'gotcha', t);
        later(t, () => sound.caught());
        t += 350;
      } else if (e.kind === 'shuffle') {
        later(t, () => { sound.shuffle(); this.toast('Draw pile empty: the discards were shuffled back in'); });
      }
    }
    // Anything still hidden (an element that never got a flight) shows up now.
    later(t + 1500, () => { for (const id of [...this.hidden]) this.reveal(id); });
  }
}
