// DPay hosted checkout (v2) client. Endpoints/fields verified against https://dpay.ly/docs/api.
import { setting } from "./lib.ts";

export type Mode = "sandbox" | "live";

export class DpayError extends Error {
  constructor(public status: number, public code: string | null, public detail: string) {
    super(detail);
    this.name = "DpayError";
  }
}

export async function currentMode(): Promise<Mode> {
  const v = await setting("payments.dpay_mode");
  return v === "live" ? "live" : "sandbox"; // anything unexpected falls back to the safe sandbox environment
}

export function tokenFor(mode: Mode): string {
  const t = Deno.env.get(mode === "live" ? "DPAY_TOKEN_LIVE" : "DPAY_TOKEN_SANDBOX");
  if (!t) throw new DpayError(503, "token_missing", `DPAY_TOKEN_${mode.toUpperCase()} is not configured`);
  return t;
}

export function webhookSecrets(): { env: Mode; secret: string }[] {
  const out: { env: Mode; secret: string }[] = [];
  const l = Deno.env.get("DPAY_WEBHOOK_SECRET_LIVE");
  const s = Deno.env.get("DPAY_WEBHOOK_SECRET_SANDBOX");
  if (l) out.push({ env: "live", secret: l });
  if (s) out.push({ env: "sandbox", secret: s });
  return out;
}

const BASE = (Deno.env.get("DPAY_BASE_URL") ?? "https://dpay.ly").replace(/\/+$/, "");
if (!BASE.startsWith("https://")) throw new Error("DPAY_BASE_URL must be https");

export async function call<T>(
  mode: Mode,
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {}
): Promise<{ status: number; data: T }> {
  let res: Response;
  try {
    res = await fetch(`${BASE}/api${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${tokenFor(mode)}`,
        "Content-Type": "application/json",
        Accept: "application/json",
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(15_000),
    });
  } catch (err: any) {
    const isTimeout = err?.name === "TimeoutError" || err?.name === "AbortError";
    throw new DpayError(503, isTimeout ? "network_timeout" : "network", "DPay unreachable");
  }

  const text = await res.text();
  let parsed: any = null;
  try {
    parsed = text ? JSON.parse(text) : null;
  } catch {
    /* non-JSON response */
  }

  if (!res.ok) {
    // RFC 7807: { type, title, status, detail, code?, errors? }
    throw new DpayError(
      res.status,
      parsed?.code ?? null,
      String(parsed?.detail ?? parsed?.message ?? `HTTP ${res.status}`).slice(0, 300)
    );
  }
  return { status: res.status, data: parsed as T };
}

export interface Checkout {
  id: string;
  url: string;
  status: "open" | "paid" | "expired" | "cancelled";
  live: boolean;
  amount: string;
  currency: string;
  reference: string | null;
  expires_at: string;
  payment: null | {
    tx_id: string;
    amount_charged: string;
    fee_amount: string;
    paid_at: string;
  };
}

export async function createCheckout(
  mode: Mode,
  input: {
    amount: string;
    reference: string;
    description: string;
    returnUrl: string;
    cancelUrl: string;
    idempotencyKey: string;
    expiresInMinutes: number;
    metadata: Record<string, string | number>;
    customer?: {
      name?: string | null;
      phone?: string | null;
      email?: string | null;
    };
  }
): Promise<Checkout> {
  if (input.idempotencyKey.length > 64) {
    throw new DpayError(422, "idempotency_key_too_long", "Idempotency-Key > 64");
  }
  const { data } = await call<any>(
    mode,
    "POST",
    "/v2/checkout-sessions",
    {
      amount: input.amount,
      currency: "LYD",
      reference: input.reference,
      description: input.description,
      return_url: input.returnUrl,
      cancel_url: input.cancelUrl,
      expires_in_minutes: input.expiresInMinutes,
      locale: "ar",
      metadata: input.metadata,
      customer: input.customer,
    },
    { "Idempotency-Key": input.idempotencyKey }
  );
  return data?.data ?? data;
}

export async function getCheckout(mode: Mode, id: string): Promise<Checkout> {
  const { data } = await call<any>(mode, "GET", `/v2/checkout-sessions/${encodeURIComponent(id)}`);
  return data?.data ?? data;
}

/**
 * Searches for an existing checkout by our internal reference.
 * Used during recovery when a previous network call timed out.
 */
export async function getCheckoutByReference(mode: Mode, reference: string): Promise<Checkout | null> {
  try {
    const { data } = await call<any>(mode, "GET", `/v2/checkout-sessions?reference=${encodeURIComponent(reference)}`);
    const list = data?.data ?? data;
    if (Array.isArray(list) && list.length > 0) {
      return list[0];
    }
    return null;
  } catch {
    return null;
  }
}

export async function cancelCheckout(mode: Mode, id: string): Promise<void> {
  await call(mode, "POST", `/v2/checkout-sessions/${encodeURIComponent(id)}/cancel`);
}

export async function listPayMethods(mode: Mode): Promise<unknown> {
  const { data } = await call(mode, "GET", "/pay-methods");
  return data?.data ?? data;
}

export { envOfCheckoutId, assertDpayUrl } from "./dpay-normalize.ts";
