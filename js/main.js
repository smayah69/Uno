import {
  MAX_PLAYERS, MIN_PLAYERS, COLOR_KEYS, DECK_SIZE, RULE_KEYS, createLobby, startGame, play, draw, pass,
  callUno, catchUno, autoMove, viewFor, playerBySeat, canJump, cardName, gameTime, formatTime,
} from './game.js';
import { TableView, awayPlayers } from './table.js';
import { avatar, badge, scoreboard, seatColor } from './parts.js';
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
const CATCH_MS = [1800, 4500]; // how quickly a bot calls Contre-UNO on someone who forgot UNO
const BOT_FORGETS = 0.15;   // bots forget to say UNO now and then, so you can catch them
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
const store = {
  get(k, area = localStorage) { try { return area.getItem(k); } catch { return null; } },
  set(k, v, area = localStorage) { try { area.setItem(k, v); } catch { /* storage blocked */ } },
  del(k, area = localStorage) { try { area.removeItem(k); } catch { /* storage blocked */ } },
};

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
    this.catchTimer = null;
    this.catchFor = null;
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
    else if (msg.t === 'catch' && Number.isInteger(msg.seat)) this.act(pid, 'catch', msg);
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
      else if (action === 'catch') catchUno(s, p.seat, msg.seat, secureRandom);
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
    const p = playerBySeat(s, seat);
    const m = autoMove(s, seat);
    try {
      if (m.kind === 'play') {
        if (s.hands[seat].length - m.ids.length === 1 && !(p.bot && secureRandom() < BOT_FORGETS)) callUno(s, seat);
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
          if (s.hands[p.seat].length === 2 && secureRandom() > BOT_FORGETS) callUno(s, p.seat);
          play(s, p.seat, [card.id], null, secureRandom);
        } catch { return; }
        this.publish();
      }, wait);
      return;
    }
  }

  // Contre-UNO: a bot notices who forgot to say UNO (not always, not instantly).
  scheduleCatch() {
    const s = this.state;
    const targets = s.phase === 'playing' && !awayPlayers(s).length ? Object.keys(s.exposed || {}).map(Number) : [];
    const key = targets.length ? targets.join(',') : null;
    if (key === this.catchFor) return;
    this.catchFor = key;
    clearTimeout(this.catchTimer);
    if (!key) return;
    const target = targets[0];
    const bots = s.players.filter((p) => p.bot && p.seat !== target);
    if (!bots.length || secureRandom() > 0.75) return;
    const bot = bots[Math.floor(secureRandom() * bots.length)];
    const wait = CATCH_MS[0] + secureRandom() * (CATCH_MS[1] - CATCH_MS[0]);
    this.catchTimer = setTimeout(() => {
      if (this.state !== s || !s.exposed[target] || !bot.bot) return;
      try { catchUno(s, bot.seat, target, secureRandom); } catch { return; }
      this.publish();
    }, wait);
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
      else if (e.kind === 'catch') text = `Contre-UNO! ${name(e.seat)} caught ${name(e.target)} without UNO: +2`;
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
    this.scheduleCatch();
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
  sendCatch(seat) { this.act(this.me, 'catch', { seat }); }
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
    clearTimeout(this.catchTimer);
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
  sendCatch(seat) { this.net.send({ t: 'catch', seat }); }
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
    this.endShown = false;
    const send = (fn) => (...args) => this.session && this.session[fn](...args);
    this.table = new TableView({
      actions: {
        play: send('sendPlay'),
        draw: send('sendDraw'),
        pass: send('sendPass'),
        uno: send('sendUno'),
        catch: send('sendCatch'),
        replaceWithBot: (p) => {
          if (confirm(`Replace ${p.name} with a bot for the rest of this game? They will be disconnected and can't take the seat back.`)) this.session.replaceWithBot(p.id);
        },
      },
      toast: (text) => this.toast(text),
      turnTotal: TURN_MS,
    });
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
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') this.toggleChat(false); });

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
    this.table.reset();
    this.chatLines = [];
    this.renderChat();
    this.toggleChat(false);
    store.del('uno.session', sessionStorage);
    $('#overlay').hidden = true;
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
      if (p && this.state.phase !== 'lobby') this.table.bubble(p.seat, e.text.length > 60 ? `${e.text.slice(0, 58)}…` : e.text, 'say');
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
    if (state.phase === 'lobby') {
      $('#overlay').hidden = true;
      this.table.closePicker();
      this.table.selected = [];
      this.table.lastEventId = state.eventId;
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
    const away = awayPlayers({ ...state, players });
    const paused = away.length > 0;
    const mine = players.find((p) => p.id === me);
    this.table.render(state, me, { players, isHost: this.isHost, turnMs });

    this.renderClock();
    $('#round-label').textContent = `Round ${state.round}`;
    const chips = RULE_CHIPS.filter(([k]) => state.rules[k]);
    $('#rule-chips').replaceChildren(...chips.map(([, t]) => badge(t, 'rule')));
    $('#chat-count').textContent = `${players.filter((p) => p.connected).length} online`;

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
  }
}

function validChat(e) {
  return e && typeof e === 'object' && (e.kind === 'sys' || e.kind === 'chat') && typeof e.text === 'string'
    && (e.kind === 'sys' || (typeof e.name === 'string' && typeof e.pid === 'string'));
}

new UI();
