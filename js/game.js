// Pure Uno rules engine. No DOM, no networking: the host owns the full state
// (every hand and the draw pile) and mutates it through these functions.
// Players only ever receive viewFor(state, seat): their own hand plus what
// everyone at a real table can see.

export const COLOR_KEYS = ['r', 'y', 'g', 'b'];
export const CARD_COLORS = {
  r: { name: 'Red', main: '#e5383b' },
  y: { name: 'Yellow', main: '#f5b700' },
  g: { name: 'Green', main: '#2fa84f' },
  b: { name: 'Blue', main: '#1f6fe5' },
};
// Player identity colors (sidebar rows, chat names, seats around the table).
export const SEAT_COLORS = ['#ff5d8f', '#4cc9f0', '#7ae582', '#ffb703', '#b388ff', '#ff8c42', '#2ec4b6', '#f15bb5'];

export const MIN_PLAYERS = 2;
export const MAX_PLAYERS = 8;
export const HAND_SIZE = 7;
export const DECK_SIZE = 108;
// House rules, all off by default and combinable.
//   jumpIn: "saute mouton": throw the exact same card (color + value) as the
//           one just played, out of turn. Play continues from you.
//   multi:  "saute mouton" doubles: on your turn, play several cards with the
//           same number at once. The last one sets the color.
//   stack:  "+2 combo": answer a +2 with a +2; the next player draws the total.
export const RULES = Object.freeze({ jumpIn: false, multi: false, stack: false });
export const RULE_KEYS = Object.keys(RULES);

const ACTIONS = ['skip', 'rev', 'd2'];
const EVENTS_KEEP = 16;
const VALUE_ORDER = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9', 'skip', 'rev', 'd2', 'wild', 'd4'];

export const isNumber = (card) => /^[0-9]$/.test(card.v);
export const isWild = (card) => card.c === 'w';
export const points = (card) => (isNumber(card) ? Number(card.v) : isWild(card) ? 50 : 20);
export const topCard = (s) => s.discard[s.discard.length - 1];
export const playerBySeat = (s, seat) => s.players.find((p) => p.seat === seat);
const nameOf = (s, seat) => (playerBySeat(s, seat) || { name: '?' }).name;

export function cardName(card) {
  const value = { skip: 'Skip', rev: 'Reverse', d2: '+2', wild: 'Wild', d4: 'Wild +4' }[card.v] || card.v;
  return isWild(card) ? value : `${CARD_COLORS[card.c].name} ${value}`;
}

// Hand order for display: by color, then value.
export function sortHand(cards) {
  const colorOrder = [...COLOR_KEYS, 'w'];
  return [...cards].sort((a, b) => colorOrder.indexOf(a.c) - colorOrder.indexOf(b.c)
    || VALUE_ORDER.indexOf(a.v) - VALUE_ORDER.indexOf(b.v) || a.id - b.id);
}

// The standard 108-card deck: per color one 0, two of 1-9, two Skip, two
// Reverse, two +2; plus four Wild and four Wild +4.
export function buildDeck() {
  const deck = [];
  let id = 0;
  for (const c of COLOR_KEYS) {
    deck.push({ id: id++, c, v: '0' });
    for (let n = 1; n <= 9; n++) for (let k = 0; k < 2; k++) deck.push({ id: id++, c, v: String(n) });
    for (const v of ACTIONS) for (let k = 0; k < 2; k++) deck.push({ id: id++, c, v });
  }
  for (let k = 0; k < 4; k++) deck.push({ id: id++, c: 'w', v: 'wild' });
  for (let k = 0; k < 4; k++) deck.push({ id: id++, c: 'w', v: 'd4' });
  return deck;
}

export function shuffle(list, rng = Math.random) {
  for (let i = list.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [list[i], list[j]] = [list[j], list[i]];
  }
  return list;
}

export function createLobby(rules = RULES) {
  return {
    phase: 'lobby',
    rules: { ...RULES, ...rules },
    players: [],      // {id, name, seat, connected, host, bot?, afk?, replaced?}
    hands: {},        // seat -> [card]                     (secret)
    deck: [],         // draw pile, top is the last card    (secret)
    discard: [],      // played cards, top is last; a wild keeps its chosen color in `w`
    color: null,      // color to match (a wild's chosen color)
    turn: -1,
    dir: 1,           // 1 = clockwise (to the left), -1 after a Reverse
    pending: 0,       // stacked +2 cards waiting for the turn player (stack rule)
    drawn: null,      // id of the card the turn player just drew: they may play it
    by: -1,           // seat that played the top card (-1: flipped from the deck)
    uno: {},          // seat -> said UNO and is down to one card
    armed: {},        // seat -> pressed UNO, ready for the play that leaves one card (secret)
    exposed: {},      // seat -> down to one card without having said UNO: anyone can catch them
    events: [],       // recent events for animations, sounds and the chat log
    eventId: 0,
    stats: {},        // seat -> {played, drawn, jumps, caught}
    winner: -1,
    ranks: [],        // seats: winner first, then fewest points left in hand
    scores: {},       // seat -> points left in hand at the end of the round
    roundPoints: 0,   // what the winner scored this round
    totals: {},       // player id -> points won over all rounds
    round: 0,
    clock: { base: 0, since: null }, // play time: base ms + (now - since) while running
    note: '',
    seq: 0,
  };
}

function event(s, e) {
  s.eventId += 1;
  s.events.push({ id: s.eventId, ...e });
  if (s.events.length > EVENTS_KEEP) s.events.shift();
}

export function nextSeat(s, from, steps = 1) {
  const n = s.players.length;
  return (((from + s.dir * steps) % n) + n) % n;
}

export function startGame(s, rng = Math.random) {
  const k = s.players.length;
  if (k < MIN_PLAYERS) throw new Error(`Need at least ${MIN_PLAYERS} players`);
  if (k > MAX_PLAYERS) throw new Error(`${MAX_PLAYERS} players max`);
  s.players.forEach((p, i) => { p.seat = i; });
  s.deck = shuffle(buildDeck(), rng);
  s.hands = {};
  s.stats = {};
  for (const p of s.players) {
    s.hands[p.seat] = [];
    s.stats[p.seat] = { played: 0, drawn: 0, jumps: 0, caught: 0 };
  }
  for (let r = 0; r < HAND_SIZE; r++) for (const p of s.players) s.hands[p.seat].push(s.deck.pop());
  // The game opens on a number card: anything else goes back into the pile.
  let first = s.deck.pop();
  while (!isNumber(first)) {
    s.deck.splice(Math.floor(rng() * s.deck.length), 0, first);
    first = s.deck.pop();
  }
  s.discard = [first];
  s.color = first.c;
  s.by = -1;
  s.dir = 1;
  s.pending = 0;
  s.drawn = null;
  s.uno = {};
  s.armed = {};
  s.exposed = {};
  s.events = [];
  s.winner = -1;
  s.ranks = [];
  s.scores = {};
  s.roundPoints = 0;
  s.round += 1;
  s.clock = { base: 0, since: null };
  s.turn = Math.floor(rng() * k);
  s.phase = 'playing';
  s.note = `${nameOf(s, s.turn)} starts`;
  event(s, { kind: 'start', seat: s.turn });
  return s;
}

// Plain matching: same color, same value, or a wild.
export function matches(card, top, color) {
  return isWild(card) || card.c === color || card.v === top.v;
}

// May the turn player open their play with this card? Works on the host's
// state and on a player's view (same field names).
export function canStart(s, card) {
  if (s.pending > 0) return card.v === 'd2';
  if (s.drawn !== null && s.drawn !== undefined && card.id !== s.drawn) return false;
  return matches(card, topCard(s), s.color);
}

// Jump-in: the exact same colored card as the one on top, out of turn.
// Not on your own card (that's what the doubles rule is for).
export function canJump(s, seat, card) {
  if (!s.rules.jumpIn || s.phase !== 'playing' || seat === s.turn || seat === s.by || isWild(card)) return false;
  const top = topCard(s);
  return card.c === top.c && card.v === top.v;
}

// Other cards in the hand that can go down with this one (doubles rule).
export function companions(hand, card) {
  return isNumber(card) ? hand.filter((c) => c.id !== card.id && c.v === card.v) : [];
}

// Could this player go down to exactly one card right now? Then they must
// say UNO first (the UNO button lights up).
export function couldGoToOne(s, seat, hand) {
  if (s.phase !== 'playing' || hand.length < 2) return false;
  if (seat !== s.turn) return hand.length === 2 && hand.some((c) => canJump(s, seat, c));
  return hand.some((c) => {
    if (!canStart(s, c)) return false;
    const most = s.rules.multi && s.pending === 0 ? 1 + companions(hand, c).length : 1;
    return most >= hand.length - 1;
  });
}

// Returns an error message, or null when the play is legal.
export function checkPlay(s, seat, ids, color) {
  if (s.phase !== 'playing') return 'The round is over';
  if (!Array.isArray(ids) || ids.length < 1 || new Set(ids).size !== ids.length) return 'Pick a card';
  const hand = s.hands[seat] || [];
  const cards = ids.map((id) => hand.find((c) => c.id === id));
  if (cards.some((c) => !c)) return "That card isn't in your hand";
  if (isWild(cards[cards.length - 1]) && !COLOR_KEYS.includes(color)) return 'Pick a color for the wild card';
  if (seat !== s.turn) {
    if (cards.length === 1 && canJump(s, seat, cards[0])) return null;
    return s.rules.jumpIn ? 'Too late: that card no longer matches' : "It's not your turn";
  }
  if (!canStart(s, cards[0])) {
    if (s.pending > 0) return `Stack a +2 or draw ${s.pending}`;
    if (s.drawn !== null) return 'You can only play the card you just drew';
    return "That card doesn't match";
  }
  if (cards.length > 1) {
    if (!s.rules.multi) return 'One card at a time';
    if (!cards.every((c) => isNumber(c) && c.v === cards[0].v)) return 'Only cards with the same number go down together';
  }
  return null;
}

// A play by the turn player, or a jump-in by someone else. Effects apply as
// if the cards were played from the player's seat.
export function play(s, seat, ids, color = null, rng = Math.random) {
  const err = checkPlay(s, seat, ids, color);
  if (err) throw new Error(err);
  const jump = seat !== s.turn;
  const hand = s.hands[seat];
  const cards = ids.map((id) => hand.find((c) => c.id === id));
  s.hands[seat] = hand.filter((c) => !ids.includes(c.id));
  const played = cards.map((c) => (isWild(c) ? { ...c, w: color } : { ...c }));
  s.discard.push(...played);
  const last = cards[cards.length - 1];
  s.color = isWild(last) ? color : last.c;
  s.by = seat;
  s.drawn = null;
  s.turn = seat;
  s.stats[seat].played += cards.length;
  if (jump) s.stats[seat].jumps += 1;
  const name = nameOf(s, seat);
  const what = cards.length > 1 ? `${cards.length} × ${last.v}` : cardName(last) + (isWild(last) ? ` (${CARD_COLORS[color].name})` : '');
  s.note = jump ? `${name} jumped in with ${what}!` : `${name} played ${what}`;
  event(s, { kind: 'play', seat, cards: played, jump });

  // UNO has to be said before the play that leaves one card. Forgot? You're
  // exposed: anyone can catch you (Contre-UNO) and you draw 2, until you
  // have more than one card again.
  const left = s.hands[seat].length;
  if (left === 1 && s.armed[seat]) {
    s.uno[seat] = true;
    event(s, { kind: 'uno', seat });
  } else if (left === 1) {
    s.exposed[seat] = true;
  }
  s.armed[seat] = false;
  applyEffect(s, seat, last, rng);
  if (left === 0) finishRound(s, seat, rng);
  s.seq += 1;
  return played;
}

function applyEffect(s, seat, card, rng) {
  if (card.v === 'skip') {
    const victim = nextSeat(s, seat);
    event(s, { kind: 'skip', seat: victim });
    s.note += `, ${nameOf(s, victim)} is skipped`;
    s.turn = nextSeat(s, seat, 2);
  } else if (card.v === 'rev') {
    s.dir = -s.dir;
    event(s, { kind: 'reverse', dir: s.dir });
    // With two players a Reverse works like a Skip.
    s.turn = s.players.length === 2 ? seat : nextSeat(s, seat);
  } else if (card.v === 'd2' && s.rules.stack) {
    s.pending += 2;
    s.turn = nextSeat(s, seat);
  } else if (card.v === 'd2' || card.v === 'd4') {
    const victim = nextSeat(s, seat);
    const n = card.v === 'd2' ? 2 : 4;
    give(s, victim, n, rng);
    s.note += `: ${nameOf(s, victim)} draws ${n} and is skipped`;
    s.turn = nextSeat(s, seat, 2);
  } else {
    s.turn = nextSeat(s, seat);
  }
}

// Draw: take the stacked penalty, or one card (which may be played right away).
export function draw(s, seat, rng = Math.random) {
  if (s.phase !== 'playing') throw new Error('The round is over');
  if (seat !== s.turn) throw new Error("It's not your turn");
  if (s.drawn !== null) throw new Error('Play the card you drew, or keep it');
  s.armed[seat] = false;
  const name = nameOf(s, seat);
  if (s.pending > 0) {
    const n = s.pending;
    s.pending = 0;
    give(s, seat, n, rng);
    s.note = `${name} draws ${n}`;
    s.turn = nextSeat(s, seat);
  } else {
    const [card] = give(s, seat, 1, rng);
    if (card && matches(card, topCard(s), s.color)) {
      s.drawn = card.id;
      s.note = `${name} drew a card`;
    } else {
      s.note = card ? `${name} drew a card and passes` : `${name} passes (no cards left to draw)`;
      s.turn = nextSeat(s, seat);
    }
  }
  s.seq += 1;
}

// Keep the card you just drew.
export function pass(s, seat) {
  if (s.phase !== 'playing' || seat !== s.turn || s.drawn === null) throw new Error('Nothing to pass');
  s.drawn = null;
  s.note = `${nameOf(s, seat)} keeps the card`;
  s.turn = nextSeat(s, seat);
  s.seq += 1;
}

// Say UNO, before the play that leaves you with one card. Returns false
// when it changes nothing (too many cards to matter, or already said).
// Saying it after the fact doesn't count.
export function callUno(s, seat) {
  if (s.phase !== 'playing' || !s.hands[seat] || s.hands[seat].length < 2 || s.armed[seat]) return false;
  s.armed[seat] = true;
  return true;
}

// Contre-UNO: catch someone who went down to one card without saying UNO.
// They draw 2. Open until they're caught or hold more than one card again.
export function catchUno(s, catcher, target, rng = Math.random) {
  if (s.phase !== 'playing' || !s.exposed[target] || catcher === target || !s.hands[catcher]) {
    throw new Error('Nobody to catch there');
  }
  delete s.exposed[target];
  event(s, { kind: 'catch', seat: catcher, target });
  give(s, target, 2, rng);
  s.stats[target].caught += 1;
  s.note = `Contre-UNO! ${nameOf(s, catcher)} caught ${nameOf(s, target)}: +2`;
  s.seq += 1;
}

function give(s, seat, n, rng) {
  const got = [];
  for (let i = 0; i < n; i++) {
    if (!s.deck.length) reshuffle(s, rng);
    if (!s.deck.length) break; // every card is in someone's hand
    got.push(s.deck.pop());
  }
  s.hands[seat].push(...got);
  s.stats[seat].drawn += got.length;
  if (s.hands[seat].length > 1) {
    s.uno[seat] = false;
    delete s.exposed[seat];
  }
  if (got.length) event(s, { kind: 'draw', seat, n: got.length, cards: got.map((c) => ({ ...c })) });
  return got;
}

// Draw pile empty: everything under the top card is shuffled into a new one.
function reshuffle(s, rng) {
  if (s.discard.length < 2) return;
  const keep = s.discard.pop();
  s.deck = shuffle(s.discard.map(({ id, c, v }) => ({ id, c, v })), rng);
  s.discard = [keep];
  event(s, { kind: 'shuffle' });
}

function finishRound(s, seat, rng) {
  // A last +2 still counts: the next player draws before the points are added up.
  if (s.pending > 0) {
    const victim = s.turn;
    const n = s.pending;
    s.pending = 0;
    give(s, victim, n, rng);
  }
  s.phase = 'ended';
  s.winner = seat;
  s.turn = -1;
  s.drawn = null;
  s.exposed = {};
  s.scores = {};
  for (const p of s.players) s.scores[p.seat] = s.hands[p.seat].reduce((sum, c) => sum + points(c), 0);
  const others = s.players.map((p) => p.seat).filter((x) => x !== seat);
  others.sort((a, b) => s.scores[a] - s.scores[b] || s.hands[a].length - s.hands[b].length || a - b);
  s.ranks = [seat, ...others];
  s.roundPoints = others.reduce((sum, x) => sum + s.scores[x], 0);
  const winner = playerBySeat(s, seat);
  s.totals[winner.id] = (s.totals[winner.id] || 0) + s.roundPoints;
  s.note = `${winner.name} wins the round!`;
  event(s, { kind: 'win', seat, points: s.roundPoints });
}

// What one player is allowed to see. seat -1: lobby or nobody.
export function viewFor(s, seat) {
  const counts = {};
  for (const p of s.players) counts[p.seat] = (s.hands[p.seat] || []).length;
  const ended = s.phase === 'ended';
  const hands = {};
  if (ended) for (const p of s.players) hands[p.seat] = s.hands[p.seat].map((c) => ({ ...c }));
  return {
    phase: s.phase,
    rules: { ...s.rules },
    round: s.round,
    totals: { ...s.totals },
    players: s.players.map((p) => ({ ...p })),
    turn: s.turn,
    dir: s.dir,
    color: s.color,
    pending: s.pending,
    by: s.by,
    drawn: seat >= 0 && seat === s.turn ? s.drawn : null,
    uno: { ...s.uno },
    exposed: { ...s.exposed },
    armed: !!s.armed[seat],
    discard: s.discard.slice(-6).map((c) => ({ ...c })),
    deckCount: s.deck.length,
    counts,
    hand: seat >= 0 && s.hands[seat] ? s.hands[seat].map((c) => ({ ...c })) : [],
    hands: ended ? hands : null, // everything is revealed when the round ends
    // Others only learn how many cards someone drew, never which.
    events: s.events.map((e) => (e.kind === 'draw' && e.seat !== seat ? { id: e.id, kind: e.kind, seat: e.seat, n: e.n } : e)),
    eventId: s.eventId,
    stats: JSON.parse(JSON.stringify(s.stats)),
    winner: s.winner,
    ranks: [...s.ranks],
    scores: { ...s.scores },
    roundPoints: s.roundPoints,
    clock: { ...s.clock },
    note: s.note,
    seq: s.seq,
  };
}

// Simple strategy for bots, AFK players and timeouts.
// Returns {kind: 'play', ids, color} | {kind: 'draw'} | {kind: 'pass'}.
export function autoMove(s, seat) {
  const hand = s.hands[seat];
  if (s.pending > 0) {
    const d2 = hand.find((c) => c.v === 'd2');
    return d2 ? { kind: 'play', ids: [d2.id], color: null } : { kind: 'draw' };
  }
  const options = hand.filter((c) => canStart(s, c));
  if (!options.length) return s.drawn !== null ? { kind: 'pass' } : { kind: 'draw' };
  const nextCount = s.hands[nextSeat(s, seat)].length;
  const counts = colorCounts(hand);
  let best = null;
  let bestScore = -Infinity;
  for (const c of options) {
    let score;
    if (isNumber(c)) score = 10 + Number(c.v) + counts[c.c] * 2;
    else if (c.v === 'wild') score = nextCount <= 2 ? 30 : 2;
    else if (c.v === 'd4') score = nextCount <= 2 ? 60 : 1;
    else score = 18 + counts[c.c] * 2 + (nextCount <= 2 ? 40 : 0);
    if (s.rules.multi && isNumber(c)) score += 8 * companions(hand, c).length;
    if (score > bestScore) { bestScore = score; best = c; }
  }
  let ids = [best.id];
  if (s.rules.multi && isNumber(best)) {
    // Throw all the same numbers; finish on the color we hold most of.
    const rest = companions(hand, best);
    const after = colorCounts(hand.filter((c) => c.id !== best.id && !rest.includes(c)));
    rest.sort((a, b) => after[a.c] - after[b.c]);
    ids = [best.id, ...rest.map((c) => c.id)];
  }
  const color = isWild(best) ? bestColor(hand.filter((c) => c.id !== best.id)) : null;
  return { kind: 'play', ids, color };
}

function colorCounts(cards) {
  const out = { r: 0, y: 0, g: 0, b: 0, w: 0 };
  for (const c of cards) out[c.c] += 1;
  return out;
}

export function bestColor(cards) {
  const counts = colorCounts(cards);
  return COLOR_KEYS.reduce((best, c) => (counts[c] > counts[best] ? c : best), COLOR_KEYS[0]);
}

// Play time in ms. `now` is the host's clock; the clock stops while paused.
export function gameTime(state, now = Date.now()) {
  const c = state.clock || { base: 0, since: null };
  return c.base + (c.since !== null ? Math.max(0, now - c.since) : 0);
}

export function formatTime(ms) {
  const t = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = t % 60;
  const mm = String(m).padStart(h ? 2 : 1, '0'), ss = String(s).padStart(2, '0');
  return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
}
