import {
  CARD_COLORS, MAX_PLAYERS, MIN_PLAYERS, COLOR_KEYS, DECK_SIZE, RULE_KEYS, createLobby, startGame, play, draw, pass,
  callUno, autoMove, viewFor, playerBySeat, canStart, canJump, companions, couldGoToOne, sortHand, isNumber,
  isWild, cardName, gameTime, formatTime,
} from './game.js';
import { cardEl, backEl } from './cards.js';
import { avatar, badge, ringSVG, setRing, scoreboard, seatColor, statusLabel } from './parts.js';
import { sound } from './sound.js';
import './analytics.js';
import { sanitizeName, sanitizeChat, MAX_NAME } from './text.js';
import { createHostNet, createClientNet, randomId, isLocalMode } from './net.js';

// Time a connected player gets to act; miss it once and the computer plays for
// them (AFK) until they play again. ?local=1&turnms=N shortens it for tests.
const TURN_MS = (isLocalMode && Number(new URLSearchParams(location.search).get('turnms'))) || 25000;
const AFK_MS = 2500;        // an AFK player's turn waits this long, so they can take it back
const BOT_MS = 1500;        // a bot's thinking time
const JUMP_MS = [700, 1600]; // how quickly a bot jumps in (saute mouton)
const PING_MS = 2500;       // heartbeat interval
const DEAD_MS = 9000;       // no traffic for this long = connection is dead
const RETRY_MS = 3000;      // client reconnect interval while the host is away
const SAVE_KEY = 'uno.host';
const SAVE_TTL = 12 * 3600 * 1000;
const CHAT_KEEP = 80;
const CHAT_GAP_MS = 600;    // per-player chat throttle
const MAX_CONNS = 16;
const BOT_NAMES = ['Robo Rita', 'Bot Bob', 'Chip', 'Beep Boop', 'Gizmo', 'Sparky', 'Botzilla', 'Unobot'];

const $ = (sel) => document.querySelector(sel);
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
const store = {
  get(k, area = localStorage) { try { return area.getItem(k); } catch { return null; } },
  set(k, v, area = localStorage) { try { area.setItem(k, v); } catch { /* storage blocked */ } },
  del(k, area = localStorage) { try { area.removeItem(k); } catch { /* storage blocked */ } },
};

// Players who dropped and haven't been handed to the auto-player.
export const awayPlayers = (s) => (s.phase === 'playing' ? s.players.filter((p) => !p.connected && !p.bot) : []);

const validIds = (ids) => Array.isArray(ids) && ids.length >= 1 && ids.length <= 12
  && ids.every((i) => Number.isInteger(i) && i >= 0 && i < DECK_SIZE);

function secureRandom() {
  const a = new Uint32Array(1);
  crypto.getRandomValues(a);
  return a[0] / 2 ** 32;
}

// ===================================================================
// Host: authoritative game server running in the host's browser.
// It holds every hand and the draw pile; each player only ever gets
// viewFor(state, theirSeat).
// ===================================================================
class Host {
  constructor(name, ui, saved = null) {
    this.ui = ui;
    this.net = createHostNet();
    this.connPid = new Map();   // connection id -> player id
    this.seen = new Map();      // connection id -> last message time
    this.rate = new Map();      // connection id -> {t, n}
    this.timer = null;
    this.turnKey = null;
    this.deadline = 0;
    this.jumpTimer = null;
    this.jumpFor = null;
    this.me = 'p0';
    this.chat = [];             // recent chat + event lines, sent to (re)joiners
    this.chatAt = new Map();    // player id -> last chat time
    if (saved) {
      // Resuming after the host's tab closed: everyone else must reconnect.
      this.state = saved.state;
      this.secrets = new Map(saved.secrets);
      this.nextPid = saved.nextPid;
      this.resumePin = saved.pin;
      for (const p of this.state.players) p.connected = p.host;
      const c = this.state.clock;
      if (c && c.since !== null) { c.base += Math.max(0, (saved.savedAt || Date.now()) - c.since); c.since = null; }
    } else {
      this.state = createLobby();
      this.secrets = new Map(); // client secret -> player id (never broadcast)
      this.nextPid = 1;
      this.state.players.push({ id: 'p0', name, seat: -1, connected: true, host: true });
    }
    this.logged = this.state.eventId;
  }

  static loadSaved() {
    try {
      const d = JSON.parse(store.get(SAVE_KEY));
      if (d && d.v === 1 && /^\d{6}$/.test(d.pin) && d.state && d.state.phase === 'playing' && Date.now() - d.savedAt < SAVE_TTL) return d;
    } catch { /* corrupt or missing */ }
    return null;
  }

  async start() {
    this.net.onJoin = (cid) => {
      this.seen.set(cid, Date.now());
      if (this.seen.size > MAX_CONNS) { this.net.send(cid, { t: 'reject', reason: 'Too many connections' }); this.net.drop(cid); }
    };
    this.net.onLeave = (cid) => this.leave(cid);
    this.net.onMessage = (cid, msg) => this.receive(cid, msg);
    this.net.onStatus = (text) => this.ui.busy(true, text);
    this.pin = await this.net.start(this.resumePin);
    this.ui.pin = this.pin;
    this.heartbeat = setInterval(() => this.beat(), PING_MS);
    this.publish();
    return this.pin;
  }

  beat() {
    const now = Date.now();
    for (const [cid, t] of this.seen) {
      if (now - t > DEAD_MS) { this.net.drop(cid, 0); this.leave(cid); }
      else this.net.send(cid, { t: 'ping' });
    }
  }

  limited(cid) {
    const now = Date.now();
    const r = this.rate.get(cid) || { t: now, n: 0 };
    if (now - r.t > 5000) { r.t = now; r.n = 0; }
    r.n += 1;
    this.rate.set(cid, r);
    return r.n > 40;
  }

  receive(cid, msg) {
    if (!this.seen.has(cid)) return;
    this.seen.set(cid, Date.now());
    if (!msg || typeof msg !== 'object' || typeof msg.t !== 'string' || msg.t === 'ping' || this.limited(cid)) return;
    if (msg.t === 'hello') return this.hello(cid, msg);
    const pid = this.connPid.get(cid);
    if (!pid) return;
    if (msg.t === 'back') this.back(pid);
    else if (msg.t === 'play' && validIds(msg.ids) && (msg.color == null || COLOR_KEYS.includes(msg.color))) this.act(pid, 'play', msg);
    else if (msg.t === 'draw' || msg.t === 'pass' || msg.t === 'uno') this.act(pid, msg.t);
    else if (msg.t === 'chat') this.say(pid, msg.text);
  }

  say(pid, raw) {
    const text = sanitizeChat(raw);
    const p = this.state.players.find((x) => x.id === pid);
    const now = Date.now();
    if (!text || !p || now - (this.chatAt.get(pid) || 0) < CHAT_GAP_MS) return;
    this.chatAt.set(pid, now);
    this.pushChat({ kind: 'chat', pid, name: p.name, text });
  }

  pushChat(e) {
    this.chat.push(e);
    if (this.chat.length > CHAT_KEEP) this.chat.shift();
    for (const [cid] of this.connPid) this.net.send(cid, { t: 'chat', e });
    this.ui.addChat(e);
  }

  hello(cid, msg) {
    if (this.connPid.has(cid)) return;
    const secret = typeof msg.secret === 'string' && /^[0-9a-f]{32}$/.test(msg.secret) ? msg.secret : null;
    const s = this.state;
    const reject = (reason) => { this.net.send(cid, { t: 'reject', reason }); this.net.drop(cid); };
    if (!secret) return reject('Bad request');
    const name = sanitizeName(msg.name) || 'Player';

    let pid = this.secrets.get(secret);
    let player = pid && s.players.find((p) => p.id === pid);
    if (player && player.replaced) return reject('The host replaced you with a bot');
    // Coming back from another tab/device: claim your away seat by name.
    if (!player && s.phase !== 'lobby') {
      player = s.players.find((p) => !p.host && !p.connected && !p.replaced && !p.cpu && p.name.toLowerCase() === name.toLowerCase());
      if (player) {
        pid = player.id;
        for (const [k, v] of this.secrets) if (v === pid) this.secrets.delete(k);
        this.secrets.set(secret, pid);
      }
    }
    if (player) {
      // Drop any stale connection still bound to this player.
      for (const [c, p] of this.connPid) if (p === pid) { this.connPid.delete(c); this.seen.delete(c); this.net.drop(c); }
      const wasAway = !player.connected;
      player.connected = true;
      player.bot = false;
      if (wasAway && s.phase !== 'lobby') this.toastAll(`${player.name} is back`);
    } else {
      if (s.phase !== 'lobby' && s.players.some((p) => p.replaced && p.name.toLowerCase() === name.toLowerCase())) return reject('The host replaced you with a bot');
      if (s.phase !== 'lobby') return reject('This game has already started');
      if (s.players.length >= MAX_PLAYERS) return reject(`The table is full (${MAX_PLAYERS} players max)`);
      pid = `p${this.nextPid++}`;
      player = { id: pid, name: this.uniqueName(name), seat: -1, connected: true, host: false };
      s.players.push(player);
      this.secrets.set(secret, pid);
      this.toastAll(`${player.name} joined`);
    }
    this.connPid.set(cid, pid);
    this.net.send(cid, { t: 'welcome', pid, pin: this.pin });
    this.net.send(cid, { t: 'chatlog', list: this.chat });
    this.publish();
  }

  uniqueName(name) {
    const taken = new Set(this.state.players.map((p) => p.name.toLowerCase()));
    if (!taken.has(name.toLowerCase())) return name;
    for (let i = 2; ; i++) {
      const n = `${Array.from(name).slice(0, MAX_NAME - 3).join('')} ${i}`;
      if (!taken.has(n.toLowerCase())) return n;
    }
  }

  leave(cid) {
    this.seen.delete(cid);
    this.rate.delete(cid);
    const pid = this.connPid.get(cid);
    this.connPid.delete(cid);
    if (!pid || [...this.connPid.values()].includes(pid)) return;
    const s = this.state;
    const p = s.players.find((x) => x.id === pid);
    if (!p) return;
    if (s.phase === 'lobby') {
      s.players = s.players.filter((x) => x.id !== pid);
      for (const [k, v] of this.secrets) if (v === pid) this.secrets.delete(k);
      this.toastAll(`${p.name} left`);
    } else {
      p.connected = false;
      if (s.phase === 'playing' && !p.bot) this.toastAll(`${p.name} is away: game paused`);
    }
    this.publish();
  }

  // ---- host-only controls ----
  setRule(key, on) {
    const s = this.state;
    if (s.phase !== 'lobby' || !RULE_KEYS.includes(key)) return;
    s.rules[key] = !!on;
    this.publish();
  }

  addBot() {
    const s = this.state;
    if (s.phase !== 'lobby' || s.players.length >= MAX_PLAYERS) return;
    const used = new Set(s.players.map((p) => p.name));
    const name = this.uniqueName(BOT_NAMES.find((n) => !used.has(n)) || 'Bot');
    s.players.push({ id: `p${this.nextPid++}`, name, seat: -1, connected: false, host: false, bot: true, cpu: true });
    this.publish();
  }

  kick(pid) {
    const s = this.state;
    if (s.phase !== 'lobby' || pid === this.me) return;
    for (const [c, p] of this.connPid) {
      if (p === pid) { this.net.send(c, { t: 'reject', reason: 'You were removed by the host' }); this.connPid.delete(c); this.net.drop(c); }
    }
    for (const [k, v] of this.secrets) if (v === pid) this.secrets.delete(k);
    s.players = s.players.filter((x) => x.id !== pid);
    this.publish();
  }

  begin() {
    if (this.state.phase !== 'lobby' || this.state.players.length < MIN_PLAYERS) return;
    startGame(this.state, secureRandom);
    this.publish();
  }

  // Stop waiting: the computer plays for the away players until they return.
  continueWithout() {
    for (const p of awayPlayers(this.state)) p.bot = true;
    this.publish();
  }

  // Host hands a player's seat to a bot for the rest of this game.
  replaceWithBot(pid) {
    const s = this.state;
    const p = s.players.find((x) => x.id === pid);
    if (s.phase !== 'playing' || !p || p.host || p.replaced || p.cpu) return;
    p.bot = true;
    p.afk = false;
    p.replaced = true;
    for (const [k, v] of this.secrets) if (v === pid) this.secrets.delete(k);
    for (const [c, x] of this.connPid) {
      if (x === pid) { this.net.send(c, { t: 'end', reason: 'The host replaced you with a bot' }); this.connPid.delete(c); this.net.drop(c); }
    }
    p.connected = false;
    this.toastAll(`${p.name} was replaced by a bot`);
    this.publish();
  }

  // Next round with the same table: scores carry over.
  backToLobby() {
    const s = this.state;
    const keep = s.players.filter((p) => p.connected || p.cpu);
    const kept = new Set(keep.map((p) => p.id));
    for (const [k, v] of this.secrets) if (!kept.has(v)) this.secrets.delete(k);
    const fresh = createLobby(s.rules);
    fresh.players = keep.map((p) => ({ id: p.id, name: p.name, seat: -1, connected: p.connected, host: p.host, ...(p.cpu ? { bot: true, cpu: true } : {}) }));
    for (const p of keep) if (s.totals[p.id]) fresh.totals[p.id] = s.totals[p.id];
    fresh.round = s.round;
    fresh.eventId = s.eventId;
    this.state = fresh;
    this.publish();
  }

  // ---- gameplay ----
  act(pid, action, msg = {}) {
    const s = this.state;
    if (s.phase !== 'playing' || awayPlayers(s).length) return;
    const p = s.players.find((x) => x.id === pid);
    if (!p || p.seat < 0) return;
    try {
      if (action === 'play') play(s, p.seat, msg.ids, msg.color || null, secureRandom);
      else if (action === 'draw') draw(s, p.seat, secureRandom);
      else if (action === 'pass') pass(s, p.seat);
      else if (action === 'uno' && !callUno(s, p.seat)) return;
    } catch (err) {
      this.tell(pid, err.message); // stale or illegal: say why, change nothing
      return;
    }
    if (p.afk) { p.afk = false; this.toastAll(`${p.name} is back`); } // playing again
    this.publish();
  }

  // AFK player says they're back: stop auto-playing their turns.
  back(pid) {
    const p = this.state.players.find((x) => x.id === pid);
    if (!p || !p.afk) return;
    p.afk = false;
    this.toastAll(`${p.name} is back`);
    this.publish();
  }

  tell(pid, text) {
    if (pid === this.me) return this.ui.toast(text);
    for (const [cid, p] of this.connPid) if (p === pid) this.net.send(cid, { t: 'toast', text });
  }

  // The turn timer only restarts when the turn situation changes, so saying
  // UNO or chatting doesn't buy extra time.
  schedule() {
    const s = this.state;
    const paused = awayPlayers(s).length > 0;
    const p = s.phase === 'playing' && !paused ? playerBySeat(s, s.turn) : null;
    const key = p ? [s.turn, s.eventId, s.drawn, !!p.bot, !!p.afk].join('|') : null;
    if (key === this.turnKey) return;
    this.turnKey = key;
    clearTimeout(this.timer);
    this.timer = null;
    this.deadline = 0;
    if (!p) return;
    const auto = p.bot || p.afk;
    const ms = p.bot ? BOT_MS : p.afk ? AFK_MS : TURN_MS;
    if (!auto) this.deadline = Date.now() + ms;
    this.timer = setTimeout(() => {
      this.turnKey = null;
      // Ran out of time: auto-play now, and keep auto-playing quickly until they're back.
      if (!auto) {
        p.afk = true;
        this.toastAll(`${p.name} is AFK: the computer plays for them`);
      }
      this.autoTurn(p.seat);
      this.publish();
    }, ms);
  }

  autoTurn(seat) {
    const s = this.state;
    if (s.phase !== 'playing' || s.turn !== seat) return;
    const m = autoMove(s, seat);
    try {
      if (m.kind === 'play') {
        if (s.hands[seat].length - m.ids.length === 1) callUno(s, seat);
        play(s, seat, m.ids, m.color, secureRandom);
      } else if (m.kind === 'draw') draw(s, seat, secureRandom);
      else pass(s, seat);
    } catch (err) {
      // Should not happen; never let the game stall on it.
      console.warn('auto move failed', err);
      if (s.drawn !== null) pass(s, seat);
      else draw(s, seat, secureRandom);
    }
  }

  // Bots love saute mouton: one with the same card throws it after a beat.
  scheduleJump() {
    const s = this.state;
    const top = s.phase === 'playing' ? s.discard[s.discard.length - 1] : null;
    const key = top && s.rules.jumpIn && !awayPlayers(s).length ? `${top.id}|${s.by}` : null;
    if (key === this.jumpFor) return;
    this.jumpFor = key;
    clearTimeout(this.jumpTimer);
    if (!key) return;
    for (const p of s.players) {
      if (!p.bot) continue;
      const card = s.hands[p.seat].find((c) => canJump(s, p.seat, c));
      if (!card || secureRandom() > 0.8) continue;
      const wait = JUMP_MS[0] + secureRandom() * (JUMP_MS[1] - JUMP_MS[0]);
      this.jumpTimer = setTimeout(() => {
        if (this.state !== s || this.jumpFor !== key || !p.bot) return;
        try {
          if (s.hands[p.seat].length === 2) callUno(s, p.seat);
          play(s, p.seat, [card.id], null, secureRandom);
        } catch { return; }
        this.publish();
      }, wait);
      return;
    }
  }

  save() {
    if (this.state.phase === 'playing') {
      store.set(SAVE_KEY, JSON.stringify({
        v: 1, pin: this.pin, state: this.state, secrets: [...this.secrets], nextPid: this.nextPid, savedAt: Date.now(),
      }));
    } else store.del(SAVE_KEY);
  }

  // Game clock runs only while the game is actually being played (not paused).
  tickClock() {
    const s = this.state;
    const now = Date.now();
    if (!s.clock) s.clock = { base: 0, since: null };
    const running = s.phase === 'playing' && awayPlayers(s).length === 0;
    if (running && s.clock.since === null) s.clock.since = now;
    if (!running && s.clock.since !== null) { s.clock.base += now - s.clock.since; s.clock.since = null; }
  }

  // The big moments go to the chat log too.
  logEvents() {
    const s = this.state;
    const name = (seat) => (playerBySeat(s, seat) || { name: '?' }).name;
    for (const e of s.events) {
      if (e.id <= this.logged) continue;
      this.logged = e.id;
      let text = null;
      if (e.kind === 'start') text = `Round ${s.round}: ${name(e.seat)} starts`;
      else if (e.kind === 'play' && e.jump) text = `${name(e.seat)} jumped in with ${cardName(e.cards[0])}! (saute mouton)`;
      else if (e.kind === 'uno') text = `${name(e.seat)}: UNO!`;
      else if (e.kind === 'forgot') text = `${name(e.seat)} forgot to say UNO: +2`;
      else if (e.kind === 'win') text = `${name(e.seat)} wins round ${s.round} (+${e.points} points)`;
      if (text) this.pushChat({ kind: 'sys', text });
    }
  }

  mySeat() {
    const me = this.state.players.find((p) => p.id === this.me);
    return me ? me.seat : -1;
  }

  publish() {
    const s = this.state;
    this.tickClock();
    this.logEvents();
    s.seq += 1;
    this.schedule();
    this.scheduleJump();
    this.save();
    const turnMs = this.deadline ? this.deadline - Date.now() : 0;
    const now = Date.now();
    for (const [cid, pid] of this.connPid) {
      const p = s.players.find((x) => x.id === pid);
      this.net.send(cid, { t: 'state', s: viewFor(s, p ? p.seat : -1), turnMs, now });
    }
    this.ui.render(viewFor(s, this.mySeat()), this.me, true, turnMs, now);
  }

  toastAll(text) {
    for (const [cid] of this.connPid) this.net.send(cid, { t: 'toast', text });
    this.ui.toast(text);
    this.pushChat({ kind: 'sys', text });
  }

  sendChat(text) { this.say(this.me, text); }
  sendPlay(ids, color) { this.act(this.me, 'play', { ids, color }); }
  sendDraw() { this.act(this.me, 'draw'); }
  sendPass() { this.act(this.me, 'pass'); }
  sendUno() { this.act(this.me, 'uno'); }
  sendBack() { this.back(this.me); }

  // Deliberate exit: tell everyone and forget the saved game.
  end() {
    for (const [cid] of this.connPid) this.net.send(cid, { t: 'end', reason: 'The host ended the game' });
    store.del(SAVE_KEY);
    setTimeout(() => this.close(), 200);
  }

  close() {
    clearTimeout(this.timer);
    clearTimeout(this.jumpTimer);
    clearInterval(this.heartbeat);
    this.net.close();
  }
}

// ===================================================================
// Client: forwards input to the host and renders the host's state.
// Keeps reconnecting while the host is away during a game.
// ===================================================================
class Client {
  constructor(name, ui) {
    this.name = name;
    this.ui = ui;
    this.net = createClientNet();
    this.me = null;
    this.closed = false;
    this.online = false;
    this.lastState = null;
    let secret = store.get('uno.secret', sessionStorage);
    if (!secret || !/^[0-9a-f]{32}$/.test(secret)) {
      secret = randomId(16);
      store.set('uno.secret', secret, sessionStorage);
    }
    this.secret = secret;
  }

  async join(pin) {
    this.pin = pin;
    this.net.onMessage = (msg) => this.receive(msg);
    this.net.onClose = () => this.lost();
    await this.connect();
    this.heartbeat = setInterval(() => this.beat(), PING_MS);
  }

  // One connection attempt: transport + hello/welcome handshake.
  async connect() {
    await this.net.connect(this.pin);
    this.seen = Date.now();
    this.net.send({ t: 'hello', name: this.name, secret: this.secret });
    await new Promise((resolve, reject) => {
      this.pending = { resolve, reject };
      setTimeout(() => { if (this.pending) { this.pending = null; reject(new Error('Host did not respond')); } }, 8000);
    });
    this.online = true;
  }

  beat() {
    if (!this.online) return;
    if (Date.now() - this.seen > DEAD_MS) { this.net.close(); this.lost(); return; }
    this.net.send({ t: 'ping' });
  }

  lost() {
    if (this.closed || !this.online) return;
    this.online = false;
    if (!this.lastState || this.lastState.phase !== 'playing') {
      this.closed = true;
      // After a round the result screen stays up; nothing to wait for.
      if (!this.lastState || this.lastState.phase !== 'ended') this.ui.disconnected('Connection to the host was lost');
      return;
    }
    this.ui.hostAway(true);
    this.retry();
  }

  retry() {
    clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(async () => {
      if (this.closed) return;
      try {
        await this.connect();
        this.ui.hostAway(false);
      } catch {
        if (!this.closed) this.retry();
      }
    }, RETRY_MS);
  }

  receive(msg) {
    this.seen = Date.now();
    if (!msg || typeof msg !== 'object') return;
    if (msg.t === 'welcome') {
      this.me = msg.pid;
      store.set('uno.pin', this.pin, sessionStorage);
      if (this.pending) { this.pending.resolve(); this.pending = null; }
    } else if (msg.t === 'reject' || msg.t === 'end') {
      const reason = String(msg.reason || 'Disconnected');
      this.closed = true;
      if (this.pending) { this.pending.reject(Object.assign(new Error(reason), { fromHost: true })); this.pending = null; }
      if (this.me) this.ui.disconnected(reason);
    } else if (msg.t === 'state' && this.me && validView(msg.s)) {
      this.lastState = msg.s;
      this.ui.render(msg.s, this.me, false, Number(msg.turnMs) || 0, Number(msg.now) || Date.now());
    } else if (msg.t === 'toast' && typeof msg.text === 'string') {
      this.ui.toast(msg.text);
    } else if (msg.t === 'chat') {
      this.ui.addChat(msg.e);
    } else if (msg.t === 'chatlog' && Array.isArray(msg.list)) {
      this.ui.setChat(msg.list);
    }
  }

  sendChat(text) { this.net.send({ t: 'chat', text }); }
  sendPlay(ids, color) { this.net.send({ t: 'play', ids, color }); }
  sendDraw() { this.net.send({ t: 'draw' }); }
  sendPass() { this.net.send({ t: 'pass' }); }
  sendUno() { this.net.send({ t: 'uno' }); }
  sendBack() { this.net.send({ t: 'back' }); }

  close() {
    this.closed = true;
    clearInterval(this.heartbeat);
    clearTimeout(this.retryTimer);
    this.net.close();
  }
}

// Just enough shape-checking that a bad message can't crash the renderer.
function validView(s) {
  return s && typeof s === 'object' && Array.isArray(s.players) && Array.isArray(s.hand) && Array.isArray(s.discard)
    && Array.isArray(s.events) && s.rules && typeof s.rules === 'object' && s.counts && typeof s.counts === 'object';
}


// Where a card sits on the discard pile: a little messy, like a real one.
const jitter = (id) => ({ x: ((id * 13) % 9) - 4, y: ((id * 7) % 7) - 3, r: ((id * 47) % 29) - 14 });
const RULE_CHIPS = [['jumpIn', '≡ Jump in'], ['multi', '×2 Doubles'], ['stack', '+2 Combo']];

// ===================================================================
// UI
// ===================================================================
class UI {
  constructor() {
    this.session = null;
    this.state = null;
    this.me = null;
    this.mySeat = -1;
    this.clockOffset = 0; // host clock minus ours
    this.hostIsAway = false;
    this.chatLines = [];
    this.unread = 0;
    this.selected = [];        // card ids picked for a doubles play, in order
    this.sentAt = 0;           // last play sent; clicks wait for the host's answer
    this.lastEventId = null;   // newest event already shown
    this.hidden = new Set();   // card ids hidden until their flying copy lands
    this.seatEls = new Map();  // seat -> elements around the table
    this.seatsKey = null;
    this.lastTurnSeat = null;
    this.endShown = false;
    this.bind();
    this.autoResume();
  }

  bind() {
    const name = $('#name-input');
    const pin = $('#pin-input');
    name.value = store.get('uno.name') || '';
    const params = new URLSearchParams(location.search);
    const urlPin = params.get('pin') || store.get('uno.pin', sessionStorage);
    if (urlPin && /^\d{6}$/.test(urlPin)) { pin.value = urlPin; $('#join-box').hidden = false; }
    $('#local-badge').hidden = !isLocalMode;

    const refresh = () => {
      const ok = sanitizeName(name.value).length > 0;
      $('#btn-host').disabled = !ok;
      $('#btn-join-toggle').disabled = !ok;
      $('#btn-join').disabled = !ok || !/^\d{6}$/.test(pin.value);
      const saved = Host.loadSaved();
      $('#resume-box').hidden = !saved;
      if (saved) $('#resume-pin').textContent = saved.pin;
    };
    this.refreshHome = refresh;
    name.addEventListener('input', refresh);
    pin.addEventListener('input', () => { pin.value = pin.value.replace(/\D/g, '').slice(0, 6); refresh(); });
    refresh();

    $('#btn-host').addEventListener('click', () => this.host());
    $('#btn-resume').addEventListener('click', () => this.host(Host.loadSaved()));
    $('#btn-discard').addEventListener('click', () => { store.del(SAVE_KEY); refresh(); });
    $('#btn-join-toggle').addEventListener('click', () => { $('#join-box').hidden = false; pin.focus(); });
    $('#home-form').addEventListener('submit', (e) => { e.preventDefault(); if (!$('#btn-join').disabled) this.join(pin.value); });

    // Lobby
    $('#btn-copy-pin').addEventListener('click', () => this.copy(this.pin, 'PIN copied'));
    $('#btn-copy-link').addEventListener('click', () => this.copy(this.inviteLink(), 'Invite link copied'));
    $('#btn-invite').addEventListener('click', () => this.copy(this.inviteLink(), 'Invite link copied'));
    $('#btn-start').addEventListener('click', () => this.session.begin());
    $('#btn-add-bot').addEventListener('click', () => this.session.addBot());
    $('#btn-leave-lobby').addEventListener('click', () => this.leave());
    for (const input of document.querySelectorAll('#rules input')) {
      input.addEventListener('change', () => {
        if (this.session instanceof Host) this.session.setRule(input.dataset.rule, input.checked);
      });
    }

    // Game
    $('#btn-leave-game').addEventListener('click', () => {
      const isHost = this.session instanceof Host;
      const msg = isHost
        ? 'End the game for everyone?\n\n(If you just close or refresh the tab instead, the game pauses and you can resume it.)'
        : 'Leave the game? It will pause until you come back.';
      if (confirm(msg)) this.leave();
    });
    $('#btn-back').addEventListener('click', () => this.session && this.session.sendBack());
    $('#btn-continue').addEventListener('click', () => this.session instanceof Host && this.session.continueWithout());
    $('#btn-again').addEventListener('click', () => { $('#overlay').hidden = true; this.session.backToLobby(); });
    $('#btn-home').addEventListener('click', () => this.leave());
    $('#btn-copy-results').addEventListener('click', () => this.copy(this.results, 'Results copied'));
    $('#hand').addEventListener('click', (e) => {
      const c = e.target.closest('.card');
      if (c) this.cardClicked(Number(c.dataset.id));
    });
    $('#deck').addEventListener('click', () => this.drawClicked());
    $('#btn-pass').addEventListener('click', () => { if (this.ready()) { this.sentAt = Date.now(); this.session.sendPass(); } });
    $('#btn-play').addEventListener('click', () => this.playSelected());
    $('#btn-clear').addEventListener('click', () => { this.selected = []; this.rerender(); });
    $('#btn-uno').addEventListener('click', () => this.unoClicked());
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
      if (e.key === 'Escape') { this.closePicker(); this.toggleChat(false); }
      // Keys (when you're not typing): U says UNO, D draws.
      if (document.activeElement.tagName === 'INPUT' || !$('#screen-game').classList.contains('active')) return;
      if (e.key === 'u' || e.key === 'U') this.unoClicked();
      if (e.key === 'd' || e.key === 'D') this.drawClicked();
    });
    new ResizeObserver(() => this.fitHand()).observe($('#hand-wrap'));
    // Table pieces scale with the table (CSS reads --m).
    new ResizeObserver(([e]) => {
      const { width, height } = e.contentRect;
      $('#table').style.setProperty('--m', `${Math.round(Math.min(width, height))}px`);
      this.positionSeats();
    }).observe($('#table'));
    $('#deck .deck-stack').append(backEl(), backEl(), backEl());

    setInterval(() => this.renderClock(), 1000);
    $('#btn-chat').addEventListener('click', () => this.toggleChat());
    $('#btn-chat-close').addEventListener('click', () => this.toggleChat(false));
    $('#chat-form').addEventListener('submit', (e) => {
      e.preventDefault();
      const input = $('#chat-input');
      const text = sanitizeChat(input.value);
      if (text && this.session) this.session.sendChat(text);
      input.value = '';
    });
    const soundBtn = $('#btn-sound');
    soundBtn.classList.toggle('muted', sound.muted);
    soundBtn.addEventListener('click', () => soundBtn.classList.toggle('muted', sound.toggle()));
  }

  // A refreshed tab goes straight back into the game it was in.
  autoResume() {
    const mode = store.get('uno.session', sessionStorage);
    if (!sanitizeName($('#name-input').value)) return;
    if (mode === 'host' && Host.loadSaved()) this.host(Host.loadSaved());
    else if (mode === 'client' && /^\d{6}$/.test($('#pin-input').value)) this.join($('#pin-input').value);
  }

  myName() {
    const n = sanitizeName($('#name-input').value);
    store.set('uno.name', n);
    return n;
  }

  busy(on, text = '') {
    for (const id of ['#btn-host', '#btn-join', '#btn-join-toggle', '#btn-resume']) $(id).disabled = on;
    $('#home-error').textContent = text;
    $('#home-error').classList.toggle('info', on);
  }

  async host(saved = null) {
    const name = this.myName();
    if (!name) return;
    this.busy(true, saved ? `Resuming game ${saved.pin}…` : 'Creating game…');
    const h = new Host(name, this, saved);
    try {
      this.session = h;
      this.pin = await h.start();
      this.renderChat(); // shows the (new) PIN to invite people with
      store.set('uno.session', 'host', sessionStorage);
      this.busy(false);
    } catch (err) {
      h.close();
      this.session = null;
      this.busy(false, err.message);
    }
    this.refreshHome();
  }

  inviteLink() {
    const u = new URL(location.href);
    u.search = '';
    u.searchParams.set('pin', this.pin);
    if (isLocalMode) u.searchParams.set('local', '1');
    return u.toString();
  }

  async join(pin) {
    const name = this.myName();
    if (!name) return;
    this.busy(true, 'Connecting…');
    const c = new Client(name, this);
    try {
      this.session = c;
      this.pin = pin;
      // One automatic retry for network hiccups; a refusal from the host is final.
      for (let attempt = 0; ; attempt++) {
        try {
          await c.join(pin);
          break;
        } catch (err) {
          if (err.fromHost || attempt >= 1 || this.session !== c) throw err;
          this.busy(true, 'Connection failed, retrying…');
          await new Promise((r) => setTimeout(r, 1500));
        }
      }
      store.set('uno.session', 'client', sessionStorage);
      this.busy(false);
    } catch (err) {
      c.close();
      this.session = null;
      store.del('uno.session', sessionStorage);
      this.busy(false, err.message);
    }
    this.refreshHome();
  }

  leave() {
    if (this.session instanceof Host) this.session.end();
    else if (this.session) this.session.close();
    this.session = null;
    this.state = null;
    this.hostIsAway = false;
    this.lastEventId = null;
    this.seatsKey = null;
    this.selected = [];
    this.hidden.clear();
    this.chatLines = [];
    this.renderChat();
    this.toggleChat(false);
    store.del('uno.session', sessionStorage);
    $('#overlay').hidden = true;
    this.closePicker();
    this.show('home');
    this.refreshHome();
  }

  show(name) {
    for (const s of document.querySelectorAll('.screen')) s.classList.toggle('active', s.id === `screen-${name}`);
  }

  copy(text, done) {
    const fallback = () => prompt('Copy this:', text);
    if (navigator.clipboard) navigator.clipboard.writeText(text).then(() => this.toast(done), fallback);
    else fallback();
  }

  toast(text) {
    const t = $('#toast');
    t.textContent = text;
    t.classList.add('show');
    clearTimeout(this.toastTimer);
    this.toastTimer = setTimeout(() => t.classList.remove('show'), 2400);
  }

  disconnected(why) {
    if (!this.session) return;
    this.session.close();
    this.session = null;
    store.del('uno.session', sessionStorage);
    this.overlay('Disconnected', { text: why || 'Connection lost' });
  }

  hostAway(on) {
    this.hostIsAway = on;
    this.rerender();
  }

  // ---- chat ----
  toggleChat(open = !$('#chat').classList.contains('open')) {
    $('#chat').classList.toggle('open', open);
    $('#btn-chat').setAttribute('aria-expanded', String(open));
    if (open) {
      this.unread = 0;
      this.renderUnread();
      const log = $('#chat-log');
      log.scrollTop = log.scrollHeight;
      if (window.matchMedia('(pointer: fine)').matches) $('#chat-input').focus();
    }
  }

  setChat(list) {
    this.chatLines = list.filter(validChat).slice(-CHAT_KEEP);
    this.renderChat();
  }

  addChat(e) {
    if (!validChat(e)) return;
    this.chatLines.push(e);
    if (this.chatLines.length > CHAT_KEEP) this.chatLines.shift();
    if (e.kind === 'chat') {
      // Messages also pop up as speech bubbles at the sender's seat.
      const p = this.state && this.state.players.find((x) => x.id === e.pid);
      if (p && this.state.phase !== 'lobby') this.bubble(p.seat, e.text.length > 60 ? `${e.text.slice(0, 58)}…` : e.text, 'say');
      if (e.pid !== this.me) {
        sound.chat();
        if (!$('#chat').classList.contains('open')) { this.unread += 1; this.renderUnread(); }
      }
    }
    this.renderChat();
  }

  renderUnread() {
    const b = $('#chat-unread');
    b.hidden = !this.unread;
    b.textContent = this.unread > 9 ? '9+' : String(this.unread || '');
  }

  renderChat() {
    const log = $('#chat-log');
    const players = (this.state && this.state.players) || [];
    const line = (cls, ...parts) => {
      const li = document.createElement('li');
      li.className = cls;
      li.append(...parts);
      return li;
    };
    const items = [];
    if (this.pin) {
      const b = document.createElement('b');
      b.textContent = this.pin;
      items.push(line('sys', 'Invite friends with PIN ', b));
    }
    for (const e of this.chatLines) {
      if (e.kind === 'sys') { items.push(line('sys', e.text)); continue; }
      const p = players.find((x) => x.id === e.pid);
      const who = document.createElement('span');
      who.className = 'who';
      who.textContent = `${e.name}:`;
      who.style.color = p && p.seat >= 0 ? seatColor(p.seat) : 'var(--yellow)';
      items.push(line('msg', who, document.createTextNode(e.text)));
    }
    const atBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 40;
    log.replaceChildren(...items);
    if (atBottom) log.scrollTop = log.scrollHeight;
  }

  renderClock() {
    const s = this.state;
    const el = $('#game-clock');
    if (!s || s.phase === 'lobby' || this.hostIsAway) return; // frozen while the host is away
    el.textContent = formatTime(gameTime(s, Date.now() + this.clockOffset));
    el.classList.toggle('stopped', !s.clock || s.clock.since === null);
  }

  overlay(title, { subtitle = '', board = null, text = '', again = false, results = '' } = {}) {
    $('#overlay-title').textContent = title;
    $('#overlay-sub').textContent = subtitle;
    $('#overlay-board').replaceChildren(...(board ? [board] : []));
    $('#overlay-text').textContent = text;
    $('#btn-again').hidden = !again;
    this.results = results;
    $('#btn-copy-results').hidden = !results;
    $('#overlay').hidden = false;
  }

  showScoreboard(state, isHost) {
    const sb = scoreboard(state, { me: this.me, now: Date.now() + this.clockOffset });
    const winner = playerBySeat(state, state.winner);
    this.overlay(winner && winner.id === this.me ? 'You win the round! 🎉' : `${winner ? winner.name : '?'} wins the round`, {
      subtitle: `Round ${state.round} · ${formatTime(sb.total)} · the winner scores the points left in everyone's hands`,
      board: sb.table,
      text: isHost ? '' : 'Waiting for the host to start the next round…',
      again: isHost,
      results: sb.text,
    });
  }

  // ---- rendering ----
  render(state, me, isHost, turnMs, hostNow = Date.now()) {
    this.clockOffset = hostNow - Date.now();
    this.state = state;
    this.me = me;
    this.isHost = isHost;
    this.sentAt = 0;
    if (state.phase === 'lobby') {
      $('#overlay').hidden = true;
      this.closePicker();
      this.selected = [];
      this.lastEventId = state.eventId;
      this.renderLobby(state, me, isHost);
      this.show('lobby');
      return;
    }
    this.show('game');
    this.renderGame(state, me, turnMs);
    // A flag, not prev/state comparison: the host re-renders fresh views each time.
    if (state.phase !== 'ended') this.endShown = false;
    else if (!this.endShown) {
      this.endShown = true;
      const winner = playerBySeat(state, state.winner);
      setTimeout(() => (winner && winner.id === me ? sound.win() : sound.lose()), 500);
      setTimeout(() => { if (this.state && this.state.phase === 'ended') this.showScoreboard(this.state, this.isHost); }, 1700);
    }
  }

  rerender() {
    if (this.state && this.state.phase !== 'lobby') this.renderGame(this.state, this.me, null);
  }

  renderLobby(state, me, isHost) {
    $('#pin-display').replaceChildren(...Array.from(this.pin || '').map((d) => Object.assign(document.createElement('span'), { textContent: d })));
    for (const input of document.querySelectorAll('#rules input')) {
      input.checked = !!state.rules[input.dataset.rule];
      input.disabled = !isHost;
    }
    $('#rules-text').textContent = isHost ? 'Pick any, or none. They work together.' : 'The host picks the house rules.';
    $('#player-count').textContent = `${state.players.length}/${MAX_PLAYERS}`;
    const ul = $('#lobby-players');
    ul.replaceChildren(...state.players.map((p) => {
      const li = document.createElement('li');
      li.append(avatar(p.name, -1, { bot: !!p.cpu }));
      const name = document.createElement('span');
      name.className = 'pname';
      name.textContent = p.name;
      li.append(name);
      if (state.round > 0) li.append(badge(`${state.totals[p.id] || 0} pts`, 'pts'));
      if (p.cpu) li.append(badge('Bot', 'bot'));
      if (p.host) li.append(badge('Host', 'host'));
      if (p.id === me) li.append(badge('You', 'you'));
      if (isHost && !p.host) {
        const x = document.createElement('button');
        x.type = 'button';
        x.className = 'kick';
        x.title = `Remove ${p.name}`;
        x.setAttribute('aria-label', `Remove ${p.name}`);
        x.textContent = '✕';
        x.addEventListener('click', () => this.session.kick(p.id));
        li.append(x);
      }
      return li;
    }));
    const enough = state.players.length >= MIN_PLAYERS;
    $('#btn-start').hidden = !isHost;
    $('#btn-start').disabled = !enough;
    $('#btn-start').textContent = state.round > 0 ? `Start round ${state.round + 1}` : 'Start game';
    $('#btn-add-bot').hidden = !isHost;
    $('#btn-add-bot').disabled = state.players.length >= MAX_PLAYERS;
    $('#lobby-status').textContent = isHost
      ? (enough ? 'Ready when you are.' : 'Share the PIN, or add a bot to play right away.')
      : 'Waiting for the host to start the game…';
  }

  renderGame(state, me, turnMs) {
    // While the host is unreachable, show the host as away too.
    const players = state.players.map((p) => (p.host && this.hostIsAway && !this.isHost ? { ...p, connected: false, bot: false } : p));
    const view = { ...state, players };
    const away = awayPlayers(view);
    const paused = away.length > 0;
    const mine = players.find((p) => p.id === me);
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

    this.renderClock();
    $('#round-label').textContent = `Round ${state.round}`;
    const chips = RULE_CHIPS.filter(([k]) => state.rules[k]);
    $('#rule-chips').replaceChildren(...chips.map(([, t]) => badge(t, 'rule')));
    $('#chat-count').textContent = `${players.filter((p) => p.connected).length} online`;
    if (state.phase === 'playing' && state.turn !== this.lastTurnSeat) {
      if (state.turn === mySeat && this.lastTurnSeat !== null) sound.turn();
      this.lastTurnSeat = state.turn;
    }

    // Banners
    $('#pause-banner').hidden = !paused;
    $('#afk-banner').hidden = !(mine && mine.afk && state.phase === 'playing');
    if (paused) {
      const names = away.map((p) => (p.id === me ? 'you' : p.name)).join(', ');
      $('#pause-text').textContent = this.hostIsAway && !this.isHost
        ? `Paused: the host (${away.find((p) => p.host)?.name || 'host'}) is away. Waiting for them to come back…`
        : `Paused: waiting for ${names} to come back…${this.isHost && this.pin ? ` They can rejoin with PIN ${this.pin}.` : ''}`;
      $('#btn-continue').hidden = !(this.session instanceof Host);
      $('#btn-invite').hidden = !(this.session instanceof Host);
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
    const rx = window.innerWidth < 600 ? 41 : 44;
    const ry = 41;
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
      let botBtn = null;
      if (this.isHost && !p.host && !p.cpu) {
        botBtn = el('button', 'seat-bot', face);
        botBtn.type = 'button';
        botBtn.textContent = '🤖';
        botBtn.title = `Replace ${p.name} with a bot`;
        botBtn.setAttribute('aria-label', botBtn.title);
        botBtn.addEventListener('click', () => {
          if (confirm(`Replace ${p.name} with a bot for the rest of this game? They will be disconnected and can't take the seat back.`)) this.session.replaceWithBot(p.id);
        });
      }
      this.seatEls.set(p.seat, { root, face, pic, count, name, flag, pts, fan, botBtn, n: -1, who: null });
    }
    this.positionSeats();
  }

  renderSeats(view, mySeat, turnMs, paused) {
    const playing = view.phase === 'playing';
    for (const p of view.players) {
      const s = this.seatEls.get(p.seat);
      if (!s) continue;
      if (s.who !== p.name) {
        s.who = p.name;
        s.pic.replaceChildren(avatar(p.name, p.seat, { bot: !!p.cpu }));
        s.name.textContent = p.seat === mySeat ? 'You' : p.name;
        s.root.title = p.name;
      }
      const active = playing && p.seat === view.turn;
      s.root.classList.toggle('active', active);
      s.root.classList.toggle('away', !p.connected && !p.bot);
      s.root.classList.toggle('bot', !!p.bot && !p.cpu);
      s.root.classList.toggle('uno', playing && !!view.uno[p.seat]);
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
      if (s.botBtn) s.botBtn.hidden = !playing || !!p.bot;
      if (turnMs !== null) setRing(s.face, active && !paused && turnMs > 0 ? turnMs : 0, TURN_MS);
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

  renderActions(view, mySeat, myTurn, paused) {
    const live = view.phase === 'playing' && !paused;
    const choosing = this.selected.length > 0;
    $('#btn-pass').hidden = !(live && myTurn && view.drawn !== null && !choosing);
    $('#btn-play').hidden = !(live && myTurn && choosing);
    $('#btn-play').textContent = this.selected.length > 1 ? `Play ${this.selected.length} cards` : 'Play 1 card';
    $('#btn-clear').hidden = !(live && myTurn && choosing);
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
    $('#note-text').textContent = s.note || '';
  }

  // ---- input ----
  ready() {
    const s = this.state;
    return this.session && s && s.phase === 'playing' && !this.paused && Date.now() - this.sentAt > 800;
  }

  sendPlay(ids, color = null) {
    this.sentAt = Date.now();
    this.selected = [];
    if (color) sound.wild();
    this.session.sendPlay(ids, color);
  }

  unoClicked() {
    const b = $('#btn-uno');
    if (!this.session || b.disabled) return;
    sound.armed();
    b.classList.add('said'); // instant feedback; the host confirms
    this.session.sendUno();
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
    this.session.sendDraw();
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
      } else if (e.kind === 'forgot') {
        this.bubble(e.seat, 'Forgot UNO! +2', 'forgot', t);
        later(t, () => sound.forgot());
        t += 450;
      } else if (e.kind === 'shuffle') {
        later(t, () => { sound.shuffle(); this.toast('Draw pile empty: the discards were shuffled back in'); });
      }
    }
    // Anything still hidden (an element that never got a flight) shows up now.
    later(t + 1500, () => { for (const id of [...this.hidden]) this.reveal(id); });
  }
}

function validChat(e) {
  return e && typeof e === 'object' && (e.kind === 'sys' || e.kind === 'chat') && typeof e.text === 'string'
    && (e.kind === 'sys' || (typeof e.name === 'string' && typeof e.pid === 'string'));
}

new UI();
