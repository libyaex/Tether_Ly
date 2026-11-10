// POST { scope: "mine" } | { scope: "orders", kind: "deposits"|"buy"|"sell", from, to, status? }
// "mine": the caller's own wallet statement. "orders": staff export, requires orders.read; every export is audited.
import { admin, HttpError, rateLimit, requireUser, serve, corsHeaders } from "../_shared/lib.ts";

const MAX_ROWS = 5000;
const cell = (v: unknown): string => {
  let s = v === null || v === undefined ? "" : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;                     // CSV/formula injection guard
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
function csv(req: Request, name: string, header: string[], rows: unknown[][]) {
  const text = "\uFEFF" + [header, ...rows].map((r) => r.map(cell).join(",")).join("\r\n");
  return new Response(text, { headers: { ...corsHeaders(req), "Content-Type": "text/csv; charset=utf-8",
    "Content-Disposition": `attachment; filename="${name}"`, "Cache-Control": "no-store" } });
}
const iso = (v: unknown, d: Date) => { const t = Date.parse(String(v ?? "")); return new Date(Number.isNaN(t) ? d.getTime() : t).toISOString(); };

serve(async (req) => {
  const user = await requireUser(req);
  await rateLimit(`export:${user.id}`, 6, 60);
  const b = await req.json().catch(() => ({}));
  const from = iso(b.from, new Date(Date.now() - 30 * 864e5)), to = iso(b.to, new Date(Date.now() + 864e5));

  if (b.scope === "mine") {
    const { data: w } = await admin.from("wallets").select("available_account_id,held_account_id").eq("user_id", user.id).single();
    if (!w) throw new HttpError(404, "not_found");
    const { data, error } = await admin.from("ledger_entries")
      .select("created_at,direction,amount,currency,account_id,ledger_transactions(kind,reference_type,reference_id,description)")
      .in("account_id", [w.available_account_id, w.held_account_id]).gte("created_at", from).lt("created_at", to)
      .order("created_at", { ascending: false }).limit(MAX_ROWS);
    if (error) { console.error("export_failed", error.message); throw new HttpError(500, "internal_error"); }
    return csv(req, "wallet-statement.csv",
      ["date", "bucket", "direction", "amount", "currency", "kind", "reference_type", "reference_id"],
      (data ?? []).map((r: any) => [r.created_at, r.account_id === w.held_account_id ? "held" : "available", r.direction, r.amount,
        r.currency, r.ledger_transactions?.kind, r.ledger_transactions?.reference_type, r.ledger_transactions?.reference_id]));
  }

  if (b.scope === "orders") {
    const { data: ok } = await admin.rpc("actor_has_permission", { p_actor: user.id, p: "orders.read" });
    if (!ok) throw new HttpError(403, "forbidden");
    const kind = String(b.kind);
    const table = kind === "deposits" ? "deposit_orders" : kind === "buy" ? "buy_orders" : kind === "sell" ? "sell_orders" : null;
    if (!table) throw new HttpError(422, "invalid_kind");
    let q = admin.from(table).select("*").gte("created_at", from).lt("created_at", to).order("created_at", { ascending: false }).limit(MAX_ROWS);
    if (typeof b.status === "string" && b.status) q = q.eq("status", b.status);
    const { data, error } = await q;
    if (error) { console.error("export_failed", error.message); throw new HttpError(500, "internal_error"); }
    await admin.from("audit_logs").insert({ actor_id: user.id, action: "export_csv", entity_type: table,
      note: JSON.stringify({ from, to, status: b.status ?? null, rows: data?.length ?? 0 }) });
    // Never export payout snapshots / raw provider payloads wholesale: whitelist columns per table.
    const cols: Record<string, string[]> = {
      deposit_orders: ["id", "ref", "user_id", "amount", "status", "provider_amount_charged", "provider_fee", "provider_tx_id", "created_at", "updated_at"],
      buy_orders: ["id", "ref", "user_id", "status", "price", "fee_pct", "usdt_amount", "lyd_gross", "lyd_fee", "lyd_total", "network_code", "receive_address", "executed_by", "executed_at", "created_at"],
      sell_orders: ["id", "ref", "user_id", "status", "price", "fee_pct", "usdt_expected", "usdt_received", "lyd_gross", "lyd_fee", "lyd_net", "network_code", "deposit_verified_by", "created_at"],
    };
    return csv(req, `${kind}-orders.csv`, cols[table], (data ?? []).map((r: any) => cols[table].map((c) => r[c])));
  }
  throw new HttpError(422, "invalid_scope");
});
