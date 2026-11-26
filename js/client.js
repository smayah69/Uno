// A player (not the host): forwards input to the host and renders the views
// the host sends. Keeps reconnecting while the host is away, so a host who
// refreshes or loses their connection finds everyone again.
import { createClientNet, randomId } from './net.js';
import { isRoom, codeLabel, check } from './room.js';
import { session } from './store.js';
import { PROTOCOL, PING_MS, DEAD_MS, RETRY_MS, isHex32, validView, versionError } from './protocol.js';

const WELCOME_MS = 8000; // the host has this long to answer our hello
const HELD_MAX = 50;     // messages kept while the handshake finishes

export class Client {
  constructor({ name, ui, net = null }) {
    this.name = name;
    this.ui = ui;
    this.net = net || createClientNet();
    this.me = null;          // our player id, once the host welcomed us
    this.closed = false;
    this.online = false;
    this.ready = false;      // handshake done: messages are shown, not held
    this.held = [];
    this.pending = null;     // the hello waiting for its welcome: {resolve, reject}
    this.lastState = null;
    let secret = session.get('uno.secret');
    if (!isHex32(secret)) {
      secret = randomId(16);
      session.set('uno.secret', secret);
    }
    this.secret = secret;
  }

  async join(pin) {
    this.pin = pin;
    this.room = isRoom(pin) ? pin : null;
    this.net.onMessage = (msg) => this.receive(msg);
    this.net.onClose = () => this.lost();
    await this.connect();
    if (!this.heartbeat) this.heartbeat = setInterval(() => this.beat(), PING_MS);
  }

  // One connection attempt: transport + hello/welcome handshake. In a private
  // room the host must also prove it's the owner before we show anything it
  // sends. A refusal from the host comes back with err.fromHost (don't retry).
  async connect() {
    if (this.closed) throw new Error('Closed');
    this.ready = false;
    this.held = [];
    await this.net.connect(this.pin);
    if (this.closed) throw new Error('Closed');
    this.seen = Date.now();
    const nonce = this.room ? randomId(16) : undefined;
    const welcome = await new Promise((resolve, reject) => {
      // Each attempt has its own timer, so a late one can't fail a newer attempt.
      const wait = {
        resolve: (m) => { clearTimeout(timer); resolve(m); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      };
      const timer = setTimeout(() => {
        if (this.pending !== wait) return;
        this.pending = null;
        reject(new Error('Host did not respond'));
      }, WELCOME_MS);
      this.pending = wait;
      this.net.send({ t: 'hello', v: PROTOCOL, name: this.name, secret: this.secret, nonce });
    });
    if (this.room) {
      let ok = false;
      try { ok = await check(this.room, nonce, welcome.proof); } catch { /* server unreachable: not verified */ }
      if (this.closed) throw new Error('Closed');
      if (!ok) {
        this.net.drop();
        throw new Error(`Could not verify that this is the real ${codeLabel(this.room)} host. Try again in a moment.`);
      }
    }
    if (welcome.v !== PROTOCOL) throw this.refused(versionError(welcome.v));
    if (typeof welcome.pid !== 'string') throw this.refused('Bad answer from the host');
    this.me = welcome.pid;
    session.set('uno.pin', this.pin);
    this.ready = true;
    this.online = true;
    const held = this.held;
    this.held = [];
    for (const m of held) this.receive(m);
  }

  // The host turned us away for good: stop, and say why if we were in.
  refused(reason) {
    const wasIn = !!this.me;
    this.close();
    if (wasIn) this.ui.disconnected(reason);
    return Object.assign(new Error(reason), { fromHost: true });
  }

  beat() {
    if (!this.online || this.closed) return;
    if (Date.now() - this.seen > DEAD_MS) { this.net.drop(); this.lost(); return; }
    this.net.send({ t: 'ping' });
  }

  lost() {
    if (this.closed || !this.online) return;
    this.online = false;
    this.ready = false;
    // Wait for the host while a game is on (they can resume it, scores
    // included), and in a private room's lobby (its address doesn't change).
    const st = this.lastState;
    if (!st || (st.phase === 'lobby' && !(st.round > 0) && !this.room)) {
      this.close();
      this.ui.disconnected('Connection to the host was lost');
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
    if (this.closed) return;
    this.seen = Date.now();
    if (!msg || typeof msg !== 'object') return;
    if (!this.ready && /^(state|toast|chat|chatlog)$/.test(msg.t)) {
      this.held.push(msg);
      if (this.held.length > HELD_MAX) this.held.shift();
      return;
    }
    if (msg.t === 'welcome') {
      const p = this.pending;
      this.pending = null;
      if (p) p.resolve(msg);
    } else if (msg.t === 'reject' || msg.t === 'end') {
      const reason = msg.code === 'version' ? versionError(msg.v) : String(msg.reason || 'Disconnected');
      const p = this.pending;
      this.pending = null;
      // Reconnecting to a room host not verified yet (maybe an impostor): only this attempt fails.
      if (this.room && !this.ready && this.me) {
        if (p) p.reject(new Error(reason));
        return;
      }
      const err = this.refused(reason);
      if (p) p.reject(err);
    } else if (msg.t === 'state' && validView(msg.s)) {
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
    if (this.closed) return;
    this.closed = true;
    this.online = false;
    clearInterval(this.heartbeat);
    clearTimeout(this.retryTimer);
    const p = this.pending;
    this.pending = null;
    if (p) p.reject(new Error('Closed'));
    this.net.close();
  }
}
