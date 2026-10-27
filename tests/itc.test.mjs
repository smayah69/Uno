// Run with: node --test tests/
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const handler = createRequire(import.meta.url)('../api/itc.js');

async function call(body, method = 'POST') {
  const res = {
    statusCode: 200, headers: {}, body: '',
    setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
    end(b) { this.body = b; },
  };
  await handler({ method, body }, res);
  return { status: res.statusCode, data: res.body ? JSON.parse(res.body) : null, headers: res.headers };
}

const nonce = 'ab'.repeat(16);

test('itc: refuses without ITC_PASSWORD configured', async () => {
  delete process.env.ITC_PASSWORD;
  assert.equal((await call({ op: 'login', password: '' })).status, 503);
});

test('itc: login, prove, check', async () => {
  process.env.ITC_PASSWORD = 'correct horse';
  assert.equal((await call({ op: 'login', password: 'x' }, 'GET')).status, 405);
  const bad = await call({ op: 'login', password: 'wrong' });
  assert.equal(bad.status, 401);
  assert.equal(bad.data.ticket, undefined);

  const { status, data, headers } = await call({ op: 'login', password: 'correct horse' });
  assert.equal(status, 200);
  assert.equal(headers['cache-control'], 'no-store');
  const { ticket } = data;
  assert.match(ticket, /^\d+\.[\w-]{43}$/);

  // Only a valid ticket gets a proof.
  assert.equal((await call({ op: 'prove', ticket: 'nope', room: 'itc1', nonce })).status, 401);
  const [exp, sig] = ticket.split('.');
  assert.equal((await call({ op: 'prove', ticket: `${Number(exp) + 1}.${sig}`, room: 'itc1', nonce })).status, 401);
  assert.equal((await call({ op: 'prove', ticket, room: 'lobby', nonce })).status, 400);
  assert.equal((await call({ op: 'prove', ticket, room: 'itc1', nonce: 'short' })).status, 400);
  const { proof } = (await call({ op: 'prove', ticket, room: 'itc1', nonce })).data;

  // The proof is bound to the room and the player's challenge.
  assert.equal((await call({ op: 'check', room: 'itc1', nonce, proof })).data.ok, true);
  assert.equal((await call({ op: 'check', room: 'itc2', nonce, proof })).data.ok, false);
  assert.equal((await call({ op: 'check', room: 'itc1', nonce: 'cd'.repeat(16), proof })).data.ok, false);
  assert.equal((await call({ op: 'check', room: 'itc1', nonce, proof: 'x' })).data.ok, false);
  assert.equal((await call({ op: 'check', room: 'itc1', nonce })).data.ok, false);

  // JSON sent as a string body works too.
  assert.equal((await call(JSON.stringify({ op: 'check', room: 'itc1', nonce, proof }))).data.ok, true);

  // Changing the password revokes tickets and proofs.
  process.env.ITC_PASSWORD = 'new password';
  assert.equal((await call({ op: 'prove', ticket, room: 'itc1', nonce })).status, 401);
  assert.equal((await call({ op: 'check', room: 'itc1', nonce, proof })).data.ok, false);
});

test('itc: expired ticket is refused', async () => {
  process.env.ITC_PASSWORD = 'pw';
  const { ticket } = (await call({ op: 'login', password: 'pw' })).data;
  const realNow = Date.now;
  Date.now = () => realNow() + 31 * 24 * 3600 * 1000;
  try {
    assert.equal((await call({ op: 'prove', ticket, room: 'itc2', nonce })).status, 401);
  } finally {
    Date.now = realNow;
  }
});
