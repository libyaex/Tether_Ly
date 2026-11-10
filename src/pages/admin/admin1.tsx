import { useEffect, useMemo, useState } from "react";
import { Link, useNav, useParams } from "../../lib/router";
import { supabase, must } from "../../lib/supabase";
import { api, fn, saveText } from "../../lib/api";
import { ApiError, errorMessage } from "../../lib/errors";
import { useAsync, useDebounced } from "../../lib/hooks";
import { useAuth } from "../../lib/auth";
import { Async, Badge, Banner, Button, Card, Confirm, CopyText, DataTable, Field, Input, Modal, Pager, Select, Stat, Tabs, Textarea, useAction, type Col } from "../../components/ui";
import { Icon } from "../../components/Icon";
import { BUY, DEPOSIT, PAYOUT_TYPE, SELL } from "../../lib/labels";
import { ago, dt, lyd, price, usdt } from "../../lib/format";
import { calcBuy, calcSell, validAmount, cleanAmount } from "../../lib/decimal";
import { useToast } from "../../lib/toast";

const TABLE = { deposit: "deposit_orders", buy: "buy_orders", sell: "sell_orders" } as const;
type Kind = keyof typeof TABLE;
const LABELS = { deposit: DEPOSIT, buy: BUY, sell: SELL };
const AMOUNT = { deposit: "amount", buy: "lyd_total", sell: "lyd_net" } as const;
const SAFE = /^[A-Za-z0-9_\-]{1,64}$/;                 // anything interpolated into a PostgREST or() filter is whitelisted first
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

import { FinancialAnalytics } from "../../components/FinancialAnalytics";

// ---------------------------------------------------------------- Dashboard
export function AdminDashboard() {
  const d = useAsync(() => api<any>("report.dashboard"), []);
  return (<><h1>لوحة المؤشرات والتحليلات</h1>
    <FinancialAnalytics />
    <Async state={d} lines={5}>{(m) => (<>
      {m.reconciliation_mismatches > 0 && <Banner tone="bad"><strong>اختلاف محاسبي:</strong> {m.reconciliation_mismatches} محفظة لا يطابق رصيدها الدفتر. أوقف العمليات الحساسة وراجع <Link to="/admin/reports">التقارير</Link>.</Banner>}
      {m.needs_attention > 0 && <Banner tone="warn">{m.needs_attention} عنصر يحتاج مراجعة. <Link to="/admin/orders">افتح الطلبات</Link></Banner>}
      <div className="grid3" style={{ marginTop: "1rem" }}>
        <Stat k="المستخدمون" v={m.users_total} /><Stat k="النشطون" v={m.users_active} /><Stat k="شحن معلّق" v={m.deposits_pending} /><Stat k="شحن مكتمل" v={m.deposits_paid} />
        <Stat k="شراء مفتوح" v={m.buy_open} /><Stat k="بيع مفتوح" v={m.sell_open} /><Stat k="عمليات اليوم" v={m.orders_today} /><Stat k="فاشلة/مرفوضة اليوم" v={m.failed_today} /></div>
      <Card title="الأرصدة والسيولة" sub="لا يُفترض أن الرصيد الداخلي يساوي السيولة الفعلية؛ قارن الالتزامات بالمتاح.">
        <div className="grid3"><Stat k="أرصدة العملاء المتاحة" v={lyd(m.wallet_available_total)} /><Stat k="أرصدة العملاء المحجوزة" v={lyd(m.wallet_held_total)} /><Stat k="مستحق للعملاء (قيد الصرف)" v={lyd(m.customer_payable_lyd)} />
          <Stat k="السيولة النقدية بالدينار (الدفتر)" v={lyd(m.company_cash_lyd)} /><Stat k="مقاصة مزوّد الدفع" v={lyd(m.provider_clearing_lyd)} /><Stat k="رصيد USDT (الدفتر)" v={usdt(m.company_usdt)} /></div>
        <p className="small muted">الأرقام من دفتر الأستاذ. الأرصدة النقدية ورصيد USDT تتطلب إدخال أرصدة افتتاحية بتسوية موثقة (صفحة التسويات).</p></Card></>)}
    </Async></>);
}

// ---------------------------------------------------------------- Orders list
const PAGE = 20;
export function AdminOrders() {
  const { navigate } = useNav(); const { run, busy } = useAction();
  const [kind, setKind] = useState<Kind>("buy"); const [q, setQ] = useState(""); const [status, setStatus] = useState(""); const [from, setFrom] = useState(""); const [to, setTo] = useState("");
  const [min, setMin] = useState(""); const [max, setMax] = useState(""); const [network, setNetwork] = useState(""); const [mine, setMine] = useState(false); const [page, setPage] = useState(0);
  const [sort, setSort] = useState({ key: "created_at", asc: false }); const dq = useDebounced(q.trim());
  const { session } = useAuth();
  const list = useAsync(async () => {
    let ids: string[] = [];
    if (dq && SAFE.test(dq) && kind !== "deposit") {   // search by TXID / bank reference
      const t = await must<any[]>(supabase.from("usdt_transfers").select("id").ilike("txid", `%${dq}%`).limit(20)); ids = t.map((x) => x.id);
    }
    let qy = supabase.from(TABLE[kind]).select("*, profiles(full_name,email)", { count: "exact" });
    if (status) qy = qy.eq("status", status); if (from) qy = qy.gte("created_at", from); if (to) qy = qy.lte("created_at", `${to}T23:59:59`);
    if (min && validAmount(min, 2)) qy = qy.gte(AMOUNT[kind], min); if (max && validAmount(max, 2)) qy = qy.lte(AMOUNT[kind], max);
    if (network && kind !== "deposit") qy = qy.eq("network_code", network); if (mine && kind !== "deposit") qy = qy.eq("assigned_to", session!.user.id);
    if (dq) {
      if (UUID.test(dq)) qy = qy.or(`id.eq.${dq},user_id.eq.${dq}`);
      else if (SAFE.test(dq)) { const parts = [`ref.ilike.%${dq}%`]; if (ids.length && kind !== "deposit") parts.push(`${kind === "buy" ? "outgoing_transfer_id" : "incoming_transfer_id"}.in.(${ids.join(",")})`); qy = qy.or(parts.join(",")); }
      else return { rows: [] as any[], count: 0 };
    }
    const sk = sort.key === "amount" ? AMOUNT[kind] : "created_at";
    const { data, count, error } = await qy.order(sk, { ascending: sort.asc }).range(page * PAGE, page * PAGE + PAGE - 1);
    if (error) throw new Error("internal_error"); return { rows: data ?? [], count: count ?? 0 };
  }, [kind, dq, status, from, to, min, max, network, mine, page, sort.key, sort.asc]);
  const nets = useAsync(() => must<any[]>(supabase.from("supported_networks").select("code")), []);
  const cols: Col<any>[] = [
    { key: "ref", label: "المرجع", render: (r) => <span className="mono">{r.ref}</span> }, { key: "user", label: "العميل", render: (r) => r.profiles?.full_name ?? "—" },
    { key: "amount", label: kind === "sell" ? "الصافي" : "المبلغ", sortable: true, render: (r) => lyd(r[AMOUNT[kind]]) },
    ...(kind !== "deposit" ? [{ key: "usdt", label: "USDT", render: (r: any) => usdt(r.usdt_amount ?? r.usdt_expected) }, { key: "net", label: "الشبكة", render: (r: any) => r.network_code }] : []),
    { key: "status", label: "الحالة", render: (r) => <Badge label={LABELS[kind][r.status] ?? { text: r.status, tone: "wait" }} /> },
    ...(kind !== "deposit" ? [{ key: "flag", label: "", render: (r: any) => r.flagged_large ? <span className="badge warn" title="عملية كبيرة"><Icon name="alert" size={14} />كبيرة</span> : null }] : []),
    { key: "created_at", label: "التاريخ", sortable: true, render: (r) => ago(r.created_at) }];
  const reset = () => setPage(0);
  return (<>
    <div className="row between"><h1>الطلبات</h1>
      <Button size="sm" variant="ghost" busy={busy} onClick={async () => { const t = await run(() => fn<string>("export-csv", { scope: "orders", kind, status: status || undefined, from: from || undefined, to: to ? `${to}T23:59:59` : undefined })); if (typeof t === "string") saveText(`${kind}-orders.csv`, t); }}><Icon name="download" size={16} />تصدير CSV</Button></div>
    <Tabs value={kind} onChange={(k) => { setKind(k); setStatus(""); reset(); }} items={[{ id: "buy", label: "شراء USDT" }, { id: "sell", label: "بيع USDT" }, { id: "deposit", label: "الشحن" }]} />
    <Card className="flat"><div className="grid3">
      <Field id="oq" label="بحث (مرجع / معرّف مستخدم / TXID)"><Input id="oq" className="ltr" value={q} onChange={(e) => { setQ(e.target.value); reset(); }} /></Field>
      <Field id="os" label="الحالة"><Select id="os" value={status} onChange={(e) => { setStatus(e.target.value); reset(); }}><option value="">الكل</option>{Object.entries(LABELS[kind]).map(([v, l]) => <option key={v} value={v}>{l.text}</option>)}</Select></Field>
      <Field id="of" label="من"><Input id="of" type="date" value={from} onChange={(e) => { setFrom(e.target.value); reset(); }} /></Field>
      <Field id="ot" label="إلى"><Input id="ot" type="date" value={to} onChange={(e) => { setTo(e.target.value); reset(); }} /></Field>
      <Field id="omin" label="مبلغ من (د.ل)"><Input id="omin" className="ltr" inputMode="decimal" value={min} onChange={(e) => { setMin(e.target.value); reset(); }} /></Field>
      <Field id="omax" label="مبلغ إلى (د.ل)"><Input id="omax" className="ltr" inputMode="decimal" value={max} onChange={(e) => { setMax(e.target.value); reset(); }} /></Field>
      {kind !== "deposit" && <Field id="on" label="الشبكة"><Select id="on" value={network} onChange={(e) => { setNetwork(e.target.value); reset(); }}><option value="">الكل</option>{nets.data?.map((n) => <option key={n.code}>{n.code}</option>)}</Select></Field>}
      {kind !== "deposit" && <div className="field"><span className="lbl">الموظف</span><label className="check"><input type="checkbox" checked={mine} onChange={(e) => { setMine(e.target.checked); reset(); }} /><span>طلباتي فقط</span></label></div>}</div></Card>
    <Async state={list}>{(r) => (<><DataTable cols={cols} rows={r.rows} onRow={(x) => navigate(`/admin/orders/${kind}/${x.id}`)} sort={sort} onSort={(k) => { setSort((s) => ({ key: k, asc: s.key === k ? !s.asc : false })); reset(); }} empty="لا توجد طلبات مطابقة" /><Pager page={page} pageSize={PAGE} count={r.count} onPage={setPage} /></>)}</Async></>);
}

// ---------------------------------------------------------------- Order detail + staff actions
function KV({ k, v }: { k: string; v: React.ReactNode }) { return <><dt>{k}</dt><dd>{v}</dd></>; }
export function AdminOrderDetail({ kind: fixed }: { kind?: Kind }) {
  const { kind: pk, id } = useParams(); const kind = (fixed ?? pk) as Kind; const { session, has } = useAuth();
  const st = useAsync(async () => {
    const o = await must<any>(supabase.from(TABLE[kind]).select("*, profiles(full_name,email,status)").eq("id", id).maybeSingle()); if (!o) throw new Error("not_found");
    const tid = o.outgoing_transfer_id ?? o.incoming_transfer_id;
    const t = tid ? await must<any>(supabase.from("usdt_transfers").select("*").eq("id", tid).maybeSingle()) : null;
    const pay = kind === "sell" ? await must<any>(supabase.from("payout_records").select("*").eq("sell_order_id", o.id).maybeSingle()) : null;
    const hist = await must<any[]>(supabase.from("audit_logs").select("id,created_at,actor_id,action,before_data,after_data").eq("entity_type", TABLE[kind]).eq("entity_id", o.id).order("created_at").limit(100)).catch(() => []);
    const names = await must<any[]>(supabase.from("profiles").select("id,full_name").in("id", [...new Set(hist.map((h) => h.actor_id).filter(Boolean))])).catch(() => []);
    return { o, t, pay, hist, names: Object.fromEntries(names.map((n) => [n.id, n.full_name])) };
  }, [kind, id]);
  const toast = useToast(); const reload = () => st.reload();
  const claim = async () => { try { await api("order.assign", { kind, order_id: id, assignee: session!.user.id }); toast("ok", "أُسند الطلب إليك"); reload(); } catch (e) { toast("bad", errorMessage(e)); } };
  return (<>
    <Link to="/admin/orders" className="small">← الطلبات</Link>
    <Async state={st}>{({ o, t, pay, hist, names }) => { const lb = LABELS[kind][o.status] ?? { text: o.status, tone: "wait" as const }; return (<>
      <div className="row between"><h1>{kind === "buy" ? "طلب شراء" : kind === "sell" ? "طلب بيع" : "عملية شحن"} <span className="mono">{o.ref}</span></h1><Badge label={lb} /></div>
      {o.flagged_large && <Banner tone="warn">عملية ذات قيمة كبيرة — راجعها بعناية إضافية.</Banner>}
      {o.profiles?.status && o.profiles.status !== "active" && <Banner tone="bad">حساب العميل غير نشط ({o.profiles.status}).</Banner>}
      <div className="grid2" style={{ alignItems: "start" }}>
        <Card title="تفاصيل الطلب"><dl className="kv">
          <KV k="العميل" v={<Link to={`/admin/users/${o.user_id}`}>{o.profiles?.full_name}</Link>} /><KV k="البريد" v={<span className="mono">{o.profiles?.email}</span>} />
          {kind === "deposit" && <><KV k="المبلغ" v={lyd(o.amount)} /><KV k="المدفوع لدى المزوّد" v={lyd(o.provider_amount_charged)} /><KV k="رسوم المزوّد" v={lyd(o.provider_fee)} /><KV k="مرجع المزوّد" v={<span className="mono">{o.provider_tx_id ?? "—"}</span>} />{o.review_reason && <KV k="سبب المراجعة" v={o.review_reason} />}</>}
          {kind === "buy" && <><KV k="الكمية" v={usdt(o.usdt_amount)} /><KV k="سعر التنفيذ" v={lyd(o.price)} /><KV k="القيمة" v={lyd(o.lyd_gross)} /><KV k={`العمولة (${Number(o.fee_pct)}%)`} v={lyd(o.lyd_fee)} /><KV k="المخصوم" v={lyd(o.lyd_total)} /><KV k="الشبكة" v={o.network_code} /><KV k="عنوان الاستلام" v={<CopyText text={o.receive_address} />} /></>}
          {kind === "sell" && <><KV k="الكمية المتوقعة" v={usdt(o.usdt_expected)} /><KV k="المستلمة" v={usdt(o.usdt_received)} /><KV k="سعر الشراء" v={lyd(o.price)} /><KV k="القيمة" v={lyd(o.lyd_gross)} /><KV k={`الرسوم (${Number(o.fee_pct)}%)`} v={lyd(o.lyd_fee)} /><KV k="الصافي المستحق" v={lyd(o.lyd_net)} /><KV k="الشبكة" v={o.network_code} />{o.deposit_address && <KV k="عنوان إيداع المنصة" v={<CopyText text={o.deposit_address} />} />}{o.txid && <KV k="هاش العميل (TXID)" v={<CopyText text={o.txid} />} />}{o.sender_address && <KV k="عنوان المرسِل" v={<span className="mono">{o.sender_address}</span>} />}<KV k="المهلة" v={dt(o.expires_at)} /></>}
          <KV k="أُنشئ" v={dt(o.created_at)} /><KV k="آخر تحديث" v={dt(o.updated_at)} />{o.rejection_reason && <KV k="سبب الرفض" v={o.rejection_reason} />}{o.review_note && <KV k="ملاحظة المراجعة" v={o.review_note} />}
          {"assigned_to" in o && <KV k="المسؤول" v={o.assigned_to ? names[o.assigned_to] ?? "موظف" : <Button size="sm" variant="ghost" onClick={claim}>استلام الطلب</Button>} />}
        </dl></Card>
        <div>
          {(t || o.txid) && <Card title="معاملة USDT"><dl className="kv"><KV k="TXID" v={<CopyText text={t?.txid || o.txid} />} /><KV k="الشبكة" v={t?.network_code || o.network_code} /><KV k="الاتجاه" v={t?.direction === "outgoing_to_customer" ? "صادرة للعميل" : "واردة من العميل"} /><KV k="التحقق" v={t?.verification === "verified_onchain" ? "تم التحقق على البلوكشين" : t?.verification === "rejected" ? "مرفوضة" : "بانتظار التحقق"} /></dl>
            <p className="small muted">تحقق من صحة المعاملة والشبكة والعنوان والكمية في مستكشف البلوكشين قبل الاعتماد.</p></Card>}
          {kind === "sell" && (o.proof_data_url || o.proof_path) && (
            <Card title="إثبات التحويل (سكرين شوت)">
              <div style={{ textAlign: "center" }}>
                <a href={o.proof_data_url || o.proof_path} target="_blank" rel="noopener noreferrer">
                  <img
                    src={o.proof_data_url || o.proof_path}
                    alt="لقطة شاشة إثبات التحويل"
                    style={{ maxWidth: "100%", maxHeight: 220, borderRadius: 10, border: "1px solid var(--line-light)", objectFit: "contain" }}
                  />
                </a>
                <p className="small muted" style={{ marginTop: 6, marginBottom: 0 }}>اضغط على الصورة لفتحها بالحجم الكامل</p>
              </div>
            </Card>
          )}
          {kind === "sell" && o.payout_snapshot && <Card title="بيانات الاستلام المعتمدة (مجمّدة)"><dl className="kv"><KV k="النوع" v={PAYOUT_TYPE[o.payout_snapshot.type]} />{o.payout_snapshot.holder_name && <KV k="صاحب الحساب" v={o.payout_snapshot.holder_name} />}{o.payout_snapshot.bank_name && <KV k="المصرف" v={o.payout_snapshot.bank_name} />}{o.payout_snapshot.iban && <KV k="IBAN" v={<CopyText text={o.payout_snapshot.iban} />} />}{o.payout_snapshot.account_number && <KV k="رقم الحساب" v={<CopyText text={o.payout_snapshot.account_number} />} />}</dl></Card>}
          {pay && <Card title="سجل الصرف"><dl className="kv"><KV k="المبلغ" v={lyd(pay.amount)} /><KV k="مرجع التحويل" v={<span className="mono">{pay.external_reference}</span>} /><KV k="نفّذه" v={names[pay.executed_by] ?? "موظف"} /><KV k="اعتمده" v={pay.approved_by ? dt(pay.approved_at) : "بانتظار الاعتماد"} /></dl></Card>}
          <Actions kind={kind} o={o} t={t} pay={pay} has={has} me={session!.user.id} done={reload} />
        </div></div>
      <Card title="سجل التغييرات"><ul className="list">{hist.length ? hist.map((h) => <li key={h.id}><div className="item"><div className="grow"><strong>{h.action === "insert" ? "إنشاء" : `الحالة: ${h.before_data?.status ?? ""} ← ${h.after_data?.status ?? ""}`}</strong><div className="small muted">{names[h.actor_id] ?? "النظام"} · {dt(h.created_at)}</div></div></div></li>) : <li className="muted small">لا توجد سجلات.</li>}</ul></Card></>); }}</Async></>);
}

function Actions({ kind, o, t, pay, has, me, done }: { kind: Kind; o: any; t: any; pay: any; has: (p: string) => boolean; me: string; done: () => void }) {
  const [dlg, setDlg] = useState<null | "reject" | "complete" | "review" | "payout" | "resolve">(null); const { run, busy } = useAction();
  const go = async (a: string, p: Record<string, unknown>, ok: string) => { const r = await run(() => api(a, p), ok); if (r !== undefined) done(); };
  const self = o.user_id === me;
  if (self) return <Banner tone="warn">هذا طلبك الشخصي؛ لا يمكنك معالجته.</Banner>;
  return (<Card title="الإجراءات"><div className="row wrap">
    {kind === "buy" && has("buy.process") && <>
      {o.status === "pending_review" && <Button busy={busy} onClick={() => go("buy.set_status", { order_id: o.id, to: "approved" }, "تمت الموافقة")}>موافقة</Button>}
      {o.status === "approved" && <Button busy={busy} onClick={() => go("buy.set_status", { order_id: o.id, to: "processing" }, "بدأت المعالجة")}>بدء المعالجة</Button>}
      {["pending_review", "approved", "processing"].includes(o.status) && <Button variant="ghost" busy={busy} onClick={() => go("buy.set_status", { order_id: o.id, to: "needs_attention" }, "حُوّل لمراجعة")}>تصعيد للمشرف</Button>}
      {o.status === "needs_attention" && <Button variant="ghost" busy={busy} onClick={() => go("buy.set_status", { order_id: o.id, to: "pending_review" }, "أُعيد للمراجعة")}>إرجاع للمراجعة</Button>}
      {["pending_review", "approved", "processing", "needs_attention"].includes(o.status) && <Button variant="danger" onClick={() => setDlg("reject")}>رفض مع سبب</Button>}</>}
    {kind === "buy" && has("buy.complete") && o.status === "processing" && <Button variant="accent" onClick={() => setDlg("complete")}>تسجيل التحويل وتأكيد التنفيذ</Button>}
    {kind === "sell" && has("sell.review") && ["deposit_submitted", "needs_review"].includes(o.status) && <Button onClick={() => setDlg("review")}>مراجعة الإيداع</Button>}
    {kind === "sell" && has("payout.execute") && o.status === "awaiting_payout" && !pay && <Button variant="accent" onClick={() => setDlg("payout")}>تسجيل الصرف</Button>}
    {kind === "sell" && has("payout.approve") && o.status === "awaiting_payout" && pay && !pay.approved_by && <Button variant="accent" busy={busy} onClick={() => setDlg("payout")}>اعتماد الصرف</Button>}
    {kind === "deposit" && has("deposits.review") && o.status === "needs_review" && <Button onClick={() => setDlg("resolve")}>حسم المراجعة</Button>}
    {!["buy", "sell", "deposit"].includes(kind) && null}
  </div>
    {dlg === "reject" && <ReasonDialog title="رفض طلب الشراء" confirm="رفض الطلب وإرجاع المبلغ" onClose={() => setDlg(null)} onSubmit={async (reason) => { await api("buy.release", { order_id: o.id, to: "rejected", reason }); done(); }} />}
    {dlg === "complete" && <CompleteBuy o={o} onClose={() => setDlg(null)} done={done} />}
    {dlg === "review" && <ReviewSell o={o} onClose={() => setDlg(null)} done={done} />}
    {dlg === "payout" && (pay ? <Confirm title="اعتماد الصرف" confirmText="اعتماد وإتمام الطلب" body={<p>سيُسجَّل صرف <strong>{lyd(pay.amount)}</strong> بالمرجع <span className="mono">{pay.external_reference}</span> ويُقفل الطلب. لا يمكن التراجع.</p>} onClose={() => setDlg(null)} onConfirm={async () => { await api("sell.approve_payout", { order_id: o.id }); done(); }} /> : <RecordPayout o={o} onClose={() => setDlg(null)} done={done} />)}
    {dlg === "resolve" && <ResolveDeposit o={o} onClose={() => setDlg(null)} done={done} />}
  </Card>);
}
function ReasonDialog({ title, confirm, onSubmit, onClose }: { title: string; confirm: string; onSubmit: (r: string) => Promise<void>; onClose: () => void }) {
  const [r, setR] = useState(""); const { run, busy } = useAction();
  return <Modal title={title} onClose={onClose}><Field id="rs" label="السبب (يظهر للعميل)"><Textarea id="rs" value={r} onChange={(e) => setR(e.target.value)} /></Field><Button variant="danger" busy={busy} disabled={r.trim().length < 3} onClick={async () => { const ok = await run(async () => { await onSubmit(r.trim()); return true; }, "تم"); if (ok) onClose(); }}>{confirm}</Button></Modal>;
}
function CompleteBuy({ o, onClose, done }: { o: any; onClose: () => void; done: () => void }) {
  const [f, setF] = useState({ network: "", address: "", usdt: "", txid: "", note: "" }); const { run, busy } = useAction(); const set = (k: string, v: string) => setF((x) => ({ ...x, [k]: v }));
  const ready = f.network && f.address && f.usdt && f.txid.length >= 8;
  return <Modal title="تأكيد تنفيذ التحويل" onClose={onClose}>
    <Banner tone="warn">أعد إدخال البيانات التي حوّلت بها فعليًا. يجب أن تطابق الطلب تمامًا، وإلا يُرفض التأكيد. المطلوب: <strong>{usdt(o.usdt_amount)}</strong> على <strong>{o.network_code}</strong>.</Banner>
    <Field id="cn" label="الشبكة"><Input id="cn" className="ltr" value={f.network} onChange={(e) => set("network", e.target.value.trim().toUpperCase())} /></Field>
    <Field id="ca" label="عنوان المستلم"><Input id="ca" className="ltr" value={f.address} onChange={(e) => set("address", e.target.value.trim())} /></Field>
    <Field id="cu" label="كمية USDT المرسلة"><Input id="cu" className="ltr" inputMode="decimal" value={f.usdt} onChange={(e) => set("usdt", e.target.value)} /></Field>
    <Field id="ct" label="رقم المعاملة (TXID)" hint="لا يمكن استخدام TXID في طلبين"><Input id="ct" className="ltr" value={f.txid} onChange={(e) => set("txid", e.target.value.trim())} /></Field>
    <Field id="cm" label="ملاحظة (اختيارية)"><Textarea id="cm" value={f.note} onChange={(e) => set("note", e.target.value)} /></Field>
    <Button variant="accent" busy={busy} disabled={!ready} onClick={async () => { const r = await run(() => api("buy.complete", { order_id: o.id, network: f.network, address: f.address, usdt_sent: f.usdt, txid: f.txid, note: f.note || undefined }), "تم تسجيل التنفيذ"); if (r !== undefined) { done(); onClose(); } }}>تأكيد التنفيذ</Button>
  </Modal>;
}
function ReviewSell({ o, onClose, done }: { o: any; onClose: () => void; done: () => void }) {
  const [dec, setDec] = useState("approve"); const [recv, setRecv] = useState(""); const [onchain, setOnchain] = useState(false); const [note, setNote] = useState(""); const { run, busy } = useAction();
  return <Modal title="مراجعة إيداع USDT" onClose={onClose}>
    <Banner tone="warn">قبل الاعتماد تحقق في المستكشف من: الشبكة ({o.network_code})، عنوان الإيداع، الكمية المتوقعة <strong>{usdt(o.usdt_expected)}</strong>، عدد التأكيدات، وأن TXID لم يُستخدم سابقًا.</Banner>
    <Field id="rd" label="القرار"><Select id="rd" value={dec} onChange={(e) => setDec(e.target.value)}><option value="approve">اعتماد وصول USDT</option><option value="needs_review">طلب معلومات إضافية</option><option value="reject">رفض</option></Select></Field>
    {dec === "approve" && <><Field id="rv" label="الكمية المستلمة فعليًا" hint="يجب أن تساوي الكمية المتوقعة تمامًا، وإلا ارفض أو أحِل للمراجعة"><Input id="rv" className="ltr" inputMode="decimal" value={recv} onChange={(e) => setRecv(e.target.value)} /></Field>
      <label className="check"><input type="checkbox" checked={onchain} onChange={(e) => setOnchain(e.target.checked)} /><span>تحققت من المعاملة على البلوكشين (الشبكة، العنوان، الكمية، التأكيدات)</span></label></>}
    <Field id="rn" label={dec === "approve" ? (onchain ? "ملاحظة (اختيارية)" : "ملاحظة مطلوبة: كيف تحققت يدويًا؟") : "السبب (يظهر للعميل)"}><Textarea id="rn" value={note} onChange={(e) => setNote(e.target.value)} /></Field>
    <Button variant={dec === "reject" ? "danger" : "accent"} busy={busy} disabled={dec === "approve" ? !validAmount(recv, 6) : note.trim().length < 3} onClick={async () => { const r = await run(() => api("sell.review", { order_id: o.id, decision: dec, usdt_received: dec === "approve" ? recv : undefined, onchain_verified: onchain, note: note || undefined }), "تم تسجيل القرار"); if (r !== undefined) { done(); onClose(); } }}>تنفيذ</Button>
  </Modal>;
}
function RecordPayout({ o, onClose, done }: { o: any; onClose: () => void; done: () => void }) {
  const [ref, setRef] = useState(""); const { run, busy } = useAction();
  return <Modal title="تسجيل صرف المقابل" onClose={onClose}>
    <Banner tone="info">المبلغ المستحق: <strong>{lyd(o.lyd_net)}</strong>. سجّل مرجع التحويل المصرفي بعد تنفيذه فعليًا. سيعتمد الصرف موظف آخر.</Banner>
    <Field id="pr" label="مرجع التحويل / رقم العملية"><Input id="pr" className="ltr" value={ref} onChange={(e) => setRef(e.target.value)} /></Field>
    <Button variant="accent" busy={busy} disabled={ref.trim().length < 3} onClick={async () => { const r = await run(() => api("sell.record_payout", { order_id: o.id, external_reference: ref.trim() }), "سُجّل الصرف وينتظر الاعتماد"); if (r !== undefined) { done(); onClose(); } }}>حفظ</Button>
  </Modal>;
}
function ResolveDeposit({ o, onClose, done }: { o: any; onClose: () => void; done: () => void }) {
  const [dec, setDec] = useState("fail"); const [ref, setRef] = useState(""); const [note, setNote] = useState(""); const { run, busy } = useAction();
  return <Modal title="حسم عملية شحن معزولة" onClose={onClose}>
    <Banner tone="warn">{o.review_reason ?? "المبلغ أو المرجع لا يطابق"}. لا تُضِف الرصيد إلا بعد التأكد لدى مزوّد الدفع أن <strong>{lyd(o.amount)}</strong> وصلت فعلًا.</Banner>
    <Field id="dd" label="القرار"><Select id="dd" value={dec} onChange={(e) => setDec(e.target.value)}><option value="fail">رفض (لا يُضاف رصيد)</option><option value="credit">إضافة الرصيد بعد التحقق</option></Select></Field>
    {dec === "credit" && <Field id="dr" label="مرجع الدفع لدى المزوّد"><Input id="dr" className="ltr" value={ref} onChange={(e) => setRef(e.target.value)} /></Field>}
    <Field id="dn" label="الملاحظة (10 أحرف على الأقل)"><Textarea id="dn" value={note} onChange={(e) => setNote(e.target.value)} /></Field>
    <Button variant={dec === "fail" ? "danger" : "accent"} busy={busy} disabled={note.trim().length < 10 || (dec === "credit" && ref.trim().length < 4)} onClick={async () => { const r = await run(() => api("deposit.resolve", { order_id: o.id, decision: dec, provider_ref: ref || undefined, note }), "تم الحسم"); if (r !== undefined) { done(); onClose(); } }}>تنفيذ</Button>
  </Modal>;
}

// ---------------------------------------------------------------- Rates
export function AdminRates() {
  const cur = useAsync(() => must<any>(supabase.from("exchange_rates").select("*").order("created_at", { ascending: false }).limit(1).maybeSingle()), []);
  const hist = useAsync(() => must<any[]>(supabase.from("exchange_rates").select("*").order("created_at", { ascending: false }).limit(30)), []);
  const [f, setF] = useState<Record<string, string>>({}); const [confirm, setConfirm] = useState(false); const [large, setLarge] = useState(false); const [notify, setNotify] = useState(false); const [note, setNote] = useState("");
  const [from, setFrom] = useState(""); const [to, setTo] = useState(""); const { run, busy } = useAction();
  useEffect(() => { if (cur.data) setF({ sell_price: String(cur.data.sell_price), buy_price: String(cur.data.buy_price), buy_fee_pct: String(cur.data.buy_fee_pct), sell_fee_pct: String(cur.data.sell_fee_pct), min_buy_lyd: String(cur.data.min_buy_lyd), max_buy_lyd: String(cur.data.max_buy_lyd), min_sell_usdt: String(cur.data.min_sell_usdt), max_sell_usdt: String(cur.data.max_sell_usdt) }); }, [cur.data]);
  const set = (k: string, v: string) => setF((x) => ({ ...x, [k]: cleanAmount(v) }));
  const errs: string[] = []; const need = ["sell_price", "buy_price", "buy_fee_pct", "sell_fee_pct", "min_buy_lyd", "max_buy_lyd", "min_sell_usdt", "max_sell_usdt"];
  for (const k of need) if (!f[k] || !validAmount(f[k], 4)) errs.push(k);
  const bad = errs.length > 0 || Number(f.buy_price) > Number(f.sell_price) || Number(f.max_buy_lyd) < Number(f.min_buy_lyd) || Number(f.max_sell_usdt) < Number(f.min_sell_usdt) || Number(f.sell_price) <= 0 || Number(f.buy_price) <= 0;
  const pb = !bad ? calcBuy(f.sell_price, f.buy_fee_pct, { usdt: "100" }) : null; const ps = !bad ? calcSell(f.buy_price, f.sell_fee_pct, "100") : null;
  const F = (k: string, label: string, hint?: string) => <Field id={`r-${k}`} label={label} hint={hint} error={errs.includes(k) ? "قيمة غير صالحة" : null}><Input id={`r-${k}`} className="ltr" inputMode="decimal" value={f[k] ?? ""} onChange={(e) => set(k, e.target.value)} invalid={errs.includes(k)} /></Field>;
  async function publish(confirmLarge: boolean) {
    try { await api("rate.publish", { ...f, valid_from: from ? new Date(from).toISOString() : undefined, valid_to: to ? new Date(to).toISOString() : undefined, note: note || undefined, confirm_large: confirmLarge, notify }); cur.reload(); hist.reload(); setConfirm(false); }
    catch (e) { if (e instanceof ApiError && e.code === "large_rate_change_confirm_required" && !confirmLarge) { setLarge(true); throw e; } throw e; }
  }
  return (<><h1>الأسعار والرسوم والحدود</h1>
    <Banner tone="info">كل تعديل يُسجَّل كإصدار جديد ولا يغيّر أسعار الطلبات القائمة ولا عروض الأسعار المثبّتة. سعر شراء المنصة من العميل مستقل عن سعر بيعها له.</Banner>
    <Card><div className="grid2 keep">{F("sell_price", "سعر بيع USDT للعملاء (د.ل)", "ما يدفعه العميل عند الشراء")}{F("buy_price", "سعر شراء USDT من العملاء (د.ل)", "ما يستلمه العميل عند البيع")}
      {F("buy_fee_pct", "رسوم الشراء %")}{F("sell_fee_pct", "رسوم البيع %")}{F("min_buy_lyd", "أدنى شراء (د.ل)")}{F("max_buy_lyd", "أقصى شراء (د.ل)")}{F("min_sell_usdt", "أدنى بيع (USDT)")}{F("max_sell_usdt", "أقصى بيع (USDT)")}</div>
      {Number(f.buy_price) > Number(f.sell_price) && <div className="err" role="alert">سعر الشراء من العملاء يجب ألا يتجاوز سعر البيع لهم.</div>}
      <div className="grid2"><Field id="r-from" label="يبدأ في (اختياري)"><Input id="r-from" type="datetime-local" value={from} onChange={(e) => setFrom(e.target.value)} /></Field><Field id="r-to" label="ينتهي في (اختياري)"><Input id="r-to" type="datetime-local" value={to} onChange={(e) => setTo(e.target.value)} /></Field></div>
      <Field id="r-note" label="ملاحظة التعديل"><Input id="r-note" value={note} onChange={(e) => setNote(e.target.value)} /></Field>
      <label className="check" style={{ marginBottom: ".75rem" }}><input type="checkbox" checked={notify} onChange={(e) => setNotify(e.target.checked)} /><span>إشعار المستخدمين النشطين بتغيير الأسعار</span></label>
      {pb && ps && <div className="banner info" aria-live="polite"><Icon name="info" size={20} /><div><strong>معاينة (100 USDT):</strong> شراء العميل = {lyd(pb.total)} (قيمة {lyd(pb.gross)} + رسوم {lyd(pb.fee)}) · بيع العميل = {lyd(ps.net)} (قيمة {lyd(ps.gross)} − رسوم {lyd(ps.fee)})</div></div>}
      <Button disabled={bad} onClick={() => setConfirm(true)}>نشر الأسعار…</Button></Card>
    {confirm && <Confirm title="تأكيد نشر الأسعار" confirmText={large ? "نعم، التغيير كبير ومقصود" : "نشر"} danger={large} body={<><p>سيُطبَّق السعر الجديد على الطلبات الجديدة فورًا.</p>{large && <Banner tone="bad">التغيير يتجاوز الحد المسموح دون تأكيد. تأكد أنه ليس خطأ إدخال.</Banner>}</>} onClose={() => { setConfirm(false); setLarge(false); }} onConfirm={() => publish(large)} />}
    <Card title="سجل الأسعار"><Async state={hist}>{(rows) => <DataTable cols={[{ key: "d", label: "التاريخ", render: (r) => dt(r.created_at) }, { key: "s", label: "بيع للعملاء", render: (r) => price(r.sell_price) }, { key: "b", label: "شراء من العملاء", render: (r) => price(r.buy_price) }, { key: "f", label: "الرسوم", render: (r) => `${Number(r.buy_fee_pct)}% / ${Number(r.sell_fee_pct)}%` }, { key: "n", label: "ملاحظة", render: (r) => r.note ?? "—" }]} rows={rows} />}</Async></Card></>);
}
