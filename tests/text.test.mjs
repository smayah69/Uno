// Names and chat: nothing invisible, nothing that passes for someone else.
// Run with: npm test
import test from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeName, sanitizeChat, MAX_NAME, MAX_CHAT } from '../js/text.js';

test('names: invisible and blank-looking characters are removed', () => {
  assert.equal(sanitizeName('Bo\u200Bb'), 'Bob');              // zero-width space
  assert.equal(sanitizeName('Bob\u{E0041}\u{E0042}'), 'Bob');  // tag characters
  assert.equal(sanitizeName('A\u061CB'), 'AB');                // Arabic letter mark
  assert.equal(sanitizeName('\u202Eevil'), 'evil');            // bidi override
  assert.equal(sanitizeName('so\u00ADft'), 'soft');            // soft hyphen
  for (const blank of ['\u3164', '\u115F\u1160', '\u2800\u2800', '\uFFA0', '\u00AD', '  ', '\u200D']) {
    assert.equal(sanitizeName(blank), '', JSON.stringify(blank));
  }
});

test('names: look-alikes fold into the plain name', () => {
  assert.equal(sanitizeName('Ｂｏｂ'), 'Bob');
  assert.equal(sanitizeName('𝐁𝐨𝐛'), 'Bob');
});

test('names: trimmed, spaces collapsed, length capped by characters', () => {
  assert.equal(sanitizeName('  Ana   Maria\t\n '), 'Ana Maria');
  assert.equal(Array.from(sanitizeName('😀'.repeat(40))).length, MAX_NAME);
  assert.equal(sanitizeName('🎲'), '🎲');
  assert.equal(sanitizeName('Chloé'), 'Chloé');
  assert.equal(sanitizeName('김민준'), '김민준');
  assert.equal(sanitizeName(42), '');
  assert.equal(sanitizeName(null), '');
});

test('chat: cleaned the same way, longer limit, text kept as typed', () => {
  assert.equal(sanitizeChat('gg\u200B wp\n\nnext'), 'gg wp next');
  assert.equal(sanitizeChat('x²'), 'x²');
  assert.equal(Array.from(sanitizeChat('a'.repeat(500))).length, MAX_CHAT);
  assert.equal(sanitizeChat('\u202E\u200B'), '');
});
