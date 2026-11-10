import { useEffect, useState, type ReactNode } from "react";
import { Link, useNav } from "../lib/router";
import { useAuth } from "../lib/auth";
import { useSettings } from "../lib/settings";
import { useAsync, useOnline } from "../lib/hooks";
import { Icon, LogoMark } from "./Icon";
import { Banner } from "./ui";
import { PWAInstallButton, OfflineIndicator } from "./PWAInstall";
import { NotificationCenter } from "./NotificationCenter";
import { supabase, must } from "../lib/supabase";

export function Brand() {
  const { s } = useSettings();
  const name = String(s["platform.name"] ?? "Libya USDT Exchange");
  const logo = String(s["platform.logo_url"] ?? "");
  return (
    <Link to="/" className="brand">
      {/^https:\/\//.test(logo) ? (
        <img src={logo} alt="" />
      ) : (
        <div
          style={{
            width: "36px",
            height: "36px",
            borderRadius: "10px",
            background: "linear-gradient(135deg, #10b981 0%, #059669 100%)",
            display: "grid",
            placeItems: "center",
            boxShadow: "0 2px 10px rgba(16, 185, 129, 0.4)",
          }}
        >
          <LogoMark />
        </div>
      )}
      <span className="brand-text">{name}</span>
    </Link>
  );
}

export function StatusBanners({ admin }: { admin?: boolean }) {
  const online = useOnline();
  const { s } = useSettings();
  const { isStaff } = useAuth();
  return (
    <>
      <OfflineIndicator />
      {!online && (
        <Banner tone="warn" icon="offline">
          لا يوجد اتصال بالإنترنت. لن تظهر الأرصدة المحدّثة ولا يمكن تنفيذ أي عملية حتى يعود الاتصال.
        </Banner>
      )}
      {s["maintenance.enabled"] === true && (
        <Banner tone="warn" icon="settings">
          <strong>المنصة في وضع الصيانة.</strong> الطلبات الجديدة متوقفة مؤقتًا، ويمكنك متابعة طلباتك القائمة.
          {s["maintenance.message"] ? ` ${s["maintenance.message"]}` : ""}
          {s["maintenance.eta"] ? ` المدة المتوقعة: ${s["maintenance.eta"]}` : ""}
          {admin && isStaff ? " (الموظفون يستطيعون المتابعة)" : ""}
        </Banner>
      )}
    </>
  );
}

export function PublicLayout({ children }: { children: ReactNode }) {
  const { session } = useAuth();
  const { s } = useSettings();
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  return (
    <div className="public">
      <header className="topbar">
        <Brand />

        {/* Desktop Navigation Links - hidden on small mobile, visible on >= 820px */}
        <nav className="desktop-nav" style={{ whiteSpace: "nowrap" }}>
          <Link to="/">الرئيسية</Link>
          <Link to="/prices">الأسعار والحدود</Link>
          <Link to="/info/how-it-works">كيف تعمل</Link>
          <Link to="/info/fees">الرسوم</Link>
          <Link to="/info/faq">الأسئلة الشائعة</Link>
        </nav>

        <span className="grow" />
        <PWAInstallButton />
        {session ? (
          <Link
            to="/app"
            className="btn accent sm"
            style={{ padding: "0.45rem 1.15rem", borderRadius: "10px", fontWeight: 700, flex: "none" }}
          >
            حسابي
          </Link>
        ) : (
          <Link
            to="/login"
            className="btn accent sm"
            style={{ padding: "0.45rem 1.15rem", borderRadius: "10px", fontWeight: 700, flex: "none" }}
          >
            سجل الآن
          </Link>
        )}

        {/* Mobile Hamburger Menu Toggle */}
        <button
          type="button"
          onClick={() => setMobileMenuOpen(true)}
          className="iconbtn mobile-menu-btn"
          aria-label="القائمة"
          style={{ flex: "none" }}
        >
          <Icon name="menu" size={22} />
        </button>
      </header>

      {/* Mobile Navigation Drawer */}
      {mobileMenuOpen && (
        <div className="drawer" onClick={() => setMobileMenuOpen(false)}>
          <aside
            className="side"
            style={{ display: "block" }}
            onClick={(e) => e.stopPropagation()}
            aria-label="قائمة التنقل للجوّال"
          >
            <div className="row between" style={{ padding: "0.75rem", borderBottom: "1px solid var(--line-light)" }}>
              <Brand />
              <button
                type="button"
                onClick={() => setMobileMenuOpen(false)}
                className="iconbtn"
                style={{ width: "36px", height: "36px" }}
                aria-label="إغلاق"
              >
                ✕
              </button>
            </div>

            <div style={{ padding: "1rem 0.5rem", display: "grid", gap: "4px" }}>
              <Link to="/" onClick={() => setMobileMenuOpen(false)}>
                <Icon name="home" size={18} />
                <span>الرئيسية</span>
              </Link>
              <Link to="/prices" onClick={() => setMobileMenuOpen(false)}>
                <Icon name="tag" size={18} />
                <span>الأسعار والحدود اليومية</span>
              </Link>
              <Link to="/info/how-it-works" onClick={() => setMobileMenuOpen(false)}>
                <Icon name="info" size={18} />
                <span>كيف تعمل المنصة</span>
              </Link>
              <Link to="/info/fees" onClick={() => setMobileMenuOpen(false)}>
                <Icon name="shield" size={18} />
                <span>الرسوم والعمولات</span>
              </Link>
              <Link to="/info/faq" onClick={() => setMobileMenuOpen(false)}>
                <Icon name="help" size={18} />
                <span>الأسئلة الشائعة</span>
              </Link>

              <hr style={{ border: 0, borderTop: "1px solid var(--line-light)", margin: "0.85rem 0" }} />

              {session ? (
                <Link
                  to="/app"
                  onClick={() => setMobileMenuOpen(false)}
                  style={{
                    background: "rgba(16, 185, 129, 0.15)",
                    color: "#6ee7b7",
                    borderRadius: "10px",
                    fontWeight: 700,
                  }}
                >
                  <Icon name="wallet" size={18} />
                  <span>لوحة تحكم حسابي</span>
                </Link>
              ) : (
                <Link
                  to="/login"
                  onClick={() => setMobileMenuOpen(false)}
                  style={{
                    background: "linear-gradient(135deg, #10b981 0%, #059669 100%)",
                    color: "#ffffff",
                    borderRadius: "10px",
                    fontWeight: 700,
                  }}
                >
                  <Icon name="lock" size={18} />
                  <span>تسجيل الدخول / فتح حساب</span>
                </Link>
              )}
            </div>
          </aside>
        </div>
      )}
      <main>
        <div className="page" style={{ paddingBottom: 0 }}>
          <StatusBanners />
        </div>
        {children}
      </main>
      <footer className="footer">
        <nav aria-label="روابط">
          {[
            ["about", "من نحن"],
            ["how-it-works", "كيف تعمل"],
            ["fees", "الرسوم"],
            ["faq", "أسئلة شائعة"],
            ["terms", "الشروط"],
            ["privacy", "الخصوصية"],
            ["complaints", "الشكاوى"],
            ["refunds", "الإلغاء والاسترجاع"],
            ["risk", "المخاطر"],
          ].map(([p, l]) => (
            <Link key={p} to={`/info/${p}`}>
              {l}
            </Link>
          ))}
        </nav>
        {(s["platform.support_email"] || s["platform.support_phone"]) && (
          <div style={{ marginBottom: "0.4rem" }}>
            الدعم الفني المعتمد: {s["platform.support_email"] as string} {s["platform.support_phone"] as string}
          </div>
        )}
        {s["platform.legal_entity"] && <div>{s["platform.legal_entity"] as string}</div>}
        <div style={{ color: "var(--muted)", fontSize: "0.8rem", marginTop: "0.5rem" }}>
          © {new Date().getFullYear()} {String(s["platform.name"] ?? "")} · تكامل مؤتمت بالكامل مع بوابة DPay ليبيا
        </div>
      </footer>
    </div>
  );
}

export function AppLayout({ children }: { children: ReactNode }) {
  const { profile } = useAuth();
  const { path } = useNav();

  const tabs: [string, string, string][] = [
    ["/app", "home", "الرئيسية"],
    ["/transactions", "list", "الطلبات"],
    ["/buy", "buy", "تحويل"],
    ["/wallet", "wallet", "المحفظة"],
    ["/profile", "user", "حسابي"],
  ];

  return (
    <>
      <header className="topbar">
        <Brand />
        <span className="grow" />
        <PWAInstallButton />
        <NotificationCenter />
      </header>
      <div className="page">
        <StatusBanners />
        {profile && profile.status !== "active" && (
          <Banner tone="warn" icon="clock">
            {profile.status === "pending_verification"
              ? "حسابك بانتظار التحقق. لا يمكن الشحن أو التداول حتى يتم تفعيله."
              : "حسابك غير نشط حاليًا. تواصل مع الدعم الفني."}
          </Banner>
        )}
        {children}
      </div>
      <nav className="tabbar" aria-label="التنقل الرئيسي" style={{ background: "#0a0e1a", borderTop: "1px solid rgba(255, 255, 255, 0.08)" }}>
        {tabs.map(([to, icon, label]) => {
          const isActive = to === "/app" ? path === "/app" : path === to || (to !== "/app" && path.startsWith(to));
          return (
            <Link
              key={to}
              to={to}
              aria-current={isActive ? "page" : undefined}
              style={{
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                justifyContent: "center",
                gap: "3px",
                padding: "6px 4px",
                textDecoration: "none",
                color: isActive ? "#22d3ee" : "#64748b",
                fontWeight: isActive ? 700 : 500,
              }}
            >
              <div
                style={{
                  width: isActive ? "52px" : "36px",
                  height: "30px",
                  borderRadius: "16px",
                  background: isActive ? "#00838f" : "transparent",
                  color: isActive ? "#ffffff" : "currentColor",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  transition: "all 0.2s ease",
                }}
              >
                <Icon name={icon} size={20} />
              </div>
              <span style={{ fontSize: "0.74rem" }}>{label}</span>
            </Link>
          );
        })}
      </nav>
    </>
  );
}

const ADMIN_NAV: [string, string, string, string | null][] = [
  ["/admin", "chart", "لوحة المؤشرات والأرباح", "reports.read"],
  ["/admin/orders", "list", "الطلبات والعمليات", "orders.read"],
  ["/admin/rates", "tag", "الأسعار والحدود", "rates.write"],
  ["/admin/users", "users", "المستخدمون والعملاء", "users.read"],
  ["/admin/staff", "shield", "الموظفون والصلاحيات", "roles.manage"],
  ["/admin/adjustments", "wallet", "التسويات ودفتر الأستاذ", "ledger.adjust"],
  ["/admin/support", "headset", "تذاكر الدعم الفني", "support.reply"],
  ["/admin/reports", "file", "التقارير المالية والمحاسبية", "reports.read"],
  ["/admin/settings", "settings", "الإعدادات وبوابة DPay", "settings.read"],
  ["/admin/audit", "lock", "سجل التدقيق والحركات", "audit.read"],
  ["/admin/health", "refresh", "صحة النظام والتكامل", "settings.read"],
];

export function AdminLayout({ children }: { children: ReactNode }) {
  const { has, profile, perms } = useAuth();
  const { path } = useNav();
  const [open, setOpen] = useState(false);

  useEffect(() => setOpen(false), [path]);

  const isSuperAdmin = perms.includes("settings.write");

  const nav = (
    <aside className="side" aria-label="قائمة الإدارة">
      <div style={{ padding: "0.5rem 0.75rem 0.75rem", fontWeight: 800, fontSize: "1.1rem", color: "#ffffff" }}>
        لوحة التحكم المركزية
      </div>

      {/* Staff user badge */}
      <div
        style={{
          margin: "0.2rem 0.5rem 1rem",
          padding: "0.65rem 0.85rem",
          background: "rgba(255,255,255,0.03)",
          borderRadius: "12px",
          border: "1px solid var(--line-light)",
        }}
      >
        <div style={{ fontSize: "0.72rem", color: "var(--muted)", marginBottom: "3px" }}>الموظف المسجل حالياً:</div>
        <div style={{ fontSize: "0.85rem", fontWeight: 700, color: "#ffffff", marginBottom: "8px" }}>
          {profile?.full_name || "مشرف الإدارة"}
        </div>
      </div>

      {ADMIN_NAV.filter(([, , , p]) => !p || has(p)).map(([to, icon, label]) => (
        <Link
          key={to}
          to={to}
          aria-current={(to === "/admin" ? path === "/admin" : path.startsWith(to)) ? "page" : undefined}
        >
          <Icon name={icon} size={18} />
          <span>{label}</span>
        </Link>
      ))}

      <hr style={{ border: 0, borderTop: "1px solid var(--line-light)", margin: "1rem 0" }} />
      <Link to="/" style={{ color: "var(--muted)", fontSize: "0.85rem" }}>
        <Icon name="home" size={16} />
        <span>عرض واجهة الموقع الرئيسي</span>
      </Link>
    </aside>
  );

  return (
    <div className="admin">
      {nav}
      <div>
        <header className="topbar">
          <button className="iconbtn menu-btn" onClick={() => setOpen(true)} aria-label="القائمة">
            <Icon name="menu" />
          </button>
          <Brand />
          <span className="grow" />
          <HealthPill />
          <PWAInstallButton />
          <NotificationCenter />
          <span
            className="badge ok"
            style={{
              marginInlineStart: "0.25rem",
              background: isSuperAdmin ? "rgba(16, 185, 129, 0.15)" : "rgba(245, 158, 11, 0.15)",
              color: isSuperAdmin ? "#6ee7b7" : "#fcd34d",
              borderColor: isSuperAdmin ? "rgba(16, 185, 129, 0.3)" : "rgba(245, 158, 11, 0.3)",
            }}
          >
            {isSuperAdmin ? "مشرف عام" : "مسؤول عمليات"}
          </span>
        </header>
        <div className="page wide">
          <StatusBanners admin />
          {children}
        </div>
      </div>
      {open && <div className="drawer" onClick={() => setOpen(false)}>{nav}</div>}
    </div>
  );
}

/** Real system status: worst of the latest recorded health checks (written by the ops-cron job); stale data counts as degraded. */
function HealthPill() {
  const st = useAsync(async () => {
    const rows = await must<any[]>(
      supabase.from("system_health_checks").select("check_name,status,checked_at").order("checked_at", { ascending: false }).limit(60),
    );
    const latest = new Map<string, any>();
    rows.forEach((r) => !latest.has(r.check_name) && latest.set(r.check_name, r));
    const list = [...latest.values()];
    if (!list.length) return "unknown";
    const stale = Date.now() - new Date(list[0].checked_at).getTime() > 15 * 60 * 1000;
    if (list.some((r) => r.status === "down")) return "down";
    if (stale || list.some((r) => r.status === "degraded")) return "degraded";
    return "ok";
  }, []);
  const MAP: Record<string, [string, string]> = {
    ok: ["سليم", "#047857"], degraded: ["متدهور", "#b45309"], down: ["متوقف", "#b91c1c"], unknown: ["لا بيانات", "#475569"],
  };
  const [label, bg] = MAP[(st.data as string) ?? "unknown"] ?? MAP.unknown;
  return (
    <Link
      to="/admin/health"
      className="btn sm"
      style={{ background: bg, borderColor: "rgba(255,255,255,0.2)", color: "#fff", display: "inline-flex", alignItems: "center", gap: "6px", padding: "0.35rem 0.85rem", fontSize: "0.8rem", fontWeight: 700, textDecoration: "none" }}
    >
      <Icon name="shield" size={14} />
      <span>صحة النظام: {label}</span>
    </Link>
  );
}
