// Bots: what they play and when. Shared by the online host and the /sandbox
// page, so bots behave the same in both. The host also uses autoTurn for AFK
// players and missed turns.
import { autoMove, callUno, play, draw, pass, canJump, catchUno, topCard, playerBySeat } from './game.js';

export const BOT_MS = 1500;            // a bot's thinking time on its turn
export const JUMP_MS = [700, 1600];    // how quickly a bot jumps in (saute mouton)
export const JUMP_ODDS = 0.8;          // chance a bot holding the same card throws it
export const CATCH_MS = [1800, 4500];  // how quickly a bot calls Contre-UNO
export const CATCH_ODDS = 0.75;        // chance a bot notices someone forgot UNO at all
export const FORGETS = 0.15;           // bots forget to say UNO now and then, so you can catch them

const between = ([lo, hi], rng) => lo + rng() * (hi - lo);

// One automatic turn for `seat`. A forgetful player (a bot) now and then
// doesn't say UNO. Never throws: a stuck game is worse than an odd move.
// Returns false when it isn't that seat's turn.
export function autoTurn(s, seat, { forgetful = false, rng = Math.random } = {}) {
  if (s.phase !== 'playing' || s.turn !== seat) return false;
  const m = autoMove(s, seat);
  try {
    if (m.kind === 'play') {
      if (s.hands[seat].length - m.ids.length === 1 && !(forgetful && rng() < FORGETS)) callUno(s, seat);
      play(s, seat, m.ids, m.color, rng);
    } else if (m.kind === 'draw') draw(s, seat, rng);
    else pass(s, seat);
  } catch (err) {
    console.warn('auto move failed', err);
    try {
      if (s.drawn !== null) pass(s, seat);
      else draw(s, seat, rng);
    } catch { return false; }
  }
  return true;
}

// Out-of-turn moves by bots: jumping in with the same card (saute mouton) and
// calling Contre-UNO on someone who forgot UNO. Call update() after every
// change; each plan is redone only when its situation changes, and carried
// out after a human-like beat if it still holds.
export class BotReflexes {
  // state(): the engine state now. isBot(seat): a bot plays this seat now.
  // active(): play is running (not paused). changed(): a bot just acted.
  constructor({ state, isBot, active = () => true, changed = () => {}, rng = Math.random }) {
    Object.assign(this, { state, isBot, active, changed, rng });
    this.jumpTimer = null;
    this.jumpFor = null;
    this.catchTimer = null;
    this.catchFor = null;
  }

  update() {
    this.planJump();
    this.planCatch();
  }

  stop() {
    clearTimeout(this.jumpTimer);
    clearTimeout(this.catchTimer);
    this.jumpFor = this.catchFor = null;
  }

  live(s) {
    return this.state() === s && s.phase === 'playing' && this.active();
  }

  planJump() {
    const s = this.state();
    const key = s.phase === 'playing' && s.rules.jumpIn && this.active() ? `${topCard(s).id}|${s.by}` : null;
    if (key === this.jumpFor) return;
    this.jumpFor = key;
    clearTimeout(this.jumpTimer);
    if (!key) return;
    for (const p of s.players) {
      if (!this.isBot(p.seat)) continue;
      const card = s.hands[p.seat].find((c) => canJump(s, p.seat, c));
      if (!card || this.rng() > JUMP_ODDS) continue;
      this.jumpTimer = setTimeout(() => {
        if (!this.live(s) || this.jumpFor !== key || !this.isBot(p.seat)) return;
        try {
          if (s.hands[p.seat].length === 2 && this.rng() > FORGETS) callUno(s, p.seat);
          play(s, p.seat, [card.id], null, this.rng);
        } catch { return; } // too late: the card no longer matches
        this.changed();
      }, between(JUMP_MS, this.rng));
      return;
    }
  }

  planCatch() {
    const s = this.state();
    const targets = s.phase === 'playing' && this.active() ? Object.keys(s.exposed || {}).map(Number) : [];
    const key = targets.length ? targets.join(',') : null;
    if (key === this.catchFor) return;
    this.catchFor = key;
    clearTimeout(this.catchTimer);
    if (!key) return;
    const target = targets[0];
    const bots = s.players.map((p) => p.seat).filter((seat) => seat !== target && this.isBot(seat));
    if (!bots.length || this.rng() > CATCH_ODDS) return;
    const bot = bots[Math.floor(this.rng() * bots.length)];
    this.catchTimer = setTimeout(() => {
      if (!this.live(s) || !s.exposed[target] || !this.isBot(bot) || !playerBySeat(s, bot)) return;
      try { catchUno(s, bot, target, this.rng); } catch { return; }
      this.changed();
    }, between(CATCH_MS, this.rng));
  }
}
