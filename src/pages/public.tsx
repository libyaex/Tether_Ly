import heroImage from "../assets/images/hero.webp";
import { useState, useEffect } from "react";
import { Link, useParams } from "../lib/router";
import { supabase, must } from "../lib/supabase";
import { useAsync } from "../lib/hooks";
import { useSettings } from "../lib/settings";
import { Async, Banner, Card, Stat } from "../components/ui";
import { Icon } from "../components/Icon";
import { dt, lyd, usdt } from "../lib/format";
import { useAuth } from "../lib/auth";
import { calcBuy, calcSell } from "../lib/decimal";

export function useRate() {
  const asyncState = useAsync(() => must<any>(supabase.from("current_exchange_rate").select("*").maybeSingle()), []);
  useEffect(() => {
    function onRatesUpdated() {
      asyncState.reload();
    }
    window.addEventListener("rates-updated", onRatesUpdated);
    window.addEventListener("db-updated", onRatesUpdated);
    window.addEventListener("storage", onRatesUpdated);
    return () => {
      window.removeEventListener("rates-updated", onRatesUpdated);
      window.removeEventListener("db-updated", onRatesUpdated);
      window.removeEventListener("storage", onRatesUpdated);
    };
  }, [asyncState.reload]);
  return asyncState;
}

export function LiveRateCalculator({ rate }: { rate: any }) {
  const [tab, setTab] = useState<"buy" | "sell">("buy");
  const [amountInput, setAmountInput] = useState<string>("500");

  const buyPrice = Number(rate?.sell_price || 10.45); // Customer pays buyPrice to buy USDT
  const sellPrice = Number(rate?.buy_price || 10.32); // Customer receives sellPrice to sell USDT
  const feePct = tab === "buy" ? Number(rate?.buy_fee_pct || 1.0) : Number(rate?.sell_fee_pct || 1.0);

  const numVal = parseFloat(amountInput) || 0;
  
  let computedUsdt = "0.00";
  let computedLyd = "0.00";
  let computedFee = "0.00";

  if (tab === "buy") {
    const calc = calcBuy(buyPrice, feePct, { lyd: amountInput });
    computedUsdt = calc ? Number(calc.usdt).toFixed(2) : "0.00";
    computedFee = calc ? Number(calc.fee).toFixed(2) : "0.00";
    computedLyd = calc ? Number(calc.total).toFixed(2) : "0.00";
  } else {
    const calc = calcSell(sellPrice, feePct, amountInput);
    computedLyd = calc ? Number(calc.net).toFixed(2) : "0.00";
    computedFee = calc ? Number(calc.fee).toFixed(2) : "0.00";
    computedUsdt = amountInput || "0.00";
  }

  return (
    <div
      style={{
        background: "rgba(17, 24, 39, 0.95)",
        border: "1px solid rgba(255, 255, 255, 0.08)",
        borderRadius: "20px",
        padding: "1.25rem",
        boxShadow: "0 15px 35px -5px rgba(0, 0, 0, 0.6)",
      }}
    >
      <div className="row between" style={{ marginBottom: "1rem" }}>
        <div style={{ display: "flex", gap: "6px", background: "rgba(0,0,0,0.3)", padding: "4px", borderRadius: "10px" }}>
          <button
            type="button"
            onClick={() => setTab("buy")}
            className="btn sm"
            style={{
              padding: "0.3rem 0.9rem",
              fontSize: "0.82rem",
              background: tab === "buy" ? "var(--accent)" : "transparent",
              color: tab === "buy" ? "#042f2e" : "var(--muted)",
              fontWeight: tab === "buy" ? 700 : 500,
            }}
          >
            شراء USDT
          </button>
          <button
            type="button"
            onClick={() => setTab("sell")}
            className="btn sm"
            style={{
              padding: "0.3rem 0.9rem",
              fontSize: "0.82rem",
              background: tab === "sell" ? "var(--gold)" : "transparent",
              color: tab === "sell" ? "#451a03" : "var(--muted)",
              fontWeight: tab === "sell" ? 700 : 500,
            }}
          >
            بيع USDT
          </button>
        </div>
        <div className="hero-badge" style={{ margin: 0, fontSize: "0.76rem" }}>
          <span className="pulse-dot" />
          <span>سعر حي: {tab === "buy" ? `${buyPrice.toFixed(2)} د.ل` : `${sellPrice.toFixed(2)} د.ل`}</span>
        </div>
      </div>

      <div style={{ marginBottom: "1rem" }}>
        <label style={{ display: "block", fontSize: "0.8rem", color: "var(--muted)", marginBottom: "6px" }}>
          {tab === "buy" ? "المبلغ الذي تدفعه بالدينار الليبي:" : "كمية USDT التي ترغب ببيعها:"}
        </label>
        <div
          style={{
            display: "flex",
            alignItems: "stretch",
            borderRadius: "14px",
            overflow: "hidden",
            border: `1px solid ${tab === "buy" ? "rgba(16, 185, 129, 0.4)" : "rgba(245, 158, 11, 0.4)"}`,
            background: "#090d16",
          }}
        >
          <input
            type="number"
            value={amountInput}
            onChange={(e) => setAmountInput(e.target.value)}
            className="input ltr num"
            style={{
              border: 0,
              background: "transparent",
              fontSize: "1.35rem",
              fontWeight: 700,
              padding: "0.65rem 1rem",
              flex: 1,
            }}
            placeholder="0.00"
          />
          <span
            style={{
              padding: "0.65rem 1rem",
              background: "rgba(255,255,255,0.04)",
              fontWeight: 700,
              fontSize: "0.85rem",
              color: tab === "buy" ? "#34d399" : "#fbbf24",
              display: "flex",
              alignItems: "center",
              borderInlineStart: "1px solid rgba(255, 255, 255, 0.08)",
            }}
          >
            {tab === "buy" ? "دينار ليبي" : "USDT"}
          </span>
        </div>
      </div>

      {/* Quick Amount Chips */}
      <div className="row wrap" style={{ gap: "6px", marginBottom: "1.25rem" }}>
        {[100, 250, 500, 1000, 2500].map((preset) => (
          <button
            key={preset}
            type="button"
            onClick={() => setAmountInput(String(preset))}
            className="btn ghost sm"
            style={{
              fontSize: "0.75rem",
              padding: "2px 8px",
              minHeight: "28px",
              background: amountInput === String(preset) ? "rgba(255,255,255,0.12)" : "rgba(255,255,255,0.03)",
            }}
          >
            {preset} {tab === "buy" ? "د.ل" : "USDT"}
          </button>
        ))}
      </div>

      {/* Result Card */}
      <div
        style={{
          background: "rgba(0,0,0,0.35)",
          border: "1px solid rgba(255,255,255,0.06)",
          borderRadius: "14px",
          padding: "1rem",
          marginBottom: "1.25rem",
        }}
      >
        <div className="row between" style={{ marginBottom: "0.5rem" }}>
          <span style={{ color: "var(--muted)", fontSize: "0.85rem" }}>
            {tab === "buy" ? "تستلم تقريبًا في محفظتك:" : "تستلم صافي بالدينار الليبي:"}
          </span>
          <span
            className="num"
            style={{
              fontSize: "1.45rem",
              fontWeight: 800,
              color: tab === "buy" ? "#34d399" : "#fbbf24",
            }}
          >
            {tab === "buy" ? `${computedUsdt} USDT` : `${computedLyd} د.ل`}
          </span>
        </div>
        <div className="row between" style={{ fontSize: "0.78rem", color: "var(--muted)" }}>
          <span>الرسوم المحتسبة ({feePct}%):</span>
          <span className="num">{computedFee} د.ل</span>
        </div>
      </div>

      <Link
        to={tab === "buy" ? "/buy" : "/sell"}
        className={`btn block ${tab === "buy" ? "accent" : "gold"}`}
        style={{ fontWeight: 700, fontSize: "0.95rem" }}
      >
        {tab === "buy" ? "تنفيذ طلب الشراء الآن" : "تنفيذ طلب البيع الآن"}
      </Link>
    </div>
  );
}

export function PricesBlock() {
  const rate = useRate();
  const { s } = useSettings();
  return (
    <Async state={rate} lines={2}>
      {(r) =>
        !r ? (
          <Banner tone="info" icon="clock">
            لم تُنشر أسعار بعد. ستظهر هنا فور نشرها من الإدارة.
          </Banner>
        ) : (
          <>
            <div className="grid2 keep" style={{ marginBottom: "0.75rem" }}>
              <div
                style={{
                  background: "linear-gradient(135deg, rgba(16, 185, 129, 0.08) 0%, rgba(17, 24, 39, 0.95) 100%)",
                  border: "1px solid rgba(16, 185, 129, 0.3)",
                  borderRadius: "14px",
                  padding: "1rem",
                }}
              >
                <div style={{ color: "var(--muted)", fontSize: "0.8rem", marginBottom: "4px" }}>شراء USDT (تدفع)</div>
                <div className="num" style={{ fontSize: "1.6rem", fontWeight: 800, color: "#34d399" }}>
                  {Number(r.sell_price).toFixed(2)} <span style={{ fontSize: "0.95rem" }}>د.ل</span>
                </div>
              </div>
              <div
                style={{
                  background: "linear-gradient(135deg, rgba(245, 158, 11, 0.08) 0%, rgba(17, 24, 39, 0.95) 100%)",
                  border: "1px solid rgba(245, 158, 11, 0.3)",
                  borderRadius: "14px",
                  padding: "1rem",
                }}
              >
                <div style={{ color: "var(--muted)", fontSize: "0.8rem", marginBottom: "4px" }}>بيع USDT (تستلم)</div>
                <div className="num" style={{ fontSize: "1.6rem", fontWeight: 800, color: "#fbbf24" }}>
                  {Number(r.buy_price).toFixed(2)} <span style={{ fontSize: "0.95rem" }}>د.ل</span>
                </div>
              </div>
            </div>
            <p className="small muted" style={{ marginTop: ".6rem" }}>
              آخر تحديث: {dt(r.created_at)} · السعر يُثبَّت للطلب عند التأكيد لمدة{" "}
              {String(s["trading.quote_ttl_seconds"] ?? 120)} ثانية، ولا يتغير بأثر رجعي.
            </p>
            <dl className="kv small" style={{ marginTop: "0.75rem" }}>
              <dt>رسوم الشراء</dt>
              <dd>{Number(r.buy_fee_pct)}%</dd>
              <dt>رسوم البيع</dt>
              <dd>{Number(r.sell_fee_pct)}%</dd>
              <dt>حدود الشراء</dt>
              <dd>
                {lyd(r.min_buy_lyd)} – {lyd(r.max_buy_lyd)}
              </dd>
              <dt>حدود البيع</dt>
              <dd>
                {usdt(r.min_sell_usdt)} – {usdt(r.max_sell_usdt)}
              </dd>
            </dl>
          </>
        )
      }
    </Async>
  );
}

export function Home() {
  const { s } = useSettings();
  const { session } = useAuth();
  const rate = useRate();
  const faq: { q: string; a: string }[] = Array.isArray(s["content.faq"]) ? s["content.faq"] : [];
  const flag = (k: string) => s[k] === true;

  return (
    <>
      {/* Modern Hero Section */}
      <section
        style={{
          position: "relative",
          overflow: "hidden",
          borderBottom: "1px solid var(--line-light)",
          background: "linear-gradient(180deg, rgba(16, 185, 129, 0.06) 0%, rgba(7, 9, 14, 0.98) 100%)",
          padding: "3rem 1rem 3.5rem",
        }}
      >
        <div className="page" style={{ paddingBottom: 0 }}>
          <div className="row wrap" style={{ alignItems: "center", justifyContent: "space-between", gap: "2.5rem" }}>
            <div style={{ flex: "1 1 360px", maxWidth: "580px" }}>
              <div className="hero-badge">
                <span className="pulse-dot" />
                <span>متكاملة مع بوابة الدفع DPay</span>
              </div>
              <h1 style={{ fontSize: "2.25rem", lineHeight: 1.25, marginBottom: "1rem", color: "#ffffff", fontWeight: 800 }}>
                تداول <span style={{ color: "#34d399" }}>USDT</span> مقابل الدينار الليبي بأمان وسرعة فائقة
              </h1>
              <p style={{ fontSize: "1.02rem", color: "var(--text-dim)", lineHeight: 1.7, marginBottom: "1.75rem" }}>
                اشحن محفظتك فورياً بالدينار الليبي عبر البطاقات المصرفية، واشترِ أو بِع USDT بأفضل أسعار السوق الليبي وبأعلى معايير الحماية والتسوية المدققة.
              </p>
              <div className="row wrap" style={{ gap: "0.85rem", marginBottom: "2rem" }}>
                {session ? (
                  <Link to="/app" className="btn accent" style={{ padding: "0.85rem 1.85rem", fontSize: "1.05rem", fontWeight: 700 }}>
                    الذهاب إلى محفظتي
                  </Link>
                ) : (
                  <>
                    <Link to="/login" className="btn accent" style={{ padding: "0.85rem 1.85rem", fontSize: "1.05rem", fontWeight: 700 }}>
                      سجل الآن عبر Google
                    </Link>
                    <Link to="/prices" className="btn ghost" style={{ padding: "0.85rem 1.5rem", fontSize: "0.95rem" }}>
                      الأسعار والحدود
                    </Link>
                  </>
                )}
              </div>

              {/* Trust Indicators */}
              <div
                style={{
                  display: "flex",
                  flexWrap: "wrap",
                  gap: "1.25rem",
                  fontSize: "0.84rem",
                  color: "#cbd5e1",
                  borderTop: "1px solid var(--line-light)",
                  paddingTop: "1.25rem",
                }}
              >
                <div className="row" style={{ gap: "6px" }}>
                  <span style={{ color: "#10b981", fontWeight: 700 }}>✓</span>
                  <span>دفع إلكتروني معتمد DPay</span>
                </div>
                <div className="row" style={{ gap: "6px" }}>
                  <span style={{ color: "#10b981", fontWeight: 700 }}>✓</span>
                  <span>دخول موحد وآمن عبر Google</span>
                </div>
                <div className="row" style={{ gap: "6px" }}>
                  <span style={{ color: "#10b981", fontWeight: 700 }}>✓</span>
                  <span>تنفيذ موثّق ومراجعة بشرية لكل عملية</span>
                </div>
              </div>
            </div>

            {/* Visual 3D Hero Graphic */}
            <div style={{ flex: "1 1 340px", maxWidth: "480px" }}>
              <div
                style={{
                  position: "relative",
                  borderRadius: "24px",
                  overflow: "hidden",
                  border: "1px solid rgba(16, 185, 129, 0.3)",
                  boxShadow: "0 25px 50px -12px rgba(0, 0, 0, 0.8), 0 0 30px rgba(16, 185, 129, 0.2)",
                }}
              >
                <img
                  src={heroImage}
                  alt="منصة ليبيا لتداول USDT"
                  referrerPolicy="no-referrer"
                  style={{
                    width: "100%",
                    display: "block",
                    aspectRatio: "16/10",
                    objectFit: "cover",
                  }}
                />
                <div
                  style={{
                    position: "absolute",
                    bottom: "12px",
                    insetInlineStart: "12px",
                    insetInlineEnd: "12px",
                    background: "rgba(11, 15, 25, 0.88)",
                    backdropFilter: "blur(12px)",
                    WebkitBackdropFilter: "blur(12px)",
                    border: "1px solid rgba(255, 255, 255, 0.12)",
                    borderRadius: "14px",
                    padding: "0.65rem 1rem",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "space-between",
                  }}
                >
                  <div className="row" style={{ gap: "8px" }}>
                    <span className="pulse-dot" />
                    <span style={{ fontSize: "0.82rem", fontWeight: 600, color: "#f8fafc" }}>
                      سعر الصرف اللحظي المعتمد
                    </span>
                  </div>
                  <span style={{ fontSize: "0.82rem", fontWeight: 700, color: "#34d399" }}>
                    USDT / LYD
                  </span>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* Main Content Sections */}
      <div className="page" style={{ paddingTop: "2.5rem" }}>
        {/* Dedicated Live Rates & Calculator Section */}
        <div style={{ marginBottom: "2.5rem" }}>
          <div style={{ textAlign: "center", marginBottom: "1.75rem" }}>
            <div className="hero-badge" style={{ marginBottom: "0.5rem" }}>
              <span className="pulse-dot" />
              <span>الأسعار اللحظية والحاسبة التفاعلية</span>
            </div>
            <h2 style={{ fontSize: "1.75rem", fontWeight: 800, color: "#ffffff", marginBottom: "0.4rem" }}>
              أسعار الصرف المباشرة وحاسبة التحويل
            </h2>
            <p style={{ color: "var(--text-dim)", fontSize: "0.92rem", maxWidth: "560px", margin: "0 auto" }}>
              احسب بدقة كمية USDT المستلمة أو المبلغ بالدينار الليبي بناءً على السعر اللحظي بدون أي رسوم خفية.
            </p>
          </div>

          <div className="grid2" style={{ gap: "1.5rem", alignItems: "start" }}>
            {/* Rates Card */}
            <div>
              <Card title="أسعار الصرف والحدود الرسمية" sub="سعر ثابت ومضمون عند تنفيذ الطلب">
                <PricesBlock />
                <div style={{ marginTop: "1rem", textAlign: "end" }}>
                  <Link to="/prices" className="small" style={{ color: "var(--accent)" }}>
                    تفاصيل الرسوم والشبكات المدعومة ←
                  </Link>
                </div>
              </Card>
            </div>

            {/* Live Interactive Calculator */}
            <div>
              {rate.data && <LiveRateCalculator rate={rate.data} />}
            </div>
          </div>
        </div>

        {/* 3 Bento Feature Highlights */}
        <div className="grid3" style={{ marginBottom: "1.5rem" }}>
          <div
            style={{
              background: "#0d1322",
              border: "1px solid var(--line-light)",
              borderRadius: "18px",
              padding: "1.25rem",
              position: "relative",
              overflow: "hidden",
            }}
          >
            <div style={{ width: "48px", height: "48px", borderRadius: "12px", background: "rgba(16, 185, 129, 0.12)", display: "grid", placeItems: "center", marginBottom: "1rem", color: "#34d399" }}>
              <Icon name="wallet" size={24} />
            </div>
            <h3 style={{ fontSize: "1.05rem", marginBottom: "0.4rem" }}>شحن فوري عبر DPay</h3>
            <p style={{ fontSize: "0.85rem", color: "var(--muted)", margin: 0 }}>
              اشحن محفظتك بالدينار الليبي مباشرة باستخدام بطاقات المصارف الليبية ومحفظة DPay الإلكترونية دون انتظار.
            </p>
          </div>

          <div
            style={{
              background: "#0d1322",
              border: "1px solid var(--line-light)",
              borderRadius: "18px",
              padding: "1.25rem",
              position: "relative",
              overflow: "hidden",
            }}
          >
            <div style={{ width: "48px", height: "48px", borderRadius: "12px", background: "rgba(56, 189, 248, 0.12)", display: "grid", placeItems: "center", marginBottom: "1rem", color: "#38bdf8" }}>
              <Icon name="shield" size={24} />
            </div>
            <h3 style={{ fontSize: "1.05rem", marginBottom: "0.4rem" }}>أمان مصرفي ودفتر أستاذ</h3>
            <p style={{ fontSize: "0.85rem", color: "var(--muted)", margin: 0 }}>
              معاملات محاسبية ذرية مدققة ومحمية ضد التكرار والتلاعب المالي مع التحقق الصارم من التوقيع الرقمي.
            </p>
          </div>

          <div
            style={{
              background: "#0d1322",
              border: "1px solid var(--line-light)",
              borderRadius: "18px",
              padding: "1.25rem",
              position: "relative",
              overflow: "hidden",
            }}
          >
            <div style={{ width: "48px", height: "48px", borderRadius: "12px", background: "rgba(245, 158, 11, 0.12)", display: "grid", placeItems: "center", marginBottom: "1rem", color: "#fbbf24" }}>
              <Icon name="tag" size={24} />
            </div>
            <h3 style={{ fontSize: "1.05rem", marginBottom: "0.4rem" }}>أفضل أسعار صرف في ليبيا</h3>
            <p style={{ fontSize: "0.85rem", color: "var(--muted)", margin: 0 }}>
              تثبيت سعر الصرف فور تأكيد الطلب، مع رسوم شفافة 1% دون أي خصومات خفية أو تكاليف غير معلنة.
            </p>
          </div>
        </div>

        {/* Operational Status */}
        <Card title="حالة الخدمات الفورية">
          <ul className="list">
            <li>
              <div className="item">
                <Icon name={flag("trading.buy_enabled") ? "check" : "clock"} />
                <span className="grow">شراء USDT وتحويلها للمحفظة</span>
                <strong style={{ color: flag("trading.buy_enabled") ? "#34d399" : "var(--muted)" }}>
                  {flag("trading.buy_enabled") ? "متاح فوريًا" : "متوقف مؤقتًا"}
                </strong>
              </div>
            </li>
            <li>
              <div className="item">
                <Icon name={flag("trading.sell_enabled") ? "check" : "clock"} />
                <span className="grow">بيع USDT واستلام المقابل بالدينار</span>
                <strong style={{ color: flag("trading.sell_enabled") ? "#34d399" : "var(--muted)" }}>
                  {flag("trading.sell_enabled") ? "متاح فوريًا" : "متوقف مؤقتًا"}
                </strong>
              </div>
            </li>
            <li>
              <div className="item">
                <Icon name={flag("payments.topups_enabled") && s["payments.dpay_mode"] === "live" ? "check" : "clock"} />
                <span className="grow">الشحن الإلكتروني المباشر (بوابة DPay)</span>
                <strong style={{ color: flag("payments.topups_enabled") && s["payments.dpay_mode"] === "live" ? "#34d399" : "#fbbf24" }}>
                  {flag("payments.topups_enabled") && s["payments.dpay_mode"] === "live" ? "متاح" : "غير متاح حاليًا"}
                </strong>
              </div>
            </li>
          </ul>
        </Card>

        {/* How it works */}
        <Card title="كيف تبدأ التداول في 4 خطوات بسيطة">
          <ol className="steps">
            <li>
              <div>
                <strong>1. سجّل حسابك وتحقق من الهوية</strong>
                <div className="muted small">عملية تسجيل سريعة وآمنة بدون تعقيدات لتفعيل محفظتك الرقمية.</div>
              </div>
            </li>
            <li>
              <div>
                <strong>2. اشحن رصيدك بالدينار الليبي</strong>
                <div className="muted small">
                  عبر بوابة DPay المستضافة المعتمدة محلياً، ويتم إيداع الرصيد تلقائياً في حسابك بعد التأكيد.
                </div>
              </div>
            </li>
            <li>
              <div>
                <strong>3. اشترِ أو بِع USDT</strong>
                <div className="muted small">
                  حدّد الكمية المرغوبة وسعر الصرف الثابت، وأكّد العملية ليتولى الفريق التنفيذ بدقة وأمان.
                </div>
              </div>
            </li>
            <li>
              <div>
                <strong>4. استلم أرباحك وعملاتك</strong>
                <div className="muted small">
                  استلم USDT مباشرة على عنوان محفظتك الخاصة (TRC-20 / ERC-20) أو استلم الدينار الليبي في حسابك المصرفي.
                </div>
              </div>
            </li>
          </ol>
        </Card>

        {/* FAQs */}
        {faq.length > 0 && (
          <Card title="الأسئلة الشائعة">
            {faq.slice(0, 5).map((f, i) => (
              <details className="faq" key={i}>
                <summary>{f.q}</summary>
                <p className="prose">{f.a}</p>
              </details>
            ))}
            <div style={{ marginTop: "1rem", textAlign: "end" }}>
              <Link to="/info/faq" className="small" style={{ color: "var(--accent)" }}>
                عرض جميع الأسئلة والإجابات ←
              </Link>
            </div>
          </Card>
        )}
      </div>
    </>
  );
}

export function PricesPage() {
  return (
    <div className="page">
      <h1>جدول الأسعار والحدود التشغيلية</h1>
      <Card>
        <PricesBlock />
      </Card>
      <Banner tone="info">
        الأسعار تحددها إدارة المنصة وتُحدّث بانتظام حسب حركة الأسواق العالمية. السعر الذي يظهر في شاشة «مراجعة الطلب» هو
        السعر المضمون والمثبّت لطلبك لمدة محددة بالثواني.
      </Banner>
    </div>
  );
}

const PAGES: Record<string, [string, string]> = {
  about: ["من نحن", "content.about"],
  "how-it-works": ["كيف تعمل المنصة", "content.how_it_works"],
  fees: ["جدول الرسوم والعمولات", "content.fees"],
  faq: ["الأسئلة الشائعة", "content.faq"],
  terms: ["شروط الاستخدام والخدمة", "content.terms"],
  privacy: ["سياسة الخصوصية وحماية البيانات", "content.privacy"],
  complaints: ["سياسة معالجة الشكاوى والمقترحات", "content.complaints"],
  refunds: ["سياسة الإلغاء والاسترجاع المالي", "content.refunds"],
  risk: ["إخلاء مسؤولية مخاطر الأصول الرقمية", "content.risk"],
};

export function InfoPage() {
  const { slug } = useParams();
  const { s, loading } = useSettings();
  const def = PAGES[slug];
  if (!def) return <NotFound />;
  const val = s[def[1]];
  const empty = !val || (Array.isArray(val) && val.length === 0) || (typeof val === "string" && !val.trim());
  return (
    <div className="page">
      <h1>{def[0]}</h1>
      <Card>
        {loading ? null : empty ? (
          <p className="muted">لم يُنشر هذا المحتوى بعد. تتولى إدارة المنصة إضافته من لوحة التحكم.</p>
        ) : Array.isArray(val) ? (
          val.map((f: any, i: number) => (
            <details className="faq" key={i}>
              <summary>{f.q}</summary>
              <p className="prose">{f.a}</p>
            </details>
          ))
        ) : (
          <div className="prose">{String(val)}</div>
        )}
      </Card>
    </div>
  );
}

export function NotFound() {
  return (
    <div className="center">
      <div>
        <Icon name="search" size={48} />
        <h1>الصفحة غير موجودة</h1>
        <p className="muted">الرابط غير صحيح أو تم نقل الصفحة إلى مسار آخر.</p>
        <Link to="/" className="btn accent">
          الصفحة الرئيسية
        </Link>
      </div>
    </div>
  );
}

export function NotConfigured() {
  return (
    <div className="center">
      <div>
        <Icon name="settings" size={48} />
        <h1>التطبيق غير مهيّأ</h1>
        <p className="muted">
          متغيرا البيئة VITE_SUPABASE_URL وVITE_SUPABASE_ANON_KEY غير مضبوطين. راجع docs/DEPLOYMENT.md.
        </p>
      </div>
    </div>
  );
}
