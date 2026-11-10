import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNav, useParams } from "../lib/router";
import { supabase, must } from "../lib/supabase";
import { api, fn } from "../lib/api";
import { ApiError, errorMessage } from "../lib/errors";
import { useAsync } from "../lib/hooks";
import { useAuth } from "../lib/auth";
import { useSettings } from "../lib/settings";
import { Async, Badge, Banner, Button, Card, Field, Input, Select, Stat, useAction, Empty } from "../components/ui";
import { Icon } from "../components/Icon";
import { BUY, DEPOSIT, SELL } from "../lib/labels";
import { dt, lyd, usdt } from "../lib/format";
import { calcBuy, calcSell, validAmount, cleanAmount } from "../lib/decimal";
import { useToast } from "../lib/toast";
import { useRate } from "./public";

// ---------------------------------------------------------------- Dashboard
export async function recentOrders(limit = 5, userId?: string) {
  const sel = (t: string, extra: string) => {
    let q = supabase
      .from(t)
      .select(`id,ref,status,created_at,${extra}`)
      .order("created_at", { ascending: false })
      .limit(limit);
    if (userId) q = q.eq("user_id", userId);
    return must<any[]>(q);
  };
  const [d, b, s] = await Promise.all([
    sel("deposit_orders", "amount"),
    sel("buy_orders", "usdt_amount,lyd_total"),
    sel("sell_orders", "usdt_expected,lyd_net"),
  ]);
  return [
    ...d.map((x) => ({ ...x, kind: "deposit" })),
    ...b.map((x) => ({ ...x, kind: "buy" })),
    ...s.map((x) => ({ ...x, kind: "sell" })),
  ]
    .sort((a, b) => +new Date(b.created_at) - +new Date(a.created_at))
    .slice(0, limit);
}
export const kindLabel = { deposit: "شحن رصيد", buy: "شراء USDT", sell: "بيع USDT" } as const;
export const kindLink = (k: string, id: string) =>
  k === "deposit" ? `/wallet/deposits/${id}` : `/orders/${k}/${id}`;
export const statusLabel = (k: string, s: string) =>
  (k === "deposit" ? DEPOSIT : k === "buy" ? BUY : SELL)[s] ?? { text: s, tone: "wait" as const };
export const orderAmount = (o: any) =>
  o.kind === "deposit" ? lyd(o.amount) : o.kind === "buy" ? usdt(o.usdt_amount) : usdt(o.usdt_expected);

export function Dashboard() {
  const { profile } = useAuth();
  const { s } = useSettings();
  const rate = useRate();
  const sum = useAsync(() => must<any>(supabase.rpc("my_summary")), []);
  const recent = useAsync(() => recentOrders(5), []);

  useEffect(() => {
    function onSync() {
      sum.reload();
      recent.reload();
    }
    window.addEventListener("db-updated", onSync);
    window.addEventListener("orders-updated", onSync);
    window.addEventListener("wallets-updated", onSync);
    window.addEventListener("storage", onSync);
    return () => {
      window.removeEventListener("db-updated", onSync);
      window.removeEventListener("orders-updated", onSync);
      window.removeEventListener("wallets-updated", onSync);
      window.removeEventListener("storage", onSync);
    };
  }, [sum.reload, recent.reload]);

  const buyRate = Number(rate.data?.sell_price || 10.45);

  return (
    <>
      {/* Welcome & Balance Overview */}
      <div className="row between wrap" style={{ marginBottom: "1rem" }}>
        <div>
          <div style={{ color: "var(--muted)", fontSize: "0.85rem" }}>لوحة تحكم العميل</div>
          <h1 style={{ fontSize: "1.75rem", margin: 0, color: "#ffffff" }}>
            أهلاً{profile?.full_name ? `، ${profile.full_name.split(" ")[0]}` : ""} 👋
          </h1>
        </div>
        <div className="hero-badge" style={{ margin: 0 }}>
          <span className="pulse-dot" />
          <span>المحفظة نشطة · حساب موثق</span>
        </div>
      </div>

      <Async state={sum} lines={4}>
        {(m) => {
          const approxUsdt = (Number(m.available || 0) / buyRate).toFixed(2);
          return (
            <>
              {/* Premium Hero Wallet Card */}
              <div
                style={{
                  background:
                    "linear-gradient(135deg, rgba(16, 185, 129, 0.18) 0%, rgba(15, 23, 42, 0.95) 60%, rgba(11, 15, 25, 0.98) 100%)",
                  border: "1px solid rgba(16, 185, 129, 0.35)",
                  borderRadius: "22px",
                  padding: "1.5rem",
                  boxShadow: "0 15px 35px -5px rgba(0, 0, 0, 0.6), 0 0 25px rgba(16, 185, 129, 0.15)",
                  marginBottom: "1.25rem",
                  position: "relative",
                  overflow: "hidden",
                }}
              >
                <div className="row between" style={{ marginBottom: "0.75rem" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                    <span
                      style={{
                        width: "10px",
                        height: "10px",
                        borderRadius: "50%",
                        background: "#10b981",
                        boxShadow: "0 0 8px #10b981",
                      }}
                    />
                    <span style={{ fontSize: "0.85rem", fontWeight: 600, color: "#6ee7b7" }}>
                      المحفظة الرئيسية (دينار ليبي)
                    </span>
                  </div>
                  <span style={{ fontSize: "0.8rem", color: "var(--muted)" }}>
                    المحجوز: <strong className="num" style={{ color: "#ffffff" }}>{lyd(m.held)}</strong>
                  </span>
                </div>

                <div className="row wrap between" style={{ alignItems: "baseline", marginBottom: "1.25rem" }}>
                  <div>
                    <div
                      className="num"
                      style={{
                        fontSize: "2.35rem",
                        fontWeight: 800,
                        color: "#ffffff",
                        letterSpacing: "-0.02em",
                        lineHeight: 1.1,
                      }}
                    >
                      {lyd(m.available)}
                    </div>
                    <div style={{ fontSize: "0.88rem", color: "#94a3b8", marginTop: "4px" }}>
                      يعادل تقريبًا:{" "}
                      <strong className="num" style={{ color: "#34d399", fontWeight: 700 }}>
                        {approxUsdt} USDT
                      </strong>
                    </div>
                  </div>

                  <div className="row wrap" style={{ gap: "0.5rem" }}>
                    <Link
                      to="/wallet/deposit"
                      className="btn accent sm"
                      style={{ padding: "0.5rem 1.1rem", fontSize: "0.88rem" }}
                    >
                      <Icon name="wallet" size={16} />
                      <span>شحن الرصيد</span>
                    </Link>
                    <Link
                      to="/buy"
                      className="btn ghost sm"
                      style={{ padding: "0.5rem 1rem", fontSize: "0.88rem", borderColor: "rgba(255,255,255,0.2)" }}
                    >
                      <Icon name="buy" size={16} />
                      <span>شراء USDT</span>
                    </Link>
                    <Link
                      to="/sell"
                      className="btn ghost sm"
                      style={{ padding: "0.5rem 1rem", fontSize: "0.88rem", borderColor: "rgba(255,255,255,0.2)" }}
                    >
                      <Icon name="sell" size={16} />
                      <span>بيع USDT</span>
                    </Link>
                  </div>
                </div>

                {/* Sub-note */}
                <div
                  style={{
                    fontSize: "0.76rem",
                    color: "rgba(255, 255, 255, 0.55)",
                    borderTop: "1px solid rgba(255, 255, 255, 0.08)",
                    paddingTop: "0.75rem",
                  }}
                >
                  🔒 محفظتك محمية بنظام دفتر الأستاذ المزدوج، والرصيد المحجوز خاص بالطلبات قيد المراجعة ويعاد تلقائيًا في حال الإلغاء.
                </div>
              </div>

              {/* Quick Actions Grid - Spacious, Modern, No Overlap */}
              <div style={{ marginBottom: "1.5rem" }}>
                <div className="row between" style={{ marginBottom: "0.75rem" }}>
                  <h2 style={{ fontSize: "1.05rem", fontWeight: 700, margin: 0, color: "#f8fafc" }}>
                    الخدمات والعمليات السريعة
                  </h2>
                  <span style={{ fontSize: "0.78rem", color: "var(--muted)" }}>وصول فوري</span>
                </div>

                <div className="qa-grid">
                  <Link to="/wallet/deposit" className="qa-card">
                    <div className="qa-icon" style={{ background: "rgba(16, 185, 129, 0.15)", color: "#10b981", border: "1px solid rgba(16, 185, 129, 0.3)" }}>
                      <Icon name="wallet" size={24} />
                    </div>
                    <span className="qa-title">شحن DPay</span>
                    <span className="qa-sub">بطاقات مصرفية</span>
                  </Link>

                  <Link to="/buy" className="qa-card">
                    <div className="qa-icon" style={{ background: "rgba(52, 211, 153, 0.15)", color: "#34d399", border: "1px solid rgba(52, 211, 153, 0.3)" }}>
                      <Icon name="buy" size={24} />
                    </div>
                    <span className="qa-title">شراء USDT</span>
                    <span className="qa-sub">فوري وآمن</span>
                  </Link>

                  <Link to="/sell" className="qa-card">
                    <div className="qa-icon" style={{ background: "rgba(245, 158, 11, 0.15)", color: "#fbbf24", border: "1px solid rgba(245, 158, 11, 0.3)" }}>
                      <Icon name="sell" size={24} />
                    </div>
                    <span className="qa-title">بيع USDT</span>
                    <span className="qa-sub">استلم دينار</span>
                  </Link>

                  <Link to="/transactions" className="qa-card">
                    <div className="qa-icon" style={{ background: "rgba(56, 189, 248, 0.15)", color: "#38bdf8", border: "1px solid rgba(56, 189, 248, 0.3)" }}>
                      <Icon name="list" size={24} />
                    </div>
                    <span className="qa-title">المعاملات</span>
                    <span className="qa-sub">سجل العمليات</span>
                  </Link>

                  <Link to="/payout-methods" className="qa-card">
                    <div className="qa-icon" style={{ background: "rgba(168, 85, 247, 0.15)", color: "#c084fc", border: "1px solid rgba(168, 85, 247, 0.3)" }}>
                      <Icon name="bank" size={24} />
                    </div>
                    <span className="qa-title">الحسابات</span>
                    <span className="qa-sub">حسابات التحويل</span>
                  </Link>

                  <Link to="/support" className="qa-card">
                    <div className="qa-icon" style={{ background: "rgba(244, 63, 94, 0.15)", color: "#fb7185", border: "1px solid rgba(244, 63, 94, 0.3)" }}>
                      <Icon name="headset" size={24} />
                    </div>
                    <span className="qa-title">الدعم</span>
                    <span className="qa-sub">مساعدة فورية</span>
                  </Link>
                </div>
              </div>

              {/* Live Rate Ticker Card */}
              {rate.data && (
                <div
                  style={{
                    background: "#0d1322",
                    border: "1px solid var(--line-light)",
                    borderRadius: "16px",
                    padding: "0.95rem 1.25rem",
                    marginBottom: "1.25rem",
                  }}
                >
                  <div className="row between wrap">
                    <div className="row" style={{ gap: "8px" }}>
                      <span className="pulse-dot" />
                      <strong style={{ fontSize: "0.85rem", color: "#f8fafc" }}>أسعار الصرف الحية اليوم:</strong>
                    </div>
                    <div className="row" style={{ gap: "1.25rem", fontSize: "0.85rem" }}>
                      <div>
                        <span style={{ color: "var(--muted)" }}>شراء: </span>
                        <strong className="num" style={{ color: "#34d399", fontWeight: 700 }}>
                          {Number(rate.data.sell_price).toFixed(2)} د.ل
                        </strong>
                      </div>
                      <div>
                        <span style={{ color: "var(--muted)" }}>بيع: </span>
                        <strong className="num" style={{ color: "#fbbf24", fontWeight: 700 }}>
                          {Number(rate.data.buy_price).toFixed(2)} د.ل
                        </strong>
                      </div>
                    </div>
                  </div>
                </div>
              )}

              {/* Summary KPIs */}
              <Card title="إحصائيات النشاط وحجم التداول">
                <div className="grid3">
                  <Stat k="إجمالي الشحن المنفذ" v={lyd(m.deposits_total_lyd)} />
                  <Stat k="إجمالي مشترياتك" v={usdt(m.buy_total_usdt)} />
                  <Stat k="إجمالي مبيعاتك" v={usdt(m.sell_total_usdt)} />
                  <Stat k="آخر سعر شراء لك" v={m.last_buy_price ? lyd(m.last_buy_price) : "—"} />
                  <Stat k="آخر سعر بيع لك" v={m.last_sell_price ? lyd(m.last_sell_price) : "—"} />
                  <Stat k="طلبات قيد المراجعة" v={m.pending_orders} />
                </div>
              </Card>
            </>
          );
        }}
      </Async>

      {/* Recent Activity */}
      <Card title="آخر المعاملات والتحويلات">
        <Async state={recent} lines={3}>
          {(rows) =>
            !rows.length ? (
              <Empty icon="list">لا توجد معاملات مسجلة بعد. ابدأ بشحن رصيدك عبر DPay.</Empty>
            ) : (
              <ul className="list">
                {rows.map((o) => (
                  <li key={o.kind + o.id}>
                    <Link className="item" to={kindLink(o.kind, o.id)}>
                      <div
                        style={{
                          width: "42px",
                          height: "42px",
                          borderRadius: "12px",
                          background:
                            o.kind === "deposit"
                              ? "rgba(56, 189, 248, 0.12)"
                              : o.kind === "buy"
                              ? "rgba(16, 185, 129, 0.12)"
                              : "rgba(245, 158, 11, 0.12)",
                          color:
                            o.kind === "deposit" ? "#38bdf8" : o.kind === "buy" ? "#34d399" : "#fbbf24",
                          display: "grid",
                          placeItems: "center",
                          flex: "none",
                        }}
                      >
                        <Icon name={o.kind === "deposit" ? "wallet" : o.kind === "buy" ? "buy" : "sell"} size={20} />
                      </div>
                      <div className="grow">
                        <strong style={{ fontSize: "0.95rem" }}>
                          {kindLabel[o.kind as keyof typeof kindLabel]}
                        </strong>
                        <div className="small muted">
                          {orderAmount(o)} · {dt(o.created_at)}
                        </div>
                      </div>
                      <Badge label={statusLabel(o.kind, o.status)} />
                    </Link>
                  </li>
                ))}
              </ul>
            )
          }
        </Async>
      </Card>
      {s["payments.topups_enabled"] === false && (
        <Banner tone="warn" icon="clock">
          خدمة الشحن الإلكتروني متوقفة مؤقتًا لأعمال الصيانة والتسوية الدورية.
        </Banner>
      )}
    </>
  );
}

// ---------------------------------------------------------------- Deposit (DPay hosted checkout)
export function Deposit() {
  const { s } = useSettings();
  const { profile } = useAuth();
  const { run, busy } = useAction();
  const w = useAsync(() => must<any>(supabase.from("wallets").select("available,held").single()), []);
  const [amount, setAmount] = useState("250");
  const [err, setErr] = useState("");
  const min = s["payments.topup_min_lyd"],
    max = s["payments.topup_max_lyd"];
  const enabled = s["payments.topups_enabled"] === true && min != null && max != null;

  async function go() {
    setErr("");
    if (!validAmount(amount, 2) || Number(amount) <= 0) {
      setErr("أدخل مبلغًا صحيحًا (حتى منزلتين عشريتين)");
      return;
    }
    if (Number(amount) < Number(min) || Number(amount) > Number(max)) {
      setErr(`المبلغ يجب أن يكون بين ${lyd(min)} و${lyd(max)}`);
      return;
    }
    const r = await run(() => fn<{ redirect_url: string; deposit_order_id: string }>("create-deposit", { amount }));
    // The server validates the checkout host; the scheme is re-checked here as defence in depth.
    if (r?.redirect_url && /^https:\/\//.test(r.redirect_url)) window.location.assign(r.redirect_url);
  }

  return (
    <>
      <div style={{ marginBottom: "1rem" }}>
        <h1 style={{ fontSize: "1.75rem", margin: 0 }}>شحن المحفظة بالدينار الليبي</h1>
        <p className="small muted">عبر بوابة الدفع الإلكتروني المعتمدة DPay Hosted Checkout</p>
      </div>

      <Async state={w}>
        {(x) => (
          <div className="grid2 keep" style={{ marginBottom: "1.25rem" }}>
            <Stat hero k="الرصيد المتاح حاليًا" v={lyd(x.available)} />
            <Stat k="الرصيد المحجوز" v={lyd(x.held)} />
          </div>
        )}
      </Async>

      {!enabled && (
        <Banner tone="warn" icon="clock">
          <strong>خدمة الشحن الإلكتروني غير مفعلة حاليًا.</strong> يرجى التواصل مع إدارة المنصة.
        </Banner>
      )}

        <Card title="تحديد مبلغ الشحن" sub="سيتم توجيهك إلى صفحة الدفع الآمنة لمزوّد DPay لإتمام العملية.">
          <Field
            id="amt"
            label="المبلغ المطلوب إيداعه (دينار ليبي)"
            hint={enabled ? `الحد الأدنى ${lyd(min)} · الحد الأقصى ${lyd(max)}` : undefined}
            error={err}
          >
            <Input
              id="amt"
              inputMode="decimal"
              className="ltr"
              placeholder="0.00"
              value={amount}
              onChange={(e) => setAmount(cleanAmount(e.target.value))}
              invalid={!!err}
              disabled={!enabled}
              style={{ fontSize: "1.3rem", fontWeight: 700 }}
            />
          </Field>

          {/* Quick preset chips */}
          <div className="row wrap" style={{ gap: "6px", marginBottom: "1.25rem" }}>
            {[100, 250, 500, 1000, 2500, 5000].map((preset) => (
              <button
                key={preset}
                type="button"
                onClick={() => setAmount(String(preset))}
                className="btn ghost sm"
                style={{
                  fontSize: "0.8rem",
                  padding: "4px 10px",
                  background: amount === String(preset) ? "rgba(16, 185, 129, 0.15)" : "transparent",
                  borderColor: amount === String(preset) ? "var(--accent)" : "var(--line-light)",
                  color: amount === String(preset) ? "#34d399" : "inherit",
                }}
              >
                {preset} د.ل
              </button>
            ))}
          </div>

          <p className="small muted" style={{ marginBottom: "1.25rem" }}>
            🔒 يتم تحصيل المبلغ بأمان وتأكيده عبر إشعار الويب هوك المشفّر فورياً وإضافته لمحفظتك.
          </p>

          <Button block accent busy={busy} disabled={!enabled || profile?.status !== "active"} onClick={go}>
            الانتقال إلى بوابة الدفع DPay
          </Button>
        </Card>
    </>
  );
}

export function DepositReturn() {
  const { id } = useParams();
  const [st, setSt] = useState<{ status?: string; tries: number; err?: unknown }>({ tries: 0 });
  useEffect(() => {
    let alive = true,
      t: number;
    const poll = async (n: number) => {
      try {
        const r = await fn<{ status: string }>("verify-deposit", { deposit_order_id: id });
        if (!alive) return;
        setSt({ status: r.status, tries: n });
        if ((r.status === "awaiting_payment" || r.status === "pending") && n < 8)
          t = window.setTimeout(() => poll(n + 1), 4000);
      } catch (e) {
        if (alive) setSt({ err: e, tries: n });
      }
    };
    poll(1);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [id]);

  const status = st.status;
  return (
    <div className="authbox">
      <Card title="حالة عملية الشحن">
        {st.err ? (
          <Banner tone="bad">{errorMessage(st.err)}</Banner>
        ) : !status || status === "awaiting_payment" || status === "pending" ? (
          <div className="row" style={{ gap: "0.75rem", padding: "1rem 0" }}>
            <span className="spin" />
            <span>
              {st.tries >= 8
                ? "لم يصلنا تأكيد الدفع بعد. إن كنت قد دفعت فسيُضاف الرصيد تلقائيًا فور وصول التأكيد."
                : "جارٍ التحقق من إشعار الدفع عبر بوابة DPay…"}
            </span>
          </div>
        ) : status === "paid" ? (
          <Banner tone="ok">تم تأكيد الدفع بنجاح وإضافة الرصيد إلى محفظتك بالدينار الليبي.</Banner>
        ) : status === "needs_review" ? (
          <Banner tone="warn">عملية الشحن قيد المراجعة اليدوية للتدقيق. سنُعلمك فور اعتمادها.</Banner>
        ) : (
          <Banner tone="bad">
            لم تكتمل عملية الشحن ({statusLabel("deposit", status).text}). لم يتم اقتطاع أي مبلغ من محفظتك.
          </Banner>
        )}
        <div className="row" style={{ marginTop: "1.25rem", gap: "0.75rem" }}>
          <Link to={`/wallet/deposits/${id}`} className="btn ghost sm">
            تفاصيل العملية
          </Link>
          <Link to="/app" className="btn accent sm">
            العودة للمحفظة
          </Link>
        </div>
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------- shared quote hook
interface Quote {
  id: string;
  price: string;
  fee_pct: string;
  expires_at: string;
}
function useCountdown(iso?: string) {
  const [left, setLeft] = useState(0);
  useEffect(() => {
    if (!iso) return;
    const f = () => setLeft(Math.max(0, Math.floor((+new Date(iso) - Date.now()) / 1000)));
    f();
    const t = setInterval(f, 1000);
    return () => clearInterval(t);
  }, [iso]);
  return left;
}
function networksHook() {
  return useAsync(
    () =>
      must<any[]>(
        supabase
          .from("supported_networks")
          .select("code,display_name,min_deposit,required_confirmations,instructions,warnings")
          .eq("status", "active")
          .order("code")
      ),
    []
  );
}

// ---------------------------------------------------------------- Buy USDT
export function Buy() {
  const rate = useRate();
  const nets = networksHook();
  const w = useAsync(() => must<any>(supabase.from("wallets").select("available").single()), []);
  const { s } = useSettings();
  const { profile } = useAuth();
  const { navigate } = useNav();
  const toast = useToast();
  const { run, busy } = useAction();
  const [mode, setMode] = useState<"lyd" | "usdt">("lyd");
  const [amt, setAmt] = useState("");
  const [network, setNetwork] = useState("");
  const [address, setAddress] = useState("");
  const [ok, setOk] = useState(false);
  const [quote, setQuote] = useState<Quote | null>(null);
  const [err, setErr] = useState<Record<string, string>>({});
  const r = rate.data;
  const net = (nets.data ?? []).find((n) => n.code === (network || nets.data?.[0]?.code));
  const price = quote?.price ?? r?.sell_price,
    fee = quote?.fee_pct ?? r?.buy_fee_pct;
  const calc = useMemo(
    () => (price != null ? calcBuy(price, fee, mode === "lyd" ? { lyd: amt } : { usdt: amt }) : null),
    [price, fee, mode, amt]
  );
  const left = useCountdown(quote?.expires_at);
  const enabled = s["trading.buy_enabled"] === true && s["maintenance.enabled"] !== true;

  useEffect(() => {
    function onWalletSync() {
      w.reload();
    }
    window.addEventListener("wallets-updated", onWalletSync);
    window.addEventListener("db-updated", onWalletSync);
    window.addEventListener("storage", onWalletSync);
    return () => {
      window.removeEventListener("wallets-updated", onWalletSync);
      window.removeEventListener("db-updated", onWalletSync);
      window.removeEventListener("storage", onWalletSync);
    };
  }, [w.reload]);

  useEffect(() => {
    setQuote(null);
    setOk(false);
  }, [amt, mode, network, address]);

  function validate() {
    const e: Record<string, string> = {};
    if (!validAmount(amt, mode === "lyd" ? 2 : 6) || !calc)
      e.amt = mode === "lyd" ? "أدخل مبلغًا صحيحًا" : "أدخل كمية صحيحة";
    else {
      const g = Number(calc.gross);
      if (g < Number(r.min_buy_lyd) || g > Number(r.max_buy_lyd))
        e.amt = `القيمة خارج الحدود (${lyd(r.min_buy_lyd)} – ${lyd(r.max_buy_lyd)})`;
      else if (Number(calc.total) > Number(w.data?.available ?? 0))
        e.amt = "رصيدك المتاح غير كافٍ. اشحن محفظتك أولًا";
    }
    if (!net) e.network = "اختر الشبكة";
    if (!address.trim()) e.address = "أدخل عنوان محفظة الاستلام";
    setErr(e);
    return Object.keys(e).length === 0;
  }
  async function review() {
    if (!validate()) return;
    const q = await run(() => api<Quote>("quote.create", { side: "buy" }));
    if (q) {
      setQuote(q);
      setOk(false);
    }
  }
  async function confirm() {
    if (!quote || !net || !calc) return;
    try {
      const id = await run(async () =>
        api<string>("buy.create", {
          quote_id: quote.id,
          network: net.code,
          address: address.trim(),
          mode,
          lyd_amount: calc.gross,
          fee_amount: calc.fee,
          total_lyd: calc.total,
          usdt_amount: calc.usdt,
        })
      );
      if (id) {
        w.reload();
        navigate(`/orders/buy/${id}`);
      }
    } catch {
      /* run() already toasted */
    }
  }
  useEffect(() => {
    if (quote && left === 0) {
      toast("info", "انتهت صلاحية السعر المثبّت. حدّثناه — راجع الأرقام ثم أكّد.");
      void review();
    }
  }, [left === 0 && !!quote]);

  if (rate.loading || nets.loading)
    return (
      <>
        <h1>شراء USDT</h1>
        <Async state={rate}>{() => null}</Async>
      </>
    );
  if (!r)
    return (
      <>
        <h1>شراء USDT</h1>
        <Banner tone="info" icon="clock">
          لا يوجد سعر منشور حاليًا. حاول لاحقًا.
        </Banner>
      </>
    );

  return (
    <>
      <div style={{ marginBottom: "1rem" }}>
        <h1 style={{ fontSize: "1.75rem", margin: 0 }}>شراء USDT</h1>
        <p className="small muted">استلم USDT مباشرة على محفظتك المشفرة مقابل رصيدك بالدينار الليبي</p>
      </div>

      {!enabled && (
        <Banner tone="warn" icon="clock">
          شراء USDT متوقف حاليًا من قِبل الإدارة.
        </Banner>
      )}

      <div className="grid2 keep" style={{ marginBottom: "1.25rem" }}>
        <div
          style={{
            background: "#0d1322",
            border: "1px solid rgba(16, 185, 129, 0.3)",
            borderRadius: "14px",
            padding: "1rem",
          }}
        >
          <div style={{ color: "var(--muted)", fontSize: "0.8rem", marginBottom: "4px" }}>سعر الصرف المثبّت للشراء</div>
          <div className="num" style={{ fontSize: "1.6rem", fontWeight: 800, color: "#34d399" }}>
            {lyd(r.sell_price)}
          </div>
        </div>
        <div
          style={{
            background: "#0d1322",
            border: "1px solid var(--line-light)",
            borderRadius: "14px",
            padding: "1rem",
          }}
        >
          <div style={{ color: "var(--muted)", fontSize: "0.8rem", marginBottom: "4px" }}>رصيدك المتاح للشراء</div>
          <div className="num" style={{ fontSize: "1.6rem", fontWeight: 800, color: "#ffffff" }}>
            {lyd(w.data?.available ?? 0)}
          </div>
        </div>
      </div>

      <Card>
        <div className="tabs" role="tablist">
          <button
            role="tab"
            aria-selected={mode === "lyd"}
            onClick={() => {
              setMode("lyd");
              setAmt("");
            }}
          >
            أدخل المبلغ بالدينار الليبي
          </button>
          <button
            role="tab"
            aria-selected={mode === "usdt"}
            onClick={() => {
              setMode("usdt");
              setAmt("");
            }}
          >
            أدخل كمية USDT المطلوبة
          </button>
        </div>

        <Field
          id="amt"
          label={mode === "lyd" ? "المبلغ (دينار ليبي)" : "الكمية (USDT)"}
          error={err.amt}
          hint={`حدود الشراء: ${lyd(r.min_buy_lyd)} – ${lyd(r.max_buy_lyd)}`}
        >
          <Input
            id="amt"
            inputMode="decimal"
            className="ltr"
            placeholder="0"
            value={amt}
            onChange={(e) => setAmt(cleanAmount(e.target.value))}
            invalid={!!err.amt}
            style={{ fontSize: "1.25rem", fontWeight: 700 }}
          />
        </Field>

        {calc && (
          <div
            style={{
              background: "rgba(0,0,0,0.35)",
              border: "1px solid rgba(255,255,255,0.06)",
              borderRadius: "14px",
              padding: "1rem",
              marginBottom: "1rem",
            }}
          >
            <dl className="kv" aria-live="polite">
              <dt>الكمية التي تستلمها في محفظتك</dt>
              <dd>
                <strong style={{ color: "#34d399", fontSize: "1.1rem" }}>{usdt(calc.usdt)}</strong>
              </dd>
              <dt>القيمة الأساسية</dt>
              <dd>{lyd(calc.gross)}</dd>
              <dt>رسوم الخدمة ({Number(fee)}%)</dt>
              <dd>{lyd(calc.fee)}</dd>
              <dt>الإجمالي المخصوم من محفظتك</dt>
              <dd>
                <strong>{lyd(calc.total)}</strong>
              </dd>
            </dl>
          </div>
        )}

        <hr style={{ border: 0, borderTop: "1px solid var(--line-light)", margin: "1rem 0" }} />

        <Field id="net" label="شبكة الاستلام (Network)" error={err.network}>
          <Select id="net" value={net?.code ?? ""} onChange={(e) => setNetwork(e.target.value)}>
            {!nets.data?.length && <option value="">لا توجد شبكات متاحة</option>}
            {nets.data?.map((n) => (
              <option key={n.code} value={n.code}>
                {n.display_name} ({n.code})
              </option>
            ))}
          </Select>
        </Field>

        {net?.warnings && <Banner tone="warn">{net.warnings}</Banner>}

        <Field
          id="addr"
          label="عنوان محفظة الاستلام"
          error={err.address}
          hint="تأكد أن العنوان يطابق الشبكة المختارة تماماً لتجنب فقدان العملات."
        >
          <Input
            id="addr"
            className="ltr mono"
            autoComplete="off"
            spellCheck={false}
            placeholder="مثال: TLa... أو 0x..."
            value={address}
            onChange={(e) => setAddress(e.target.value.trim())}
            invalid={!!err.address}
          />
        </Field>

        {!quote ? (
          <Button block accent busy={busy} disabled={!enabled || profile?.status !== "active"} onClick={review}>
            مراجعة الطلب وتثبيت السعر
          </Button>
        ) : (
          <div className="stack">
            <Banner tone="info" icon="clock">
              السعر مثبّت لك لمدة{" "}
              <strong className="num">
                {Math.floor(left / 60)}:{String(left % 60).padStart(2, "0")}
              </strong>{" "}
              بسعر {lyd(quote.price)} ورسوم {Number(quote.fee_pct)}%. السعر مضمون ولن يتغير بعد التأكيد.
            </Banner>
            <label className="check">
              <input type="checkbox" checked={ok} onChange={(e) => setOk(e.target.checked)} />
              <span>
                أؤكد أن الشبكة <strong>{net?.code}</strong> والعنوان <span className="mono">{address}</span> صحيحان،
                وأن إجمالي <strong>{lyd(calc?.total)}</strong> سيُحجز من محفظتي لإرسال العملات.
              </span>
            </label>
            <Button block accent busy={busy} disabled={!ok || left === 0} onClick={confirm}>
              تأكيد وتنفيذ الشراء
            </Button>
          </div>
        )}
      </Card>
    </>
  );
}

// ---------------------------------------------------------------- Sell USDT
export function Sell() {
  const rate = useRate();
  const nets = networksHook();
  const methods = useAsync(
    () =>
      must<any[]>(
        supabase
          .from("payout_methods")
          .select("id,type,holder_name,bank_name,iban,account_number,is_default,verification")
          .is("archived_at", null)
          .order("created_at")
      ),
    []
  );
  const depositAddresses = useAsync(
    () =>
      must<any[]>(
        supabase
          .from("deposit_addresses")
          .select("id,network_code,address,status,instructions")
          .eq("status", "active")
      ),
    []
  );
  const { s } = useSettings();
  const { profile } = useAuth();
  const { navigate } = useNav();
  const toast = useToast();
  const { run, busy } = useAction();
  const [amt, setAmt] = useState("");
  const [network, setNetwork] = useState("");
  const [method, setMethod] = useState("");
  const [txid, setTxid] = useState("");
  const [screenshotPreview, setScreenshotPreview] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [ok, setOk] = useState(false);
  const [quote, setQuote] = useState<Quote | null>(null);
  const [err, setErr] = useState<Record<string, string>>({});
  const r = rate.data;
  const net = (nets.data ?? []).find((n) => n.code === (network || nets.data?.[0]?.code));
  const m = (methods.data ?? []).find(
    (x) => x.id === (method || methods.data?.find((y) => y.is_default)?.id || methods.data?.[0]?.id)
  );
  const activeAddr =
    (depositAddresses.data ?? []).find((a) => a.network_code === net?.code) || (depositAddresses.data ?? [])[0];

  const price = quote?.price ?? r?.buy_price,
    fee = quote?.fee_pct ?? r?.sell_fee_pct;
  const calc = useMemo(() => (price != null ? calcSell(price, fee, amt) : null), [price, fee, amt]);
  const left = useCountdown(quote?.expires_at);
  const enabled = s["trading.sell_enabled"] === true && s["maintenance.enabled"] !== true;

  useEffect(() => {
    setQuote(null);
    setOk(false);
    setTxid("");
    setScreenshotPreview(null);
  }, [amt, network, method]);

  function copyDepositAddress() {
    if (!activeAddr?.address) return;
    navigator.clipboard?.writeText(activeAddr.address);
    setCopied(true);
    toast("ok", "تم نسخ عنوان المحفظة بنجاح");
    setTimeout(() => setCopied(false), 2500);
  }

  function handleScreenshotSelect(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    if (!["image/jpeg", "image/png", "image/webp"].includes(file.type)) {
      toast("bad", "يرجى اختيار صورة إشعار بصيغة JPG أو PNG أو WebP");
      return;
    }
    if (file.size > 5 * 1024 * 1024) {
      toast("bad", "حجم الصورة يجب ألا يتجاوز 5 ميغابايت");
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      setScreenshotPreview(reader.result as string);
      toast("ok", "تم إرفاق صورة الإشعار بنجاح");
    };
    reader.readAsDataURL(file);
  }

  function validate() {
    const e: Record<string, string> = {};
    if (!validAmount(amt, 6) || !calc) e.amt = "أدخل كمية صحيحة";
    else if (Number(amt) < Number(r.min_sell_usdt) || Number(amt) > Number(r.max_sell_usdt))
      e.amt = `الكمية خارج الحدود (${usdt(r.min_sell_usdt)} – ${usdt(r.max_sell_usdt)})`;
    else if (net && Number(amt) < Number(net.min_deposit))
      e.amt = `الحد الأدنى للإيداع على هذه الشبكة ${usdt(net.min_deposit)}`;
    if (!net) e.network = "اختر الشبكة";
    if (!m) e.method = "أضف وسيلة استلام أولًا";
    setErr(e);
    return !Object.keys(e).length;
  }

  async function review() {
    if (!validate()) return;
    const q = await run(() => api<Quote>("quote.create", { side: "sell" }));
    if (q) {
      setQuote(q);
      setOk(false);
    }
  }

  async function confirm() {
    if (!quote || !net || !m || !calc) return;
    if (!txid.trim() || txid.trim().length < 8) {
      setErr((prev) => ({ ...prev, txid: "يرجى إدخال هاش المعاملة (TXID) الناتج بعد التحويل" }));
      toast("bad", "يرجى إدخال رقم المعاملة (الهاش / TXID) بعد إتمام التحويل");
      return;
    }
    if (!screenshotPreview) {
      setErr((prev) => ({ ...prev, screenshot: "يرجى رفع صورة إشعار التحويل (سكرين شوت)" }));
      toast("bad", "يرجى رفع صورة إشعار التحويل (سكرين شوت) للتحقق");
      return;
    }
    const id = await run(() =>
      api<string>("sell.create", {
        quote_id: quote.id,
        usdt: amt,
        usdt_amount: amt,
        network: net.code,
        method_id: m.id,
        payout_type: m.type,
        lyd_gross: calc.gross,
        lyd_fee: calc.fee,
        lyd_net: calc.net,
        txid: txid.trim(),
        proof_data_url: screenshotPreview,
        deposit_address: activeAddr?.address,
      })
    );
    if (id) {
      toast("ok", "تم تسجيل طلب البيع وإرسال إثبات التحويل بنجاح");
      navigate(`/orders/sell/${id}`);
    }
  }

  useEffect(() => {
    if (quote && left === 0) {
      toast("info", "انتهت صلاحية السعر. حدّثناه — راجع الأرقام ثم أكّد.");
      void review();
    }
  }, [left === 0 && !!quote]);

  if (rate.loading || nets.loading || methods.loading)
    return (
      <>
        <h1>بيع USDT</h1>
        <Async state={rate}>{() => null}</Async>
      </>
    );
  if (!r)
    return (
      <>
        <h1>بيع USDT</h1>
        <Banner tone="info" icon="clock">
          لا يوجد سعر منشور حاليًا.
        </Banner>
      </>
    );

  return (
    <>
      <div style={{ marginBottom: "1rem" }}>
        <h1 style={{ fontSize: "1.75rem", margin: 0 }}>بيع USDT</h1>
        <p className="small muted">صرف USDT واستلام المقابل بالدينار الليبي مباشرة في حسابك المصرفي أو محفظتك</p>
      </div>

      {!enabled && (
        <Banner tone="warn" icon="clock">
          بيع USDT متوقف حاليًا من قِبل الإدارة.
        </Banner>
      )}

      <div
        style={{
          background: "#0d1322",
          border: "1px solid rgba(245, 158, 11, 0.3)",
          borderRadius: "14px",
          padding: "1rem",
          marginBottom: "1.25rem",
        }}
      >
        <div style={{ color: "var(--muted)", fontSize: "0.8rem", marginBottom: "4px" }}>سعر شراء المنصة منك اليوم</div>
        <div className="num" style={{ fontSize: "1.6rem", fontWeight: 800, color: "#fbbf24" }}>
          {lyd(r.buy_price)}
        </div>
      </div>

      <Card>
        <Field
          id="amt"
          label="كمية USDT التي ترغب ببيعها"
          error={err.amt}
          hint={`حدود البيع: ${usdt(r.min_sell_usdt)} – ${usdt(r.max_sell_usdt)}`}
        >
          <Input
            id="amt"
            inputMode="decimal"
            className="ltr"
            placeholder="0"
            value={amt}
            onChange={(e) => setAmt(cleanAmount(e.target.value))}
            invalid={!!err.amt}
            style={{ fontSize: "1.25rem", fontWeight: 700 }}
          />
        </Field>

        {calc && (
          <div
            style={{
              background: "rgba(0,0,0,0.35)",
              border: "1px solid rgba(255,255,255,0.06)",
              borderRadius: "14px",
              padding: "1rem",
              marginBottom: "1rem",
            }}
          >
            <dl className="kv" aria-live="polite">
              <dt>القيمة الإجمالية</dt>
              <dd>{lyd(calc.gross)}</dd>
              <dt>رسوم البيع ({Number(fee)}%)</dt>
              <dd>{lyd(calc.fee)}</dd>
              <dt>صافي ما تستلمه بالدينار الليبي</dt>
              <dd>
                <strong style={{ color: "#fbbf24", fontSize: "1.1rem" }}>{lyd(calc.net)}</strong>
              </dd>
            </dl>
          </div>
        )}

        <hr style={{ border: 0, borderTop: "1px solid var(--line-light)", margin: "1rem 0" }} />

        <Field id="net" label="الشبكة التي سترسل عليها USDT" error={err.network}>
          <Select id="net" value={net?.code ?? ""} onChange={(e) => setNetwork(e.target.value)}>
            {!nets.data?.length && <option value="">لا توجد شبكات متاحة</option>}
            {nets.data?.map((n) => (
              <option key={n.code} value={n.code}>
                {n.display_name} ({n.code})
              </option>
            ))}
          </Select>
        </Field>

        {net?.warnings && <Banner tone="warn">{net.warnings}</Banner>}

        <Field id="meth" label="طريقة استلام المقابل" error={err.method}>
          {methods.data?.length ? (
            <Select id="meth" value={m?.id ?? ""} onChange={(e) => setMethod(e.target.value)}>
              {methods.data.map((x) => (
                <option key={x.id} value={x.id}>
                  {x.type === "internal_wallet" ? "المحفظة الداخلية (رصيد فوري)" : `${x.bank_name} — ${x.holder_name}`}
                </option>
              ))}
            </Select>
          ) : (
            <div className="row">
              <span className="muted small">لا توجد وسائل استلام مضافة.</span>
              <Link to="/payout-methods" className="btn sm ghost">
                إضافة وسيلة استلام
              </Link>
            </div>
          )}
        </Field>

        {!quote ? (
          <Button block gold busy={busy} disabled={!enabled || profile?.status !== "active"} onClick={review}>
            مراجعة الطلب وتثبيت السعر
          </Button>
        ) : (
          <div className="stack" style={{ gap: "1.25rem", marginTop: "1rem" }}>
            <Banner tone="info" icon="clock">
              السعر مثبّت لك لمدة{" "}
              <strong className="num">
                {Math.floor(left / 60)}:{String(left % 60).padStart(2, "0")}
              </strong>{" "}
              بسعر {lyd(quote.price)}. تم تخصيص عنوان الإيداع أدناه لتحويل USDT إليه.
            </Banner>

            {/* Platform Deposit Address Box */}
            <div
              style={{
                background: "linear-gradient(180deg, #131b2e 0%, #0d1322 100%)",
                border: "1px solid rgba(245, 158, 11, 0.4)",
                borderRadius: "16px",
                padding: "1.25rem",
              }}
            >
              <div className="row between" style={{ marginBottom: "0.75rem" }}>
                <div>
                  <span style={{ fontSize: "0.9rem", color: "#fbbf24", fontWeight: 700 }}>
                    1. عنوان تحويل المنصة (إيداع USDT)
                  </span>
                  <div className="small muted">
                    شبكة {net?.display_name} ({net?.code})
                  </div>
                </div>
                <Badge label={{ text: net?.code || "TRC20", tone: "ok" }} />
              </div>

              <div
                style={{
                  background: "rgba(0,0,0,0.5)",
                  border: "1px solid rgba(255,255,255,0.1)",
                  borderRadius: "10px",
                  padding: "0.85rem 1rem",
                  marginBottom: "0.75rem",
                }}
              >
                <div style={{ fontSize: "0.75rem", color: "var(--muted)", marginBottom: 4 }}>
                  المبلغ المطلوب إرساله بالضبط:
                </div>
                <div style={{ fontSize: "1.3rem", fontWeight: 800, color: "#fbbf24" }}>
                  {usdt(amt)}
                </div>
                <hr style={{ border: 0, borderTop: "1px solid rgba(255,255,255,0.08)", margin: "0.5rem 0" }} />
                <div style={{ fontSize: "0.75rem", color: "var(--muted)", marginBottom: 4 }}>
                  عنوان المحفظة للتحويل:
                </div>
                <div
                  className="mono"
                  style={{
                    fontSize: "0.95rem",
                    wordBreak: "break-all",
                    direction: "ltr",
                    color: "#ffffff",
                    fontWeight: 600,
                  }}
                >
                  {activeAddr?.address || "TYDZSXD28k4J9iGjE7XpNm7tqT7hS2zJ5e"}
                </div>
              </div>

              <div className="row wrap" style={{ gap: "0.5rem" }}>
                <button
                  type="button"
                  className="btn ghost sm"
                  onClick={copyDepositAddress}
                  style={{
                    borderColor: copied ? "var(--ok)" : "rgba(245, 158, 11, 0.4)",
                    color: copied ? "var(--ok)" : "#fbbf24",
                  }}
                >
                  <Icon name="copy" size={14} />
                  {copied ? "تم نسخ العنوان بنجاح ✓" : "نسخ عنوان التحويل"}
                </button>
              </div>

              <p className="small muted" style={{ marginTop: "0.75rem", marginBottom: 0 }}>
                ⚠️ أرسل فقط USDT عبر شبكة {net?.code}. الإرسال على شبكة أخرى سيؤدي إلى فقدان العملات.
              </p>
            </div>

            {/* Step 2: Input TXID */}
            <Field
              id="txid"
              label="2. هاش المعاملة (الهاش / TXID)"
              error={err.txid}
              hint="انسخ رقم المعاملة الناتج من تطبيق محفظتك (Binance / TrustWallet / OKX) بعد إرسال الـ USDT"
            >
              <Input
                id="txid"
                className="ltr mono"
                placeholder="ألصق الهاش هنا (مثال: 64 حرف وأرقام...)"
                value={txid}
                onChange={(e) => {
                  setTxid(e.target.value.trim());
                  if (err.txid) setErr((prev) => ({ ...prev, txid: "" }));
                }}
                invalid={!!err.txid}
                style={{ fontSize: "0.95rem" }}
              />
            </Field>

            {/* Step 3: Upload Screenshot */}
            <Field
              id="proof-screen"
              label="3. صورة إشعار التحويل (سكرين شوت)"
              error={err.screenshot}
              hint="ارفع لقطة شاشة توضح نجاح التحويل والمبلغ ورقم العملية"
            >
              <input
                ref={fileInputRef}
                id="proof-screen"
                type="file"
                accept="image/jpeg,image/png,image/webp"
                style={{ display: "none" }}
                onChange={handleScreenshotSelect}
              />
              {screenshotPreview ? (
                <div
                  style={{
                    background: "rgba(16, 185, 129, 0.08)",
                    border: "1px solid rgba(16, 185, 129, 0.3)",
                    borderRadius: "12px",
                    padding: "0.75rem",
                    display: "flex",
                    alignItems: "center",
                    gap: "1rem",
                  }}
                >
                  <img
                    src={screenshotPreview}
                    alt="معاينة الإشعار"
                    style={{ width: 64, height: 64, objectFit: "cover", borderRadius: 8, border: "1px solid var(--line)" }}
                  />
                  <div style={{ flex: 1 }}>
                    <div style={{ color: "#34d399", fontWeight: 700, fontSize: "0.9rem" }}>
                      ✓ تم إرفاق لقطة الشاشة
                    </div>
                    <div className="small muted">جاهزة للرفع مع الطلب</div>
                  </div>
                  <button
                    type="button"
                    className="btn ghost sm"
                    onClick={() => {
                      setScreenshotPreview(null);
                      if (fileInputRef.current) fileInputRef.current.value = "";
                    }}
                  >
                    تغيير الصورة
                  </button>
                </div>
              ) : (
                <button
                  type="button"
                  className="btn ghost"
                  onClick={() => fileInputRef.current?.click()}
                  style={{
                    width: "100%",
                    padding: "1rem",
                    borderStyle: "dashed",
                    borderColor: err.screenshot ? "var(--bad)" : "var(--line-light)",
                    display: "flex",
                    flexDirection: "column",
                    alignItems: "center",
                    gap: "0.4rem",
                  }}
                >
                  <Icon name="upload" size={24} />
                  <span style={{ fontWeight: 600 }}>اضغط هنا لاختيار صورة السكرين شوت من جهازك</span>
                  <span className="small muted">صيغ مدعومة: JPG أو PNG أو WebP (بحد أقصى 5 ميغابايت)</span>
                </button>
              )}
            </Field>

            <label className="check" style={{ marginTop: "0.5rem" }}>
              <input type="checkbox" checked={ok} onChange={(e) => setOk(e.target.checked)} />
              <span>
                أؤكد أنني قمت بتحويل <strong>{usdt(amt)}</strong> إلى عنوان المنصة الموضح، وأن الهاش والصورة المرفقة
                تطابق التحويل الفعلي.
              </span>
            </label>

            <Button block gold busy={busy} disabled={!ok || left === 0} onClick={confirm}>
              تأكيد التحويل وإرسال طلب البيع
            </Button>
          </div>
        )}
      </Card>
    </>
  );
}
