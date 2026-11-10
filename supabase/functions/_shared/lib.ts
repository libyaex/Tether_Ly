// Shared helpers for all Edge Functions. Server-side only; uses the service-role key Supabase injects.
import { createClient } from "npm:@supabase/supabase-js@2.45.4";

export const admin = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  { auth: { persistSession: false, autoRefreshToken: false } },
);

export class HttpError extends Error {
  constructor(public status: number, public code: string) { super(code); }
}

// ---------- CORS (explicit allow-list; never "*")
const allowedOrigins = (Deno.env.get("ALLOWED_ORIGINS") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
export function corsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get("origin") ?? "";
  const h: Record<string, string> = {
    "Vary": "Origin",
    "Access-Control-Allow-Headers": "authorization, content-type, x-client-info, apikey",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
  };
  if (allowedOrigins.includes(origin)) h["Access-Control-Allow-Origin"] = origin;
  return h;
}

export function json(req: Request, body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders(req), "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

/** CORS preflight, POST-only, uniform error bodies, never leaks internals. */
export function serve(fn: (req: Request) => Promise<Response>) {
  Deno.serve(async (req) => {
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders(req) });
    try {
      if (req.method !== "POST") throw new HttpError(405, "method_not_allowed");
      return await fn(req);
    } catch (e) {
      if (e instanceof HttpError) return json(req, { error: e.code }, e.status);
      console.error("unhandled", e instanceof Error ? e.message : String(e));
      return json(req, { error: "internal_error" }, 500);
    }
  });
}

// ---------- auth
export async function requireUser(req: Request) {
  const m = (req.headers.get("authorization") ?? "").match(/^Bearer (.+)$/i);
  if (!m) throw new HttpError(401, "unauthenticated");
  const { data, error } = await admin.auth.getUser(m[1]);
  if (error || !data.user) throw new HttpError(401, "unauthenticated");
  return data.user;
}

// ---------- RPC error contract: only known codes reach the client
const codes = (status: number, list: string[]) => list.map((c) => [c, status] as [string, number]);
const KNOWN = new Map<string, number>([
  ...codes(403, ["forbidden", "self_dealing", "separation_of_duties", "account_not_active", "target_not_active"]),
  ...codes(404, ["not_found", "unknown_session"]),
  ...codes(409, ["illegal_transition", "quote_used", "quote_expired", "txid_already_used", "payout_already_recorded",
    "method_in_use", "already_exists", "already_assigned", "ticket_closed", "last_super_admin", "payout_not_recorded"]),
  ...codes(422, ["quote_invalid", "invalid_side", "exactly_one_amount_required", "invalid_amount", "out_of_limits",
    "network_inactive", "invalid_address", "insufficient_balance", "daily_limit_exceeded", "trading_disabled",
    "maintenance", "no_rate", "invalid_target", "reason_required", "confirmation_mismatch", "txid_required",
    "invalid_txid", "invalid_proof_path", "amount_mismatch", "note_required", "reference_required", "proof_required",
    "invalid_type", "holder_required", "bank_required", "invalid_iban", "invalid_account_number", "too_many_methods",
    "invalid_payout_method", "no_deposit_address", "below_network_minimum", "invalid_decision", "topups_disabled",
    "topup_limits_not_configured", "large_rate_change_confirm_required", "invalid_value", "confirmation_required",
    "live_readiness_failed", "assignee_not_eligible", "invalid_account", "too_many_open_tickets", "related_not_found",
    "reopen_window_passed", "reopen_limit", "invalid_endpoint", "invalid_attachment_path", "invalid_price",
    "paid_without_payment_details", "invalid_regex", "invalid_network"]),
]);
export function fromRpcError(err: { message: string }): HttpError {
  const code = err.message.split(":")[0].trim();
  const status = KNOWN.get(code);
  if (status) return new HttpError(status, code);
  console.error("rpc_error", err.message);           // logged server-side only
  return new HttpError(500, "internal_error");
}

export async function rpc<T = unknown>(name: string, args: Record<string, unknown>): Promise<T> {
  const { data, error } = await admin.rpc(name, args);
  if (error) throw fromRpcError(error);
  return data as T;
}

// ---------- rate limiting (fails closed)
export async function rateLimit(key: string, max: number, windowSecs: number) {
  const { data, error } = await admin.rpc("check_rate_limit", { p_key: key, p_max: max, p_window_secs: windowSecs });
  if (error) { console.error("rate_limit_error", error.message); throw new HttpError(503, "temporarily_unavailable"); }
  if (!data) throw new HttpError(429, "rate_limited");
}

// ---------- crypto (pure helpers live in crypto.ts)
import { timingSafeEqual, verifyHmacSha256 } from "./crypto.ts";
export { timingSafeEqual, verifyHmacSha256 };
export function requireCronSecret(req: Request) {
  const expected = Deno.env.get("CRON_SECRET");
  const got = req.headers.get("x-cron-secret") ?? "";
  if (!expected || expected.length < 24 || !timingSafeEqual(got, expected)) throw new HttpError(401, "unauthenticated");
}

export async function setting(key: string): Promise<string | null> {
  const { data } = await admin.from("admin_settings").select("value").eq("key", key).maybeSingle();
  if (!data) return null;
  const v = data.value;
  return typeof v === "string" ? v : JSON.stringify(v);
}
