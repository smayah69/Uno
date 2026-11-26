// Test doubles for the host and client: storage, transports and a UI that
// records what it was asked to show.

// localStorage / sessionStorage (Node has none).
export class MemStorage {
  constructor() { this.m = new Map(); }
  getItem(k) { return this.m.has(k) ? this.m.get(k) : null; }
  setItem(k, v) { this.m.set(k, String(v)); }
  removeItem(k) { this.m.delete(k); }
  clear() { this.m.clear(); }
}
globalThis.localStorage = new MemStorage();
globalThis.sessionStorage = new MemStorage();

// Seeded PRNG so failures are reproducible.
export function rng(seed = 1) {
  let t = seed;
  return () => {
    t = (t + 0x6d2b79f5) | 0;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

export const secret = (n) => n.toString(16).padStart(32, '0');

// The host's side of the transport. open/say/gone play the players.
export class FakeHostNet {
  constructor() {
    this.sent = [];
    this.dropped = [];
    this.closed = false;
  }
  start(pin) { return Promise.resolve(pin || '123456'); }
  send(cid, msg) { this.sent.push({ cid, msg }); }
  drop(cid) { this.dropped.push(cid); }
  close() { this.closed = true; }
  to(cid, t) { return this.sent.filter((x) => x.cid === cid && (!t || x.msg.t === t)).map((x) => x.msg); }
  open(cid) { this.onJoin(cid); }
  say(cid, msg) { this.onMessage(cid, msg); }
  gone(cid) { this.onLeave(cid); }
}

// A player's side of the transport. hostSays plays the host.
export class FakeClientNet {
  constructor() {
    this.sent = [];
    this.connects = 0;
    this.drops = 0;
    this.closed = false;
  }
  connect() { this.connects += 1; return Promise.resolve(); }
  send(msg) { this.sent.push(msg); }
  drop() { this.drops += 1; }
  close() { this.closed = true; }
  hostSays(msg) { this.onMessage(msg); }
}

export function fakeUI() {
  return {
    renders: 0,
    last: null,
    toasts: [],
    chats: [],
    away: [],
    gone: [],
    render(view) { this.renders += 1; this.last = view; },
    toast(text) { this.toasts.push(text); },
    addChat(e) { this.chats.push(e); },
    setChat() {},
    busy() {},
    hostAway(on) { this.away.push(on); },
    disconnected(why) { this.gone.push(why); },
  };
}

// Let pending promise callbacks run.
export async function flush(n = 10) {
  for (let i = 0; i < n; i++) await Promise.resolve();
}
