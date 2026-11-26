// The host: what it accepts from players, and what it does on its own.
// Run with: npm test
import test from 'node:test';
import assert from 'node:assert/strict';
import { FakeHostNet, fakeUI, rng, secret, flush } from './helpers.mjs';
import { Host } from '../js/host.js';
import { PROTOCOL, VERSION_REASON } from '../js/protocol.js';
import { play } from '../js/game.js';

const NOW = 1_700_000_000_000;

async function hosted(t, opts = {}) {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: NOW });
  localStorage.clear();
  const net = new FakeHostNet();
  const ui = fakeUI();
  const h = new Host({ name: 'Hosty', ui, net, rng: rng(3), ...opts });
  await h.start();
  return { h, net, ui };
}

// Let time pass while these players stay connected (they ping, like real ones).
function wait(t, net, cids, ms) {
  for (let left = ms; left > 0; left -= 2000) {
    t.mock.timers.tick(Math.min(2000, left));
    for (const cid of cids) net.say(cid, { t: 'ping' });
  }
}

const hello = (net, cid, name, n, extra = {}) => {
  net.open(cid);
  net.say(cid, { t: 'hello', v: PROTOCOL, name, secret: secret(n), ...extra });
};

// A round the host wins right away: their last card matches.
function hostWins(h) {
  const s = h.state;
  const seat = h.mySeat();
  const card = s.deck.find((c) => c.c === s.color && /^\d$/.test(c.v));
  s.deck = s.deck.filter((c) => c !== card);
  s.hands[seat] = [card];
  s.turn = seat;
  s.drawn = null;
  s.pending = 0;
  h.sendPlay([card.id]);
  assert.equal(s.phase, 'ended');
}

test('host: after Leave, no timer or message brings the game back', async (t) => {
  const { h, net, ui } = await hosted(t);
  hello(net, 'c1', 'Ana', 1);
  h.addBot();
  h.begin();
  assert.ok(localStorage.getItem('uno.host'), 'game saved while playing');
  const s = h.state;
  s.turn = s.players.find((p) => p.id === 'p1').seat; // Ana's turn
  s.turnId += 1;
  h.publish();
  const renders = ui.renders;
  h.end();
  net.say('c1', { t: 'draw' }); // her move lands just after the host left
  assert.equal(localStorage.getItem('uno.host'), null);
  net.say('c1', { t: 'chat', text: 'still there?' });
  net.say('c1', { t: 'draw' });
  t.mock.timers.tick(60_000); // every turn, bot and AFK timer would have fired by now
  assert.equal(ui.renders, renders, 'nothing redrawn after leaving');
  assert.equal(localStorage.getItem('uno.host'), null, 'the ended game is not saved again');
  assert.ok(net.closed, 'transport closed after the goodbyes');
  assert.deepEqual(net.to('c1', 'end').map((m) => m.reason), ['The host ended the game']);
});

test('host: a room proof that arrives after Leave is ignored', async (t) => {
  let answer;
  t.mock.method(globalThis, 'fetch', () => new Promise((r) => { answer = r; }));
  localStorage.clear();
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: NOW });
  localStorage.setItem('uno.itc.ticket', `${NOW / 1000 + 3600}.sig`);
  const net = new FakeHostNet();
  const ui = fakeUI();
  const h = new Host({ name: 'Owner', ui, net, room: 'itc1', rng: rng(1) });
  await h.start();
  hello(net, 'c1', 'Ana', 1, { nonce: 'ab'.repeat(16) });
  const renders = ui.renders;
  h.end();
  answer({ ok: true, json: async () => ({ proof: 'p' }) });
  await flush();
  assert.equal(net.to('c1', 'welcome').length, 0);
  assert.equal(ui.renders, renders);
});

test('host: idle connections are dropped and cannot lock players out', async (t) => {
  const { h, net } = await hosted(t);
  // 16 connections that never say hello, only keep the link alive.
  const squatters = Array.from({ length: 16 }, (_, i) => `q${i}`);
  for (const q of squatters) net.open(q);
  // Only 8 may wait at once: the oldest made room.
  assert.match(net.to('q0', 'reject')[0].reason, /Too many/);
  assert.equal(h.waiting.size, 8);
  // A real player still gets in.
  hello(net, 'real', 'Ana', 1);
  assert.equal(net.to('real', 'welcome').length, 1);
  // Keep pinging past the hello deadline: the squatters go, the player stays.
  wait(t, net, [...squatters, 'real'], 14_000);
  assert.equal(h.waiting.size, 0);
  assert.equal(h.seen.size, 1);
  assert.ok(h.seen.has('real'));
  assert.ok(!net.dropped.includes('real'));
  assert.equal(h.state.players.length, 2);
});

test('host: a page from another version is asked to refresh', async (t) => {
  const { h, net } = await hosted(t);
  net.open('old');
  net.say('old', { t: 'hello', name: 'Old', secret: secret(9) }); // no version: before this protocol
  const [r] = net.to('old', 'reject');
  assert.equal(r.code, 'version');
  assert.equal(r.v, PROTOCOL);
  assert.equal(r.reason, VERSION_REASON);
  assert.equal(h.state.players.length, 1);
  assert.ok(net.dropped.includes('old'));
});

test('host: a removed player cannot come straight back', async (t) => {
  const { h, net } = await hosted(t);
  hello(net, 'c1', 'Bob', 1);
  hello(net, 'c2', 'bob', 2); // gets "bob 2"
  const [bob, bob2] = h.state.players.slice(1);
  assert.equal(bob2.name, 'bob 2');
  h.kick(bob2.id);
  assert.match(net.to('c2', 'reject')[0].reason, /removed/);
  // Same tab, any name: no.
  hello(net, 'c3', 'Robert', 2);
  assert.match(net.to('c3', 'reject')[0].reason, /removed/);
  // New tab under the name they had: no.
  hello(net, 'c4', 'BOB 2', 4);
  assert.match(net.to('c4', 'reject')[0].reason, /removed/);
  // The other Bob, who wasn't removed, can still join from another tab.
  hello(net, 'c5', 'Bob', 5);
  assert.equal(net.to('c5', 'welcome').length, 1);
  assert.equal(h.state.players.at(-1).name, 'Bob 2');
  // Someone else entirely: fine.
  hello(net, 'c6', 'Carla', 6);
  assert.equal(net.to('c6', 'welcome').length, 1);
  // Ten minutes later the name is free again (not the tab).
  wait(t, net, ['c1', 'c5', 'c6'], 11 * 60_000);
  hello(net, 'c7', 'bob 2', 7);
  assert.equal(net.to('c7', 'welcome').length, 1);
  hello(net, 'c8', 'Zed', 2);
  assert.match(net.to('c8', 'reject')[0].reason, /removed/);
  assert.ok(!h.state.players.some((p) => p.id === bob2.id));
  assert.ok(h.state.players.some((p) => p.id === bob.id), 'the first Bob was never affected');
});

test('host: look-alike names get a number', async (t) => {
  const { h, net } = await hosted(t);
  hello(net, 'c1', 'Bob', 1);
  hello(net, 'c2', 'Bob\u{E0041}\u{E0042}', 2);  // invisible tag characters
  hello(net, 'c3', 'Ｂｏｂ', 3);                // fullwidth
  hello(net, 'c4', '\u3164\u2800', 4);         // blank: becomes "Player"
  assert.deepEqual(h.state.players.map((p) => p.name), ['Hosty', 'Bob', 'Bob 2', 'Bob 3', 'Player']);
});

test('host: scores survive a host refresh between rounds', async (t) => {
  const { h, net } = await hosted(t);
  hello(net, 'a', 'Ana', 1);
  hello(net, 'b', 'Ben', 2);
  h.addBot();
  h.begin();
  hostWins(h);
  const total = h.state.totals.p0;
  assert.ok(total > 0);
  const saved = Host.loadSaved();
  assert.equal(saved && saved.state.phase, 'ended', 'kept after the round ends');

  // The host's tab reloads.
  h.close();
  const net2 = new FakeHostNet();
  const ui2 = fakeUI();
  const h2 = new Host({ name: 'Hosty', ui: ui2, net: net2, saved: Host.loadSaved(), rng: rng(4) });
  assert.equal(await h2.start(), '123456');
  assert.equal(ui2.last.phase, 'ended');
  assert.equal(ui2.last.totals.p0, total);
  // Ana finds her way back; Ben is slower.
  hello(net2, 'a2', 'Ana', 1);
  assert.equal(net2.to('a2', 'welcome')[0].pid, 'p1');
  h2.backToLobby();
  assert.deepEqual(h2.state.players.map((p) => [p.name, p.connected]), [['Hosty', true], ['Ana', true], ['Ben', false], ['Robo Rita', false]]);
  assert.equal(h2.state.totals.p0, total);
  assert.ok(Host.loadSaved(), 'the lobby between rounds is kept too');
  // Ben never comes back: after a minute his seat goes.
  wait(t, net2, ['a2'], 65_000);
  assert.deepEqual(h2.state.players.map((p) => p.name), ['Hosty', 'Ana', 'Robo Rita']);
  hello(net2, 'b2', 'Ben', 2); // later on he simply joins again
  assert.equal(h2.state.players.length, 4);
});

test('host: Contre-UNO and UNO calls do not restart the turn timer', async (t) => {
  const { h, net } = await hosted(t);
  hello(net, 'a', 'Ana', 1);
  hello(net, 'b', 'Ben', 2);
  h.begin();
  const s = h.state;
  const seatOf = (pid) => s.players.find((p) => p.id === pid).seat;
  // Make it Ana's turn, with Ben exposed (one card, no UNO).
  s.turn = seatOf('p1');
  s.turnId += 1;
  h.publish();
  const deadline = h.deadline;
  assert.ok(deadline > Date.now());
  wait(t, net, ['a', 'b'], 10_000);
  s.hands[seatOf('p2')] = s.hands[seatOf('p2')].slice(0, 1);
  s.exposed[seatOf('p2')] = true;
  h.sendCatch(seatOf('p2'));            // the host catches Ben
  assert.equal(s.hands[seatOf('p2')].length, 3);
  net.say('a', { t: 'uno' });           // Ana presses UNO (too many cards: nothing)
  net.say('a', { t: 'chat', text: 'hurry' });
  assert.equal(h.deadline, deadline, 'same deadline');
  wait(t, net, ['a', 'b'], 15_500);     // 25 s after her turn began
  assert.ok(s.players.find((p) => p.id === 'p1').afk, 'Ana timed out on schedule');
});

test('host: bots play by themselves, a new turn restarts the clock', async (t) => {
  const { h } = await hosted(t);
  h.addBot();
  h.addBot();
  h.begin();
  const s = h.state;
  // Hand the turn to a bot and let it think.
  const bot = s.players.find((p) => p.cpu);
  s.turn = bot.seat;
  s.turnId += 1;
  h.publish();
  const before = s.turnId;
  t.mock.timers.tick(1600);
  assert.ok(s.turnId > before || s.phase === 'ended', 'the bot moved');
});

test('host: junk and floods from a player change nothing', async (t) => {
  const { h, net } = await hosted(t);
  hello(net, 'a', 'Ana', 1);
  h.begin();
  const seq = h.state.seq;
  for (const msg of [null, 7, 'x', {}, { t: 5 }, { t: 'play', ids: [999] }, { t: 'play', ids: [1], color: 'pink' }, { t: 'catch', seat: 'x' }, { t: 'hello', v: PROTOCOL }]) {
    net.say('a', msg);
  }
  assert.equal(h.state.seq, seq);
  for (let i = 0; i < 100; i++) net.say('a', { t: 'chat', text: `spam ${i}` });
  assert.ok(h.chat.filter((e) => e.kind === 'chat').length <= 1, 'chat is throttled');
  // Moves from someone else's seat are refused.
  const hostSeat = h.mySeat();
  const s = h.state;
  s.turn = hostSeat;
  const card = s.hands[hostSeat][0];
  assert.throws(() => play(s, s.players.find((p) => p.id === 'p1').seat, [card.id]));
});
