// Cron (every 5 min, header x-cron-secret): re-reads pending DPay checkouts and applies the same idempotent transition.
// For hosts DPay's webhook cannot reach, THIS is the settlement path (per DPay docs). <= 30 reads per run (rate limit 120/min).
import { admin, json, requireCronSecret, rpc, serve } from "../_shared/lib.ts";
import { DpayError, envOfCheckoutId, getCheckout } from "../_shared/dpay.ts";
import { normalizeDpayPayload } from "../_shared/dpay-normalize.ts";

serve(async (req) => {
  requireCronSecret(req);
  const rows = await rpc<{ checkout_id: string; deposit_order_id: string }[]>("list_reconcilable_checkouts", {
    p_hours: 24,
    p_limit: 30,
  });
  const outcomes: Record<string, number> = {};
  let errors = 0,
    stopped = false;
  for (const r of rows ?? []) {
    try {
      const rawCheckout = await getCheckout(envOfCheckoutId(r.checkout_id), r.checkout_id);
      const norm = normalizeDpayPayload(rawCheckout);
      if (norm.success) {
        const outcome = await rpc<string>("apply_checkout", {
          p_checkout_id: r.checkout_id,
          p_checkout: norm.data,
        });
        outcomes[outcome] = (outcomes[outcome] ?? 0) + 1;
      } else {
        errors++;
        outcomes["normalize_fail"] = (outcomes["normalize_fail"] ?? 0) + 1;
      }
    } catch (e) {
      errors++;
      if (e instanceof DpayError && e.status === 429) {
        stopped = true;
        break;
      } // back off, next run continues
      console.error("reconcile_item_failed", r.checkout_id, e instanceof Error ? e.message : String(e));
    }
  }
  await admin.rpc("record_health_check", {
    p_name: "dpay_reconcile",
    p_status: errors === 0 ? "ok" : "degraded",
    p_detail: { checked: rows?.length ?? 0, errors, stopped_by_rate_limit: stopped, outcomes },
  });
  return json(req, { checked: rows?.length ?? 0, errors, outcomes });
});
