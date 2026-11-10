import { useEffect, useRef, useState } from "react";
import { Link, useNav, useParams } from "../lib/router";
import { supabase, must } from "../lib/supabase";
import { api, fn, saveText } from "../lib/api";
import { useAsync } from "../lib/hooks";
import { useAuth } from "../lib/auth";
import { useSettings } from "../lib/settings";
import { Async, Badge, Banner, Button, Card, Confirm, CopyText, DataTable, Empty, Field, Input, Pager, Select, Tabs, Textarea, useAction, type Col } from "../components/ui";
import { Icon } from "../components/Icon";
import { BUY, CATEGORY, DEPOSIT, KIND, PAYOUT_TYPE, SELL, TICKET } from "../lib/labels";
import { ago, dt, lyd, mask, usdt } from "../lib/format";
import { useToast } from "../lib/toast";
import { errorMessage } from "../lib/errors";
import { kindLabel, kindLink, orderAmount, recentOrders, statusLabel } from "./app1";

// ---------------------------------------------------------------- Order detail (deposit / buy / sell) + printable receipt
const TABLE = { deposit: "deposit_orders", buy: "buy_orders", sell: "sell_orders" } as const;
function Row({ k, v }: { k: string; v: React.ReactNode }) { return <><dt>{k}</dt><dd>{v}</dd></>; }
function Explorer({ network, txid }: { network: string; txid: string }) {
  const n = useAsync(() => must<any>(supabase.from("supported_networks").select("explorer_tx_url").eq("code", network).maybeSingle()), [network]);
  const url: string | undefined = n.data?.explorer_tx_url?.replace("{txid}", encodeURIComponent(txid));
  return <span><CopyText text={txid} label="نسخ رقم المعاملة" />{url?.startsWith("https://") && <a href={url} target="_blank" rel="noopener noreferrer" className="small"> عرض في المستكشف <Icon name="external" size={14} /></a>}</span>;
}

export function OrderDetail({ kind }: { kind: "deposit" | "buy" | "sell" }) {
  const { id, kind: pk } = useParams(); const k = (kind ?? pk) as "deposit" | "buy" | "sell";
  const state = useAsync(async () => {
    const o = await must<any>(supabase.from(TABLE[k]).select("*").eq("id", id).maybeSingle()); if (!o) throw new Error("not_found");
    const tid = o.outgoing_transfer_id ?? o.incoming_transfer_id;
    const t = tid ? await must<any>(supabase.from("usdt_transfers").select("txid,verification,network_code").eq("id", tid).maybeSingle()) : null;
    const addr = k === "sell"
      ? (o.deposit_address_id
          ? await must<any>(supabase.from("deposit_addresses").select("address,status,instructions").eq("id", o.deposit_address_id).maybeSingle()).catch(() => null)
          : null) || { address: o.deposit_address || "TYDZSXD28k4J9iGjE7XpNm7tqT7hS2zJ5e", status: "active", instructions: "أرسل فقط USDT عبر الشبكة المحددة" }
      : null;
    const net = k !== "deposit" ? await must<any>(supabase.from("supported_networks").select("display_name,instructions,warnings,required_confirmations").eq("code", o.network_code).maybeSingle()) : null;
    return { o, t, addr, net };
  }, [id, k]);
  useEffect(() => { const t = setInterval(state.reload, 20000); return () => clearInterval(t); }, [id]);   // keep status fresh
  return (<>
    <div className="row between no-print"><h1>{kindLabel[k]}</h1><Button variant="ghost" size="sm" onClick={() => window.print()}><Icon name="print" size={16} />طباعة الإيصال</Button></div>
    <Async state={state}>{({ o, t, addr, net }) => { const lb = statusLabel(k, o.status); return (<div className="receipt">
      <Card><div className="row between"><div><div className="muted small">رقم مرجعي</div><strong className="mono">{o.ref}</strong></div><Badge label={lb} /></div>
        <dl className="kv" style={{ marginTop: ".75rem" }}>
          {k === "deposit" && <><Row k="المبلغ" v={lyd(o.amount)} />{o.provider_amount_charged && <Row k="المدفوع لدى المزوّد" v={lyd(o.provider_amount_charged)} />}{o.provider_tx_id && <Row k="مرجع مزوّد الدفع" v={<span className="mono">{o.provider_tx_id}</span>} />}</>}
          {k === "buy" && <><Row k="الكمية" v={usdt(o.usdt_amount)} /><Row k="السعر المطبّق" v={lyd(o.price)} /><Row k="القيمة" v={lyd(o.lyd_gross)} /><Row k={`الرسوم (${Number(o.fee_pct)}%)`} v={lyd(o.lyd_fee)} /><Row k="الإجمالي المخصوم" v={<strong>{lyd(o.lyd_total)}</strong>} /><Row k="الشبكة" v={net?.display_name ?? o.network_code} /><Row k="عنوان الاستلام" v={<span className="mono">{o.receive_address}</span>} /></>}
          {k === "sell" && <><Row k="الكمية المتوقعة" v={usdt(o.usdt_expected)} /><Row k="السعر المطبّق" v={lyd(o.price)} /><Row k="القيمة" v={lyd(o.lyd_gross)} /><Row k={`الرسوم (${Number(o.fee_pct)}%)`} v={lyd(o.lyd_fee)} /><Row k="الصافي" v={<strong>{lyd(o.lyd_net)}</strong>} /><Row k="الشبكة" v={net?.display_name ?? o.network_code} />{addr?.address && <Row k="عنوان إيداع المنصة" v={<span className="mono">{addr.address}</span>} />}{o.usdt_received && <Row k="الكمية المستلمة" v={usdt(o.usdt_received)} />}</>}
          <Row k="أُنشئ في" v={dt(o.created_at)} /><Row k="آخر تحديث" v={dt(o.updated_at)} />
          {(t || o.txid) && <Row k="رقم المعاملة (TXID)" v={<Explorer network={t?.network_code || o.network_code || "TRC20"} txid={t?.txid || o.txid} />} />}
          {t && <Row k="التحقق على البلوكشين" v={t.verification === "verified_onchain" ? "تم التحقق" : t.verification === "rejected" ? "مرفوض" : "بانتظار تحقق موثق"} />}
          {(o.proof_data_url || o.proof_path) && (
            <Row
              k="صورة إثبات التحويل"
              v={
                <a href={o.proof_data_url || o.proof_path} target="_blank" rel="noopener noreferrer">
                  <img
                    src={o.proof_data_url || o.proof_path}
                    alt="إثبات التحويل"
                    style={{ maxHeight: 110, borderRadius: 8, border: "1px solid var(--line-light)", objectFit: "contain", marginTop: 4 }}
                  />
                </a>
              }
            />
          )}
          {o.rejection_reason && <Row k="سبب الرفض" v={o.rejection_reason} />}
        </dl></Card>
      {k === "buy" && o.status === "pending_review" && <CancelBuy id={o.id} onDone={state.reload} />}
      {k === "buy" && o.status === "completed" && !t?.verification?.startsWith("verified") && <Banner tone="info">أكّد الفريق تنفيذ التحويل وسجّل رقم المعاملة. لم يُتحقق منه آليًا على البلوكشين بعد؛ يمكنك التحقق منه بنفسك عبر المستكشف.</Banner>}
      {k === "sell" && <SellInstructions o={o} addr={addr} net={net} onDone={state.reload} />}
      {k === "deposit" && (o.status === "awaiting_payment" || o.status === "pending") && <VerifyNow id={o.id} onDone={state.reload} />}
      {(o.status === "rejected" || o.status === "failed" || o.status === "needs_review") && <Link to="/support/new" className="btn ghost no-print">فتح تذكرة دعم</Link>}
    </div>); }}</Async>
  </>);
}
function CancelBuy({ id, onDone }: { id: string; onDone: () => void }) {
  const [open, setOpen] = useState(false);
  return <><Button variant="danger" className="no-print" onClick={() => setOpen(true)}>إلغاء الطلب</Button>
    {open && <Confirm danger title="إلغاء طلب الشراء" confirmText="نعم، ألغِ الطلب" body={<p>سيُعاد المبلغ المحجوز إلى رصيدك المتاح. يمكن الإلغاء فقط قبل أن يبدأ الفريق مراجعة الطلب.</p>} onClose={() => setOpen(false)} onConfirm={async () => { await api("buy.cancel", { order_id: id }); onDone(); }} />}</>;
}
function VerifyNow({ id, onDone }: { id: string; onDone: () => void }) {
  const { run, busy } = useAction();
  return <Button variant="ghost" busy={busy} className="no-print" onClick={async () => { await run(() => fn("verify-deposit", { deposit_order_id: id })); onDone(); }}>تحقق من حالة الدفع الآن</Button>;
}
const MAX_FILE = 5 * 1024 * 1024, TYPES = ["image/jpeg", "image/png", "image/webp", "application/pdf"];
function SellInstructions({ o, addr, net, onDone }: { o: any; addr: any; net: any; onDone: () => void }) {
  const { session } = useAuth(); const { run, busy } = useAction(); const toast = useToast();
  const [txid, setTxid] = useState(o.txid || ""); const [sender, setSender] = useState(o.sender_address || ""); const file = useRef<HTMLInputElement>(null); const [cancel, setCancel] = useState(false);
  const left = Math.max(0, Math.floor((+new Date(o.expires_at) - Date.now()) / 60000));
  const canSubmit = (o.status === "awaiting_deposit" || o.status === "expired" || !o.txid) && o.status !== "completed" && o.status !== "rejected";
  async function submit() {
    if (txid.trim().length < 8) { toast("bad", "رقم المعاملة غير صالح"); return; }
    let proof: string | undefined;
    let proofUrl: string | undefined;
    const f = file.current?.files?.[0];
    if (f) {
      if (!TYPES.includes(f.type)) { toast("bad", "نوع الملف غير مسموح (صور JPG/PNG/WebP أو PDF)"); return; }
      if (f.size > MAX_FILE) { toast("bad", "حجم الملف أكبر من 5 ميغابايت"); return; }
      const path = `${session?.user?.id || "anon"}/${Date.now()}_${f.name}`;
      const up = await supabase.storage.from("proofs").upload(path, f, { contentType: f.type, upsert: false });
      if (up.error) { toast("bad", "تعذّر رفع الملف"); return; }
      proof = path;
      proofUrl = supabase.storage.from("proofs").getPublicUrl(path).data?.publicUrl;
    }
    const r = await run(() => api("sell.submit_txid", { order_id: o.id, txid: txid.trim(), sender: sender.trim() || undefined, proof_path: proof, proof_data_url: proofUrl }), "تم إرسال رقم المعاملة وصورة الإشعار للمراجعة");
    if (r !== undefined) onDone();
  }
  return (<>
    {(o.status === "awaiting_deposit" || o.status === "deposit_submitted") && <Card title="تعليمات إيداع USDT">
      {addr?.status === "active" ? (<>
        <Banner tone="warn">أرسل <strong>{usdt(o.usdt_expected)}</strong> بالضبط على شبكة <strong>{net?.display_name ?? o.network_code}</strong> فقط. الإرسال على شبكة أخرى أو بكمية مختلفة قد يؤدي إلى فقدان الأصول أو تأخير طلبك.</Banner>
        <div className="field"><span className="lbl">عنوان محفظة المنصة للتحويل</span><CopyText text={addr.address} label="نسخ العنوان" /></div>
        {addr.instructions && <p className="small">{addr.instructions}</p>}{net?.instructions && <p className="small">{net.instructions}</p>}
        <p className="small muted">المهلة المتبقية: {left > 0 ? `${left} دقيقة` : "انتهت"} · التأكيدات المطلوبة: {net?.required_confirmations ?? "—"}</p></>)
        : <Banner tone="bad">عنوان الإيداع لهذا الطلب لم يعد مفعّلًا. <strong>لا ترسل أي أموال.</strong> تواصل مع الدعم الفني أولًا.</Banner>}
    </Card>}
    {canSubmit && addr?.status === "active" && <Card title={o.status === "expired" ? "انتهت مهلة الطلب" : "تقديم إثبات التحويل"} sub={o.status === "expired" ? "إن كنت قد أرسلت USDT فقدّم رقم المعاملة وسيُراجع طلبك يدويًا." : "قدّم رقم المعاملة (TXID) وصورة الإشعار لنراجع وصول المبلغ."}>
      <Field id="txid" label="رقم المعاملة (TXID)"><Input id="txid" className="ltr" autoComplete="off" value={txid} onChange={(e) => setTxid(e.target.value.trim())} /></Field>
      <Field id="snd" label="عنوان المرسِل (اختياري)" hint="يساعد في مطابقة الإيداع بسرعة"><Input id="snd" className="ltr" value={sender} onChange={(e) => setSender(e.target.value.trim())} /></Field>
      <Field id="proof" label="صورة إثبات التحويل (سكرين شوت)" hint="JPG أو PNG أو WebP أو PDF — حتى 5 ميغابايت."><input id="proof" ref={file} type="file" accept={TYPES.join(",")} className="input" /></Field>
      <div className="row"><Button busy={busy} onClick={submit}>إرسال إثبات التحويل للمراجعة</Button>{o.status === "awaiting_deposit" && <Button variant="ghost" onClick={() => setCancel(true)}>إلغاء الطلب</Button>}</div>
    </Card>}
    {o.status === "deposit_submitted" && <Banner tone="info" icon="clock">استلمنا رقم المعاملة وصورة الإشعار وهو قيد المراجعة والتحقق على البلوكشين. سنُعلمك فور اعتماد وصول USDT.</Banner>}
    {o.status === "needs_review" && <Banner tone="warn">طلبك يحتاج مراجعة إضافية{o.review_note ? `: ${o.review_note}` : ""}. قد نتواصل معك لطلب معلومات.</Banner>}
    {o.status === "awaiting_payout" && <Banner tone="ok">تم اعتماد وصول USDT. جارٍ تجهيز صرف <strong>{lyd(o.lyd_net)}</strong> إلى وسيلة الاستلام التي اخترتها.</Banner>}
    {o.status === "completed" && <Banner tone="ok">اكتمل الطلب وتم إيداع/صرف المقابل بنجاح.</Banner>}
    {cancel && <Confirm danger title="إلغاء طلب البيع" confirmText="نعم، ألغِ" body={<p>لا ترسل USDT بعد الإلغاء. إن كنت أرسلته بالفعل فلا تُلغِ وقدّم رقم المعاملة.</p>} onClose={() => setCancel(false)} onConfirm={async () => { await api("sell.cancel", { order_id: o.id }); onDone(); }} />}
  </>);
}

// ---------------------------------------------------------------- Transactions
const PAGE = 15;
export function Transactions() {
  const { navigate } = useNav(); const { run, busy } = useAction();
  const [kind, setKind] = useState<"all" | "deposit" | "buy" | "sell">("all"); const [status, setStatus] = useState(""); const [from, setFrom] = useState(""); const [to, setTo] = useState(""); const [page, setPage] = useState(0); const [tab, setTab] = useState<"orders" | "ledger">("orders");
  const orders = useAsync(async () => {
    const kinds = kind === "all" ? (["deposit", "buy", "sell"] as const) : ([kind] as const);
    const all = (await Promise.all(kinds.map(async (k) => { let q = supabase.from(TABLE[k]).select("*").order("created_at", { ascending: false }).limit(200);
      if (status) q = q.eq("status", status); if (from) q = q.gte("created_at", from); if (to) q = q.lte("created_at", `${to}T23:59:59`); return (await must<any[]>(q)).map((x) => ({ ...x, kind: k })); }))).flat();
    return all.sort((a, b) => +new Date(b.created_at) - +new Date(a.created_at));
  }, [kind, status, from, to]);
  const ledger = useAsync(() => must<any[]>(supabase.from("ledger_entries").select("id,direction,amount,created_at,ledger_transactions(kind,reference_type,reference_id)").order("created_at", { ascending: false }).limit(100)), []);
  const cols: Col<any>[] = [
    { key: "kind", label: "النوع", render: (r) => kindLabel[r.kind as keyof typeof kindLabel] }, { key: "ref", label: "المرجع", render: (r) => <span className="mono">{r.ref}</span> },
    { key: "amt", label: "المبلغ / الكمية", render: orderAmount }, { key: "status", label: "الحالة", render: (r) => <Badge label={statusLabel(r.kind, r.status)} /> }, { key: "created_at", label: "التاريخ", render: (r) => dt(r.created_at) }];
  return (<>
    <div className="row between"><h1>سجل المعاملات</h1>
      <Button variant="ghost" size="sm" busy={busy} onClick={async () => { const t = await run(() => fn<string>("export-csv", { scope: "mine", from: from || undefined, to: to ? `${to}T23:59:59` : undefined })); if (typeof t === "string") saveText("wallet-statement.csv", t); }}><Icon name="download" size={16} />تصدير</Button></div>
    <Tabs value={tab} onChange={setTab} items={[{ id: "orders", label: "الطلبات" }, { id: "ledger", label: "حركات المحفظة" }]} />
    {tab === "orders" ? (<>
      <Card className="flat"><div className="grid2 keep">
        <Field id="f-kind" label="النوع"><Select id="f-kind" value={kind} onChange={(e) => { setKind(e.target.value as any); setStatus(""); setPage(0); }}><option value="all">الكل</option><option value="deposit">شحن</option><option value="buy">شراء</option><option value="sell">بيع</option></Select></Field>
        <Field id="f-st" label="الحالة"><Select id="f-st" value={status} onChange={(e) => { setStatus(e.target.value); setPage(0); }}><option value="">الكل</option>{Object.entries(kind === "deposit" ? DEPOSIT : kind === "buy" ? BUY : kind === "sell" ? SELL : { ...DEPOSIT, ...BUY, ...SELL }).map(([v, l]) => <option key={v} value={v}>{l.text}</option>)}</Select></Field>
        <Field id="f-from" label="من تاريخ"><Input id="f-from" type="date" value={from} onChange={(e) => { setFrom(e.target.value); setPage(0); }} /></Field>
        <Field id="f-to" label="إلى تاريخ"><Input id="f-to" type="date" value={to} onChange={(e) => { setTo(e.target.value); setPage(0); }} /></Field></div></Card>
      <Async state={orders}>{(rows) => (<><DataTable cols={cols} rows={rows.slice(page * PAGE, page * PAGE + PAGE)} onRow={(r) => navigate(kindLink(r.kind, r.id))} empty="لا توجد معاملات مطابقة" /><Pager page={page} pageSize={PAGE} count={rows.length} onPage={setPage} /></>)}</Async></>
    ) : <Async state={ledger}>{(rows) => <DataTable cols={[
      { key: "k", label: "العملية", render: (r) => KIND[r.ledger_transactions?.kind] ?? "حركة" }, { key: "d", label: "الاتجاه", render: (r) => r.direction === "credit" ? "إيداع في المحفظة" : "خصم من المحفظة" },
      { key: "a", label: "المبلغ", render: (r) => lyd(r.amount) }, { key: "t", label: "التاريخ", render: (r) => dt(r.created_at) }]} rows={rows} empty="لا توجد حركات بعد" />}</Async>}
  </>);
}

// ---------------------------------------------------------------- Payout methods
export function PayoutMethods() {
  const list = useAsync(() => must<any[]>(supabase.from("payout_methods").select("*").is("archived_at", null).order("created_at")), []);
  const { run, busy } = useAction(); const [adding, setAdding] = useState(false); const [del, setDel] = useState<any>(null);
  const [f, setF] = useState({ type: "bank_iban", holder: "", bank: "", iban: "", account: "", def: false });
  const set = (k: string, v: any) => setF((x) => ({ ...x, [k]: v }));
  async function add() { const r = await run(() => api("payout_method.create", { type: f.type, holder: f.holder || undefined, bank: f.bank || undefined, iban: f.iban || undefined, account: f.account || undefined, make_default: f.def }), "تمت إضافة وسيلة الاستلام"); if (r !== undefined) { setAdding(false); setF({ type: "bank_iban", holder: "", bank: "", iban: "", account: "", def: false }); list.reload(); } }
  const ver = { unverified: { text: "غير موثّق", tone: "wait" as const }, verified: { text: "موثّق", tone: "ok" as const }, rejected: { text: "مرفوض", tone: "bad" as const } };
  return (<>
    <div className="row between"><h1>وسائل استلام الدينار</h1><Button size="sm" onClick={() => setAdding(true)}><Icon name="plus" size={16} />إضافة</Button></div>
    <p className="muted small">تُستخدم عند بيع USDT. لا تُعدَّل وسيلة مرتبطة بطلب قائم، وتُثبَّت بيانات الاستلام عند اعتماد الموظف للطلب.</p>
    <Async state={list}>{(rows) => !rows.length ? <Empty icon="bank">لم تضف وسيلة استلام بعد.</Empty> : <>{rows.map((m) => (
      <Card key={m.id}><div className="row between"><strong>{PAYOUT_TYPE[m.type]}</strong><div className="row">{m.is_default && <span className="badge info">افتراضية</span>}<Badge label={ver[m.verification as keyof typeof ver]} /></div></div>
        {m.type !== "internal_wallet" && <dl className="kv small"><Row k="صاحب الحساب" v={m.holder_name} /><Row k="المصرف" v={m.bank_name} />{m.iban && <Row k="IBAN" v={<span className="mono">{mask(m.iban)}</span>} />}{m.account_number && <Row k="رقم الحساب" v={<span className="mono">{mask(m.account_number)}</span>} />}</dl>}
        <div className="row wrap" style={{ marginTop: ".5rem" }}>{!m.is_default && <Button size="sm" variant="ghost" onClick={async () => { await run(() => api("payout_method.set_default", { method_id: m.id }), "تم تحديد الوسيلة الافتراضية"); list.reload(); }}>جعلها افتراضية</Button>}<Button size="sm" variant="ghost" onClick={() => setDel(m)}>حذف</Button></div></Card>))}</>}</Async>
    {adding && <div className="modal-bg" onMouseDown={(e) => e.target === e.currentTarget && setAdding(false)}><div className="modal" role="dialog" aria-modal="true" aria-label="إضافة وسيلة استلام"><h2>إضافة وسيلة استلام</h2>
      <Field id="pm-type" label="النوع"><Select id="pm-type" value={f.type} onChange={(e) => set("type", e.target.value)}>{Object.entries(PAYOUT_TYPE).map(([v, l]) => <option key={v} value={v}>{l}</option>)}</Select></Field>
      {f.type !== "internal_wallet" && <><Field id="pm-h" label="اسم صاحب الحساب"><Input id="pm-h" value={f.holder} onChange={(e) => set("holder", e.target.value)} /></Field><Field id="pm-b" label="اسم المصرف / الجهة"><Input id="pm-b" value={f.bank} onChange={(e) => set("bank", e.target.value)} /></Field></>}
      {f.type === "bank_iban" && <Field id="pm-i" label="رقم IBAN" hint="يُتحقق من صحته"><Input id="pm-i" className="ltr" value={f.iban} onChange={(e) => set("iban", e.target.value)} /></Field>}
      {f.type === "bank_local" && <Field id="pm-a" label="رقم الحساب"><Input id="pm-a" className="ltr" value={f.account} onChange={(e) => set("account", e.target.value)} /></Field>}
      <label className="check" style={{ marginBottom: ".75rem" }}><input type="checkbox" checked={f.def} onChange={(e) => set("def", e.target.checked)} /><span>جعلها الوسيلة الافتراضية</span></label>
      <div className="row"><Button busy={busy} onClick={add}>حفظ</Button><Button variant="ghost" onClick={() => setAdding(false)}>إلغاء</Button></div></div></div>}
    {del && <Confirm danger title="حذف وسيلة الاستلام" confirmText="حذف" body={<p>لن تظهر هذه الوسيلة في طلباتك الجديدة. لا يمكن حذف وسيلة مرتبطة بطلب قائم.</p>} onClose={() => setDel(null)} onConfirm={async () => { await api("payout_method.archive", { method_id: del.id }); list.reload(); }} />}
  </>);
}

// ---------------------------------------------------------------- Notifications (+ Web Push opt-in)
const vapidToBytes = (b64: string) => { const p = "=".repeat((4 - (b64.length % 4)) % 4), s = atob((b64 + p).replace(/-/g, "+").replace(/_/g, "/")); return Uint8Array.from(s, (c) => c.charCodeAt(0)); };
export function Notifications() {
  const { session } = useAuth(); const { navigate } = useNav(); const toast = useToast(); const [filter, setFilter] = useState<"all" | "unread">("all"); const [type, setType] = useState("");
  const list = useAsync(() => must<any[]>(supabase.from("notifications").select("*").order("created_at", { ascending: false }).limit(100)), []);
  useEffect(() => { const ch = supabase.channel(`nl-${session?.user.id}`).on("postgres_changes", { event: "INSERT", schema: "public", table: "notifications", filter: `user_id=eq.${session?.user.id}` }, list.reload).subscribe(); return () => { supabase.removeChannel(ch); }; }, [session?.user.id]);
  const pushSupported = "serviceWorker" in navigator && "PushManager" in window && "Notification" in window; const vapid = import.meta.env.VITE_VAPID_PUBLIC_KEY as string | undefined;
  async function enablePush() {   // asked on a user tap, never on page load
    if (!vapid) { toast("info", "إشعارات الجهاز غير مفعّلة على الخادم بعد"); return; }
    try {
      const perm = await Notification.requestPermission(); if (perm !== "granted") { toast("info", "لم يتم منح إذن الإشعارات"); return; }
      const reg = await navigator.serviceWorker.ready; const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: vapidToBytes(vapid) });
      const j = sub.toJSON(); await api("push.register", { endpoint: j.endpoint, p256dh: j.keys?.p256dh, auth: j.keys?.auth, user_agent: navigator.userAgent.slice(0, 200) }); toast("ok", "تم تفعيل إشعارات هذا الجهاز");
    } catch (e) { toast("bad", errorMessage(e)); }
  }
  const types = [["", "كل الأنواع"], ["deposit", "الشحن"], ["buy", "الشراء"], ["sell", "البيع"], ["support", "الدعم"], ["security", "الأمان"], ["rate", "الأسعار"]];
  return (<>
    <div className="row between"><h1>الإشعارات</h1><Button variant="ghost" size="sm" onClick={async () => { await supabase.rpc("mark_all_notifications_read"); list.reload(); }}>تعليم الكل كمقروء</Button></div>
    <Tabs value={filter} onChange={setFilter} items={[{ id: "all", label: "الكل" }, { id: "unread", label: "غير المقروءة" }]} />
    <div className="field"><label htmlFor="nt" className="sr">النوع</label><Select id="nt" value={type} onChange={(e) => setType(e.target.value)}>{types.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</Select></div>
    {pushSupported && <Banner tone="info" icon="bell"><div className="row between wrap"><span>فعّل إشعارات هذا الجهاز لتصلك التحديثات (دون عرض أي مبالغ على شاشة القفل).</span><Button size="sm" onClick={enablePush}>تفعيل</Button></div></Banner>}
    <Card><Async state={list}>{(rows) => { const v = rows.filter((n) => (filter === "all" || !n.read_at) && (!type || n.type.includes(type)));
      return !v.length ? <Empty icon="bell">لا توجد إشعارات.</Empty> : <ul className="list">{v.map((n) => <li key={n.id}><button className={`item${n.read_at ? "" : " unread"}`} style={{ width: "100%", background: "none", border: 0, font: "inherit", color: "inherit", textAlign: "start", cursor: "pointer" }} onClick={async () => { if (!n.read_at) await supabase.from("notifications").update({ read_at: new Date().toISOString() }).eq("id", n.id); if (n.link) navigate(n.link); else list.reload(); }}>
        <Icon name={n.level === "success" ? "check" : n.level === "warning" || n.level === "critical" ? "alert" : "bell"} /><div className="grow"><strong>{n.title}</strong>{n.body && <div className="small muted">{n.body}</div>}<div className="small muted">{ago(n.created_at)}</div></div></button></li>)}</ul>; }}</Async></Card>
  </>);
}

// ---------------------------------------------------------------- Support
export function SupportList() {
  const list = useAsync(() => must<any[]>(supabase.from("support_tickets").select("*").order("updated_at", { ascending: false }).limit(50)), []);
  return (<><div className="row between"><h1>الدعم الفني</h1><Link to="/support/new" className="btn sm"><Icon name="plus" size={16} />تذكرة جديدة</Link></div>
    <Card><Async state={list}>{(rows) => !rows.length ? <Empty icon="headset">لا توجد تذاكر.</Empty> : <ul className="list">{rows.map((t) => <li key={t.id}><Link className="item" to={`/support/${t.id}`}><div className="grow"><strong>{t.subject}</strong><div className="small muted">{CATEGORY[t.category]} · {ago(t.updated_at)}</div></div><Badge label={TICKET[t.status]} /></Link></li>)}</ul>}</Async></Card></>);
}
export function NewTicket() {
  const { navigate } = useNav(); const { run, busy } = useAction(); const { session } = useAuth(); const toast = useToast(); const file = useRef<HTMLInputElement>(null);
  const recent = useAsync(() => recentOrders(10), []);
  const [f, setF] = useState({ category: "other", subject: "", body: "", related: "" }); const set = (k: string, v: string) => setF((x) => ({ ...x, [k]: v }));
  async function submit() {
    if (f.subject.trim().length < 3 || !f.body.trim()) { toast("bad", "أدخل عنوانًا ووصفًا للمشكلة"); return; }
    let attachment: string | undefined; const fl = file.current?.files?.[0];
    if (fl) { if (!TYPES.includes(fl.type) || fl.size > MAX_FILE) { toast("bad", "الملف غير مسموح أو أكبر من 5 ميغابايت"); return; }
      const path = `${session!.user.id}/${crypto.randomUUID()}.${fl.type === "application/pdf" ? "pdf" : fl.type.split("/")[1]}`; const up = await supabase.storage.from("support").upload(path, fl, { contentType: fl.type }); if (up.error) { toast("bad", "تعذّر رفع الملف"); return; } attachment = path; }
    const [rt, rid] = f.related ? f.related.split(":") : [undefined, undefined];
    const id = await run(() => api<string>("ticket.create", { category: f.category, subject: f.subject.trim(), body: f.body.trim(), related_type: rt, related_id: rid, attachment }), "تم إنشاء التذكرة"); if (id) navigate(`/support/${id}`);
  }
  return (<><h1>تذكرة جديدة</h1><Card>
    <Field id="tc" label="التصنيف"><Select id="tc" value={f.category} onChange={(e) => set("category", e.target.value)}>{Object.entries(CATEGORY).map(([v, l]) => <option key={v} value={v}>{l}</option>)}</Select></Field>
    <Field id="tr" label="العملية المرتبطة (اختياري)"><Select id="tr" value={f.related} onChange={(e) => set("related", e.target.value)}><option value="">بدون</option>{recent.data?.map((o) => <option key={o.id} value={`${o.kind}_order:${o.id}`}>{kindLabel[o.kind as keyof typeof kindLabel]} · {o.ref}</option>)}</Select></Field>
    <Field id="ts" label="العنوان"><Input id="ts" value={f.subject} maxLength={200} onChange={(e) => set("subject", e.target.value)} /></Field>
    <Field id="tb" label="وصف المشكلة"><Textarea id="tb" value={f.body} maxLength={5000} onChange={(e) => set("body", e.target.value)} /></Field>
    <Field id="tf" label="مرفق (اختياري)" hint="JPG أو PNG أو WebP أو PDF حتى 5 ميغابايت"><input id="tf" ref={file} type="file" accept={TYPES.join(",")} className="input" /></Field>
    <Button block busy={busy} onClick={submit}>إرسال</Button></Card></>);
}
export function TicketThread({ staff }: { staff?: boolean }) {
  const { id } = useParams(); const { session } = useAuth(); const { run, busy } = useAction(); const [body, setBody] = useState("");
  const t = useAsync(() => must<any>(supabase.from("support_tickets").select("*").eq("id", id).single()), [id]);
  const msgs = useAsync(() => must<any[]>(supabase.from("support_messages").select("*").eq("ticket_id", id).order("created_at")), [id]);
  useEffect(() => { const ch = supabase.channel(`tk-${id}`).on("postgres_changes", { event: "INSERT", schema: "public", table: "support_messages", filter: `ticket_id=eq.${id}` }, () => { msgs.reload(); t.reload(); }).subscribe(); return () => { supabase.removeChannel(ch); }; }, [id]);
  const reload = () => { t.reload(); msgs.reload(); };
  return (<>
    <Link to={staff ? "/admin/support" : "/support"} className="small">← كل التذاكر</Link>
    <Async state={t}>{(tk) => (<>
      <div className="row between"><h1>{tk.subject}</h1><Badge label={TICKET[tk.status]} /></div><p className="muted small">{CATEGORY[tk.category]} · <span className="mono">{tk.ref}</span>{tk.related_id && <> · <Link to={tk.related_type === "deposit_order" ? `/wallet/deposits/${tk.related_id}` : `/orders/${tk.related_type.replace("_order", "")}/${tk.related_id}`}>العملية المرتبطة</Link></>}</p>
      <Card><Async state={msgs}>{(m) => <div className="chat" aria-live="polite">{m.map((x) => <div key={x.id} className={`msg ${x.author_id === session?.user.id ? "mine" : x.is_staff ? "staff" : ""}`}><div className="meta">{x.is_staff ? "الدعم الفني" : "العميل"} · {dt(x.created_at)}</div><div className="prose">{x.body}</div></div>)}</div>}</Async></Card>
      {tk.status !== "closed" ? <Card><Field id="rp" label="ردّك"><Textarea id="rp" value={body} maxLength={5000} onChange={(e) => setBody(e.target.value)} /></Field>
        <div className="row"><Button busy={busy} disabled={!body.trim()} onClick={async () => { const r = await run(() => api("ticket.reply", { ticket_id: tk.id, body: body.trim() })); if (r !== undefined) { setBody(""); reload(); } }}>إرسال</Button>
          <Button variant="ghost" onClick={async () => { await run(() => api("ticket.close", { ticket_id: tk.id }), "تم إغلاق التذكرة"); reload(); }}>إغلاق التذكرة</Button></div></Card>
        : !staff && <Button variant="ghost" onClick={async () => { await run(() => api("ticket.reopen", { ticket_id: tk.id }), "أُعيد فتح التذكرة"); reload(); }}>إعادة فتح التذكرة</Button>}
    </>)}</Async></>);
}

// ---------------------------------------------------------------- Profile / settings / more
export function More() {
  const { signOut } = useAuth(); const { navigate } = useNav();
  const items: [string, string, string][] = [["/wallet/deposit", "wallet", "شحن المحفظة"], ["/payout-methods", "bank", "وسائل الاستلام"], ["/notifications", "bell", "الإشعارات"], ["/support", "headset", "الدعم الفني"], ["/profile", "user", "الملف الشخصي والإعدادات"], ["/prices", "tag", "الأسعار"], ["/info/how-it-works", "info", "كيف تعمل المنصة"], ["/info/terms", "file", "الشروط والخصوصية"]];
  return (<><h1>المزيد</h1><Card><ul className="list">{items.map(([to, ic, l]) => <li key={to}><Link to={to} className="item"><Icon name={ic} /><span className="grow">{l}</span><Icon name="left" size={18} /></Link></li>)}</ul></Card>
    <Button variant="ghost" block onClick={async () => { await signOut(); navigate("/", { replace: true }); }}><Icon name="logout" size={18} />تسجيل الخروج</Button></>);
}
export function Profile() {
  const { profile, refresh, session } = useAuth(); const { run, busy } = useAction(); const toast = useToast();
  const [name, setName] = useState(profile?.full_name ?? ""); const [phone, setPhone] = useState(profile?.phone ?? ""); const [pw, setPw] = useState(""); const [pw2, setPw2] = useState("");
  const [theme, setTheme] = useState(localStorage.getItem("theme") ?? "auto"); const [mfa, setMfa] = useState<{ id: string; qr: string; secret: string } | null>(null); const [code, setCode] = useState("");
  const factors = useAsync(async () => (await supabase.auth.mfa.listFactors()).data?.totp ?? [], []);
  useEffect(() => { const r = document.documentElement; if (theme === "auto") r.removeAttribute("data-theme"); else r.setAttribute("data-theme", theme); try { localStorage.setItem("theme", theme); } catch { /* ignore */ } }, [theme]);
  return (<>
    <h1>الملف الشخصي</h1>
    <Card title="البيانات"><Field id="pn" label="الاسم الكامل"><Input id="pn" value={name} onChange={(e) => setName(e.target.value)} /></Field>
      <Field id="pp" label="رقم الهاتف"><Input id="pp" className="ltr" inputMode="tel" value={phone} onChange={(e) => setPhone(e.target.value)} /></Field>
      <p className="small muted">البريد: <span className="mono">{profile?.email ?? session?.user.email}</span></p>
      <Button busy={busy} onClick={async () => { if (name.trim().length < 2) { toast("bad", "أدخل اسمًا صحيحًا"); return; } await run(async () => { const { error } = await supabase.from("profiles").update({ full_name: name.trim(), phone: phone.trim() || null }).eq("id", session!.user.id); if (error) throw new Error("internal_error"); await refresh(); }, "تم حفظ البيانات"); }}>حفظ</Button></Card>
    <Card title="تغيير كلمة المرور"><Field id="np" label="كلمة المرور الجديدة"><Input id="np" type="password" autoComplete="new-password" value={pw} onChange={(e) => setPw(e.target.value)} /></Field>
      <Field id="np2" label="تأكيد كلمة المرور"><Input id="np2" type="password" autoComplete="new-password" value={pw2} onChange={(e) => setPw2(e.target.value)} /></Field>
      <Button busy={busy} onClick={async () => { if (pw.length < 8 || !/\d/.test(pw)) { toast("bad", "8 أحرف على الأقل مع رقم"); return; } if (pw !== pw2) { toast("bad", "كلمتا المرور غير متطابقتين"); return; } await run(async () => { const { error } = await supabase.auth.updateUser({ password: pw }); if (error) throw new Error("internal_error"); setPw(""); setPw2(""); }, "تم تغيير كلمة المرور"); }}>تغيير</Button></Card>
    <Card title="التحقق بخطوتين (TOTP)" sub="موصى به بشدة للموظفين ولكل من يملك رصيدًا.">
      <Async state={factors}>{(fs) => fs.some((x: any) => x.status === "verified") ? <Banner tone="ok">التحقق بخطوتين مفعّل.</Banner> : mfa ? (<div className="stack"><p className="small">امسح الرمز بتطبيق المصادقة، أو أدخل المفتاح يدويًا:</p><img src={mfa.qr} alt="رمز QR للتحقق بخطوتين" width={180} height={180} style={{ background: "#fff", padding: 8, borderRadius: 8 }} /><div className="mono small">{mfa.secret}</div>
        <Field id="mc" label="أدخل الرمز للتأكيد"><Input id="mc" className="ltr" inputMode="numeric" maxLength={6} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))} /></Field>
        <Button busy={busy} onClick={async () => { await run(async () => { const c = await supabase.auth.mfa.challenge({ factorId: mfa.id }); if (c.error) throw new Error("internal_error"); const v = await supabase.auth.mfa.verify({ factorId: mfa.id, challengeId: c.data.id, code }); if (v.error) throw new Error("invalid_value"); setMfa(null); factors.reload(); }, "تم تفعيل التحقق بخطوتين"); }}>تأكيد وتفعيل</Button></div>)
        : <Button variant="ghost" onClick={async () => { const { data, error } = await supabase.auth.mfa.enroll({ factorType: "totp" }); if (error || !data) { toast("bad", "تعذّر بدء التفعيل"); return; } setMfa({ id: data.id, qr: data.totp.qr_code, secret: data.totp.secret }); }}>تفعيل</Button>}</Async></Card>
    <Card title="المظهر"><Field id="th" label="الوضع"><Select id="th" value={theme} onChange={(e) => setTheme(e.target.value)}><option value="auto">تلقائي (حسب الجهاز)</option><option value="light">فاتح</option><option value="dark">داكن</option></Select></Field></Card>
    <Card title="تثبيت التطبيق"><p className="small">على Android (Chrome): القائمة ⋮ ← «تثبيت التطبيق» أو «إضافة إلى الشاشة الرئيسية». على iPhone (Safari): زر المشاركة ← «إضافة إلى الشاشة الرئيسية».</p></Card>
  </>);
}
