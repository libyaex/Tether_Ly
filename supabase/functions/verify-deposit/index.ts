// POST { deposit_order_id }  — called by the app's return page. The return URL's query string is only a hint:
// we re-read the checkout from DPay with OUR token, normalize it, and run the same idempotent transition as webhook/reconciler.
import { admin, HttpError, json, rateLimit, requireUser, rpc, serve } from "../_shared/lib.ts";
import { DpayError, envOfCheckoutId, getCheckout } from "../_shared/dpay.ts";
import { normalizeDpayPayload } from "../_shared/dpay-normalize.ts";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

serve(async (req) => {
  const user = await requireUser(req);
  await rateLimit(`verify:${user.id}`, 20, 60);
  const body = await req.json().catch(() => null);
  const id = String(body?.deposit_order_id ?? "");
  if (!UUID.test(id)) throw new HttpError(422, "invalid_id");

  const { data: order } = await admin.from("deposit_orders").select("id,status,user_id,amount,ref").eq("id", id).maybeSingle();
  if (!order || order.user_id !== user.id) throw new HttpError(404, "not_found");

  let outcome = "noop";
  if (order.status === "awaiting_payment" || order.status === "expired") {
    const { data: s } = await admin
      .from("dpay_checkout_sessions")
      .select("checkout_id")
      .eq("deposit_order_id", id)
      .order("attempt", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (s) {
      try {
        const rawCheckout = await getCheckout(envOfCheckoutId(s.checkout_id), s.checkout_id);
        const norm = normalizeDpayPayload(rawCheckout);
        if (norm.success) {
          outcome = await rpc<string>("apply_checkout", {
            p_checkout_id: s.checkout_id,
            p_checkout: norm.data,
          });
        } else {
          console.error("normalization_failed_for_checkout", s.checkout_id, norm.reason);
          outcome = "payload_error";
        }
      } catch (e) {
        if (e instanceof DpayError) {
          console.error("dpay_read_failed", e.status);
          outcome = "provider_unavailable";
        } else {
          throw e;
        }
      }
    }
  }
  const { data: fresh } = await admin.from("deposit_orders").select("status").eq("id", id).single();
  return json(req, { status: fresh?.status ?? order.status, outcome });
});
