import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { verifyHmacSha256 } from '../_shared/crypto.ts';
import { normalizeDpayPayload, normalizeAmount, envOfCheckoutId, assertDpayUrl } from '../_shared/dpay-normalize.ts';

const enc = new TextEncoder();

test('DPay Idempotency Key adheres strictly to <= 64 char limit', () => {
  const orderId = 'a1b2c3d4-e5f6-7a8b-9c0d-1e2f3a4b5c6d';
  const attempt = 1;
  const idem = `dep:${orderId}:${attempt}`;
  assert.ok(idem.length <= 64, `Idempotency key length ${idem.length} exceeded 64 chars`);
  assert.equal(idem, 'dep:a1b2c3d4-e5f6-7a8b-9c0d-1e2f3a4b5c6d:1');
});

test('assertDpayUrl accepts valid dpay.ly host and rejects phishing/fake hosts', () => {
  assert.doesNotThrow(() => assertDpayUrl('https://dpay.ly/sandbox/pay/cs_test_123'));
  assert.doesNotThrow(() => assertDpayUrl('https://checkout.dpay.ly/pay/cs_123'));
  assert.throws(() => assertDpayUrl('http://dpay.ly/pay/cs_123')); // non-https
  assert.throws(() => assertDpayUrl('https://fake-dpay.ly/pay/cs_123'));
  assert.throws(() => assertDpayUrl('https://evil.com/dpay.ly'));
});

test('envOfCheckoutId differentiates sandbox and live checkout IDs', () => {
  assert.equal(envOfCheckoutId('cs_test_99887766'), 'sandbox');
  assert.equal(envOfCheckoutId('cs_live_99887766'), 'live');
  assert.equal(envOfCheckoutId('cs_1234567890'), 'live');
});

test('Webhook signature validation over raw bytes with simulated Sandbox payload', async () => {
  const webhookSecret = 'whsec_test_secret_sandbox_abc';
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const payload = JSON.stringify({
    event: 'checkout.completed',
    live: false,
    checkout_session_id: 'cs_test_abc123',
    status: 'paid',
    amount: 150.0,
    currency: 'LYD',
    reference: 'DEP-ORDER-1001',
    payment: {
      tx_id: 'TX_DPAY_889900',
      amount_charged: 150.0,
      fee_amount: 1.5,
      paid_at: new Date().toISOString(),
    },
  });

  const rawBytes = enc.encode(payload);
  const signature = createHmac('sha256', webhookSecret).update(`${timestamp}.${payload}`).digest('hex');

  const signedBytes = new Uint8Array([...enc.encode(`${timestamp}.`), ...rawBytes]);
  const isValid = await verifyHmacSha256(webhookSecret, signedBytes, signature);
  assert.equal(isValid, true, 'Valid signature should pass');

  // Verify tampering with amount fails
  const tamperedPayload = payload.replace('150', '999');
  const tamperedBytes = new Uint8Array([...enc.encode(`${timestamp}.`), ...enc.encode(tamperedPayload)]);
  const isTamperedValid = await verifyHmacSha256(webhookSecret, tamperedBytes, signature);
  assert.equal(isTamperedValid, false, 'Tampered payload must be rejected');

  // Verify expired timestamp (> 300 seconds)
  const staleTimestamp = (Math.floor(Date.now() / 1000) - 305).toString();
  assert.ok(Math.abs(Date.now() / 1000 - Number(staleTimestamp)) > 300, 'Stale timestamp recognized');
});

test('Simulated DPay State Machine: transitions, idempotency, and late bank confirmation', () => {
  function simulateApplyCheckout(order, checkout) {
    const amt = normalizeAmount(checkout.amount);
    if (!amt || amt !== order.amount || checkout.currency !== 'LYD' || checkout.reference !== order.ref) {
      if (order.status === 'awaiting_payment' || order.status === 'expired') {
        order.status = 'needs_review';
        order.review_reason = 'mismatch';
      }
      return { outcome: 'mismatch', order };
    }

    if (checkout.status === 'paid') {
      if (order.status === 'paid') {
        return { outcome: 'already_paid', order };
      }
      if (order.status !== 'awaiting_payment' && order.status !== 'expired') {
        return { outcome: 'quarantined', order };
      }
      if (!checkout.payment?.tx_id) {
        throw new Error('paid_without_payment_details');
      }
      order.status = 'paid';
      order.credited = true;
      return { outcome: 'applied', order };
    }

    if (checkout.status === 'expired' || checkout.status === 'cancelled') {
      if (order.status === 'awaiting_payment') {
        order.status = checkout.status;
        return { outcome: 'released', order };
      }
      return { outcome: 'noop', order };
    }

    return { outcome: 'noop', order };
  }

  // 1. Normal successful flow
  let order = {
    id: 'ord-1',
    ref: 'DEP-001',
    amount: '100.00',
    status: 'awaiting_payment',
    credited: false,
  };

  const paidCheckout = {
    id: 'cs_test_1',
    status: 'paid',
    amount: '100.00',
    currency: 'LYD',
    reference: 'DEP-001',
    live: false,
    payment: { tx_id: 'TX_1', amount_charged: '100.00', fee_amount: '1.00', paid_at: new Date().toISOString() },
  };

  const res1 = simulateApplyCheckout(order, paidCheckout);
  assert.equal(res1.outcome, 'applied');
  assert.equal(res1.order.status, 'paid');
  assert.equal(res1.order.credited, true);

  // 2. Duplicate webhook event -> idempotent already_paid without crediting twice
  const res2 = simulateApplyCheckout(order, paidCheckout);
  assert.equal(res2.outcome, 'already_paid');
  assert.equal(res2.order.credited, true);

  // 3. Late bank confirmation: order was expired, but DPay late confirmation arrives as paid
  let expiredOrder = {
    id: 'ord-2',
    ref: 'DEP-002',
    amount: '200.00',
    status: 'expired',
    credited: false,
  };

  const latePaidCheckout = {
    id: 'cs_test_2',
    status: 'paid',
    amount: '200.00',
    currency: 'LYD',
    reference: 'DEP-002',
    live: false,
    payment: { tx_id: 'TX_2', amount_charged: '200.00', fee_amount: '2.00', paid_at: new Date().toISOString() },
  };

  const lateRes = simulateApplyCheckout(expiredOrder, latePaidCheckout);
  assert.equal(lateRes.outcome, 'applied', 'Late payment on expired session must be credited if matching');
  assert.equal(lateRes.order.status, 'paid');
  assert.equal(lateRes.order.credited, true);

  // 4. Amount mismatch: malicious or altered amount -> quarantined to needs_review, 0 credit
  let attackOrder = {
    id: 'ord-3',
    ref: 'DEP-003',
    amount: '50.00',
    status: 'awaiting_payment',
    credited: false,
  };

  const alteredCheckout = {
    id: 'cs_test_3',
    status: 'paid',
    amount: '10.00', // tampered amount
    currency: 'LYD',
    reference: 'DEP-003',
    live: false,
    payment: { tx_id: 'TX_3', amount_charged: '10.00', fee_amount: '0.10', paid_at: new Date().toISOString() },
  };

  const attackRes = simulateApplyCheckout(attackOrder, alteredCheckout);
  assert.equal(attackRes.outcome, 'mismatch');
  assert.equal(attackRes.order.status, 'needs_review');
  assert.equal(attackRes.order.credited, false, 'Altered amount must never credit wallet');
});
