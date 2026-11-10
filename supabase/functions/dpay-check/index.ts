// POST {}  (Bearer user JWT) — admin "test connection" button. Requires settings.write. Never returns secrets or raw provider bodies.
import { admin, HttpError, json, rateLimit, requireUser, serve } from "../_shared/lib.ts";
import { currentMode, DpayError, listPayMethods, webhookSecrets } from "../_shared/dpay.ts";

serve(async (req) => {
  const user = await requireUser(req);
  const { data: ok } = await admin.rpc("actor_has_permission", { p_actor: user.id, p: "settings.write" });
  if (!ok) throw new HttpError(403, "forbidden");
  await rateLimit(`dpay-check:${user.id}`, 6, 60);

  const mode = await currentMode();
  const secrets = webhookSecrets();
  let result:
    | "ok"
    | "token_missing"
    | "unauthorized"
    | "unreachable"
    | "network_timeout"
    | "rate_limited"
    | "environment_mismatch"
    | "error" = "ok";
  let diagnostic = "DPay API connection verified successfully";

  try {
    await listPayMethods(mode);
  } catch (e) {
    if (e instanceof DpayError) {
      if (e.code === "token_missing") {
        result = "token_missing";
        diagnostic = `Token for ${mode} environment is not configured in Supabase secrets`;
      } else if (e.status === 401 || e.status === 403) {
        result = "unauthorized";
        diagnostic = "DPay rejected credentials (invalid token or missing permissions)";
      } else if (e.status === 429) {
        result = "rate_limited";
        diagnostic = "DPay rate limit exceeded (too many requests)";
      } else if (e.code === "network_timeout") {
        result = "network_timeout";
        diagnostic = "Connection to DPay timed out (> 15 seconds)";
      } else if (e.code === "network") {
        result = "unreachable";
        diagnostic = "Unable to establish network connection to dpay.ly";
      } else {
        result = "error";
        diagnostic = e.detail || `Provider responded with HTTP ${e.status}`;
      }
    } else {
      result = "error";
      diagnostic = "Unexpected error during connectivity check";
    }
  }

  await admin.rpc("record_health_check", {
    p_name: "dpay_connectivity",
    p_status: result === "ok" ? "ok" : "down",
    p_detail: { mode, result, diagnostic, checked_by: user.id },
  });

  return json(req, {
    mode,
    result,
    diagnostic,
    webhook_secret_configured: {
      sandbox: secrets.some((s) => s.env === "sandbox"),
      live: secrets.some((s) => s.env === "live"),
    },
  });
});
