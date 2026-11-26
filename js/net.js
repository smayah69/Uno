// Transport layer. The host's browser is the authoritative game server;
// everyone else connects to it peer-to-peer.
//
// - PeerNet: WebRTC via PeerJS (public broker is only used for signaling).
//   The host registers the peer id `uno-p2p-v1-<PIN>` (or `uno-p2p-v1-itc1`
//   for the private room, see room.js).
// - LocalNet: BroadcastChannel between tabs of the same browser, enabled with
//   ?local=1. Same message flow, no internet needed (handy for testing).
//
// Clients call connect() again after a drop to reconnect (drop() ends just
// the link to the host, close() everything); a host that comes back calls
// start(pin) to reclaim its old PIN. A missing host rejects with
// err.code = 'no-host'.

const PREFIX = 'uno-p2p-v1-';
const CONNECT_TIMEOUT = 15000;
// Several STUN servers (address discovery) + PeerJS's free TURN relays for
// networks where a direct browser-to-browser link is impossible (CGNAT,
// strict corporate firewalls). Passing `config` replaces PeerJS's defaults,
// so its TURN entry is repeated here.
const ICE = {
  iceServers: [
    { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] },
    { urls: 'stun:stun.cloudflare.com:3478' },
    { urls: ['turn:eu-0.turn.peerjs.com:3478', 'turn:us-0.turn.peerjs.com:3478'], username: 'peerjs', credential: 'peerjsp' },
  ],
};
const RECLAIM_TRIES = 30;     // host resuming: the broker frees a dead id after ~a minute
const RECLAIM_DELAY = 3000;

export function randomPin() {
  const a = new Uint32Array(1);
  crypto.getRandomValues(a);
  return String(100000 + (a[0] % 900000));
}

export function randomId(bytes = 16) {
  const a = new Uint8Array(bytes);
  crypto.getRandomValues(a);
  return [...a].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// Math.random-like, from the OS's random generator (shuffles, bots).
export function secureRandom() {
  const a = new Uint32Array(1);
  crypto.getRandomValues(a);
  return a[0] / 2 ** 32;
}

// ---- PeerJS -------------------------------------------------------------

class PeerHost {
  constructor() {
    this.conns = new Map();
    this.onJoin = () => {};
    this.onLeave = () => {};
    this.onMessage = () => {};
    this.onStatus = () => {};
  }

  start(wantPin) {
    return new Promise((resolve, reject) => {
      let tries = 0;
      const attempt = () => {
        const pin = wantPin || randomPin();
        const peer = new window.Peer(PREFIX + pin, { debug: 0, config: ICE });
        peer.on('open', () => {
          this.peer = peer;
          this.pin = pin;
          peer.on('connection', (conn) => this.accept(conn));
          // Lost the signaling server: existing P2P links keep working, but
          // reconnect so new players can still join.
          peer.on('disconnected', () => { if (!peer.destroyed && !this.closed) setTimeout(() => peer.reconnect(), 1000); });
          resolve(pin);
        });
        peer.on('error', (err) => {
          if (this.peer === peer) return console.warn('peer error', err);
          peer.destroy();
          if (this.closed) return;
          if (err.type === 'unavailable-id' && wantPin && tries++ < RECLAIM_TRIES) {
            this.onStatus(`Reclaiming ${/^\d+$/.test(wantPin) ? 'PIN ' : 'room '}${wantPin.toUpperCase()}… (${tries})`);
            setTimeout(attempt, RECLAIM_DELAY);
          } else if (err.type === 'unavailable-id' && !wantPin && tries++ < 5) attempt();
          else if (err.type === 'unavailable-id' && wantPin && !/^\d+$/.test(wantPin)) reject(new Error(`${wantPin.toUpperCase()} is already open somewhere else (another tab or device?). Try again in a minute.`));
          else reject(new Error(friendlyError(err)));
        });
      };
      attempt();
    });
  }

  accept(conn) {
    const id = conn.connectionId;
    conn.on('open', () => {
      this.conns.set(id, conn);
      this.onJoin(id);
    });
    conn.on('data', (msg) => this.onMessage(id, msg));
    const gone = () => {
      if (this.conns.delete(id)) this.onLeave(id);
    };
    conn.on('close', gone);
    conn.on('error', gone);
  }

  send(id, msg) {
    const c = this.conns.get(id);
    if (c && c.open) c.send(msg);
  }

  drop(id, delay = 300) {
    const c = this.conns.get(id);
    if (c) setTimeout(() => c.close(), delay);
  }

  close() {
    this.closed = true;
    if (this.peer) this.peer.destroy();
  }
}

const NO_GAME = 'No game found with that PIN. Check it, and that the host still has the game open.';
const NO_LINK = 'Found the game but could not connect to the host. One of you may be on a network that blocks direct connections; try mobile data or another Wi-Fi.';
const NO_BROKER = 'Could not reach the matchmaking server (0.peerjs.com). Check your internet connection, or disable an ad blocker / VPN.';

class PeerClient {
  constructor() {
    this.onMessage = () => {};
    this.onClose = () => {};
    this.peer = null;    // kept between attempts: one broker registration per page, not one per retry
    this.conn = null;    // the data connection to the host
    this.linked = false; // that connection is open
    this.attempt = null; // the connect() in progress
  }

  // The signaling (broker) side, reopened when it was lost.
  ensurePeer() {
    const old = this.peer;
    if (old && !old.destroyed) {
      if (old.disconnected) {
        try { old.reconnect(); } catch { /* already reconnecting */ }
      }
      return old;
    }
    const peer = new window.Peer({ debug: 0, config: ICE });
    this.peer = peer;
    peer.on('open', () => { if (this.peer === peer && this.attempt) this.attempt.dial(); });
    peer.on('error', (err) => { if (this.peer === peer) this.peerError(err); });
    return peer;
  }

  peerError(err) {
    if (err.type === 'peer-unavailable') {
      if (this.attempt) this.attempt.fail(NO_GAME, 'no-host');
      else this.lost(this.conn);
    } else if (this.attempt) {
      this.attempt.fail(friendlyError(err));
    }
    // Errors once linked (the broker dropping, say) don't touch the open
    // link; the next connect() reopens what PeerJS closed.
  }

  // Can be called repeatedly: each attempt opens a new link to the host.
  connect(pin) {
    this.drop();
    if (this.attempt) this.attempt.fail('Connection attempt replaced');
    return new Promise((resolve, reject) => {
      const peer = this.ensurePeer();
      let done = false;
      const finish = () => {
        done = true;
        clearTimeout(timer);
        if (this.attempt === attempt) this.attempt = null;
      };
      const attempt = {
        fail: (msg, code) => {
          if (done) return;
          finish();
          this.drop();
          reject(Object.assign(new Error(msg), { code }));
        },
        dial: () => {
          if (done || this.conn) return;
          const conn = peer.connect(PREFIX + pin, { reliable: true, serialization: 'json' });
          this.conn = conn;
          conn.on('open', () => {
            if (done || this.conn !== conn) return;
            finish();
            this.linked = true;
            resolve();
          });
          conn.on('data', (msg) => { if (this.conn === conn) this.onMessage(msg); });
          conn.on('close', () => this.lost(conn));
          conn.on('error', () => this.lost(conn));
        },
      };
      const timer = setTimeout(() => {
        const brokerOk = peer.open;
        attempt.fail(brokerOk ? NO_LINK : NO_BROKER);
        // Stuck reaching the broker: start over with a fresh registration next time.
        if (!brokerOk && this.peer === peer) { this.peer = null; peer.destroy(); }
      }, CONNECT_TIMEOUT);
      this.attempt = attempt;
      if (peer.open) attempt.dial();
    });
  }

  lost(conn) {
    if (!conn || conn !== this.conn || !this.linked) return;
    this.linked = false;
    this.onClose('Connection to host lost');
  }

  send(msg) {
    if (this.conn && this.conn.open) this.conn.send(msg);
  }

  // End the link to the host (dead, or replaced); keep the broker registration.
  drop() {
    const c = this.conn;
    this.conn = null;
    this.linked = false;
    if (c) c.close();
  }

  close() {
    if (this.attempt) this.attempt.fail('Closed');
    this.drop();
    if (this.peer) {
      const p = this.peer;
      this.peer = null;
      p.destroy();
    }
  }
}

function friendlyError(err) {
  switch (err.type) {
    case 'browser-incompatible': return 'This browser does not support WebRTC.';
    case 'network':
    case 'server-error':
    case 'socket-error':
    case 'socket-closed': return 'Could not reach the matchmaking server (0.peerjs.com). Check your internet connection, or turn off an ad blocker / VPN.';
    case 'unavailable-id': return 'That PIN is still in use. Try again in a minute.';
    default: return `Connection error (${err.type || err.message || 'unknown'})`;
  }
}

// ---- BroadcastChannel (local testing) ------------------------------------

class LocalHost {
  constructor() {
    this.clients = new Set();
    this.onJoin = () => {};
    this.onLeave = () => {};
    this.onMessage = () => {};
    this.onStatus = () => {};
  }

  start(wantPin) {
    this.pin = wantPin || randomPin();
    this.ch = new BroadcastChannel(PREFIX + this.pin);
    this.ch.onmessage = ({ data }) => {
      if (data.to !== 'host') return;
      if (data.kind === 'connect') {
        this.clients.add(data.from);
        this.ch.postMessage({ to: data.from, kind: 'accept' });
        this.onJoin(data.from);
      } else if (data.kind === 'leave') {
        if (this.clients.delete(data.from)) this.onLeave(data.from);
      } else if (data.kind === 'msg' && this.clients.has(data.from)) {
        this.onMessage(data.from, data.msg);
      }
    };
    // Simulates the WebRTC links dropping when the tab goes away.
    window.addEventListener('pagehide', () => this.close());
    return Promise.resolve(this.pin);
  }

  send(id, msg) { if (this.ch) this.ch.postMessage({ to: id, kind: 'msg', msg }); }

  drop(id, delay = 300) {
    setTimeout(() => {
      if (!this.clients.delete(id)) return;
      if (this.ch) this.ch.postMessage({ to: id, kind: 'host-gone' });
      this.onLeave(id);
    }, delay);
  }

  close() {
    if (!this.ch) return;
    this.ch.postMessage({ to: '*', kind: 'host-gone' });
    this.ch.close();
    this.ch = null;
  }
}

class LocalClient {
  constructor() {
    this.onMessage = () => {};
    this.onClose = () => {};
    window.addEventListener('pagehide', () => this.close());
  }

  connect(pin) {
    this.close();
    const id = randomId(8);
    this.id = id;
    return new Promise((resolve, reject) => {
      const ch = new BroadcastChannel(PREFIX + pin);
      this.ch = ch;
      let open = false;
      const timer = setTimeout(() => { this.close(); reject(Object.assign(new Error('No game found with that PIN.'), { code: 'no-host' })); }, 2000);
      ch.onmessage = ({ data }) => {
        if (data.to !== id && data.to !== '*') return;
        if (data.kind === 'accept') { clearTimeout(timer); open = true; resolve(); }
        else if (data.kind === 'msg') this.onMessage(data.msg);
        else if (data.kind === 'host-gone' && open) {
          open = false;
          this.close(false);
          this.onClose('Connection to host lost');
        }
      };
      ch.postMessage({ to: 'host', from: id, kind: 'connect' });
    });
  }

  send(msg) { if (this.ch) this.ch.postMessage({ to: 'host', from: this.id, kind: 'msg', msg }); }

  drop() { this.close(); }

  close(announce = true) {
    if (!this.ch) return;
    if (announce) this.ch.postMessage({ to: 'host', from: this.id, kind: 'leave' });
    this.ch.close();
    this.ch = null;
  }
}

// (No `location` in Node, where the tests import this file.)
const useLocal = typeof location !== 'undefined' && new URLSearchParams(location.search).has('local');
export const isLocalMode = useLocal;
export const createHostNet = () => (useLocal ? new LocalHost() : new PeerHost());
export const createClientNet = () => (useLocal ? new LocalClient() : new PeerClient());
