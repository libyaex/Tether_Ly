import { useEffect, useState } from "react";
import { supabase, must } from "../../lib/supabase";
import { api, fn } from "../../lib/api";
import { useAsync } from "../../lib/hooks";
import { useAuth } from "../../lib/auth";
import { Async, Badge, Banner, Button, Card, Confirm, Field, Input, Select, Tabs, Textarea, useAction } from "../../components/ui";
import { dt } from "../../lib/format";
import { useSettings } from "../../lib/settings";

type Kind = "text" | "bool" | "num" | "color" | "url" | "area" | "json";
const HEX = /^#[0-9a-fA-F]{6}$/;

function SettingRow({ k, label, kind, hint, values, reload, suffix }: { k: string; label: string; kind: Kind; hint?: string; values: Record<string, any>; reload: () => void; suffix?: string }) {
  const cur = values[k]; const str = (v: any) => (v === null || v === undefined ? "" : kind === "json" ? JSON.stringify(v, null, 2) : String(v));
  const [v, setV] = useState(str(cur)); const [err, setErr] = useState<string | null>(null); const { run, busy } = useAction();
  useEffect(() => setV(str(cur)), [JSON.stringify(cur)]);
  const dirty = v !== str(cur);
  function parse(): { ok: true; value: unknown } | { ok: false; msg: string } {
    if (kind === "bool") return { ok: true, value: v === "true" };
    if (kind === "num") { if (v.trim() === "") return { ok: true, value: null }; if (!/^\d+(\.\d+)?$/.test(v.trim())) return { ok: false, msg: "أدخل رقمًا صحيحًا" }; return { ok: true, value: Number(v) }; }
    if (kind === "color") return HEX.test(v) ? { ok: true, value: v } : { ok: false, msg: "الصيغة #RRGGBB" };
    if (kind === "url") return v === "" || /^https:\/\/\S+$/.test(v) ? { ok: true, value: v } : { ok: false, msg: "يجب أن يبدأ الرابط بـ https://" };
    if (kind === "json") { try { return { ok: true, value: JSON.parse(v || "null") }; } catch { return { ok: false, msg: "JSON غير صالح" }; } }
    return { ok: true, value: v };
  }
  async function save() { const p = parse(); if (!p.ok) { setErr(p.msg); return; } setErr(null); const r = await run(() => api("setting.update", { key: k, value: p.value }), "تم الحفظ"); if (r !== undefined) reload(); }
  return (
    <Field id={`s-${k}`} label={label} hint={hint ?? k} error={err}>
      <div className="row">
        {kind === "bool" ? <Select id={`s-${k}`} value={v || "false"} onChange={(e) => setV(e.target.value)}><option value="true">مفعّل</option><option value="false">متوقف</option></Select>
          : kind === "area" || kind === "json" ? <Textarea id={`s-${k}`} className={kind === "json" ? "ltr" : undefined} style={{ minHeight: kind === "area" ? 160 : 120 }} value={v} onChange={(e) => setV(e.target.value)} />
          : kind === "color" ? <><input type="color" aria-label={label} value={HEX.test(v) ? v : "#000000"} onChange={(e) => setV(e.target.value)} style={{ width: 52, height: 48, border: 0, background: "none" }} /><Input id={`s-${k}`} className="ltr" value={v} onChange={(e) => setV(e.target.value)} invalid={!!err} /></>
          : <Input id={`s-${k}`} className={kind === "num" || kind === "url" ? "ltr" : undefined} inputMode={kind === "num" ? "decimal" : undefined} value={v} onChange={(e) => setV(e.target.value)} invalid={!!err} />}
        {suffix && <span className="muted small">{suffix}</span>}
        <Button size="sm" busy={busy} disabled={!dirty} onClick={save}>حفظ</Button>
      </div>
    </Field>
  );
}

export function AdminSettings() {
  const { has } = useAuth(); const { reload: reloadPublic } = useSettings(); const [tab, setTab] = useState("general");
  const all = useAsync(async () => Object.fromEntries((await must<any[]>(supabase.from("admin_settings").select("key,value"))).map((r) => [r.key, r.value])) as Record<string, any>, []);
  const reload = () => { all.reload(); reloadPublic(); };
  const can = has("settings.write");
  return (<><h1>إعدادات المنصة</h1>
    {!can && <Banner tone="info">لديك صلاحية القراءة فقط.</Banner>}
    <Tabs value={tab} onChange={setTab} items={[{ id: "general", label: "عام والهوية" }, { id: "trading", label: "التداول" }, { id: "payments", label: "الدفع" }, { id: "networks", label: "الشبكات والعناوين" }, { id: "security", label: "الأمان" }, { id: "notify", label: "الإشعارات" }, { id: "maintenance", label: "الصيانة" }, { id: "content", label: "المحتوى" }]} />
    <Async state={all}>{(v) => { const P = { values: v, reload }; return (<fieldset disabled={!can} style={{ border: 0, padding: 0, margin: 0 }}>
      {tab === "general" && <Card title="الهوية والتواصل" sub="تنعكس فورًا على الواجهة دون تعديل الكود.">
        <SettingRow k="platform.name" label="اسم المنصة" kind="text" {...P} /><SettingRow k="platform.tagline" label="الشعار النصي" kind="text" {...P} /><SettingRow k="platform.description" label="وصف الموقع" kind="area" {...P} />
        <SettingRow k="platform.logo_url" label="رابط الشعار (https)" kind="url" hint="صورة PNG/SVG على رابط https" {...P} /><SettingRow k="platform.primary_color" label="اللون الأساسي" kind="color" {...P} /><SettingRow k="platform.accent_color" label="اللون الثانوي" kind="color" {...P} />
        <SettingRow k="platform.support_email" label="البريد الرسمي للدعم" kind="text" {...P} /><SettingRow k="platform.support_phone" label="رقم الدعم" kind="text" {...P} /><SettingRow k="platform.website" label="رابط الموقع" kind="url" {...P} />
        <SettingRow k="platform.legal_entity" label="بيانات الشركة القانونية" kind="area" hint="اتركها فارغة حتى تتوفر بيانات موثقة" {...P} /><SettingRow k="platform.social_links" label="روابط التواصل الاجتماعي (JSON)" kind="json" {...P} />
        <SettingRow k="platform.timezone" label="المنطقة الزمنية" kind="text" hint="مثال: Africa/Tripoli" {...P} />
        <p className="small muted">اللغة الافتراضية: العربية (RTL). الواجهة معدّة للعربية فقط حاليًا؛ إضافة لغات تتطلب ترجمة النصوص.</p></Card>}
      {tab === "trading" && <Card title="التداول والحدود">
        <SettingRow k="trading.buy_enabled" label="شراء USDT" kind="bool" {...P} /><SettingRow k="trading.sell_enabled" label="بيع USDT" kind="bool" {...P} />
        <SettingRow k="trading.quote_ttl_seconds" label="مدة تثبيت السعر" kind="num" suffix="ثانية" {...P} /><SettingRow k="trading.sell_deposit_window_minutes" label="مهلة إيداع USDT لطلب البيع" kind="num" suffix="دقيقة" {...P} />
        <SettingRow k="trading.user_daily_limit_lyd" label="الحد اليومي للمستخدم" kind="num" suffix="د.ل (فارغ = بلا حد)" {...P} /><SettingRow k="trading.large_order_lyd" label="حد العملية الكبيرة (تنبيه الموظفين)" kind="num" suffix="د.ل (فارغ = بلا تنبيه)" {...P} />
        <SettingRow k="rates.max_change_pct" label="أقصى تغيير للسعر دون تأكيد إضافي" kind="num" suffix="%" hint="الافتراضي 10" {...P} />
        <p className="small muted">الأسعار والرسوم وحدود العملية الواحدة من صفحة «الأسعار».</p></Card>}
      {tab === "payments" && <Payments v={v} {...P} />}
      {tab === "networks" && <Networks />}
      {tab === "security" && <Card title="الأمان">
        <SettingRow k="security.separation_of_duties" label="فصل المهام (من يعتمد الإيداع ≠ من يسجّل الصرف ≠ من يعتمده)" kind="bool" {...P} />
        <SettingRow k="security.auto_activate_on_signup" label="تفعيل الحسابات الجديدة تلقائيًا" kind="bool" hint="الافتراضي: متوقف (مراجعة يدوية)" {...P} /><SettingRow k="payout.require_proof" label="اشتراط إرفاق إثبات عند تسجيل الصرف" kind="bool" {...P} />
        <Banner tone="info">مدة الجلسة وقفل الحساب بعد محاولات فاشلة وتأكيد البريد وسياسة كلمات المرور تُضبط في إعدادات Supabase Auth (لوحة Supabase). تحديد المعدل مفعّل في الخادم (حدود لكل مستخدم وإجراء). CORS يُضبط عبر متغير ALLOWED_ORIGINS.</Banner></Card>}
      {tab === "notify" && <Card title="الإشعارات والتنبيهات">
        <SettingRow k="ops.sla_minutes" label="مهلة المعالجة قبل تنبيه التأخر (SLA)" kind="num" suffix="دقيقة" {...P} /><SettingRow k="ops.min_liquidity_lyd" label="حد تنبيه انخفاض السيولة (دينار)" kind="num" suffix="د.ل" {...P} /><SettingRow k="ops.min_usdt_inventory" label="حد تنبيه انخفاض USDT" kind="num" suffix="USDT" {...P} />
        <Banner tone="info">الإشعارات داخل التطبيق تعمل دائمًا، وتصل للموظفين حسب الدور. تنبيهات فشل التكامل واختلاف الدفتر وعدم تطابق الأرصدة تُرسل تلقائيًا. إشعارات الجهاز (Web Push) تحتاج مفاتيح VAPID على الخادم؛ والبريد يمرّ عبر مزوّد البريد المضبوط في Supabase Auth.</Banner></Card>}
      {tab === "maintenance" && <Card title="وضع الصيانة" sub="يوقف الطلبات الجديدة (شراء/بيع/شحن) مع بقاء الطلبات القائمة ظاهرة للعملاء.">
        <SettingRow k="maintenance.enabled" label="وضع الصيانة" kind="bool" {...P} /><SettingRow k="maintenance.message" label="رسالة الصيانة" kind="area" {...P} /><SettingRow k="maintenance.eta" label="المدة المتوقعة" kind="text" {...P} /><SettingRow k="maintenance.allow_staff" label="السماح للموظفين بالمتابعة" kind="bool" {...P} /></Card>}
      {tab === "content" && <Content v={v} {...P} />}
    </fieldset>); }}</Async></>);
}

function Payments({ v, values, reload }: { v: Record<string, any>; values: Record<string, any>; reload: () => void }) {
  const { has } = useAuth();
  const { run, busy } = useAction();
  const [go, setGo] = useState(false);
  const [typed, setTyped] = useState("");
  const [chk, setChk] = useState<any>(null);

  const health = useAsync(
    () =>
      must<any[]>(
        supabase
          .from("system_health_checks")
          .select("check_name,status,detail,checked_at")
          .in("check_name", ["dpay_webhook", "dpay_reconcile", "dpay_connectivity"])
          .order("checked_at", { ascending: false })
          .limit(30)
      ),
    []
  );
  const last = (n: string) => health.data?.find((h) => h.check_name === n);
  const P = { values, reload };
  const live = v["payments.dpay_mode"] === "live";
  const missing = [
    v["payments.dpay_live_approved"] === true ? null : "موافقة DPay الكتابية على النشاط (يسجّلها المدير العام)",
    v["payments.topup_min_lyd"] != null && v["payments.topup_max_lyd"] != null ? null : "حدود الشحن",
  ].filter(Boolean) as string[];

  const tone = (s?: string) =>
    s === "ok"
      ? { text: "سليم", tone: "ok" as const }
      : s === "degraded"
      ? { text: "متدهور", tone: "warn" as const }
      : s
      ? { text: "متوقف", tone: "bad" as const }
      : { text: "لا بيانات", tone: "wait" as const };

  return (
    <>
      <Card title="إعدادات بوابة الدفع الوطنية DPay (dpay.ly)">
        <div className="row between wrap" style={{ marginBottom: "1rem" }}>
          <div className="row" style={{ gap: "8px" }}>
            <span style={{ fontWeight: 600 }}>الوضع التشغيلي النشط:</span>
            <span className={`badge ${live ? "ok" : "warn"}`} style={{ fontSize: "0.85rem" }}>
              {live ? "Live (الإنتاج)" : "Sandbox (بيئة اختبار مزوّد الدفع)"}
            </span>
          </div>
          <div className="row" style={{ gap: "6px" }}>
            <Button
              size="sm"
              variant={!live ? "accent" : "ghost"}
              onClick={async () => {
                await api("setting.update", { key: "payments.dpay_mode", value: "sandbox" });
                reload();
              }}
            >
              تفعيل وضع Sandbox
            </Button>
            <Button
              size="sm"
              variant={live ? "accent" : "ghost"}
              onClick={() => {
                if (!live) setGo(true);
              }}
            >
              التحويل إلى وضع Live
            </Button>
          </div>
        </div>

        <Banner tone="info" icon="shield">
          رموز API وأسرار الـ Webhook لا تُحفظ في هذه الصفحة ولا في قاعدة البيانات. تُضبط كأسرار لدوال Supabase Edge فقط:
          <span className="ltr mono"> DPAY_TOKEN_LIVE · DPAY_TOKEN_SANDBOX · DPAY_WEBHOOK_SECRET_LIVE · DPAY_WEBHOOK_SECRET_SANDBOX</span>
          (راجع docs/DEPLOYMENT.md).
        </Banner>

        {/* Operational Limits */}
        <h3 style={{ fontSize: "0.95rem", color: "#f8fafc", margin: "1.5rem 0 0.75rem" }}>
          ضوابط وحدود الشحن بالدينار الليبي
        </h3>
        <SettingRow k="payments.topups_enabled" label="تفعيل الشحن الإلكتروني" kind="bool" {...P} />
        <SettingRow k="payments.topup_min_lyd" label="الحد الأدنى للشحن" kind="num" suffix="د.ل" {...P} />
        <SettingRow k="payments.topup_max_lyd" label="الحد الأقصى للشحن" kind="num" suffix="د.ل" {...P} />
        <SettingRow k="payments.checkout_ttl_minutes" label="مهلة جلسة الدفع Hosted Checkout" kind="num" suffix="دقيقة" hint="الافتراضي 30 دقيقة" {...P} />

        <div className="row wrap" style={{ gap: "0.6rem", marginTop: "1.5rem" }}>
          <Button
            variant="accent"
            busy={busy}
            onClick={async () => {
              const r = await run(() => fn<any>("dpay-check"));
              if (r) {
                setChk(r);
                health.reload();
              }
            }}
          >
            فحص الاتصال والتوثيق مع DPay
          </Button>
          {chk && (
            <span className={`badge ${chk.result === "ok" ? "ok" : "bad"}`} style={{ padding: "0.45rem 0.85rem" }}>
              {chk.diagnostic || (chk.result === "ok" ? "الاتصال سليم" : "خطأ بالاتصال")}
            </span>
          )}
        </div>
      </Card>

      <Card title="سجل مطابقة وحالة تكامل DPay">
        <ul className="list">
          {[
            ["dpay_webhook", "آخر إشعار Webhook مستلم من dpay.ly"],
            ["dpay_reconcile", "آخر مطابقة دورية للحسابات ومقاصة DPay"],
            ["dpay_connectivity", "حالة الاتصال بالخادم المباشر"],
          ].map(([k, l]) => {
            const h = last(k);
            return (
              <li key={k}>
                <div className="item">
                  <span className="grow">
                    {l}
                    {h && <div className="small muted">{dt(h.checked_at)}</div>}
                  </span>
                  <Badge label={tone(h?.status)} />
                </div>
              </li>
            );
          })}
        </ul>
      </Card>

      <Card title="ضوابط الانتقال إلى الإنتاج الفعلي (Live Mode)" sub="يخضع لاعتماد المدير العام ومطابقة المتطلبات">
        {live ? (
          <Banner tone="ok">
            <strong>النظام يعمل حاليًا بالوضع الفعلي المباشر (Live Mode).</strong> جميع عمليات الدفع بالدينار الليبي
            تُنفذ عبر بطاقات المصارف الليبية ومحفظة DPay الحقيقية.
          </Banner>
        ) : (
          <>
            <SettingRow
              k="payments.dpay_live_approved"
              label="تأكيد: DPay وافقت كتابيًا على هذا النشاط (المدير العام فقط)"
              kind="bool"
              {...P}
            />
            {missing.length > 0 ? (
              <Banner tone="warn">
                <strong>المتطلبات المتبقية قبل الانتقال المباشر:</strong>
                <ul>
                  {missing.map((m) => (
                    <li key={m}>{m}</li>
                  ))}
                </ul>
              </Banner>
            ) : (
              <Banner tone="info">الشروط الأساسية مكتملة. تأكد من إدخال رمز Live وسر Webhook واختبار تدفق الدفع بالكامل.</Banner>
            )}
            <Button variant="danger" disabled={!has("settings.write")} onClick={() => setGo(true)}>
              الانتقال إلى الوضع الحي…
            </Button>
          </>
        )}
        {go && (
          <Confirm
            danger
            title="تأكيد الانتقال إلى الوضع الحي Live"
            confirmText="تأكيد التحويل"
            body={
              <>
                <Banner tone="bad">
                  ستصبح مدفوعات العملاء حقيقية عبر بوابة DPay المباشرة.
                </Banner>
                <Field id="gl" label='اكتب "GO LIVE" للتأكيد'>
                  <Input id="gl" className="ltr" value={typed} onChange={(e) => setTyped(e.target.value)} />
                </Field>
              </>
            }
            onClose={() => setGo(false)}
            onConfirm={async () => {
              if (typed !== "GO LIVE") throw new Error("confirmation_required");
              await api("setting.update", { key: "payments.dpay_mode", value: "live", confirm: typed });
              reload();
            }}
          />
        )}
      </Card>
    </>
  );
}

function Networks() {
  const nets = useAsync(() => must<any[]>(supabase.from("supported_networks").select("*").order("code")), []);
  const addrs = useAsync(() => must<any[]>(supabase.from("deposit_addresses").select("*").order("created_at", { ascending: false })), []);
  const [edit, setEdit] = useState<any>(null); const { run, busy } = useAction(); const [na, setNa] = useState({ network: "", address: "", instructions: "" });
  const blank = { code: "", display_name: "", status: "disabled", min_deposit: "0", required_confirmations: "1", address_regex: "", explorer_tx_url: "", instructions: "", warnings: "" };
  const reload = () => { nets.reload(); addrs.reload(); };
  async function save() { const r = await run(() => api("network.upsert", { code: edit.code, display_name: edit.display_name, status: edit.status, min_deposit: String(edit.min_deposit), confirmations: String(edit.required_confirmations), address_regex: edit.address_regex, explorer: edit.explorer_tx_url || undefined, instructions: edit.instructions || undefined, warnings: edit.warnings || undefined }), "تم حفظ الشبكة"); if (r !== undefined) { setEdit(null); reload(); } }
  const E = (k: string, label: string, area?: boolean, ltr?: boolean) => <Field id={`n-${k}`} label={label}>{area ? <Textarea id={`n-${k}`} value={edit[k] ?? ""} onChange={(e) => setEdit({ ...edit, [k]: e.target.value })} /> : <Input id={`n-${k}`} className={ltr ? "ltr" : undefined} value={edit[k] ?? ""} onChange={(e) => setEdit({ ...edit, [k]: e.target.value })} />}</Field>;
  return (<>
    <Card title="الشبكات المدعومة" sub="لا تُضاف شبكة أو عنوان افتراضي. أنشئ الشبكة بصيغة تحقق (Regex) صحيحة لعناوينها ثم أضف عنوان الإيداع ووثّقه.">
      <Async state={nets}>{(rows) => <ul className="list">{rows.map((n) => <li key={n.code}><div className="item"><div className="grow"><strong>{n.display_name}</strong> <span className="mono">{n.code}</span><div className="small muted">حد أدنى {n.min_deposit} · تأكيدات {n.required_confirmations}</div></div><Badge label={n.status === "active" ? { text: "نشطة", tone: "ok" } : { text: "متوقفة", tone: "wait" }} /><Button size="sm" variant="ghost" onClick={() => setEdit(n)}>تعديل</Button></div></li>)}{!rows.length && <li className="muted small">لا توجد شبكات بعد.</li>}</ul>}</Async>
      <Button size="sm" onClick={() => setEdit(blank)}>إضافة شبكة</Button></Card>
    {edit && <Card title={edit.created_at || nets.data?.some((n) => n.code === edit.code) ? "تعديل شبكة" : "شبكة جديدة"}>
      {E("code", "الرمز (أحرف كبيرة وأرقام)", false, true)}{E("display_name", "الاسم المعروض")}
      <Field id="n-st" label="الحالة"><Select id="n-st" value={edit.status} onChange={(e) => setEdit({ ...edit, status: e.target.value })}><option value="active">نشطة</option><option value="disabled">متوقفة</option></Select></Field>
      <div className="grid2 keep">{E("min_deposit", "الحد الأدنى للإيداع (USDT)", false, true)}{E("required_confirmations", "عدد التأكيدات", false, true)}</div>
      {E("address_regex", "صيغة التحقق من العنوان (Regex)", false, true)}{E("explorer_tx_url", "رابط المستكشف (https، استخدم {txid})", false, true)}{E("instructions", "تعليمات الإيداع", true)}{E("warnings", "تحذيرات", true)}
      <div className="row"><Button busy={busy} onClick={save}>حفظ</Button><Button variant="ghost" onClick={() => setEdit(null)}>إلغاء</Button></div></Card>}
    <Card title="عناوين الإيداع" sub="عنوان نشط واحد لكل شبكة. التفعيل يعطّل العنوان النشط السابق تلقائيًا. العنوان المعطَّل لا يُفعَّل مجددًا. لا تُخزَّن المفاتيح الخاصة هنا أبدًا.">
      <Async state={addrs}>{(rows) => <ul className="list">{rows.map((a) => <li key={a.id}><div className="item"><div className="grow"><span className="mono">{a.address}</span><div className="small muted">{a.network_code} · {a.activated_at ? `فُعّل ${dt(a.activated_at)}` : "لم يُفعَّل"}{a.disabled_at ? ` · عُطّل ${dt(a.disabled_at)}` : ""}</div></div>
        <Badge label={a.status === "active" ? { text: "نشط", tone: "ok" } : a.status === "draft" ? { text: "مسودة", tone: "wait" } : { text: "معطّل", tone: "bad" }} />
        {a.status !== "active" && a.status !== "disabled" && <Button size="sm" busy={busy} onClick={async () => { await run(() => api("address.activate", { id: a.id }), "تم التفعيل"); reload(); }}>تفعيل</Button>}
        {a.status !== "disabled" && <Button size="sm" variant="ghost" onClick={async () => { await run(() => api("address.disable", { id: a.id }), "تم التعطيل"); reload(); }}>تعطيل</Button>}</div></li>)}{!rows.length && <li className="muted small">لا توجد عناوين.</li>}</ul>}</Async>
      <hr style={{ border: 0, borderTop: "1px solid var(--line)", margin: "1rem 0" }} />
      <div className="grid2"><Field id="na-n" label="الشبكة"><Select id="na-n" value={na.network} onChange={(e) => setNa({ ...na, network: e.target.value })}><option value="">اختر…</option>{nets.data?.map((n) => <option key={n.code}>{n.code}</option>)}</Select></Field><Field id="na-a" label="العنوان"><Input id="na-a" className="ltr" value={na.address} onChange={(e) => setNa({ ...na, address: e.target.value.trim() })} /></Field></div>
      <Field id="na-i" label="تعليمات خاصة بالعنوان (اختياري)"><Input id="na-i" value={na.instructions} onChange={(e) => setNa({ ...na, instructions: e.target.value })} /></Field>
      <Button busy={busy} disabled={!na.network || !na.address} onClick={async () => { const r = await run(() => api("address.add", { network: na.network, address: na.address, instructions: na.instructions || undefined }), "أُضيف العنوان كمسودة. فعّله بعد التحقق منه"); if (r !== undefined) { setNa({ network: "", address: "", instructions: "" }); reload(); } }}>إضافة كمسودة</Button></Card></>);
}

function Content({ v, values, reload }: { v: Record<string, any>; values: Record<string, any>; reload: () => void }) {
  const P = { values, reload }; const faq: { q: string; a: string }[] = Array.isArray(v["content.faq"]) ? v["content.faq"] : []; const [rows, setRows] = useState(faq); const { run, busy } = useAction();
  useEffect(() => setRows(Array.isArray(v["content.faq"]) ? v["content.faq"] : []), [JSON.stringify(v["content.faq"])]);
  return (<><Banner tone="warn">النصوص القانونية (الشروط، الخصوصية، المخاطر…) يجب أن يكتبها أو يعتمدها المالك/مستشار قانوني. تُترك فارغة حتى تُكتب، وتظهر للزوار عبارة «لم يُنشر بعد».</Banner>
    <Card title="صفحات المحتوى">{[["content.about", "من نحن"], ["content.how_it_works", "كيف تعمل المنصة"], ["content.fees", "الرسوم"], ["content.terms", "شروط الاستخدام"], ["content.privacy", "سياسة الخصوصية"], ["content.complaints", "معالجة الشكاوى"], ["content.refunds", "الإلغاء والاسترجاع"], ["content.risk", "إخلاء مسؤولية المخاطر"]].map(([k, l]) => <SettingRow key={k} k={k} label={l} kind="area" {...P} />)}</Card>
    <Card title="الأسئلة الشائعة">{rows.map((r, i) => <div key={i} className="card flat"><Field id={`q${i}`} label={`السؤال ${i + 1}`}><Input id={`q${i}`} value={r.q} onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, q: e.target.value } : x)))} /></Field><Field id={`a${i}`} label="الإجابة"><Textarea id={`a${i}`} value={r.a} onChange={(e) => setRows(rows.map((x, j) => (j === i ? { ...x, a: e.target.value } : x)))} /></Field><Button size="sm" variant="ghost" onClick={() => setRows(rows.filter((_, j) => j !== i))}>حذف</Button></div>)}
      <div className="row"><Button size="sm" variant="ghost" onClick={() => setRows([...rows, { q: "", a: "" }])}>إضافة سؤال</Button><Button busy={busy} onClick={async () => { const r = await run(() => api("setting.update", { key: "content.faq", value: rows.filter((x) => x.q.trim() && x.a.trim()) }), "تم حفظ الأسئلة"); if (r !== undefined) reload(); }}>حفظ الأسئلة</Button></div></Card></>);
}
