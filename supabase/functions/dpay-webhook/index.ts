// DPay → us. Verify signature over RAW bytes, enforce 5-minute window, split environments, dedupe, normalize, then apply.
// Always answers 2xx for events we have understood (even duplicates/ignored); 5xx only when processing must be retried.
import { admin, verifyHmacSha256 } from "../_shared/lib.ts";
import { currentMode, webhookSecrets } from "../_shared/dpay.ts";
import { normalizeDpayPayload } from "../_shared/dpay-normalize.ts";

const enc = new TextEncoder();
const res = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

async function health(status: "ok" | "degraded" | "down", detail: Record<string, unknown>) {
  await admin.rpc("record_health_check", { p_name: "dpay_webhook", p_status: status, p_detail: detail });
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return res(405, { error: "method_not_allowed" });

  const raw = new Uint8Array(await req.arrayBuffer());
  if (raw.byteLength > 256 * 1024) return res(413, { error: "too_large" });
  const timestamp = req.headers.get("x-dpay-timestamp") ?? "";
  const signature = req.headers.get("x-dpay-signature") ?? "";
  const eventHeader = req.headers.get("x-dpay-event") ?? "";

  // 1. replay window (5 minutes)
  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || Math.abs(Date.now() / 1000 - ts) > 300) {
    return res(400, { error: "stale_or_invalid_timestamp" });
  }

  // 2. signature over `${timestamp}.${rawBody}` (bytes), try each configured endpoint secret
  const signed = new Uint8Array([...enc.encode(`${timestamp}.`), ...raw]);
  let sigEnv: "live" | "sandbox" | null = null;
  for (const { env, secret } of webhookSecrets()) {
    if (await verifyHmacSha256(secret, signed, signature)) {
      sigEnv = env;
      break;
    }
  }
  if (!sigEnv) {
    // Do not store the untrusted payload; keep a rate-limited breadcrumb only.
    const { data: ok } = await admin.rpc("check_rate_limit", {
      p_key: "webhook-bad-signature",
      p_max: 20,
      p_window_secs: 60,
    });
    if (ok) await health("degraded", { reason: "invalid_signature" });
    return res(400, { error: "invalid_signature" });
  }

  let body: any;
  try {
    body = JSON.parse(new TextDecoder().decode(raw));
  } catch {
    return res(400, { error: "invalid_json" });
  }

  // 3. Normalization layer: normalize variations across checkout.*, payment.*, and wrapped { data: ... }
  const normResult = normalizeDpayPayload(body, eventHeader);
  if (!normResult.success) {
    return res(400, { error: normResult.reason });
  }
  const normalized = normResult.data;
  const event = String(normalized.raw_event ?? eventHeader);
  const checkoutId = normalized.id;

  // 4. environment split: the secret's environment, the payload's `live` flag and the system mode must all agree
  if (normalized.live !== (sigEnv === "live")) {
    return res(400, { error: "environment_mismatch" });
  }
  const mode = await currentMode();

  // 5. record (dedupe key: provider + event + checkout_session_id)
  await admin.from("payment_provider_events").upsert(
    {
      provider: "dpay",
      event,
      checkout_session_id: checkoutId,
      live: normalized.live,
      signature_valid: true,
      payload: body,
    },
    { onConflict: "provider,event,checkout_session_id", ignoreDuplicates: true }
  );

  if (sigEnv !== mode) {
    await admin
      .from("payment_provider_events")
      .update({ outcome: "ignored_env", processed_at: new Date().toISOString() })
      .eq("provider", "dpay")
      .eq("event", event)
      .eq("checkout_session_id", checkoutId);
    return res(200, { ok: true, outcome: "ignored_env" });
  }

  // 6. apply (idempotent in database; re-running duplicate is safe)
  const { data: outcome, error } = await admin.rpc("apply_checkout", {
    p_checkout_id: checkoutId,
    p_checkout: normalized,
  });
  if (error) {
    console.error("apply_checkout_failed", error.message);
    await health("degraded", { reason: "apply_failed", event });
    return res(500, { error: "processing_failed" }); // DPay retries: +1m, +5m, +15m, +1h
  }

  await admin
    .from("payment_provider_events")
    .update({ outcome, processed_at: new Date().toISOString() })
    .eq("provider", "dpay")
    .eq("event", event)
    .eq("checkout_session_id", checkoutId);

  await health("ok", { event, outcome });
  return res(200, { ok: true, outcome });
});
