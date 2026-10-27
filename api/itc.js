// Vercel function behind the private rooms /itc1 and /itc2.
//
// Only the owner (who knows ITC_PASSWORD, set in the Vercel project's
// environment variables) can open a room, and players' browsers check that
// whoever answers at the room's address really is the owner:
//
//   login  {password}            -> {ticket}  the owner's browser keeps it (30 days)
//   prove  {ticket, room, nonce} -> {proof}   the host answers a player's challenge
//   check  {room, nonce, proof}  -> {ok}      the player checks that answer
//
// Stateless: tickets and proofs are HMACs with a key derived from the
// password, so changing the password revokes every ticket.

const crypto = require('crypto');

const ROOMS = new Set(['itc1', 'itc2']);
const TICKET_TTL = 30 * 24 * 3600; // seconds
const FAIL_DELAY = 1000;           // slows down password guessing a little

const sha = (s) => crypto.createHash('sha256').update(s).digest();
const mac = (key, s) => crypto.createHmac('sha256', key).update(s).digest('base64url');
const same = (a, b) => a.length === b.length && crypto.timingSafeEqual(a, b);
const sameStr = (a, b) => typeof a === 'string' && typeof b === 'string' && same(Buffer.from(a), Buffer.from(b));
const isNonce = (n) => typeof n === 'string' && /^[0-9a-f]{32}$/.test(n);

function key() {
  const pw = process.env.ITC_PASSWORD;
  return pw ? sha(`itc-key\0${pw}`) : null;
}

function ticketOk(k, ticket, now) {
  const m = typeof ticket === 'string' && /^(\d{1,12})\.([\w-]{43})$/.exec(ticket);
  return !!m && Number(m[1]) > now && sameStr(m[2], mac(k, `ticket|${m[1]}`));
}

async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  const send = (code, body) => { res.statusCode = code; res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(body)); };
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return send(405, { error: 'Method not allowed' }); }
  const k = key();
  if (!k) return send(503, { error: 'Rooms are not set up (ITC_PASSWORD is missing on the server)' });

  let b = req.body;
  if (typeof b === 'string' || Buffer.isBuffer(b)) { try { b = JSON.parse(b); } catch { b = null; } }
  if (!b || typeof b !== 'object') return send(400, { error: 'Bad request' });
  const now = Math.floor(Date.now() / 1000);

  if (b.op === 'login') {
    const pw = typeof b.password === 'string' ? b.password.slice(0, 256) : '';
    if (!same(sha(pw), sha(process.env.ITC_PASSWORD))) {
      await new Promise((r) => setTimeout(r, FAIL_DELAY));
      return send(401, { error: 'Wrong password' });
    }
    const exp = now + TICKET_TTL;
    return send(200, { ticket: `${exp}.${mac(k, `ticket|${exp}`)}` });
  }
  if (!ROOMS.has(b.room) || !isNonce(b.nonce)) return send(400, { error: 'Bad request' });
  if (b.op === 'prove') {
    if (!ticketOk(k, b.ticket, now)) return send(401, { error: 'Host login expired' });
    return send(200, { proof: mac(k, `proof|${b.room}|${b.nonce}`) });
  }
  if (b.op === 'check') return send(200, { ok: sameStr(b.proof, mac(k, `proof|${b.room}|${b.nonce}`)) });
  return send(400, { error: 'Bad request' });
}

module.exports = handler;
