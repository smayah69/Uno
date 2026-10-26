# Uno

Online multiplayer Uno in the browser, for **2 to 8 players**.

- Type your name, then **Host a game** or **Join with PIN**.
- The host gets a **6-digit PIN** (and an invite link) to share.
- In the lobby the host picks the house rules, can **add bots**, and starts once 2 or more players are in.

## Deploy on Vercel

It's a static site: no build step, no server code.

1. On Vercel: **Add New… → Project → Import** this repo.
2. Framework preset: **Other**. Leave Build Command and Output Directory empty.
3. **Deploy**.

`vercel.json` adds security headers (CSP, nosniff, no-referrer, frame-ancestors none).

## How it works

Vercel can't keep WebSocket connections open, so there is no game server:

- **The host's browser is the game server.** It holds the deck and every hand, shuffles with
  `crypto.getRandomValues`, validates every move and sends each player **only their own view**:
  their hand, how many cards everyone else holds, the discard pile. Other hands and the draw pile
  never leave the host. When someone draws, the others only learn how many cards they took.
- Players connect to the host **peer-to-peer over WebRTC** with [PeerJS](https://peerjs.com)
  (vendored in `vendor/`). The free PeerJS broker (`0.peerjs.com`) is only used for the handshake;
  the host registers the peer ID `uno-p2p-v1-<PIN>`. After that, traffic goes browser to browser
  (or through PeerJS's TURN relay on strict NATs).

```
js/game.js   rules engine (pure, unit tested): deck, turns, house rules, scoring, per-player views
js/cards.js  card faces and backs (HTML + CSS, no images)
js/parts.js  avatars, turn timer ring, scoreboard
js/net.js    transports: PeerJS (prod) and BroadcastChannel (?local=1, testing)
js/sound.js  synthesized sound effects (Web Audio)
js/text.js   name and chat sanitizing
js/main.js   host / client controllers and the UI
fonts/       Fredoka (SIL Open Font License)
```

## Rules

Standard Uno with the 108-card deck: 7 cards each, match the top card by color or by number/symbol,
or play a Wild. Skip, Reverse (works like a Skip with 2 players), +2, Wild, Wild +4. The game opens on
a number card. Can't (or don't want to) play? Tap the **deck** next to your UNO button to draw one card.
If it fits you can play it straight away, or keep it.

**UNO:** with two cards left you have to press **UNO!** *before* the play that leaves you with one.
Forget, and you draw 2 on the spot. The button lights up when it's needed, and the `U` key presses it
(`D` draws). This also counts for jump-ins and doubles that take you down to one card.

**Scoring:** the first player out wins the round and scores the points left in everyone else's
hands (numbers face value, Skip/Reverse/+2 = 20, Wilds = 50). A final +2 or +4 still makes the next
player draw first. **Next round** keeps the scores; the totals show at every seat.

### House rules (pick any, they combine)

- **Saute mouton: jump in.** Someone throws a card and you hold the exact same one (same number or
  symbol, same color)? Throw it right away, even when it's not your turn: cards glow and say
  **Jump in!** Play continues from you, as if it had been your turn (a Skip skips the player after you,
  a Reverse turns from you). Not on your own card, and not with Wilds.
- **Saute mouton: doubles.** On your turn, throw two or more cards with the same number together
  (e.g. red 7 + blue 7). The first one has to match; the last one sets the color. Tap the first card,
  tap the others in the order you want, then **Play**. Tap a lone selected card again to play just it.
- **+2 combo.** When a +2 is played on you, answer with any +2 and the next player takes 4, then 6…
  Whoever can't (or won't) stack taps the deck to draw the whole pile. A +4 doesn't stack. With jump-in
  on, a matching +2 can cut in and pass the penalty on.

### Timing, bots and disconnects

- 25 s per turn (a white ring runs around your avatar). Miss it and you're marked **AFK**: the computer
  plays your turns quickly until you play again or press **I'm back**.
- The host can **add bots** in the lobby, and press 🤖 on any player's avatar during a game to hand
  their seat to a bot. Bots stack, jump in, and always say UNO.
- If a player drops, the game pauses until they come back (refresh, or join again with the same PIN
  and name). The host can **Continue without them** (a bot plays for them until they return).
- If the host drops, everyone waits while their client keeps reconnecting. The game is saved in the
  host's browser: a refresh resumes it, or open the site again and click **Resume game**.

### Interface

Everyone sits around the table, you at the bottom: avatar, card count, score, cards in hand and a
turn ring. Your hand is at the bottom with the deck and the **UNO!** button on the right. The rim of
the table glows in the color to play, and dots flow around it in the direction of play. Cards fly
from hand to pile and from the deck to whoever draws. Chat opens from the top bar; messages also pop
up as speech bubbles at the sender's seat. Sounds: card slaps, shuffles, a fanfare for UNO, a buzzer
for a forgotten UNO, sad trombones for +2/+4 (speaker button mutes).

## Develop / test

```bash
npx serve .                          # any static server, then open http://localhost:3000
node --test tests/*.test.mjs         # rules engine tests, including bot games under every rule combo
```

Add `?local=1` to the URL to play across tabs of the same browser without internet
(BroadcastChannel). Open one tab to host and others to join. `&turnms=5000` shortens the turn timer.

## Known limitations / threat model

- The game only runs while the host's tab is open, and can only be resumed from the host's browser.
- **The host is trusted.** Clients can't cheat: they never receive other hands or the deck, and the host
  validates turns, cards, message shape and rate, and sanitizes names and chat (rendered as text).
  A modified host client could still peek at hands or stack the deck; fixing that would need a mental
  poker protocol or a real server.
- The PIN is the only access control (900k space on a public broker). Fine for casual games, not a secret.
- Reconnect secrets are per tab (`sessionStorage`) and never broadcast. An away seat can also be
  reclaimed by name, so anyone with the PIN and that name could take it. Deliberate trade-off for casual play.
