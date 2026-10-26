// Run with: node --test tests/*.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildDeck, createLobby, startGame, play, draw, pass, callUno, catchUno, canStart, canJump, couldGoToOne,
  checkPlay, viewFor, autoMove, nextSeat, topCard, sortHand, points, gameTime, formatTime, DECK_SIZE, RULE_KEYS,
} from '../js/game.js';

// Seeded PRNG so failures are reproducible.
function rng(seed = 1) {
  let t = seed;
  return () => {
    t = (t + 0x6d2b79f5) | 0;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

let nextId = 1000;
const card = (c, v) => ({ id: nextId++, c, v });

function game(players = 3, rules = {}, seed = 7) {
  const s = createLobby(rules);
  for (let i = 0; i < players; i++) s.players.push({ id: `p${i}`, name: `P${i}`, seat: -1, connected: true });
  startGame(s, rng(seed));
  return s;
}

// Put the table in a known position: hands per seat, top card, whose turn.
function setup(s, { hands, top, turn = 0, deck = null }) {
  for (const [seat, cards] of Object.entries(hands)) s.hands[seat] = cards;
  s.discard = [top];
  s.color = top.c === 'w' ? top.w : top.c;
  s.turn = turn;
  s.by = -1;
  s.dir = 1;
  s.pending = 0;
  s.drawn = null;
  s.exposed = {};
  if (deck) s.deck = deck;
}

// Ids of every card object anywhere in a view.
function cardIds(obj, out = new Set()) {
  if (Array.isArray(obj)) obj.forEach((x) => cardIds(x, out));
  else if (obj && typeof obj === 'object') {
    if ('c' in obj && 'v' in obj) out.add(obj.id);
    Object.values(obj).forEach((x) => cardIds(x, out));
  }
  return out;
}

const allCards = (s) => [...s.deck, ...s.discard, ...Object.values(s.hands).flat()];

test('the deck has the standard 108 cards', () => {
  const deck = buildDeck();
  assert.equal(deck.length, DECK_SIZE);
  assert.equal(new Set(deck.map((c) => c.id)).size, DECK_SIZE);
  for (const c of ['r', 'y', 'g', 'b']) {
    const mine = deck.filter((x) => x.c === c);
    assert.equal(mine.length, 25);
    assert.equal(mine.filter((x) => x.v === '0').length, 1);
    assert.equal(mine.filter((x) => x.v === '7').length, 2);
    assert.equal(mine.filter((x) => x.v === 'd2').length, 2);
  }
  assert.equal(deck.filter((x) => x.v === 'wild').length, 4);
  assert.equal(deck.filter((x) => x.v === 'd4').length, 4);
});

test('deal: 7 cards each, opens on a number card, nothing lost', () => {
  for (let seed = 1; seed < 40; seed++) {
    const s = game(8, {}, seed);
    for (let seat = 0; seat < 8; seat++) assert.equal(s.hands[seat].length, 7);
    assert.match(topCard(s).v, /^[0-9]$/);
    assert.equal(s.color, topCard(s).c);
    assert.equal(allCards(s).length, DECK_SIZE);
    assert.equal(new Set(allCards(s).map((c) => c.id)).size, DECK_SIZE);
  }
});

test('2 to 8 players', () => {
  const s = createLobby();
  s.players.push({ id: 'a', name: 'A', seat: -1 });
  assert.throws(() => startGame(s), /at least 2/);
  for (let i = 0; i < 8; i++) s.players.push({ id: `p${i}`, name: `P${i}`, seat: -1 });
  assert.throws(() => startGame(s), /8 players max/);
});

test('match by color or value; wild always; turn moves on', () => {
  const s = game(3);
  const r5 = card('r', '5'), b5 = card('b', '5'), g7 = card('g', '7'), w = card('w', 'wild');
  setup(s, { hands: { 0: [r5, b5, g7, w], 1: [card('y', '1'), card('y', '2')], 2: [card('y', '3'), card('y', '4')] }, top: card('r', '9') });
  assert.ok(canStart(s, r5));
  assert.ok(!canStart(s, g7));
  assert.ok(canStart(s, w));
  assert.throws(() => play(s, 0, [g7.id]), /doesn't match/);
  assert.throws(() => play(s, 1, [s.hands[1][0].id]), /not your turn/);
  play(s, 0, [r5.id]);
  assert.equal(s.turn, 1);
  assert.equal(topCard(s).id, r5.id);
  s.turn = 0;
  play(s, 0, [b5.id]);
  assert.equal(s.color, 'b');
  s.turn = 0;
  assert.throws(() => play(s, 0, [w.id]), /Pick a color/);
  play(s, 0, [w.id], 'g');
  assert.equal(s.color, 'g');
  assert.equal(topCard(s).w, 'g');
});

test('skip, reverse, +2 and +4', () => {
  const s = game(4);
  const hands = { 0: [card('r', 'skip'), card('r', 'rev'), card('r', 'd2'), card('w', 'd4'), card('r', '1')], 1: [card('b', '1')], 2: [card('b', '2')], 3: [card('b', '3')] };
  setup(s, { hands, top: card('r', '9') });
  play(s, 0, [hands[0][0].id]);
  assert.equal(s.turn, 2, 'skip jumps over seat 1');

  s.turn = 0;
  play(s, 0, [hands[0][1].id]);
  assert.equal(s.dir, -1);
  assert.equal(s.turn, 3, 'reverse goes the other way');

  s.turn = 0;
  s.dir = 1;
  play(s, 0, [hands[0][2].id]);
  assert.equal(s.hands[1].length, 3, 'seat 1 draws 2');
  assert.equal(s.turn, 2, 'and is skipped');

  s.turn = 0;
  play(s, 0, [hands[0][3].id], 'y');
  assert.equal(s.hands[1].length, 7, 'seat 1 draws 4 more');
  assert.equal(s.turn, 2);
  assert.equal(s.color, 'y');
});

test('two players: reverse and skip give another turn', () => {
  const s = game(2);
  const rev = card('r', 'rev'), skip = card('r', 'skip');
  setup(s, { hands: { 0: [rev, skip, card('g', '1')], 1: [card('b', '1'), card('b', '2')] }, top: card('r', '9') });
  play(s, 0, [rev.id]);
  assert.equal(s.turn, 0);
  play(s, 0, [skip.id]);
  assert.equal(s.turn, 0);
});

test('draw: a playable card may be played right away or kept', () => {
  const s = game(3);
  const keep = card('b', '1');
  const drawn = card('r', '3');
  setup(s, { hands: { 0: [keep, card('r', '7')], 1: [card('g', '1')], 2: [card('g', '2')] }, top: card('r', '9'), deck: [...s.deck, drawn] });
  draw(s, 0);
  assert.equal(s.drawn, drawn.id);
  assert.equal(s.turn, 0);
  assert.throws(() => play(s, 0, [s.hands[0][1].id]), /just drew/, 'only the drawn card');
  assert.throws(() => draw(s, 0), /Play the card you drew/);
  pass(s, 0);
  assert.equal(s.turn, 1);
  assert.equal(s.hands[0].length, 3);

  // Unplayable draw: the turn passes by itself.
  s.turn = 0;
  s.deck.push(card('y', '8'));
  draw(s, 0);
  assert.equal(s.drawn, null);
  assert.equal(s.turn, 1);
});

test('+2 combo: stack +2 on +2, the next player draws the total', () => {
  const s = game(3, { stack: true });
  const a = card('r', 'd2'), b = card('b', 'd2');
  setup(s, { hands: { 0: [a, card('r', '1')], 1: [b, card('g', '5'), card('w', 'd4')], 2: [card('y', '1')] }, top: card('r', '9') });
  play(s, 0, [a.id]);
  assert.equal(s.pending, 2);
  assert.equal(s.turn, 1);
  assert.ok(!canStart(s, s.hands[1][1]), 'only a +2 while a stack is pending');
  assert.ok(!canStart(s, s.hands[1][2]), 'a +4 does not stack');
  play(s, 1, [b.id]);
  assert.equal(s.pending, 4);
  assert.equal(s.turn, 2);
  draw(s, 2);
  assert.equal(s.hands[2].length, 5);
  assert.equal(s.pending, 0);
  assert.equal(s.turn, 0, 'drawing the stack ends the turn');
});

test('without +2 combo a +2 cannot be answered', () => {
  const s = game(3);
  const a = card('r', 'd2'), b = card('b', 'd2');
  setup(s, { hands: { 0: [a, card('r', '1')], 1: [b, card('g', '5')], 2: [card('y', '1')] }, top: card('r', '9') });
  play(s, 0, [a.id]);
  assert.equal(s.pending, 0);
  assert.equal(s.hands[1].length, 4);
  assert.equal(s.turn, 2);
});

test('saute mouton (jump-in): same color and value, out of turn', () => {
  const s = game(4, { jumpIn: true });
  const r7 = card('r', '7'), r7b = card('r', '7'), b7 = card('b', '7');
  setup(s, { hands: { 0: [r7, card('g', '1')], 1: [card('y', '1')], 2: [r7b, b7, card('g', '2')], 3: [card('y', '2')] }, top: card('r', '3') });
  play(s, 0, [r7.id]);
  assert.equal(s.turn, 1);
  assert.ok(!canJump(s, 2, b7), 'same number, other color: no');
  assert.ok(canJump(s, 2, r7b));
  assert.ok(!canJump(s, 0, card('r', '7')), 'not on your own card');
  play(s, 2, [r7b.id]);
  assert.equal(s.by, 2);
  assert.equal(s.turn, 3, 'play continues from the jumper');
  assert.equal(s.stats[2].jumps, 1);
  assert.equal(s.events.at(-1).kind, 'play');
  assert.equal(s.events.at(-1).jump, true);
});

test('jump-in is off unless enabled; wilds never jump in', () => {
  const s = game(3);
  const r7 = card('r', '7'), r7b = card('r', '7');
  setup(s, { hands: { 0: [r7, card('g', '1')], 1: [card('y', '1')], 2: [r7b, card('g', '2')] }, top: card('r', '3') });
  play(s, 0, [r7.id]);
  assert.throws(() => play(s, 2, [r7b.id]), /not your turn/);

  const t = game(3, { jumpIn: true });
  const w1 = card('w', 'wild'), w2 = card('w', 'wild');
  setup(t, { hands: { 0: [w1, card('g', '1')], 1: [card('y', '1')], 2: [w2, card('g', '2')] }, top: card('r', '3') });
  play(t, 0, [w1.id], 'b');
  assert.ok(!canJump(t, 2, w2));
});

test('jump-in on a stacked +2 passes the penalty on', () => {
  const s = game(4, { jumpIn: true, stack: true });
  const a = card('r', 'd2'), b = card('r', 'd2');
  setup(s, { hands: { 0: [a, card('g', '1')], 1: [card('y', '1')], 2: [b, card('g', '2')], 3: [card('y', '2')] }, top: card('r', '3') });
  play(s, 0, [a.id]);
  assert.equal(s.turn, 1);
  play(s, 2, [b.id]); // cuts in front of seat 1
  assert.equal(s.pending, 4);
  assert.equal(s.turn, 3);
  assert.equal(s.hands[1].length, 1, 'seat 1 escaped');
});

test('jump-in with skip and reverse acts from the jumper', () => {
  const s = game(5, { jumpIn: true });
  const a = card('g', 'skip'), b = card('g', 'skip');
  const filler = (n) => [card('y', String(n)), card('y', String(n + 1))];
  setup(s, { hands: { 0: [a, ...filler(1)], 1: filler(2), 2: filler(3), 3: [b, ...filler(4)], 4: filler(5) }, top: card('g', '3') });
  play(s, 0, [a.id]); // skips 1, turn 2
  assert.equal(s.turn, 2);
  play(s, 3, [b.id]); // jumps in: skips 4, turn 0
  assert.equal(s.turn, 0);
});

test('saute mouton (doubles): same number together on your turn', () => {
  const s = game(3, { multi: true });
  const r7 = card('r', '7'), b7 = card('b', '7'), g7 = card('g', '7'), b3 = card('b', '3');
  setup(s, { hands: { 0: [r7, b7, g7, b3, card('y', '1')], 1: [card('y', '2')], 2: [card('y', '3')] }, top: card('r', '2') });
  assert.throws(() => play(s, 0, [b7.id, r7.id]), /doesn't match/, 'the first card must match');
  assert.throws(() => play(s, 0, [r7.id, b3.id]), /same number/);
  play(s, 0, [r7.id, g7.id, b7.id]);
  assert.equal(s.hands[0].length, 2);
  assert.equal(s.color, 'b', 'the last card sets the color');
  assert.equal(s.turn, 1);
  assert.equal(s.stats[0].played, 3);
});

test('doubles: off by default, not out of turn, numbers only', () => {
  const s = game(3);
  const r7 = card('r', '7'), b7 = card('b', '7');
  setup(s, { hands: { 0: [r7, b7, card('y', '1')], 1: [card('y', '2')], 2: [card('y', '3')] }, top: card('r', '2') });
  assert.throws(() => play(s, 0, [r7.id, b7.id]), /One card at a time/);

  const t = game(3, { multi: true, jumpIn: true });
  const s1 = card('r', 'skip'), s2 = card('b', 'skip');
  const x7 = card('r', '7'), y7 = card('r', '7'), z7 = card('b', '7');
  setup(t, { hands: { 0: [s1, s2, x7, card('y', '1')], 1: [card('y', '2')], 2: [y7, z7, card('y', '3')] }, top: card('r', '2') });
  assert.throws(() => play(t, 0, [s1.id, s2.id]), /same number/);
  play(t, 0, [x7.id]);
  assert.throws(() => play(t, 2, [y7.id, z7.id]), /no longer matches/, 'jump-in is one card');
});

test('both saute mouton rules together', () => {
  const s = game(4, { multi: true, jumpIn: true });
  const r5 = card('r', '5'), g5 = card('g', '5'), g5b = card('g', '5');
  setup(s, { hands: { 0: [r5, g5, card('y', '1')], 1: [card('y', '2')], 2: [card('y', '3')], 3: [g5b, card('y', '4')] }, top: card('r', '2') });
  play(s, 0, [r5.id, g5.id]);
  assert.equal(s.turn, 1);
  assert.ok(canJump(s, 3, g5b));
  play(s, 3, [g5b.id]);
  assert.equal(s.turn, 0);
});

test('UNO: say it before the play that leaves one card', () => {
  const s = game(3);
  const a = card('r', '1'), b = card('r', '2');
  setup(s, { hands: { 0: [a, b], 1: [card('r', '3'), card('y', '3'), card('y', '4')], 2: [card('g', '1'), card('g', '2')] }, top: card('r', '9') });
  assert.ok(couldGoToOne(s, 0, s.hands[0]));
  assert.ok(callUno(s, 0));
  assert.ok(!callUno(s, 0), 'once is enough');
  play(s, 0, [a.id]);
  assert.equal(s.hands[0].length, 1);
  assert.equal(s.uno[0], true);
  assert.equal(s.events.at(-1).kind, 'uno');
  assert.equal(s.armed[0], false);
});

test('UNO forgotten: no penalty until someone catches it (Contre-UNO)', () => {
  const s = game(3);
  const a = card('r', '1'), b = card('r', '2');
  setup(s, { hands: { 0: [a, b], 1: [card('r', '3'), card('y', '3'), card('y', '4')], 2: [card('g', '1'), card('g', '2')] }, top: card('r', '9') });
  play(s, 0, [a.id]);
  assert.equal(s.hands[0].length, 1, 'no automatic penalty');
  assert.equal(s.exposed[0], true);
  assert.ok(!callUno(s, 0), 'saying it now is too late');
  // Still catchable after other players have played.
  play(s, 1, [s.hands[1][0].id]);
  assert.equal(s.exposed[0], true);
  assert.throws(() => catchUno(s, 0, 0), /Nobody to catch/, "can't catch yourself");
  assert.throws(() => catchUno(s, 1, 2), /Nobody to catch/, 'only exposed players');
  catchUno(s, 2, 0);
  assert.equal(s.hands[0].length, 3);
  assert.ok(!s.exposed[0]);
  assert.equal(s.stats[0].caught, 1);
  assert.equal(s.events.at(-2).kind, 'catch');
  assert.throws(() => catchUno(s, 1, 0), /Nobody to catch/, 'only once');
});

test('UNO forgotten: the exposure ends when you hold more cards, or win', () => {
  const s = game(2);
  const a = card('r', '1');
  setup(s, { hands: { 0: [a, card('g', '5')], 1: [card('b', '1'), card('y', '2')] }, top: card('r', '9'), deck: [...s.deck, card('y', '8')] });
  play(s, 0, [a.id]);
  assert.equal(s.exposed[0], true);
  s.turn = 0;
  draw(s, 0); // a yellow 8: not playable on red
  assert.ok(!s.exposed[0], 'two cards again: nothing to catch');

  const t = game(2);
  const last = card('r', '1');
  setup(t, { hands: { 0: [card('r', '5'), last], 1: [card('b', '1'), card('y', '2')] }, top: card('r', '9') });
  play(t, 0, [t.hands[0][0].id]);
  t.turn = 0;
  play(t, 0, [last.id]);
  assert.equal(t.phase, 'ended', 'an exposed player can still go out');
  assert.deepEqual(t.exposed, {});
});

test('UNO: needed for doubles and jump-ins too; an unused call expires', () => {
  const s = game(3, { multi: true, jumpIn: true });
  const r7 = card('r', '7'), b7 = card('b', '7'), g1 = card('g', '1');
  setup(s, { hands: { 0: [r7, b7, g1], 1: [card('y', '1'), card('y', '2')], 2: [card('g', '5'), card('g', '6')] }, top: card('r', '2') });
  assert.ok(couldGoToOne(s, 0, s.hands[0]), '3 cards, doubles leave one');
  callUno(s, 0);
  play(s, 0, [r7.id, b7.id]);
  assert.equal(s.hands[0].length, 1);
  assert.equal(s.uno[0], true);

  // Seat 2 holds the same blue 7 with one other card: a jump-in leaves one.
  const t = game(3, { jumpIn: true });
  const x = card('b', '7'), y = card('b', '7');
  setup(t, { hands: { 0: [x, card('g', '1'), card('g', '3')], 1: [card('y', '1'), card('y', '2')], 2: [y, card('g', '2')] }, top: card('b', '2') });
  play(t, 0, [x.id]);
  assert.ok(couldGoToOne(t, 2, t.hands[2]));
  play(t, 2, [y.id]);
  assert.equal(t.exposed[2], true, 'a jump-in to one card needs UNO too');

  // Saying UNO and then drawing instead: the call is gone.
  const u = game(2);
  setup(u, { hands: { 0: [card('b', '1'), card('b', '2')], 1: [card('g', '1'), card('g', '2')] }, top: card('r', '9'), deck: [...u.deck, card('y', '5')] });
  callUno(u, 0);
  draw(u, 0);
  assert.equal(u.armed[0], false);
});

test('round end: points, ranks, totals; a final +2 still counts', () => {
  const s = game(3);
  const last = card('r', 'd2');
  setup(s, {
    hands: { 0: [last], 1: [card('w', 'wild'), card('b', '9')], 2: [card('g', 'skip')] },
    top: card('r', '9'),
  });
  s.uno[0] = true;
  play(s, 0, [last.id]);
  assert.equal(s.phase, 'ended');
  assert.equal(s.winner, 0);
  assert.equal(s.hands[1].length, 4, 'next player drew 2 first');
  const p1 = s.hands[1].reduce((n, c) => n + points(c), 0);
  assert.equal(s.scores[1], p1);
  assert.equal(s.scores[2], 20);
  assert.equal(s.roundPoints, p1 + 20);
  assert.equal(s.totals.p0, p1 + 20);
  assert.deepEqual(s.ranks, [0, 2, 1]);
});

test('final +2 with the combo rule: the victim draws the whole stack', () => {
  const s = game(3, { stack: true });
  const last = card('r', 'd2');
  setup(s, { hands: { 0: [last], 1: [card('b', '9')], 2: [card('g', '1')] }, top: card('r', 'd2') });
  s.pending = 4;
  play(s, 0, [last.id]);
  assert.equal(s.phase, 'ended');
  assert.equal(s.hands[1].length, 7);
});

test('empty draw pile: the discards are reshuffled under the top card', () => {
  const s = game(2);
  const top = card('r', '9');
  const old = [card('b', '1'), card('w', 'wild')];
  old[1].w = 'b';
  setup(s, { hands: { 0: [card('g', '3'), card('g', '4')], 1: [card('y', '1')] }, top, deck: [] });
  s.discard = [...old, top];
  draw(s, 0);
  assert.equal(topCard(s).id, top.id);
  assert.equal(s.discard.length, 1);
  assert.equal(s.hands[0].length, 3);
  assert.ok(s.events.some((e) => e.kind === 'shuffle'));
  assert.ok(allCards(s).every((c) => c.w === undefined || c.id === top.id), 'wild colors are reset');

  // Nothing left anywhere: drawing just passes.
  s.turn = 0;
  s.drawn = null;
  s.deck = [];
  s.discard = [top];
  draw(s, 0);
  assert.equal(s.turn, 1);
});

test('views: your hand only, no draw pile, others see draw counts not cards', () => {
  const s = game(3);
  const v = viewFor(s, 1);
  assert.deepEqual(v.hand.map((c) => c.id), s.hands[1].map((c) => c.id));
  assert.equal(v.hands, null);
  assert.equal(v.deck, undefined);
  assert.equal(v.deckCount, s.deck.length);
  assert.deepEqual(v.counts, { 0: 7, 1: 7, 2: 7 });
  const seen = cardIds(v);
  for (const seat of [0, 2]) for (const c of s.hands[seat]) assert.ok(!seen.has(c.id), `card ${c.id} of seat ${seat} leaked`);
  for (const c of s.deck) assert.ok(!seen.has(c.id), `deck card ${c.id} leaked`);

  s.turn = 0;
  s.drawn = null;
  s.discard = [card('r', '9')];
  s.color = 'r';
  s.deck.push(card('g', '1'));
  draw(s, 0);
  const mine = viewFor(s, 0).events.at(-1);
  const theirs = viewFor(s, 2).events.at(-1);
  assert.equal(mine.cards.length, 1);
  assert.equal(theirs.cards, undefined);
  assert.equal(theirs.n, 1);
  assert.equal(viewFor(s, 2).armed, false);
});

test('views: every hand is revealed when the round ends', () => {
  const s = game(2);
  const last = card('r', '1');
  setup(s, { hands: { 0: [last], 1: [card('b', '2')] }, top: card('r', '9') });
  play(s, 0, [last.id]);
  const v = viewFor(s, 1);
  assert.equal(v.hands[1].length, 1);
  assert.equal(v.hands[0].length, 0);
});

test('checkPlay rejects junk input', () => {
  const s = game(3);
  const seat = s.turn;
  assert.match(checkPlay(s, seat, [], null), /Pick a card/);
  assert.match(checkPlay(s, seat, [1, 1], null), /Pick a card/);
  assert.match(checkPlay(s, seat, [9999], null), /isn't in your hand/);
  assert.match(checkPlay(s, seat, 'x', null), /Pick a card/);
});

test('hand sorting and seats', () => {
  const h = sortHand([card('w', 'd4'), card('b', '2'), card('r', 'skip'), card('r', '3')]);
  assert.deepEqual(h.map((c) => c.c + c.v), ['r3', 'rskip', 'b2', 'wd4']);
  const s = game(4);
  s.dir = 1;
  assert.equal(nextSeat(s, 3), 0);
  s.dir = -1;
  assert.equal(nextSeat(s, 0), 3);
  assert.equal(nextSeat(s, 0, 2), 2);
});

test('game clock and time format', () => {
  const s = game(2);
  s.clock = { base: 60000, since: 1000 };
  assert.equal(gameTime(s, 31000), 90000);
  assert.equal(formatTime(90000), '1:30');
  assert.equal(formatTime(3723000), '1:02:03');
});

// Bots play whole games under every rule combination: every move they pick is
// legal, cards are never lost or duplicated, and every game ends.
test('bot games under all rule combinations', () => {
  const combos = 2 ** RULE_KEYS.length;
  for (let mask = 0; mask < combos; mask++) {
    const rules = Object.fromEntries(RULE_KEYS.map((k, i) => [k, !!(mask & (1 << i))]));
    for (let seed = 1; seed <= 12; seed++) {
      const players = 2 + (seed % 7);
      const r = rng(seed * 31 + mask);
      const s = game(players, rules, seed * 17 + mask);
      let steps = 0;
      while (s.phase === 'playing') {
        assert.ok(steps++ < 5000, `game did not end (${JSON.stringify(rules)}, seed ${seed})`);
        // Someone jumps in now and then.
        if (rules.jumpIn && r() < 0.3) {
          const jumper = s.players.map((p) => p.seat).find((seat) => s.hands[seat].some((c) => canJump(s, seat, c)));
          if (jumper !== undefined) {
            play(s, jumper, [s.hands[jumper].find((c) => canJump(s, jumper, c)).id]);
            continue;
          }
        }
        const exposed = Object.keys(s.exposed).map(Number);
        if (exposed.length && r() < 0.5) catchUno(s, (exposed[0] + 1) % players, exposed[0], r);
        const seat = s.turn;
        const m = autoMove(s, seat);
        if (m.kind === 'play') {
          assert.equal(checkPlay(s, seat, m.ids, m.color), null);
          if (s.hands[seat].length - m.ids.length === 1 && r() < 0.7) callUno(s, seat);
          play(s, seat, m.ids, m.color, r);
        } else if (m.kind === 'draw') draw(s, seat, r);
        else pass(s, seat);
        const cards = allCards(s);
        assert.equal(cards.length, DECK_SIZE);
        assert.equal(new Set(cards.map((c) => c.id)).size, DECK_SIZE);
      }
      assert.equal(s.hands[s.winner].length, 0);
      assert.equal(s.ranks.length, players);
    }
  }
});
