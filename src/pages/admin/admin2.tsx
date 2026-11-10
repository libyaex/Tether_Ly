import { useEffect, useState } from "react";
import { Link, useNav, useParams } from "../../lib/router";
import { supabase, must } from "../../lib/supabase";
import { api, fn, saveText } from "../../lib/api";
import { useAsync, useDebounced } from "../../lib/hooks";
import { useAuth } from "../../lib/auth";
import { Async, Badge, Banner, Button, Card, Confirm, DataTable, Empty, Field, Input, Modal, Pager, Select, Stat, Tabs, Textarea, useAction, type Col } from "../../components/ui";
import { Icon } from "../../components/Icon";
import { ACCOUNT, CATEGORY, KIND, ROLE, TICKET } from "../../lib/labels";
import { ago, dt, lyd, usdt } from "../../lib/format";
import { validAmount, cleanAmount } from "../../lib/decimal";
import { useSettings } from "../../lib/settings";
import { TicketThread } from "../app2";

const PAGE = 20, SAFE = /^[\p{L}\p{N}@._\- ]{1,64}$/u;

// ---------------------------------------------------------------- Users
export function AdminUsers() {
  const { navigate } = useNav(); const [q, setQ] = useState(""); const [status, setStatus] = useState(""); const [page, setPage] = useState(0); const dq = useDebounced(q.trim());
  const list = useAsync(async () => {
    let qy = supabase.from("profiles").select("id,full_name,email,phone,status,created_at,wallets(available,held)", { count: "exact" });
    if (status) qy = qy.eq("status", status); if (dq && SAFE.test(dq)) qy = qy.or(`full_name.ilike.%${dq}%,email.ilike.%${dq}%`);
    const { data, count, error } = await qy.order("created_at", { ascending: false }).range(page * PAGE, page * PAGE + PAGE - 1); if (error) throw new Error("internal_error"); return { rows: data ?? [], count: count ?? 0 };
  }, [dq, status, page]);
  return (<><h1>المستخدمون</h1><Card className="flat"><div className="grid2 keep">
    <Field id="uq" label="بحث (اسم / بريد)"><Input id="uq" value={q} onChange={(e) => { setQ(e.target.value); setPage(0); }} /></Field>
    <Field id="us" label="الحالة"><Select id="us" value={status} onChange={(e) => { setStatus(e.target.value); setPage(0); }}><option value="">الكل</option>{Object.entries(ACCOUNT).map(([v, l]) => <option key={v} value={v}>{l.text}</option>)}</Select></Field></div></Card>
    <Async state={list}>{(r) => <><DataTable rows={r.rows} onRow={(u) => navigate(`/admin/users/${u.id}`)} cols={[{ key: "n", label: "الاسم", render: (u) => u.full_name }, { key: "e", label: "البريد", render: (u) => <span className="mono">{u.email}</span> }, { key: "st", label: "الحالة", render: (u) => <Badge label={ACCOUNT[u.status]} /> }, { key: "b", label: "المتاح", render: (u) => lyd((u.wallets as any)?.available ?? (u.wallets as any)?.[0]?.available ?? 0) }, { key: "c", label: "التسجيل", render: (u) => ago(u.created_at) }]} /><Pager page={page} pageSize={PAGE} count={r.count} onPage={setPage} /></>}</Async></>);
}
export function AdminUserDetail() {
  const { id } = useParams(); const { has } = useAuth(); const [dlg, setDlg] = useState(false);
  const st = useAsync(async () => {
    const [u, w, o] = await Promise.all([must<any>(supabase.from("profiles").select("*").eq("id", id).single()), must<any>(supabase.from("wallets").select("available,held").eq("user_id", id).single()),
      Promise.all(["deposit_orders", "buy_orders", "sell_orders"].map((t) => must<any[]>(supabase.from(t).select("id,ref,status,created_at").eq("user_id", id).order("created_at", { ascending: false }).limit(10)).then((r) => r.map((x) => ({ ...x, t })))))]);
    const accs = await must<any[]>(supabase.from("ledger_accounts").select("id").eq("owner_user_id", id)); const ids = new Set(accs.map((a) => a.id));
    const led = await must<any[]>(supabase.from("ledger_entries").select("id,direction,amount,created_at,account_id,ledger_transactions(kind)").in("account_id", [...ids]).order("created_at", { ascending: false }).limit(30));
    return { u, w, led, orders: o.flat().sort((a, b) => +new Date(b.created_at) - +new Date(a.created_at)) };
  }, [id]);
  return (<><Link to="/admin/users" className="small">← المستخدمون</Link>
    <Async state={st}>{({ u, w, led, orders }) => (<>
      <div className="row between"><h1>{u.full_name}</h1><Badge label={ACCOUNT[u.status]} /></div>
      <Card><dl className="kv"><dt>البريد</dt><dd className="mono">{u.email}</dd><dt>الهاتف</dt><dd className="mono">{u.phone ?? "—"}</dd><dt>التسجيل</dt><dd>{dt(u.created_at)}</dd><dt>المتاح</dt><dd>{lyd(w.available)}</dd><dt>المحجوز</dt><dd>{lyd(w.held)}</dd></dl>
        {has("users.restrict") && <div className="row wrap" style={{ marginTop: ".75rem" }}><Button variant="ghost" onClick={() => setDlg(true)}>تغيير حالة الحساب</Button></div>}
        <p className="small muted">لا يملك أي موظف تعديل الرصيد مباشرة. التسويات الاستثنائية من صفحة «التسويات المالية» وتحتاج موافقة شخص ثانٍ.</p></Card>
      <Card title="آخر الطلبات"><DataTable rows={orders} cols={[{ key: "t", label: "النوع", render: (o) => ({ deposit_orders: "شحن", buy_orders: "شراء", sell_orders: "بيع" } as any)[o.t] }, { key: "r", label: "المرجع", render: (o) => <Link className="mono" to={o.t === "deposit_orders" ? `/admin/orders/deposit/${o.id}` : `/admin/orders/${o.t === "buy_orders" ? "buy" : "sell"}/${o.id}`}>{o.ref}</Link> }, { key: "s", label: "الحالة", render: (o) => o.status }, { key: "c", label: "التاريخ", render: (o) => ago(o.created_at) }]} empty="لا توجد طلبات" /></Card>
      <Card title="سجل حركات المحفظة"><DataTable rows={led} cols={[{ key: "k", label: "العملية", render: (r) => KIND[r.ledger_transactions?.kind] ?? "حركة" }, { key: "d", label: "الاتجاه", render: (r) => (r.direction === "credit" ? "إيداع" : "خصم") }, { key: "a", label: "المبلغ", render: (r) => lyd(r.amount) }, { key: "t", label: "التاريخ", render: (r) => dt(r.created_at) }]} empty="لا توجد حركات" /></Card>
      {dlg && <StatusDialog u={u} onClose={() => setDlg(false)} done={st.reload} />}</>)}</Async></>);
}
function StatusDialog({ u, onClose, done }: { u: any; onClose: () => void; done: () => void }) {
  const [s, setS] = useState(u.status); const [reason, setReason] = useState(""); const { run, busy } = useAction();
  return <Modal title="تغيير حالة الحساب" onClose={onClose}><Field id="st" label="الحالة الجديدة"><Select id="st" value={s} onChange={(e) => setS(e.target.value)}>{Object.entries(ACCOUNT).map(([v, l]) => <option key={v} value={v}>{l.text}</option>)}</Select></Field>
    <Field id="sr" label="السبب (يُسجَّل في سجل التدقيق)"><Textarea id="sr" value={reason} onChange={(e) => setReason(e.target.value)} /></Field>
    <Button variant={s === "active" ? undefined : "danger"} busy={busy} disabled={s === u.status || reason.trim().length < 5} onClick={async () => { const r = await run(() => api("user.set_status", { user_id: u.id, status: s, reason: reason.trim() }), "تم تحديث الحالة"); if (r !== undefined) { done(); onClose(); } }}>تأكيد</Button></Modal>;
}

// ---------------------------------------------------------------- Staff & roles
export function AdminStaff() {
  const { session } = useAuth(); const { run, busy } = useAction(); const [email, setEmail] = useState(""); const [role, setRole] = useState("support_agent"); const [revoke, setRevoke] = useState<any>(null);
  const list = useAsync(async () => { const roles = await must<any[]>(supabase.from("user_roles").select("user_id,role,granted_at,revoked_at").is("revoked_at", null));
    const ids = [...new Set(roles.map((r) => r.user_id))]; const ps = ids.length ? await must<any[]>(supabase.from("profiles").select("id,full_name,email").in("id", ids)) : []; const m = Object.fromEntries(ps.map((p) => [p.id, p]));
    return roles.map((r) => ({ ...r, id: `${r.user_id}:${r.role}`, p: m[r.user_id] })); }, []);
  async function grant() { const u = await must<any>(supabase.from("profiles").select("id").ilike("email", email.trim()).maybeSingle()); if (!u) { await run(async () => { throw new Error("not_found"); }); return; }
    const r = await run(() => api("role.grant", { user_id: u.id, role }), "تم منح الدور"); if (r !== undefined) { setEmail(""); list.reload(); } }
  return (<><h1>الموظفون والأدوار</h1>
    <Card title="منح دور" sub="يجب أن يكون للمستخدم حساب نشط. أدوار «مدير» و«مدير عام» يمنحها المدير العام فقط."><div className="grid2"><Field id="se" label="بريد المستخدم"><Input id="se" className="ltr" value={email} onChange={(e) => setEmail(e.target.value)} /></Field><Field id="sro" label="الدور"><Select id="sro" value={role} onChange={(e) => setRole(e.target.value)}>{Object.entries(ROLE).map(([v, l]) => <option key={v} value={v}>{l}</option>)}</Select></Field></div><Button busy={busy} disabled={!email.includes("@")} onClick={grant}>منح</Button></Card>
    <Card title="الموظفون الحاليون"><Async state={list}>{(rows) => <DataTable rows={rows} cols={[{ key: "n", label: "الاسم", render: (r) => r.p?.full_name }, { key: "e", label: "البريد", render: (r) => <span className="mono">{r.p?.email}</span> }, { key: "r", label: "الدور", render: (r) => ROLE[r.role] }, { key: "g", label: "منذ", render: (r) => ago(r.granted_at) }, { key: "x", label: "", render: (r) => r.user_id !== session?.user.id ? <Button size="sm" variant="ghost" onClick={() => setRevoke(r)}>سحب</Button> : <span className="muted small">أنت</span> }]} />}</Async></Card>
    {revoke && <Confirm danger title="سحب الدور" confirmText="سحب" body={<p>سيفقد {revoke.p?.full_name} صلاحيات «{ROLE[revoke.role]}» فورًا.</p>} onClose={() => setRevoke(null)} onConfirm={async () => { await api("role.revoke", { user_id: revoke.user_id, role: revoke.role }); list.reload(); }} />}</>);
}

// ---------------------------------------------------------------- Adjustments (two-person)
export function AdminAdjustments() {
  const { session } = useAuth(); const { run, busy } = useAction(); const [open, setOpen] = useState(false); const [f, setF] = useState({ account: "", dir: "credit", amount: "", reason: "" });
  const accs = useAsync(() => must<any[]>(supabase.from("ledger_accounts").select("id,code,name,kind,currency,owner_user_id").neq("kind", "suspense").order("code")), []);
  const list = useAsync(() => must<any[]>(supabase.from("adjustment_requests").select("*, ledger_accounts(code,currency)").order("created_at", { ascending: false }).limit(50)), []);
  const sys = (accs.data ?? []).filter((a) => !a.owner_user_id);
  return (<><div className="row between"><h1>التسويات المالية</h1><Button size="sm" onClick={() => setOpen(true)}><Icon name="plus" size={16} />طلب تسوية</Button></div>
    <Banner tone="warn">كل تسوية تحتاج طلبًا من موظف واعتمادًا من موظف آخر، وتُرحَّل بقيد محاسبي موثق مقابل حساب التسوية. لا حذف ولا تعديل للقيود. لإدخال رصيد افتتاحي للسيولة (النقد أو USDT) استخدم حساب الشركة المناسب.</Banner>
    <Card><Async state={list}>{(rows) => <DataTable rows={rows} empty="لا توجد طلبات تسوية" cols={[{ key: "a", label: "الحساب", render: (r) => <span className="mono">{r.ledger_accounts?.code}</span> }, { key: "d", label: "الاتجاه", render: (r) => (r.direction === "debit" ? "مدين" : "دائن") }, { key: "m", label: "المبلغ", render: (r) => (r.ledger_accounts?.currency === "USDT" ? usdt(r.amount) : lyd(r.amount)) }, { key: "r", label: "السبب", render: (r) => r.reason }, { key: "s", label: "الحالة", render: (r) => <Badge label={r.status === "approved" ? { text: "معتمدة", tone: "ok" } : r.status === "rejected" ? { text: "مرفوضة", tone: "bad" } : { text: "بانتظار الاعتماد", tone: "wait" }} /> },
      { key: "x", label: "", render: (r) => r.status === "pending" && r.requested_by !== session?.user.id ? <div className="row"><Button size="sm" busy={busy} onClick={async () => { await run(() => api("adjustment.decide", { request_id: r.id, approve: true }), "تم الاعتماد"); list.reload(); }}>اعتماد</Button><Button size="sm" variant="ghost" onClick={async () => { await run(() => api("adjustment.decide", { request_id: r.id, approve: false }), "رُفض الطلب"); list.reload(); }}>رفض</Button></div> : r.status === "pending" ? <span className="small muted">بانتظار موظف آخر</span> : null }]} />}</Async></Card>
    {open && <Modal title="طلب تسوية" onClose={() => setOpen(false)}><Field id="aa" label="الحساب"><Select id="aa" value={f.account} onChange={(e) => setF({ ...f, account: e.target.value })}><option value="">اختر…</option>{sys.map((a) => <option key={a.id} value={a.id}>{a.name} ({a.currency})</option>)}</Select></Field>
      <div className="grid2 keep"><Field id="ad" label="الاتجاه"><Select id="ad" value={f.dir} onChange={(e) => setF({ ...f, dir: e.target.value })}><option value="debit">مدين (يزيد الأصول)</option><option value="credit">دائن</option></Select></Field><Field id="am" label="المبلغ"><Input id="am" className="ltr" inputMode="decimal" value={f.amount} onChange={(e) => setF({ ...f, amount: cleanAmount(e.target.value) })} /></Field></div>
      <Field id="ar" label="السبب (10 أحرف على الأقل)"><Textarea id="ar" value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })} /></Field>
      <p className="small muted">تسوية أرصدة العملاء الفردية تتم من ملف المستخدم عبر هذا الطلب بتحديد حسابه؛ هنا حسابات الشركة.</p>
      <Button busy={busy} disabled={!f.account || !validAmount(f.amount, 8) || f.reason.trim().length < 10} onClick={async () => { const r = await run(() => api("adjustment.request", { account_id: f.account, direction: f.dir, amount: f.amount, reason: f.reason.trim() }), "أُرسل الطلب للاعتماد"); if (r !== undefined) { setOpen(false); list.reload(); } }}>إرسال للاعتماد</Button></Modal>}</>);
}

// ---------------------------------------------------------------- Support queue
export function AdminSupport() {
  const { navigate } = useNav(); const [status, setStatus] = useState("pending_staff");
  const list = useAsync(() => must<any[]>(supabase.from("support_tickets").select("*, profiles(full_name)").eq("status", status).order("priority").order("created_at").limit(100)), [status]);
  return (<><h1>الدعم الفني</h1><Tabs value={status} onChange={setStatus} items={[{ id: "pending_staff", label: "بانتظار الدعم" }, { id: "pending_customer", label: "بانتظار العميل" }, { id: "closed", label: "مغلقة" }]} />
    <Async state={list}>{(rows) => <DataTable rows={rows} onRow={(t) => navigate(`/admin/support/${t.id}`)} empty="لا توجد تذاكر" cols={[{ key: "s", label: "العنوان", render: (t) => t.subject }, { key: "c", label: "العميل", render: (t) => t.profiles?.full_name }, { key: "k", label: "التصنيف", render: (t) => CATEGORY[t.category] }, { key: "p", label: "الأولوية", render: (t) => ({ low: "منخفضة", normal: "عادية", high: "عالية", urgent: "عاجلة" } as any)[t.priority] }, { key: "w", label: "الانتظار", render: (t) => ago(t.updated_at) }, { key: "st", label: "الحالة", render: (t) => <Badge label={TICKET[t.status]} /> }]} />}</Async></>);
}
export const AdminTicket = () => <TicketThread staff />;

// ---------------------------------------------------------------- Reports
const iso = (d: Date) => d.toISOString();
export function AdminReports() {
  const [range, setRange] = useState("30"); const [cf, setCf] = useState(""); const [ct, setCt] = useState(""); const { run, busy } = useAction();
  const now = new Date(); const start = range === "today" ? new Date(new Date().setHours(0, 0, 0, 0)) : range === "month" ? new Date(now.getFullYear(), now.getMonth(), 1) : range === "custom" && cf ? new Date(cf) : new Date(Date.now() - Number(range) * 864e5);
  const end = range === "custom" && ct ? new Date(`${ct}T23:59:59`) : new Date(Date.now() + 6e4);
  const r = useAsync(() => api<any>("report.range", { from: iso(start), to: iso(end) }), [range, cf, ct]);
  const dash = useAsync(() => api<any>("report.dashboard"), []);
  return (<><h1>التقارير المالية</h1>
    <Tabs value={range} onChange={setRange} items={[{ id: "today", label: "اليوم" }, { id: "7", label: "7 أيام" }, { id: "30", label: "30 يومًا" }, { id: "month", label: "الشهر الحالي" }, { id: "custom", label: "فترة مخصصة" }]} />
    {range === "custom" && <div className="grid2 keep"><Field id="cf" label="من"><Input id="cf" type="date" value={cf} onChange={(e) => setCf(e.target.value)} /></Field><Field id="ct" label="إلى"><Input id="ct" type="date" value={ct} onChange={(e) => setCt(e.target.value)} /></Field></div>}
    <Async state={r} lines={6}>{(m) => (<>
      <Card title="الشحن"><div className="grid3"><Stat k="مكتمل" v={m.deposits.paid_count} /><Stat k="إجمالي المشحون" v={lyd(m.deposits.paid_total_lyd)} /><Stat k="فاشل/منتهٍ" v={m.deposits.failed_count} /><Stat k="معلّق" v={m.deposits.pending_count} /><Stat k="رسوم المزوّد (كما أبلغ المزوّد)" v={lyd(m.deposits.provider_fees_reported)} /></div></Card>
      <Card title="شراء USDT"><div className="grid3"><Stat k="الطلبات" v={m.buy.count} /><Stat k="المكتملة" v={m.buy.completed} /><Stat k="المرفوضة" v={m.buy.rejected} /><Stat k="المعلّقة" v={m.buy.pending} /><Stat k="حجم المكتمل" v={lyd(m.buy.completed_volume_lyd)} /><Stat k="USDT المسلَّمة" v={usdt(m.buy.completed_usdt)} /><Stat k="رسوم محصّلة" v={lyd(m.buy.fees_lyd)} /></div></Card>
      <Card title="بيع USDT"><div className="grid3"><Stat k="الطلبات" v={m.sell.count} /><Stat k="المكتملة" v={m.sell.completed} /><Stat k="المرفوضة/المنتهية" v={m.sell.rejected} /><Stat k="المعلّقة" v={m.sell.pending} /><Stat k="حجم المكتمل" v={lyd(m.sell.completed_volume_lyd)} /><Stat k="USDT المستلمة" v={usdt(m.sell.completed_usdt)} /><Stat k="رسوم محصّلة" v={lyd(m.sell.fees_lyd)} /></div></Card>
      <Card title="الإيرادات والتسويات"><div className="grid3"><Stat k="إيراد الرسوم (من الدفتر)" v={lyd(m.fee_revenue_lyd)} /><Stat k="مدفوعات معتمدة للعملاء" v={lyd(m.payouts_total_lyd)} /><Stat k="تسويات معتمدة" v={m.adjustments_approved} /></div>
        <Banner tone="info">لا يُعرض «صافي الربح» عمدًا: يتطلب تكلفة اقتناء USDT وتكاليف الشبكات والتحويل غير المسجلة في الدفتر حاليًا. حجم التداول والرسوم يُعرضان منفصلين.</Banner></Card>
      <Card title="مقارنة الالتزامات بالمتاح" sub="الرصيد الداخلي لا يُفترض أنه يساوي السيولة الفعلية.">
        <Async state={dash}>{(d) => <><div className="grid3"><Stat k="التزامات: محافظ العملاء" v={lyd(m.liabilities.customer_wallets_lyd)} /><Stat k="التزامات: مستحق قيد الصرف" v={lyd(m.liabilities.customer_payable_lyd)} /><Stat k="المتاح: نقد (الدفتر)" v={lyd(d.company_cash_lyd)} /><Stat k="المتاح: مقاصة المزوّد" v={lyd(d.provider_clearing_lyd)} /><Stat k="USDT (الدفتر)" v={usdt(d.company_usdt)} /><Stat k="اختلافات الدفتر" v={d.reconciliation_mismatches} /></div>
          <p className="small" style={{ marginTop: ".5rem" }}>الالتزامات الإجمالية: <strong className="num">{lyd(Number(m.liabilities.customer_wallets_lyd) + Number(m.liabilities.customer_payable_lyd))}</strong> مقابل المتاح بالدينار: <strong className="num">{lyd(Number(d.company_cash_lyd) + Number(d.provider_clearing_lyd))}</strong></p></>}</Async></Card></>)}</Async>
    <Card title="تصدير"><div className="row wrap">{(["deposits", "buy", "sell"] as const).map((k) => <Button key={k} variant="ghost" size="sm" busy={busy} onClick={async () => { const t = await run(() => fn<string>("export-csv", { scope: "orders", kind: k, from: iso(start), to: iso(end) })); if (typeof t === "string") saveText(`${k}-orders.csv`, t); }}><Icon name="download" size={16} />{k === "deposits" ? "الشحن" : k === "buy" ? "الشراء" : "البيع"} CSV</Button>)}</div></Card></>);
}

// ---------------------------------------------------------------- Audit & health
export function AdminAudit() {
  const [page, setPage] = useState(0); const [ent, setEnt] = useState("");
  const list = useAsync(async () => { let q = supabase.from("audit_logs").select("*", { count: "exact" }); if (ent) q = q.eq("entity_type", ent);
    const { data, count, error } = await q.order("created_at", { ascending: false }).range(page * PAGE, page * PAGE + PAGE - 1); if (error) throw new Error("internal_error");
    const ids = [...new Set((data ?? []).map((x: any) => x.actor_id).filter(Boolean))]; const ps = ids.length ? await must<any[]>(supabase.from("profiles").select("id,full_name").in("id", ids)) : [];
    const m = Object.fromEntries(ps.map((p) => [p.id, p.full_name])); return { rows: (data ?? []).map((x: any) => ({ ...x, actor_name: m[x.actor_id] })), count: count ?? 0 }; }, [page, ent]);
  return (<><h1>سجل التدقيق</h1><p className="muted small">سجل لا يقبل التعديل أو الحذف.</p><Field id="ae" label="نوع الكيان"><Select id="ae" value={ent} onChange={(e) => { setEnt(e.target.value); setPage(0); }}><option value="">الكل</option>{["buy_orders", "sell_orders", "deposit_orders", "exchange_rates", "admin_settings", "user_roles", "profiles", "supported_networks", "deposit_addresses", "adjustment_requests", "payout_records"].map((x) => <option key={x}>{x}</option>)}</Select></Field>
    <Async state={list}>{(r) => <><DataTable rows={r.rows.map((x: any) => ({ ...x, id: String(x.id) }))} cols={[{ key: "t", label: "الوقت", render: (x) => dt(x.created_at) }, { key: "a", label: "المنفّذ", render: (x) => x.actor_name ?? "النظام" }, { key: "ac", label: "الإجراء", render: (x) => x.action }, { key: "e", label: "الكيان", render: (x) => x.entity_type }, { key: "i", label: "المعرّف", render: (x) => <span className="mono">{String(x.entity_id ?? "").slice(0, 8)}</span> }, { key: "n", label: "ملاحظة", render: (x) => x.note ?? "—" }]} /><Pager page={page} pageSize={PAGE} count={r.count} onPage={setPage} /></>}</Async></>);
}
export function AdminHealth() {
  const ev = useAsync(
    () =>
      must<any[]>(
        supabase.from("payment_provider_events").select("id,event,checkout_session_id,outcome,received_at")
          .in("outcome", ["quarantined", "mismatch", "unknown_session"]).order("received_at", { ascending: false }).limit(20),
      ),
    [],
  );
  const h = useAsync(async () => {
    const rows = await must<any[]>(supabase.from("system_health_checks").select("*").order("checked_at", { ascending: false }).limit(200));
    const latest = new Map<string, any>();
    rows.forEach((r) => !latest.has(r.check_name) && latest.set(r.check_name, r));
    return [...latest.values()];
  }, []);
  const tone = {
    ok: { text: "سليم", tone: "ok" as const },
    degraded: { text: "متدهور", tone: "warn" as const },
    down: { text: "متوقف", tone: "bad" as const },
  };
  const NAMES: Record<string, string> = {
    wallet_ledger_consistency: "اتساق الدفتر مع أرصدة المحافظ",
    liquidity: "السيولة (الدينار وUSDT)",
    dpay_connectivity: "الاتصال بمزوّد الدفع DPay",
    dpay_webhook: "آخر إشعار Webhook من DPay",
    dpay_reconcile: "المطابقة الدورية مع DPay",
  };
  const STALE_MIN = 15;
  return (
    <>
      <div className="row between wrap">
        <h1>صحة النظام</h1>
        <Button variant="ghost" onClick={h.reload}>تحديث</Button>
      </div>
      <p className="muted small">
        تعرض هذه الصفحة آخر نتيجة فعلية لكل فحص. تُسجَّل النتائج تلقائيًا كل 5 دقائق بواسطة المهمتين الدوريتين ops-cron وreconcile-deposits.
      </p>
      <Async state={h}>
        {(rows) => {
          if (rows.length === 0)
            return <Banner tone="warn" icon="alert">لا توجد نتائج فحص بعد. تأكد من تشغيل المهام الدورية (راجع docs/DEPLOYMENT.md، قسم الجدولة).</Banner>;
          const newest = Math.max(...rows.map((r) => new Date(r.checked_at).getTime()));
          const minutes = Math.round((Date.now() - newest) / 60000);
          return (
            <>
              {minutes > STALE_MIN && (
                <Banner tone="bad" icon="alert">آخر فحص مسجّل قبل {minutes} دقيقة؛ المهام الدورية متوقفة أو متأخرة. هذه النتائج قد لا تعكس الحالة الحالية.</Banner>
              )}
              <Card title="الفحوصات">
                <ul className="list">
                  {rows.map((r) => (
                    <li key={r.check_name}>
                      <div className="item">
                        <span className="grow">
                          {NAMES[r.check_name] ?? r.check_name}
                          <div className="small muted">{dt(r.checked_at)}</div>
                          {r.status !== "ok" && r.detail && <div className="small muted ltr mono">{JSON.stringify(r.detail)}</div>}
                        </span>
                        <Badge label={tone[r.status as keyof typeof tone] ?? tone.down} />
                      </div>
                    </li>
                  ))}
                </ul>
              </Card>
            </>
          );
        }}
      </Async>
      <Card title="إشعارات دفع تحتاج مراجعة" sub="إشعارات من DPay لم تُطبَّق تلقائيًا (عدم تطابق المبلغ/المرجع، أو طلب في حالة نهائية). لا يُضاف رصيد لها دون مراجعة موظف.">
        <Async state={ev}>
          {(rows) =>
            rows.length === 0 ? (
              <p className="muted small">لا توجد إشعارات معلّقة.</p>
            ) : (
              <ul className="list">
                {rows.map((r) => (
                  <li key={r.id}>
                    <div className="item">
                      <span className="grow">
                        <span className="mono ltr">{String(r.checkout_session_id).slice(0, 24)}</span>
                        <div className="small muted">{r.event} · {dt(r.received_at)}</div>
                      </span>
                      <Badge label={{ text: r.outcome, tone: "warn" }} />
                    </div>
                  </li>
                ))}
              </ul>
            )
          }
        </Async>
      </Card>
    </>
  );
}
