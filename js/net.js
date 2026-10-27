// Transport layer. The host's browser is the authoritative game server;
// everyone else connects to it peer-to-peer.
//
// - PeerNet: WebRTC via PeerJS (public broker is only used for signaling).
//   The host registers the peer id `uno-p2p-v1-<PIN>` (or `uno-p2p-v1-itc1`
//   for the private rooms, see room.js).
// - LocalNet: BroadcastChannel between tabs of the same browser, enabled with
//   ?local=1. Same message flow, no internet needed (handy for testing).
//
// Clients call connect() again after a drop to reconnect; a host that comes
// back calls start(pin) to reclaim its old PIN. A missing host rejects with
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
  sdpSemantics: 'unified-plan',
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

class PeerClient {
  constructor() {
    this.onMessage = () => {};
    this.onClose = () => {};
  }

  // Can be called repeatedly: every attempt uses a fresh Peer.
  connect(pin) {
    this.dispose();
    return new Promise((resolve, reject) => {
      const peer = new window.Peer({ debug: 0, config: ICE });
      this.peer = peer;
      let open = false;
      let settled = false;
      const fail = (msg, code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        peer.destroy();
        reject(Object.assign(new Error(msg), { code }));
      };
      const lost = () => {
        if (!open || this.peer !== peer) return;
        open = false;
        this.onClose('Connection to host lost');
      };
      const timer = setTimeout(() => fail(open ? 'Connection to host lost' : peer.open
        ? 'Found the game but could not connect to the host. One of you may be on a network that blocks direct connections; try mobile data or another Wi-Fi.'
        : 'Could not reach the matchmaking server (0.peerjs.com). Check your internet connection, or disable an ad blocker / VPN.'), CONNECT_TIMEOUT);
      peer.on('error', (err) => {
        if (settled) { if (err.type === 'peer-unavailable') lost(); return; }
        if (err.type === 'peer-unavailable') fail('No game found with that PIN. Check it, and that the host still has the game open.', 'no-host');
        else fail(friendlyError(err));
      });
      peer.on('open', () => {
        const conn = peer.connect(PREFIX + pin, { reliable: true, serialization: 'json' });
        this.conn = conn;
        conn.on('open', () => {
          if (settled) return;
          settled = true;
          open = true;
          clearTimeout(timer);
          resolve();
        });
        conn.on('data', (msg) => this.onMessage(msg));
        conn.on('close', lost);
        conn.on('error', lost);
      });
    });
  }

  send(msg) {
    if (this.conn && this.conn.open) this.conn.send(msg);
  }

  dispose() {
    if (this.peer) {
      const p = this.peer;
      this.peer = null;
      this.conn = null;
      p.destroy();
    }
  }

  close() { this.dispose(); }
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

  close(announce = true) {
    if (!this.ch) return;
    if (announce) this.ch.postMessage({ to: 'host', from: this.id, kind: 'leave' });
    this.ch.close();
    this.ch = null;
  }
}

const useLocal = new URLSearchParams(location.search).has('local');
export const isLocalMode = useLocal;
export const createHostNet = () => (useLocal ? new LocalHost() : new PeerHost());
export const createClientNet = () => (useLocal ? new LocalClient() : new PeerClient());
