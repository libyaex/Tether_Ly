// Single authenticated gateway for every customer/staff business action.
//   POST { action: "buy.create", params: { ... } }   Authorization: Bearer <user JWT>
// Identity ALWAYS comes from the verified JWT (p_user / p_actor); the client can never choose it.
// Authorisation is enforced inside the database RPCs (actor_has_permission / ownership checks), not here.
// Only whitelisted actions exist; params are type-checked; errors map to a fixed code list.
import { HttpError, json, rateLimit, requireUser, rpc, serve } from "../_shared/lib.ts";

type P = Record<string, any>;
interface Spec { rpc: string; schema: Record<string, string>; args: (uid: string, p: P) => Record<string, unknown>; limit?: [number, number] }

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const VALID: Record<string, (v: unknown) => unknown | undefined> = {
  uuid: (v) => (typeof v === "string" && UUID.test(v) ? v : undefined),
  str: (v) => (typeof v === "string" && v.length <= 2000 ? v : undefined),
  dec: (v) => ((typeof v === "string" || typeof v === "number") && /^\d{1,16}(\.\d{1,8})?$/.test(String(v)) ? String(v) : undefined),
  bool: (v) => (typeof v === "boolean" ? v : undefined),
  ts: (v) => (typeof v === "string" && !Number.isNaN(Date.parse(v)) ? new Date(v).toISOString() : undefined),
  json: (v) => (JSON.stringify(v ?? null).length <= 10_000 && v !== undefined ? v : undefined),
};
function parse(schema: Record<string, string>, raw: P): P {
  const out: P = {};
  for (const [k, spec] of Object.entries(schema)) {
    const optional = spec.endsWith("?");
    const check = VALID[spec.replace("?", "")];
    const v = raw?.[k];
    if (v === undefined || v === null || v === "") {
      if (!optional) throw new HttpError(422, `missing_${k}`);
      out[k] = null; continue;
    }
    const ok = check(v);
    if (ok === undefined) throw new HttpError(422, `invalid_${k}`);
    out[k] = ok;
  }
  return out;
}

const MONEY: [number, number] = [10, 60];     // actions that create/move money: 10 per minute per user
const ACTIONS: Record<string, Spec> = {
  // ---- quotes & customer trading
  "quote.create": { rpc: "create_quote", schema: { side: "str" }, args: (u, p) => ({ p_user: u, p_side: p.side }) },
  "buy.create": { rpc: "create_buy_order", limit: MONEY,
    schema: { quote_id: "uuid", lyd_amount: "dec?", usdt_amount: "dec?", network: "str", address: "str" },
    args: (u, p) => ({ p_user: u, p_quote_id: p.quote_id, p_lyd_amount: p.lyd_amount, p_usdt_amount: p.usdt_amount, p_network: p.network, p_address: p.address }) },
  "buy.cancel": { rpc: "release_buy_order", schema: { order_id: "uuid" },
    args: (u, p) => ({ p_actor: u, p_order: p.order_id, p_to: "cancelled", p_reason: null }) },
  "sell.create": { rpc: "create_sell_order", limit: MONEY,
    schema: { quote_id: "uuid", usdt: "dec", network: "str", method_id: "uuid" },
    args: (u, p) => ({ p_user: u, p_quote_id: p.quote_id, p_usdt: p.usdt, p_network: p.network, p_method: p.method_id }) },
  "sell.cancel": { rpc: "cancel_sell_order", schema: { order_id: "uuid" }, args: (u, p) => ({ p_user: u, p_order: p.order_id }) },
  "sell.submit_txid": { rpc: "submit_sell_txid", limit: MONEY,
    schema: { order_id: "uuid", txid: "str", sender: "str?", proof_path: "str?" },
    args: (u, p) => ({ p_user: u, p_order: p.order_id, p_txid: p.txid, p_sender: p.sender, p_proof_path: p.proof_path }) },

  // ---- payout methods
  "payout_method.create": { rpc: "create_payout_method",
    schema: { type: "str", holder: "str?", bank: "str?", iban: "str?", account: "str?", make_default: "bool?" },
    args: (u, p) => ({ p_user: u, p_type: p.type, p_holder: p.holder, p_bank: p.bank, p_iban: p.iban, p_account: p.account, p_default: p.make_default ?? false }) },
  "payout_method.update": { rpc: "update_payout_method",
    schema: { method_id: "uuid", holder: "str", bank: "str", iban: "str?", account: "str?" },
    args: (u, p) => ({ p_user: u, p_method: p.method_id, p_holder: p.holder, p_bank: p.bank, p_iban: p.iban, p_account: p.account }) },
  "payout_method.set_default": { rpc: "set_default_payout_method", schema: { method_id: "uuid" }, args: (u, p) => ({ p_user: u, p_method: p.method_id }) },
  "payout_method.archive": { rpc: "archive_payout_method", schema: { method_id: "uuid" }, args: (u, p) => ({ p_user: u, p_method: p.method_id }) },

  // ---- support & push
  "ticket.create": { rpc: "create_ticket",
    schema: { category: "str", subject: "str", body: "str", related_type: "str?", related_id: "uuid?", attachment: "str?" },
    args: (u, p) => ({ p_user: u, p_category: p.category, p_subject: p.subject, p_body: p.body, p_related_type: p.related_type, p_related_id: p.related_id, p_attachment: p.attachment }) },
  "ticket.reply": { rpc: "reply_ticket", schema: { ticket_id: "uuid", body: "str", attachment: "str?" },
    args: (u, p) => ({ p_actor: u, p_ticket: p.ticket_id, p_body: p.body, p_attachment: p.attachment }) },
  "ticket.close": { rpc: "close_ticket", schema: { ticket_id: "uuid" }, args: (u, p) => ({ p_actor: u, p_ticket: p.ticket_id }) },
  "ticket.reopen": { rpc: "reopen_ticket", schema: { ticket_id: "uuid" }, args: (u, p) => ({ p_user: u, p_ticket: p.ticket_id }) },
  "push.register": { rpc: "register_push_subscription", schema: { endpoint: "str", p256dh: "str", auth: "str", user_agent: "str?" },
    args: (u, p) => ({ p_user: u, p_endpoint: p.endpoint, p_p256dh: p.p256dh, p_auth: p.auth, p_ua: p.user_agent }) },
  "push.revoke": { rpc: "revoke_push_subscription", schema: { endpoint: "str" }, args: (u, p) => ({ p_user: u, p_endpoint: p.endpoint }) },

  // ---- staff: buy orders
  "buy.set_status": { rpc: "buy_order_set_status", schema: { order_id: "uuid", to: "str" }, args: (u, p) => ({ p_actor: u, p_order: p.order_id, p_to: p.to }) },
  "buy.release": { rpc: "release_buy_order", limit: MONEY, schema: { order_id: "uuid", to: "str", reason: "str" },
    args: (u, p) => ({ p_actor: u, p_order: p.order_id, p_to: p.to, p_reason: p.reason }) },
  "buy.complete": { rpc: "complete_buy_order", limit: MONEY,
    schema: { order_id: "uuid", network: "str", address: "str", usdt_sent: "dec", txid: "str", note: "str?" },
    args: (u, p) => ({ p_actor: u, p_order: p.order_id, p_network: p.network, p_address: p.address, p_usdt_sent: p.usdt_sent, p_txid: p.txid, p_note: p.note }) },

  // ---- staff: sell orders & payouts
  "sell.review": { rpc: "review_sell_deposit", limit: MONEY,
    schema: { order_id: "uuid", decision: "str", usdt_received: "dec?", onchain_verified: "bool?", note: "str?" },
    args: (u, p) => ({ p_actor: u, p_order: p.order_id, p_decision: p.decision, p_usdt_received: p.usdt_received, p_onchain_verified: p.onchain_verified ?? false, p_note: p.note }) },
  "sell.record_payout": { rpc: "record_sell_payout", limit: MONEY, schema: { order_id: "uuid", external_reference: "str", proof_path: "str?" },
    args: (u, p) => ({ p_actor: u, p_order: p.order_id, p_external_reference: p.external_reference, p_proof_path: p.proof_path }) },
  "sell.approve_payout": { rpc: "approve_sell_payout", limit: MONEY, schema: { order_id: "uuid" }, args: (u, p) => ({ p_actor: u, p_order: p.order_id }) },
  "payout_method.verify": { rpc: "verify_payout_method", schema: { method_id: "uuid", result: "str" },
    args: (u, p) => ({ p_actor: u, p_method: p.method_id, p_result: p.result }) },
  "order.assign": { rpc: "assign_order", schema: { kind: "str", order_id: "uuid", assignee: "uuid" },
    args: (u, p) => ({ p_actor: u, p_kind: p.kind, p_order: p.order_id, p_assignee: p.assignee }) },
  "ticket.meta": { rpc: "set_ticket_meta", schema: { ticket_id: "uuid", priority: "str?", assignee: "uuid?" },
    args: (u, p) => ({ p_actor: u, p_ticket: p.ticket_id, p_priority: p.priority, p_assignee: p.assignee }) },

  // ---- admin
  "rate.publish": { rpc: "publish_rate", limit: MONEY,
    schema: { sell_price: "dec", buy_price: "dec", buy_fee_pct: "dec", sell_fee_pct: "dec", min_buy_lyd: "dec", max_buy_lyd: "dec",
      min_sell_usdt: "dec", max_sell_usdt: "dec", valid_from: "ts?", valid_to: "ts?", note: "str?", confirm_large: "bool?", notify: "bool?" },
    args: (u, p) => ({ p_actor: u, p_sell_price: p.sell_price, p_buy_price: p.buy_price, p_buy_fee_pct: p.buy_fee_pct, p_sell_fee_pct: p.sell_fee_pct,
      p_min_buy_lyd: p.min_buy_lyd, p_max_buy_lyd: p.max_buy_lyd, p_min_sell_usdt: p.min_sell_usdt, p_max_sell_usdt: p.max_sell_usdt,
      p_valid_from: p.valid_from, p_valid_to: p.valid_to, p_note: p.note, p_confirm_large: p.confirm_large ?? false, p_notify: p.notify ?? false }) },
  "setting.update": { rpc: "update_setting", schema: { key: "str", value: "json", confirm: "str?" },
    args: (u, p) => ({ p_actor: u, p_key: p.key, p_value: p.value, p_confirm: p.confirm }) },
  "role.grant": { rpc: "grant_role", schema: { user_id: "uuid", role: "str" }, args: (u, p) => ({ p_actor: u, p_user: p.user_id, p_role: p.role }) },
  "role.revoke": { rpc: "revoke_role", schema: { user_id: "uuid", role: "str" }, args: (u, p) => ({ p_actor: u, p_user: p.user_id, p_role: p.role }) },
  "user.set_status": { rpc: "set_user_status", schema: { user_id: "uuid", status: "str", reason: "str" },
    args: (u, p) => ({ p_actor: u, p_user: p.user_id, p_status: p.status, p_reason: p.reason }) },
  "adjustment.request": { rpc: "request_adjustment", limit: MONEY, schema: { account_id: "uuid", direction: "str", amount: "dec", reason: "str" },
    args: (u, p) => ({ p_actor: u, p_account: p.account_id, p_direction: p.direction, p_amount: p.amount, p_reason: p.reason }) },
  "adjustment.decide": { rpc: "decide_adjustment", limit: MONEY, schema: { request_id: "uuid", approve: "bool", note: "str?" },
    args: (u, p) => ({ p_actor: u, p_request: p.request_id, p_approve: p.approve, p_note: p.note }) },
  "network.upsert": { rpc: "upsert_network", schema: { code: "str", display_name: "str", status: "str", min_deposit: "dec", confirmations: "dec",
      address_regex: "str", explorer: "str?", instructions: "str?", warnings: "str?" },
    args: (u, p) => ({ p_actor: u, p_code: p.code, p_display_name: p.display_name, p_status: p.status, p_min_deposit: p.min_deposit,
      p_confirmations: Number(p.confirmations), p_address_regex: p.address_regex, p_explorer: p.explorer, p_instructions: p.instructions, p_warnings: p.warnings }) },
  "address.add": { rpc: "add_deposit_address", schema: { network: "str", address: "str", instructions: "str?" },
    args: (u, p) => ({ p_actor: u, p_network: p.network, p_address: p.address, p_instructions: p.instructions }) },
  "address.activate": { rpc: "activate_deposit_address", limit: MONEY, schema: { id: "uuid" }, args: (u, p) => ({ p_actor: u, p_id: p.id }) },
  "address.disable": { rpc: "disable_deposit_address", schema: { id: "uuid" }, args: (u, p) => ({ p_actor: u, p_id: p.id }) },
  "deposit.resolve": { rpc: "resolve_deposit_review", limit: MONEY, schema: { order_id: "uuid", decision: "str", provider_ref: "str?", note: "str" },
    args: (u, p) => ({ p_actor: u, p_order: p.order_id, p_decision: p.decision, p_provider_ref: p.provider_ref, p_note: p.note }) },
  "report.dashboard": { rpc: "admin_dashboard", schema: {}, args: (u) => ({ p_actor: u }) },
  "report.range": { rpc: "admin_report", schema: { from: "ts", to: "ts" }, args: (u, p) => ({ p_actor: u, p_from: p.from, p_to: p.to }) },
  "report.series": { rpc: "admin_daily_series", schema: { from: "ts", to: "ts" }, args: (u, p) => ({ p_actor: u, p_from: p.from, p_to: p.to }) },
};

serve(async (req) => {
  const user = await requireUser(req);
  const body = await req.json().catch(() => null);
  const action = String(body?.action ?? "");
  const spec = Object.hasOwn(ACTIONS, action) ? ACTIONS[action] : undefined;
  if (!spec) throw new HttpError(404, "unknown_action");

  await rateLimit(`api:${user.id}`, 120, 60);
  const [max, win] = spec.limit ?? [60, 60];
  await rateLimit(`api:${user.id}:${action}`, max, win);

  const params = parse(spec.schema, body?.params ?? {});
  const data = await rpc(spec.rpc, spec.args(user.id, params));
  return json(req, { data });
});
