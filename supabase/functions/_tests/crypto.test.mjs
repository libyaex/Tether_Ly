// Run with: node --test supabase/functions/_tests/crypto.test.mjs   (Node >= 22.18, or add --experimental-strip-types)
// Verifies the webhook-signature primitive against DPay's documented scheme: HMAC-SHA256 over `${timestamp}.${rawBody}`, lowercase hex.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { verifyHmacSha256, timingSafeEqual, hexToBytes } from '../_shared/crypto.ts';

const enc = new TextEncoder();
const secret = 'whsec_test_secret_value_123';
const ts = '1789034400';
const body = JSON.stringify({ event: 'checkout.completed', live: false, checkout_session_id: 'cs_test_X', amount: 125.5, name: 'سالم علي' });
const signedBytes = new Uint8Array([...enc.encode(`${ts}.`), ...enc.encode(body)]);
const good = createHmac('sha256', secret).update(`${ts}.${body}`).digest('hex');   // independent implementation (OpenSSL)

test('accepts a correct signature (matches independent OpenSSL HMAC)', async () => {
  assert.equal(await verifyHmacSha256(secret, signedBytes, good), true);
});
test('accepts uppercase hex', async () => {
  assert.equal(await verifyHmacSha256(secret, signedBytes, good.toUpperCase()), true);
});
test('rejects a tampered body', async () => {
  const bad = new Uint8Array([...enc.encode(`${ts}.`), ...enc.encode(body.replace('125.5', '999.5'))]);
  assert.equal(await verifyHmacSha256(secret, bad, good), false);
});
test('rejects a different timestamp', async () => {
  const other = new Uint8Array([...enc.encode('1789034401.'), ...enc.encode(body)]);
  assert.equal(await verifyHmacSha256(secret, other, good), false);
});
test('rejects a wrong secret', async () => {
  assert.equal(await verifyHmacSha256('whsec_other', signedBytes, good), false);
});
test('rejects malformed signatures (empty, short, long, non-hex)', async () => {
  for (const s of ['', 'abc', good + '00', 'z'.repeat(64), good.slice(0, 63)]) {
    assert.equal(await verifyHmacSha256(secret, signedBytes, s), false, `should reject "${s.slice(0, 12)}…"`);
  }
});
test('raw bytes matter: re-encoded JSON with different whitespace fails', async () => {
  const pretty = JSON.stringify(JSON.parse(body), null, 2);
  const reenc = new Uint8Array([...enc.encode(`${ts}.`), ...enc.encode(pretty)]);
  assert.equal(await verifyHmacSha256(secret, reenc, good), false);
});
test('timingSafeEqual', () => {
  assert.equal(timingSafeEqual('abc', 'abc'), true);
  assert.equal(timingSafeEqual('abc', 'abd'), false);
  assert.equal(timingSafeEqual('abc', 'abcd'), false);
  assert.equal(timingSafeEqual('', ''), true);
});
test('hexToBytes', () => {
  assert.equal(hexToBytes('g'.repeat(64)), null);
  assert.equal(hexToBytes(good).length, 32);
});
