// Normalization and validation layer for DPay Hosted Checkout API v2 responses and webhooks.
// Unifies:
// 1. GET /api/v2/checkout-sessions/{id}
// 2. Webhook: checkout.completed, checkout.expired, checkout.cancelled
// 3. Webhook: payment.paid, payment.failed, payment.expired
// Handles differences in field names (checkout_session_id, session_id, id),
// nested vs top-level payment details, and numeric vs string amounts.

export interface NormalizedPayment {
  tx_id: string;
  amount_charged: string;
  fee_amount: string;
  paid_at: string;
}

export type NormalizedStatus = "open" | "paid" | "expired" | "cancelled" | "failed" | "unknown";

export interface NormalizedCheckout {
  id: string;
  status: NormalizedStatus;
  amount: string; // strictly 2 decimals string, e.g. "125.50"
  currency: string; // "LYD"
  reference: string;
  live: boolean;
  expires_at?: string;
  payment: NormalizedPayment | null;
  raw_event?: string;
}

export type NormalizationResult =
  | { success: true; data: NormalizedCheckout }
  | { success: false; reason: "missing_session_id" | "invalid_amount" | "missing_payment_details" | "invalid_payload" };

/**
 * Normalizes any numerical or string amount to a strict 2-decimal string.
 * Example: 102.5 -> "102.50", "102" -> "102.00", "102.55" -> "102.55"
 */
export function normalizeAmount(raw: unknown): string | null {
  if (raw === null || raw === undefined) return null;
  const str = String(raw).trim();
  if (!/^\d+(\.\d{1,4})?$/.test(str)) return null;
  const parts = str.split(".");
  const intPart = parts[0];
  const decPart = (parts[1] ?? "").padEnd(2, "0").slice(0, 2);
  return `${intPart}.${decPart}`;
}

/**
 * Extracts and maps raw status string to canonical NormalizedStatus
 */
export function normalizeStatus(rawStatus?: string, event?: string): NormalizedStatus {
  const s = String(rawStatus ?? "").toLowerCase();
  const ev = String(event ?? "").toLowerCase();

  if (s === "paid" || s === "completed" || s === "succeeded" || ev === "checkout.completed" || ev === "payment.paid") {
    return "paid";
  }
  if (s === "expired" || ev === "checkout.expired" || ev === "payment.expired") {
    return "expired";
  }
  if (s === "cancelled" || s === "canceled" || ev === "checkout.cancelled" || ev === "payment.cancelled") {
    return "cancelled";
  }
  if (s === "failed" || ev === "payment.failed") {
    return "failed";
  }
  if (s === "open" || s === "pending" || s === "awaiting_payment" || s === "created") {
    return "open";
  }
  return "unknown";
}

/**
 * Normalizes raw API response or Webhook payload into a canonical NormalizedCheckout.
 */
export function normalizeDpayPayload(raw: any, eventHeader?: string): NormalizationResult {
  if (!raw || typeof raw !== "object") {
    return { success: false, reason: "invalid_payload" };
  }

  // Unwrap { data: ... } if present
  const obj = raw.data && typeof raw.data === "object" && !Array.isArray(raw.data) ? raw.data : raw;

  // 1. Session ID extraction across schemas
  const idRaw =
    obj.checkout_session_id ??
    raw.checkout_session_id ??
    obj.session_id ??
    raw.session_id ??
    obj.id ??
    raw.id;

  const id = idRaw !== undefined && idRaw !== null ? String(idRaw).trim() : "";
  if (!id) {
    return { success: false, reason: "missing_session_id" };
  }

  // 2. Status & Event
  const event = String(raw.event ?? obj.event ?? eventHeader ?? "");
  const status = normalizeStatus(obj.status ?? raw.status, event);

  // 3. Amount
  const rawAmt = obj.amount ?? raw.amount ?? obj.total_amount;
  const amount = normalizeAmount(rawAmt);
  if (!amount) {
    return { success: false, reason: "invalid_amount" };
  }

  // 4. Currency & Reference
  const currency = String(obj.currency ?? raw.currency ?? "LYD").toUpperCase();
  const reference = String(
    obj.reference ??
    raw.reference ??
    obj.system_reference ??
    raw.system_reference ??
    obj.metadata?.reference ??
    raw.metadata?.reference ??
    ""
  ).trim();

  // 5. Environment (live flag)
  const live = Boolean(obj.live ?? raw.live ?? false);

  // 6. Payment details
  let payment: NormalizedPayment | null = null;
  const rawPayment = obj.payment ?? raw.payment;

  if (rawPayment && typeof rawPayment === "object") {
    const tx_id = String(rawPayment.tx_id ?? rawPayment.transaction_id ?? rawPayment.id ?? "").trim();
    const amount_charged = normalizeAmount(rawPayment.amount_charged ?? rawPayment.amount ?? amount) ?? amount;
    const fee_amount = normalizeAmount(rawPayment.fee_amount ?? rawPayment.fee ?? "0") ?? "0.00";
    const paid_at = String(rawPayment.paid_at ?? rawPayment.created_at ?? new Date().toISOString());

    if (tx_id) {
      payment = { tx_id, amount_charged, fee_amount, paid_at };
    }
  } else if (status === "paid") {
    // Check top-level payment fields (common in payment.paid webhook)
    const tx_id = String(obj.tx_id ?? raw.tx_id ?? obj.transaction_id ?? raw.transaction_id ?? "").trim();
    if (tx_id) {
      const amount_charged = normalizeAmount(obj.amount_charged ?? raw.amount_charged ?? amount) ?? amount;
      const fee_amount = normalizeAmount(obj.fee_amount ?? raw.fee_amount ?? "0") ?? "0.00";
      const paid_at = String(obj.paid_at ?? raw.paid_at ?? new Date().toISOString());
      payment = { tx_id, amount_charged, fee_amount, paid_at };
    }
  }

  // Verification rule: If status is paid, payment.tx_id MUST be present
  if (status === "paid" && (!payment || !payment.tx_id)) {
    return { success: false, reason: "missing_payment_details" };
  }

  const expires_at = obj.expires_at ?? raw.expires_at ? String(obj.expires_at ?? raw.expires_at) : undefined;

  return {
    success: true,
    data: {
      id,
      status,
      amount,
      currency,
      reference,
      live,
      expires_at,
      payment,
      raw_event: event || undefined,
    },
  };
}

/** Environment a checkout id belongs to (documented: sandbox ids are cs_test_…). */
export function envOfCheckoutId(id: string): "sandbox" | "live" {
  return id.startsWith("cs_test_") ? "sandbox" : "live";
}

/** The hosted page must live on dpay.ly — never redirect a customer anywhere else. */
export function assertDpayUrl(url: string): void {
  const u = new URL(url);
  if (u.protocol !== "https:" || !(u.hostname === "dpay.ly" || u.hostname.endsWith(".dpay.ly"))) {
    throw new Error("Unexpected checkout URL host (must be https://dpay.ly)");
  }
}
