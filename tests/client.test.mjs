// A player's side: the handshake, reconnecting, and what it ignores.
// Run with: npm test
import test from 'node:test';
import assert from 'node:assert/strict';
import { FakeClientNet, fakeUI, flush } from './helpers.mjs';
import { Client } from '../js/client.js';
import { PROTOCOL, VERSION_REASON, RETRY_MS } from '../js/protocol.js';

const NOW = 1_700_000_000_000;
const view = (phase, extra = {}) => ({
  phase, round: 1, players: [], hand: [], discard: [], events: [], rules: {}, counts: {}, ...extra,
});

function setup(t) {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: NOW });
  sessionStorage.clear();
  const net = new FakeClientNet();
  const ui = fakeUI();
  const c = new Client({ name: 'Ana', ui, net });
  t.after(() => c.close());
  return { c, net, ui };
}

// Join a normal game (6-digit PIN): the host welcomes us.
async function joined(t) {
  const x = setup(t);
  const p = x.c.join('123456');
  await flush();
  assert.equal(x.net.sent[0].t, 'hello');
  assert.equal(x.net.sent[0].v, PROTOCOL);
  x.net.hostSays({ t: 'welcome', v: PROTOCOL, pid: 'p1', pin: '123456' });
  await p;
  return x;
}

test('client: joins, shows states, and nothing at all after leaving', async (t) => {
  const { c, net, ui } = await joined(t);
  assert.equal(c.me, 'p1');
  net.hostSays({ t: 'state', s: view('lobby'), turnMs: 0, now: NOW });
  assert.equal(ui.renders, 1);
  c.close();
  net.hostSays({ t: 'state', s: view('playing'), turnMs: 0, now: NOW });
  net.hostSays({ t: 'toast', text: 'hi' });
  assert.equal(ui.renders, 1);
  assert.deepEqual(ui.toasts, []);
  assert.ok(net.closed);
});

test('client: a host page from before this version is spotted', async (t) => {
  const { c, net } = setup(t);
  const p = c.join('123456');
  await flush();
  net.hostSays({ t: 'welcome', pid: 'p1', pin: '123456' }); // no version: an old host
  await assert.rejects(p, (err) => err.fromHost && /host's page is out of date/.test(err.message));
  assert.ok(c.closed);
});

test('client: told by a newer host that this page is out of date', async (t) => {
  const { c, net } = setup(t);
  const p = c.join('123456');
  await flush();
  net.hostSays({ t: 'reject', code: 'version', v: PROTOCOL + 1, reason: VERSION_REASON });
  await assert.rejects(p, (err) => err.fromHost && err.message === VERSION_REASON);
  assert.ok(c.closed);
});

test('client: keeps waiting for the host after a round ends', async (t) => {
  const { c, net, ui } = await joined(t);
  net.hostSays({ t: 'state', s: view('ended'), turnMs: 0, now: NOW });
  net.onClose('Connection to host lost');
  assert.deepEqual(ui.away, [true]);
  assert.deepEqual(ui.gone, []);
  t.mock.timers.tick(RETRY_MS);
  await flush();
  assert.equal(net.connects, 2, 'trying again');
  net.hostSays({ t: 'welcome', v: PROTOCOL, pid: 'p1', pin: '123456' });
  await flush();
  assert.deepEqual(ui.away, [true, false]);
  assert.ok(c.online);
});

test('client: in a first-round lobby, a lost host means game over', async (t) => {
  const { net, ui } = await joined(t);
  net.hostSays({ t: 'state', s: view('lobby', { round: 0 }), turnMs: 0, now: NOW });
  net.onClose('Connection to host lost');
  assert.deepEqual(ui.gone, ['Connection to the host was lost']);
  assert.deepEqual(ui.away, []);
});

test('client: a late timer from an earlier attempt does not fail a newer one', async (t) => {
  // Private room: the server confirms the host. Fetch is ours to answer.
  t.mock.method(globalThis, 'fetch', async () => ({ ok: true, json: async () => ({ ok: true }) }));
  const { c, net, ui } = setup(t);
  const first = c.join('itc1');
  await flush();
  net.hostSays({ t: 'welcome', v: PROTOCOL, pid: 'p1', pin: 'itc1', proof: 'x' });
  await first;
  net.hostSays({ t: 'state', s: view('playing'), turnMs: 0, now: NOW });

  // The host drops; an unverified answer (maybe an impostor) fails attempt A.
  net.onClose('lost');
  t.mock.timers.tick(RETRY_MS);
  await flush();
  net.hostSays({ t: 'reject', reason: 'nope' });
  await flush();
  assert.ok(!c.closed, 'only that attempt failed');
  // Attempt B starts 3 s later; A's 8 s timer runs out during B.
  t.mock.timers.tick(RETRY_MS);
  await flush();
  assert.equal(net.connects, 3);
  t.mock.timers.tick(6000);
  await flush();
  net.hostSays({ t: 'welcome', v: PROTOCOL, pid: 'p1', pin: 'itc1', proof: 'x' });
  await flush();
  assert.ok(c.online, 'attempt B went through');
  assert.equal(ui.away.at(-1), false);
});

test('client: leaving while the room check is running shows nothing', async (t) => {
  let answer;
  t.mock.method(globalThis, 'fetch', () => new Promise((r) => { answer = r; }));
  const { c, net, ui } = setup(t);
  const p = c.join('itc1');
  await flush();
  net.hostSays({ t: 'welcome', v: PROTOCOL, pid: 'p1', pin: 'itc1', proof: 'x' });
  net.hostSays({ t: 'state', s: view('lobby'), turnMs: 0, now: NOW }); // held until verified
  await flush();
  c.close();
  answer({ ok: true, json: async () => ({ ok: true }) });
  await assert.rejects(p, /Closed/);
  assert.equal(ui.renders, 0);
});
