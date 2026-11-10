// Cron (every 5 min, header x-cron-secret): ledger consistency, liquidity/SLA alerts, sell-order expiry, housekeeping,
// and a DPay connectivity probe. Results are written to system_health_checks (visible to staff).
import { admin, json, requireCronSecret, rpc, serve } from "../_shared/lib.ts";
import { currentMode, DpayError, listPayMethods } from "../_shared/dpay.ts";

serve(async (req) => {
  requireCronSecret(req);
  const ops = await rpc("run_ops_checks", {});
  const expired = await rpc<number>("expire_sell_orders", {});
  const purged = await rpc<number>("purge_rate_limits", {});

  const mode = await currentMode();
  let dpay = "ok";
  try { await listPayMethods(mode); }
  catch (e) { dpay = e instanceof DpayError && e.code === "token_missing" ? "not_configured" : "down"; }
  await admin.rpc("record_health_check", {
    p_name: "dpay_connectivity",
    p_status: dpay === "ok" ? "ok" : dpay === "not_configured" ? "degraded" : "down",
    p_detail: { mode, result: dpay },
  });
  return json(req, { ops, expired_sell_orders: expired, purged_rate_limits: purged, dpay });
});
