// Bots: turns, jump-ins and Contre-UNO calls (shared by the host and /sandbox).
// Run with: npm test
import test from 'node:test';
import assert from 'node:assert/strict';
import { createLobby, startGame, topCard } from '../js/game.js';
import { autoTurn, BotReflexes, JUMP_MS, CATCH_MS } from '../js/bots.js';
import { rng } from './helpers.mjs';

function game(players = 3, rules = {}) {
  const s = createLobby(rules);
  for (let i = 0; i < players; i++) s.players.push({ id: `p${i}`, name: `P${i}`, seat: -1, connected: true });
  startGame(s, rng(5));
  return s;
}

test('autoTurn: moves only on its own turn, and always moves', () => {
  const s = game();
  const other = (s.turn + 1) % 3;
  assert.equal(autoTurn(s, other), false);
  for (let i = 0; i < 200 && s.phase === 'playing'; i++) assert.equal(autoTurn(s, s.turn, { forgetful: true, rng: rng(i) }), true);
});

test('reflexes: a bot calls Contre-UNO on someone who forgot UNO', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const s = game();
  let changed = 0;
  const r = new BotReflexes({ state: () => s, isBot: (seat) => seat !== 0, changed: () => { changed += 1; }, rng: () => 0 });
  s.hands[0] = s.hands[0].slice(0, 1);
  s.exposed[0] = true;
  r.update();
  t.mock.timers.tick(CATCH_MS[0] + 1);
  assert.equal(changed, 1);
  assert.equal(s.hands[0].length, 3);
  assert.ok(!s.exposed[0]);
});

test('reflexes: a bot holding the same card jumps in', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const s = game(3, { jumpIn: true });
  const top = topCard(s);
  const bot = (s.turn + 1) % 3;
  s.hands[bot].push({ id: 500, c: top.c, v: top.v });
  let changed = 0;
  const r = new BotReflexes({ state: () => s, isBot: (seat) => seat === bot, changed: () => { changed += 1; }, rng: () => 0 });
  r.update();
  t.mock.timers.tick(JUMP_MS[0] + 1);
  assert.equal(changed, 1);
  assert.deepEqual([topCard(s).c, topCard(s).v], [top.c, top.v]); // that card, or its twin
  assert.equal(s.by, bot);
  assert.equal(s.turn, (bot + 1) % 3, 'play goes on from the bot');
});

test('reflexes: nothing while paused, and stop() cancels a plan', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const s = game();
  let active = false;
  let changed = 0;
  const r = new BotReflexes({ state: () => s, isBot: () => true, active: () => active, changed: () => { changed += 1; }, rng: () => 0 });
  s.exposed[0] = true;
  r.update();
  t.mock.timers.tick(CATCH_MS[1] + 1);
  assert.equal(changed, 0, 'paused');
  active = true;
  r.update();
  r.stop();
  t.mock.timers.tick(CATCH_MS[1] + 1);
  assert.equal(changed, 0, 'stopped');
});
