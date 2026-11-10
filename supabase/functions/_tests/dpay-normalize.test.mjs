import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeDpayPayload, normalizeAmount, normalizeStatus } from '../_shared/dpay-normalize.ts';

test('normalizeAmount handles numbers and strings with trailing zeros', () => {
  assert.equal(normalizeAmount(102.5), '102.50');
  assert.equal(normalizeAmount('102.5'), '102.50');
  assert.equal(normalizeAmount(102), '102.00');
  assert.equal(normalizeAmount('102'), '102.00');
  assert.equal(normalizeAmount('102.75'), '102.75');
  assert.equal(normalizeAmount('abc'), null);
  assert.equal(normalizeAmount('-5'), null);
});

test('normalizeStatus maps statuses and event names accurately', () => {
  assert.equal(normalizeStatus('paid'), 'paid');
  assert.equal(normalizeStatus('open'), 'open');
  assert.equal(normalizeStatus('expired'), 'expired');
  assert.equal(normalizeStatus('cancelled'), 'cancelled');
  assert.equal(normalizeStatus(undefined, 'checkout.completed'), 'paid');
  assert.equal(normalizeStatus(undefined, 'payment.paid'), 'paid');
  assert.equal(normalizeStatus(undefined, 'checkout.expired'), 'expired');
  assert.equal(normalizeStatus(undefined, 'checkout.cancelled'), 'cancelled');
});

test('normalizes API v2 getCheckout response with { data: ... } wrapper', () => {
  const apiResp = {
    data: {
      id: 'cs_test_abc123',
      url: 'https://dpay.ly/sandbox/pay/cs_test_abc123',
      status: 'paid',
      live: false,
      amount: '500.00',
      currency: 'LYD',
      reference: 'DEP-202611-001',
      expires_at: '2026-11-03T18:00:00Z',
      payment: {
        tx_id: 'TX_998877',
        amount_charged: '500.00',
        fee_amount: '5.00',
        paid_at: '2026-11-03T17:10:00Z',
      },
    },
  };

  const res = normalizeDpayPayload(apiResp);
  assert.equal(res.success, true);
  if (res.success) {
    assert.equal(res.data.id, 'cs_test_abc123');
    assert.equal(res.data.status, 'paid');
    assert.equal(res.data.amount, '500.00');
    assert.equal(res.data.currency, 'LYD');
    assert.equal(res.data.reference, 'DEP-202611-001');
    assert.equal(res.data.live, false);
    assert.equal(res.data.payment?.tx_id, 'TX_998877');
    assert.equal(res.data.payment?.fee_amount, '5.00');
  }
});

test('normalizes checkout.completed webhook with numeric amounts', () => {
  const webhookBody = {
    event: 'checkout.completed',
    live: false,
    checkout_session_id: 'cs_test_hook456',
    status: 'paid',
    amount: 125.5,
    currency: 'LYD',
    reference: 'DEP-202611-002',
    payment: {
      tx_id: 'TX_112233',
      amount_charged: 125.5,
      fee_amount: 1.25,
      paid_at: '2026-11-03T17:20:00Z',
    },
  };

  const res = normalizeDpayPayload(webhookBody);
  assert.equal(res.success, true);
  if (res.success) {
    assert.equal(res.data.id, 'cs_test_hook456');
    assert.equal(res.data.status, 'paid');
    assert.equal(res.data.amount, '125.50');
    assert.equal(res.data.payment?.amount_charged, '125.50');
    assert.equal(res.data.payment?.fee_amount, '1.25');
  }
});

test('normalizes payment.paid webhook with top-level fields and session_id', () => {
  const webhookBody = {
    event: 'payment.paid',
    live: true,
    session_id: 'cs_live_7788',
    status: 'paid',
    amount: 250,
    system_reference: 'DEP-202611-003',
    tx_id: 'TX_PAY_5544',
    amount_charged: 250,
    fee_amount: 2.5,
    paid_at: '2026-11-03T17:30:00Z',
  };

  const res = normalizeDpayPayload(webhookBody);
  assert.equal(res.success, true);
  if (res.success) {
    assert.equal(res.data.id, 'cs_live_7788');
    assert.equal(res.data.status, 'paid');
    assert.equal(res.data.amount, '250.00');
    assert.equal(res.data.reference, 'DEP-202611-003');
    assert.equal(res.data.live, true);
    assert.equal(res.data.payment?.tx_id, 'TX_PAY_5544');
    assert.equal(res.data.payment?.amount_charged, '250.00');
  }
});

test('rejects paid status when payment details or tx_id are completely missing', () => {
  const badPaid = {
    checkout_session_id: 'cs_test_bad',
    status: 'paid',
    amount: '100.00',
    reference: 'DEP-001',
  };
  const res = normalizeDpayPayload(badPaid);
  assert.equal(res.success, false);
  if (!res.success) {
    assert.equal(res.reason, 'missing_payment_details');
  }
});

test('rejects missing session id', () => {
  const res = normalizeDpayPayload({ status: 'open', amount: '100.00' });
  assert.equal(res.success, false);
  if (!res.success) {
    assert.equal(res.reason, 'missing_session_id');
  }
});

test('normalizes open, expired and cancelled checkouts without payment info', () => {
  const openRes = normalizeDpayPayload({ id: 'cs_test_open', status: 'open', amount: '50.00', reference: 'DEP-OP' });
  assert.equal(openRes.success, true);
  if (openRes.success) {
    assert.equal(openRes.data.status, 'open');
    assert.equal(openRes.data.payment, null);
  }

  const expRes = normalizeDpayPayload({ id: 'cs_test_exp', status: 'expired', amount: '50.00', reference: 'DEP-EX' });
  assert.equal(expRes.success, true);
  if (expRes.success) {
    assert.equal(expRes.data.status, 'expired');
  }

  const canRes = normalizeDpayPayload({ id: 'cs_test_can', status: 'cancelled', amount: '50.00', reference: 'DEP-CN' });
  assert.equal(canRes.success, true);
  if (canRes.success) {
    assert.equal(canRes.data.status, 'cancelled');
  }
});
