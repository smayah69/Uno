// The host: the authoritative game server, running in the host's browser.
// It holds every hand and the draw pile; each player only ever gets
// viewFor(state, theirSeat). It talks to players through a transport from
// net.js, and to its own screen through `ui` (the UI class in main.js).
import {
  MAX_PLAYERS, MIN_PLAYERS, COLOR_KEYS, RULE_KEYS, createLobby, startGame, play, draw, pass,
  callUno, catchUno, viewFor, playerBySeat, cardName, awayPlayers,
} from './game.js';
import { autoTurn, BotReflexes, BOT_MS } from './bots.js';
import { sanitizeName, sanitizeChat, MAX_NAME } from './text.js';
import { createHostNet, secureRandom } from './net.js';
import { isRoom, codeLabel, savedTicket, forgetTicket, prove } from './room.js';
import { local } from './store.js';
import { PROTOCOL, PING_MS, DEAD_MS, CHAT_KEEP, VERSION_REASON, isHex32, validIds } from './protocol.js';

export const TURN_MS = 25000; // time a player gets; miss it and the computer plays for them (AFK)
const AFK_MS = 2500;          // an AFK player's turn waits this long, so they can take it back
const SAVE_KEY = 'uno.host';
const SAVE_TTL = 12 * 3600 * 1000;
const CHAT_GAP_MS = 600;      // per-player chat throttle
const RATE_WINDOW = 5000;     // per-connection message limit: RATE_MAX per RATE_WINDOW
const RATE_MAX = 40;
const HELLO_MS = 10000;       // a new connection has this long to say hello
const MAX_WAITING = 8;        // connections that haven't said hello yet; past that the oldest goes
const NAME_BAN_MS = 10 * 60 * 1000;  // a removed player's name can't join again for this long
const SECRET_BAN_MS = SAVE_TTL;      // nor can their browser tab
const GRACE_MS = 60000;       // host resumed between rounds: players get this long to come back
const BOT_NAMES = ['Robo Rita', 'Bot Bob', 'Chip', 'Beep Boop', 'Gizmo', 'Sparky', 'Botzilla', 'Unobot'];

export class Host {
  // saved: a game from loadSaved() to resume. room: open the private room
  // /itc1 instead of a random PIN. net, rng: for tests.
  constructor({ name, ui, saved = null, room = null, net = null, turnMs = TURN_MS, rng = secureRandom }) {
    this.ui = ui;
    this.net = net || createHostNet();
    this.turnMs = turnMs;
    this.rng = rng;
    this.closed = false;
    this.connPid = new Map();   // connection id -> player id
    this.seen = new Map();      // connection id -> last message time
    this.waiting = new Map();   // connection id -> when it opened, until it says hello
    this.proving = new Set();   // connection ids waiting for the server to sign their challenge
    this.rate = new Map();      // connection id -> {t, n}
    this.asked = new Map();     // player id -> the name they asked for (before " 2" was added)
    this.timer = null;
    this.turnKey = null;
    this.deadline = 0;
    this.me = 'p0';
    this.chat = [];             // recent chat + event lines, sent to (re)joiners
    this.chatAt = new Map();    // player id -> last chat time
    this.graceUntil = 0;
    if (saved) {
      // Resuming after the host's tab closed: everyone else must reconnect.
      this.state = saved.state;
      this.secrets = new Map(saved.secrets);
      this.banned = new Map(saved.banned || []);
      this.nextPid = saved.nextPid;
      this.resumePin = saved.pin;
      for (const p of this.state.players) p.connected = !!p.host;
      const c = this.state.clock;
      if (c && c.since !== null) { c.base += Math.max(0, (saved.savedAt || Date.now()) - c.since); c.since = null; }
      // Between rounds nothing waits for missing players, so keep their seats for a while.
      if (this.state.phase !== 'playing') this.graceUntil = Date.now() + GRACE_MS;
    } else {
      this.state = createLobby();
      this.secrets = new Map(); // client secret -> player id (never broadcast)
      this.banned = new Map();  // 'name:<lowercased>' | 'secret:<hex>' -> until (ms)
      this.nextPid = 1;
      this.state.players.push({ id: 'p0', name, seat: -1, connected: true, host: true });
      this.resumePin = room;
    }
    this.room = isRoom(this.resumePin) ? this.resumePin : null;
    this.ticket = this.room ? savedTicket() : null;
    this.logged = this.state.eventId;
    this.bots = new BotReflexes({
      state: () => this.state,
      isBot: (seat) => !!(playerBySeat(this.state, seat) || {}).bot,
      active: () => !awayPlayers(this.state).length,
      changed: () => this.publish(),
      rng: this.rng,
    });
  }

  // A game this browser was hosting: in progress, or between rounds (the
  // scores carry over).
  static loadSaved() {
    try {
      const d = JSON.parse(local.get(SAVE_KEY));
      const s = d && (d.v === 1 || d.v === 2) && Date.now() - d.savedAt < SAVE_TTL
        && (/^\d{6}$/.test(d.pin) || isRoom(d.pin)) && d.state;
      if (s && Array.isArray(s.players) && (s.phase === 'playing' || s.round > 0)) return d;
    } catch { /* corrupt or missing */ }
    return null;
  }

  static discardSaved() {
    local.del(SAVE_KEY);
  }

  async start() {
    if (this.room && !this.ticket) throw new Error(`Only the host can open ${codeLabel(this.room)}: enter the password.`);
    this.net.onJoin = (cid) => this.opened(cid);
    this.net.onLeave = (cid) => this.leave(cid);
    this.net.onMessage = (cid, msg) => this.receive(cid, msg);
    this.net.onStatus = (text) => { if (!this.closed) this.ui.busy(true, text); };
    this.pin = await this.net.start(this.resumePin);
    this.ui.pin = this.pin;
    this.heartbeat = setInterval(() => this.beat(), PING_MS);
    this.publish();
    return this.pin;
  }

  // ---- connections ----

  // A new connection gets HELLO_MS to say hello. Only MAX_WAITING may wait at
  // once: the oldest makes room, so idle connections can't fill the table's
  // doors (the room's address is public).
  opened(cid) {
    if (this.closed) return;
    const now = Date.now();
    this.seen.set(cid, now);
    this.waiting.set(cid, now);
    if (this.waiting.size > MAX_WAITING) {
      const oldest = [...this.waiting.keys()].find((c) => !this.proving.has(c)) || cid;
      this.reject(oldest, 'Too many people connecting at once. Try again in a moment.');
    }
  }

  // Refuse a connection: say why, then close it. It stops counting right away.
  reject(cid, reason, extra = {}) {
    if (reason) this.net.send(cid, { t: 'reject', reason, ...extra });
    this.forget(cid);
    this.net.drop(cid);
  }

  forget(cid) {
    this.seen.delete(cid);
    this.waiting.delete(cid);
    this.rate.delete(cid);
  }

  beat() {
    if (this.closed) return;
    const now = Date.now();
    for (const [cid, t] of this.seen) {
      const since = this.waiting.get(cid);
      const silent = since !== undefined && !this.proving.has(cid) && now - since > HELLO_MS;
      if (now - t > DEAD_MS || silent) { this.net.drop(cid, 0); this.leave(cid); }
      else this.net.send(cid, { t: 'ping' });
    }
    // Resumed between rounds: whoever hasn't come back by now has left.
    if (this.graceUntil && now > this.graceUntil) {
      this.graceUntil = 0;
      const s = this.state;
      if (s.phase === 'lobby' && s.players.some((p) => !p.connected && !p.cpu)) {
        s.players = s.players.filter((p) => p.connected || p.cpu);
        const kept = new Set(s.players.map((p) => p.id));
        for (const [k, v] of this.secrets) if (!kept.has(v)) this.secrets.delete(k);
        this.publish();
      }
    }
  }

  limited(cid) {
    const now = Date.now();
    const r = this.rate.get(cid) || { t: now, n: 0 };
    if (now - r.t > RATE_WINDOW) { r.t = now; r.n = 0; }
    r.n += 1;
    this.rate.set(cid, r);
    return r.n > RATE_MAX;
  }

  receive(cid, msg) {
    if (this.closed || !this.seen.has(cid)) return;
    this.seen.set(cid, Date.now());
    if (!msg || typeof msg !== 'object' || typeof msg.t !== 'string' || msg.t === 'ping' || this.limited(cid)) return;
    if (msg.t === 'hello') {
      if (msg.v !== PROTOCOL) return this.reject(cid, VERSION_REASON, { code: 'version', v: PROTOCOL });
      return this.room ? this.provenHello(cid, msg) : this.hello(cid, msg);
    }
    const pid = this.connPid.get(cid);
    if (!pid) return;
    if (msg.t === 'back') this.back(pid);
    else if (msg.t === 'play' && validIds(msg.ids) && (msg.color == null || COLOR_KEYS.includes(msg.color))) this.act(pid, 'play', msg);
    else if (msg.t === 'draw' || msg.t === 'pass' || msg.t === 'uno') this.act(pid, msg.t);
    else if (msg.t === 'catch' && Number.isInteger(msg.seat)) this.act(pid, 'catch', msg);
    else if (msg.t === 'chat') this.say(pid, msg.text);
  }

  // Private room: players send a random challenge with their hello. The server
  // signs it only for the owner's ticket, and the player checks that signature,
  // so nobody else can pose as the host on the room's (public) peer id.
  async provenHello(cid, msg) {
    if (this.connPid.has(cid) || this.proving.has(cid)) return;
    if (!isHex32(msg.nonce)) return this.reject(cid, 'Bad request');
    this.proving.add(cid);
    let proof;
    try {
      proof = await prove(this.ticket, this.room, msg.nonce);
    } catch (err) {
      if (this.closed) return;
      if (err.status === 401) {
        forgetTicket();
        this.ui.toast('Your host login expired: leave and open the room again with the password');
      }
      this.reject(cid, err.status === 401 ? "The host's login expired. Tell them to open the room again." : 'Could not verify the host, try again');
      return;
    } finally {
      this.proving.delete(cid);
    }
    if (!this.closed && this.seen.has(cid)) this.hello(cid, msg, proof);
  }

  // Removed by the host a short while ago (see kick)?
  isBanned(key) {
    const now = Date.now();
    for (const [k, until] of this.banned) if (until <= now) this.banned.delete(k);
    return this.banned.has(key);
  }

  hello(cid, msg, proof) {
    if (this.closed || this.connPid.has(cid) || !this.seen.has(cid)) return;
    const s = this.state;
    const secret = isHex32(msg.secret) ? msg.secret : null;
    if (!secret) return this.reject(cid, 'Bad request');
    const name = sanitizeName(msg.name) || 'Player';
    const removed = () => this.reject(cid, 'You were removed by the host');
    if (this.isBanned(`secret:${secret}`)) return removed();

    let pid = this.secrets.get(secret);
    let player = pid && s.players.find((p) => p.id === pid);
    if (player && player.replaced) return this.reject(cid, 'The host replaced you with a bot');
    // A newcomer under a name the host just removed (players coming back are fine).
    if (!player && this.isBanned(`name:${name.toLowerCase()}`)) return removed();
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
      for (const [c, p] of this.connPid) if (p === pid) { this.connPid.delete(c); this.reject(c); }
      const wasAway = !player.connected;
      player.connected = true;
      player.bot = false;
      if (wasAway && s.phase !== 'lobby') this.toastAll(`${player.name} is back`);
    } else {
      if (s.phase !== 'lobby' && s.players.some((p) => p.replaced && p.name.toLowerCase() === name.toLowerCase())) return this.reject(cid, 'The host replaced you with a bot');
      if (s.phase !== 'lobby') return this.reject(cid, 'This game has already started');
      if (s.players.length >= MAX_PLAYERS) return this.reject(cid, `The table is full (${MAX_PLAYERS} players max)`);
      pid = `p${this.nextPid++}`;
      player = { id: pid, name: this.uniqueName(name), seat: -1, connected: true, host: false };
      s.players.push(player);
      this.secrets.set(secret, pid);
      this.asked.set(pid, name);
      this.toastAll(`${player.name} joined`);
    }
    this.waiting.delete(cid);
    this.connPid.set(cid, pid);
    this.net.send(cid, { t: 'welcome', v: PROTOCOL, pid, pin: this.pin, proof });
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
    this.forget(cid);
    const pid = this.connPid.get(cid);
    this.connPid.delete(cid);
    if (this.closed || !pid || [...this.connPid.values()].includes(pid)) return;
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

  // Remove someone from the lobby. They can't come straight back: not from
  // that tab, and not under that name for a while.
  kick(pid) {
    const s = this.state;
    const p = s.players.find((x) => x.id === pid);
    if (s.phase !== 'lobby' || !p || p.host) return;
    for (const [c, x] of this.connPid) {
      if (x === pid) { this.connPid.delete(c); this.reject(c, 'You were removed by the host'); }
    }
    for (const [k, v] of this.secrets) {
      if (v !== pid) continue;
      this.secrets.delete(k);
      this.banned.set(`secret:${k}`, Date.now() + SECRET_BAN_MS);
    }
    s.players = s.players.filter((x) => x.id !== pid);
    // Their name too (as shown, and as typed if a number was added), unless
    // someone still at the table goes by it.
    if (!p.cpu) {
      const inUse = new Set(s.players.map((x) => x.name.toLowerCase()));
      for (const n of new Set([p.name, this.asked.get(pid)].filter(Boolean).map((x) => x.toLowerCase()))) {
        if (!inUse.has(n)) this.banned.set(`name:${n}`, Date.now() + NAME_BAN_MS);
      }
    }
    this.publish();
  }

  begin() {
    if (this.state.phase !== 'lobby' || this.state.players.length < MIN_PLAYERS) return;
    startGame(this.state, this.rng);
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
      if (x === pid) { this.net.send(c, { t: 'end', reason: 'The host replaced you with a bot' }); this.connPid.delete(c); this.reject(c); }
    }
    p.connected = false;
    this.toastAll(`${p.name} was replaced by a bot`);
    this.publish();
  }

  // Next round with the same table: scores carry over. Players still finding
  // their way back after the host resumed keep their seat for a while.
  backToLobby() {
    const s = this.state;
    if (s.phase !== 'ended') return;
    const grace = Date.now() < this.graceUntil;
    const keep = s.players.filter((p) => p.connected || p.cpu || (grace && !p.replaced));
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
    if (this.closed || s.phase !== 'playing' || awayPlayers(s).length) return;
    const p = s.players.find((x) => x.id === pid);
    if (!p || p.seat < 0) return;
    try {
      if (action === 'play') play(s, p.seat, msg.ids, msg.color || null, this.rng);
      else if (action === 'draw') draw(s, p.seat, this.rng);
      else if (action === 'pass') pass(s, p.seat);
      else if (action === 'catch') catchUno(s, p.seat, msg.seat, this.rng);
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

  // The turn timer restarts only when a new turn starts (turnId), or the
  // turn player drew a card they may play. Saying UNO, chatting or someone
  // calling Contre-UNO doesn't change it.
  schedule() {
    const s = this.state;
    const paused = awayPlayers(s).length > 0;
    const p = s.phase === 'playing' && !paused ? playerBySeat(s, s.turn) : null;
    const key = p ? [s.turn, s.turnId, s.drawn, !!p.bot, !!p.afk].join('|') : null;
    if (key === this.turnKey) return;
    this.turnKey = key;
    clearTimeout(this.timer);
    this.timer = null;
    this.deadline = 0;
    if (!p) return;
    const auto = p.bot || p.afk;
    const ms = p.bot ? BOT_MS : p.afk ? AFK_MS : this.turnMs;
    if (!auto) this.deadline = Date.now() + ms;
    this.timer = setTimeout(() => {
      this.turnKey = null;
      // Ran out of time: auto-play now, and keep auto-playing quickly until they're back.
      if (!auto) {
        p.afk = true;
        this.toastAll(`${p.name} is AFK: the computer plays for them`);
      }
      autoTurn(this.state, p.seat, { forgetful: !!p.bot, rng: this.rng });
      this.publish();
    }, ms);
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
    if (this.closed) return;
    this.chat.push(e);
    if (this.chat.length > CHAT_KEEP) this.chat.shift();
    for (const [cid] of this.connPid) this.net.send(cid, { t: 'chat', e });
    this.ui.addChat(e);
  }

  toastAll(text) {
    if (this.closed) return;
    for (const [cid] of this.connPid) this.net.send(cid, { t: 'toast', text });
    this.ui.toast(text);
    this.pushChat({ kind: 'sys', text });
  }

  // Kept while a game is on and between rounds (the scores), so a refresh
  // or a crash doesn't lose it.
  save() {
    const s = this.state;
    if (s.phase === 'playing' || s.round > 0) {
      local.set(SAVE_KEY, JSON.stringify({
        v: 2, pin: this.pin, state: s, secrets: [...this.secrets], banned: [...this.banned], nextPid: this.nextPid, savedAt: Date.now(),
      }));
    } else local.del(SAVE_KEY);
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

  // After every change: timers, bots, save, and a fresh view for everyone.
  // Nothing at all once the host has left (closed).
  publish() {
    if (this.closed) return;
    const s = this.state;
    this.tickClock();
    this.logEvents();
    s.seq += 1;
    this.schedule();
    this.bots.update();
    this.save();
    const now = Date.now();
    const turnMs = this.deadline ? this.deadline - now : 0;
    for (const [cid, pid] of this.connPid) {
      const p = s.players.find((x) => x.id === pid);
      this.net.send(cid, { t: 'state', s: viewFor(s, p ? p.seat : -1), turnMs, now });
    }
    this.ui.render(viewFor(s, this.mySeat()), this.me, true, turnMs, now);
  }

  sendChat(text) { this.say(this.me, text); }
  sendPlay(ids, color) { this.act(this.me, 'play', { ids, color }); }
  sendDraw() { this.act(this.me, 'draw'); }
  sendPass() { this.act(this.me, 'pass'); }
  sendUno() { this.act(this.me, 'uno'); }
  sendCatch(seat) { this.act(this.me, 'catch', { seat }); }
  sendBack() { this.back(this.me); }

  // Deliberate exit: tell everyone and forget the saved game. Everything
  // stops now (no timer or late message may bring the game back); only the
  // transport stays up a moment so the goodbyes get out.
  end() {
    for (const [cid] of this.connPid) this.net.send(cid, { t: 'end', reason: 'The host ended the game' });
    this.stop();
    local.del(SAVE_KEY);
    setTimeout(() => this.net.close(), 200);
  }

  close() {
    this.stop();
    this.net.close();
  }

  stop() {
    this.closed = true;
    clearTimeout(this.timer);
    clearInterval(this.heartbeat);
    this.bots.stop();
  }
}
