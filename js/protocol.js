// What the host and the players say to each other, and the checks both
// sides run on it.
//
//   player -> host  hello {v, name, secret, nonce?}, ping, play {ids, color},
//                   draw, pass, uno, catch {seat}, back, chat {text}
//   host -> player  welcome {v, pid, pin, proof?}, reject {reason, code?, v?},
//                   end {reason}, state {s, turnMs, now}, toast {text},
//                   chat {e}, chatlog {list}, ping
//
// Bump PROTOCOL when messages change in a way an older page can't follow.
// After a deploy, an old tab and a new one then ask to be refreshed instead
// of misbehaving.
import { DECK_SIZE } from './game.js';

export const PROTOCOL = 2;
export const PING_MS = 2500;   // heartbeat interval
export const DEAD_MS = 9000;   // no traffic for this long = the connection is dead
export const RETRY_MS = 3000;  // a player's reconnect interval while the host is away
export const CHAT_KEEP = 80;   // chat lines kept (and sent to people who join)

// What the host tells a player whose page speaks another protocol. Older
// pages show it as is; newer ones work out who has to refresh (versionError).
export const VERSION_REASON = 'Your page is out of date: refresh it, then join again.';

export function versionError(hostVersion) {
  return typeof hostVersion === 'number' && hostVersion > PROTOCOL
    ? VERSION_REASON
    : "The host's page is out of date: ask them to refresh it (the game picks up where it was), then join again.";
}

export const isHex32 = (x) => typeof x === 'string' && /^[0-9a-f]{32}$/.test(x);

export const validIds = (ids) => Array.isArray(ids) && ids.length >= 1 && ids.length <= 12
  && ids.every((i) => Number.isInteger(i) && i >= 0 && i < DECK_SIZE);

// Just enough shape-checking that a bad message can't crash the renderer.
export function validView(s) {
  return !!s && typeof s === 'object' && Array.isArray(s.players) && Array.isArray(s.hand) && Array.isArray(s.discard)
    && Array.isArray(s.events) && !!s.rules && typeof s.rules === 'object' && !!s.counts && typeof s.counts === 'object';
}

export function validChat(e) {
  return !!e && typeof e === 'object' && (e.kind === 'sys' || e.kind === 'chat') && typeof e.text === 'string'
    && (e.kind === 'sys' || (typeof e.name === 'string' && typeof e.pid === 'string'));
}
