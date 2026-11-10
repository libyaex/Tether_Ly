// POST { amount: "500.00" }  (Authorization: Bearer <user JWT>)
// Creates a pending deposit order, opens a DPay hosted checkout, returns the DPay page URL.
// The wallet is NEVER credited here; only apply_checkout() (after verification) credits it.
import { admin, HttpError, json, rateLimit, requireUser, rpc, serve, setting } from "../_shared/lib.ts";
import { assertDpayUrl, cancelCheckout, createCheckout, currentMode, DpayError, getCheckoutByReference } from "../_shared/dpay.ts";
import { normalizeAmount } from "../_shared/dpay-normalize.ts";

serve(async (req) => {
  const user = await requireUser(req);
  await rateLimit(`deposit:${user.id}`, 5, 60);

  const body = await req.json().catch(() => null);
  const rawAmt = typeof body?.amount === "string" || typeof body?.amount === "number" ? body.amount : "";
  const amount = normalizeAmount(rawAmt);
  if (!amount || !/^\d{1,12}\.\d{2}$/.test(amount)) throw new HttpError(422, "invalid_amount");

  const appBase = Deno.env.get("APP_BASE_URL");
  if (!appBase || !appBase.startsWith("https://")) throw new HttpError(503, "app_base_url_not_configured"); // DPay requires https return_url
  const mode = await currentMode();

  // 1. DB validates account status, switches, limits; creates the pending order.
  const order = await rpc<{ id: string; ref: string; amount: string }>("create_deposit_order", {
    p_user: user.id,
    p_amount: amount,
  });

  const attempt = 1;
  const idem = `dep:${order.id}:${attempt}`; // 42 chars (< 64); a retry replays the same session
  const ttl = Number(await setting("payments.checkout_ttl_minutes")) || 30;

  // 2. Open the hosted checkout. reference = our order ref (checked again in apply_checkout).
  let checkout;
  try {
    checkout = await createCheckout(mode, {
      amount: amount,
      reference: order.ref,
      description: `Wallet top-up ${order.ref}`,
      returnUrl: `${appBase.replace(/\/+$/, "")}/wallet/deposits/${order.id}/return`,
      cancelUrl: `${appBase.replace(/\/+$/, "")}/wallet/deposit`,
      idempotencyKey: idem,
      expiresInMinutes: Math.min(Math.max(ttl, 5), 1440),
      metadata: { deposit_order_id: order.id },
      customer: {
        name: user.user_metadata?.full_name || null,
        phone: user.user_metadata?.phone || null,
        email: user.email || null,
      },
    });
    assertDpayUrl(checkout.url);
    if (checkout.live !== (mode === "live")) {
      throw new DpayError(502, "environment_mismatch", "Checkout environment mismatch");
    }
  } catch (e: any) {
    const isNetwork = e instanceof DpayError && (e.code === "network" || e.code === "network_timeout");
    if (isNetwork) {
      // Indeterminate result: DPay might have created the session.
      // Try to recover by reference before giving up. DO NOT fail the order immediately.
      const existing = await getCheckoutByReference(mode, order.ref);
      if (existing && existing.url) {
        checkout = existing;
      } else {
        // Record intermediate review note without setting status to permanent failed
        await admin
          .from("deposit_orders")
          .update({ review_reason: "connection_interrupted_awaiting_reconciliation" })
          .eq("id", order.id)
          .eq("status", "pending");
        throw new HttpError(503, "provider_unavailable");
      }
    } else {
      // Definitive failure from provider (e.g. 400 validation error, limits)
      await admin
        .from("deposit_orders")
        .update({ status: "failed", review_reason: e?.code ?? "provider_error" })
        .eq("id", order.id)
        .eq("status", "pending");
      if (checkout?.id) await cancelCheckout(mode, checkout.id).catch(() => {});
      if (e instanceof DpayError) {
        console.error("dpay_create_failed", e.status, e.code);
        throw new HttpError(e.status === 429 ? 429 : 503, "provider_unavailable");
      }
      throw e;
    }
  }

  // 3. Persist the session (idempotent on the idempotency key).
  try {
    await rpc("attach_checkout_session", {
      p_order: order.id,
      p_checkout_id: checkout.id,
      p_idem: idem,
      p_attempt: attempt,
      p_live: checkout.live,
      p_url: checkout.url,
      p_expires_at: checkout.expires_at,
    });
  } catch (e) {
    await cancelCheckout(mode, checkout.id).catch(() => {});
    await admin
      .from("deposit_orders")
      .update({ status: "failed", review_reason: "attach_failed" })
      .eq("id", order.id)
      .eq("status", "pending");
    throw e;
  }
  return json(req, {
    deposit_order_id: order.id,
    ref: order.ref,
    redirect_url: checkout.url,
    expires_at: checkout.expires_at,
  });
});
