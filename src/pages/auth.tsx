import { useEffect } from "react";
import { Link, useNav, useSearch } from "../lib/router";
import { useAuth } from "../lib/auth";
import { GoogleButton } from "../components/ui";
import { Icon } from "../components/Icon";

const safeNext = (n: string | null) => (n && n.startsWith("/") && !n.startsWith("//") ? n : "/app");

export function UnifiedGoogleAuth({ mode = "login" }: { mode?: "login" | "register" }) {
  const { navigate } = useNav();
  const search = useSearch();
  const next = safeNext(search.get("next"));
  const { session, loading } = useAuth();

  // If already logged in, seamlessly redirect to destination or /app
  useEffect(() => {
    if (session && !loading) {
      navigate(next, { replace: true });
    }
  }, [session, loading, navigate, next]);

  return (
    <div className="page" style={{ minHeight: "75vh", display: "grid", placeItems: "center" }}>
      <div
        className="authbox"
        style={{
          width: "100%",
          maxWidth: "480px",
          background: "linear-gradient(180deg, rgba(17, 24, 39, 0.95) 0%, rgba(10, 14, 23, 0.98) 100%)",
          border: "1px solid rgba(16, 185, 129, 0.3)",
          borderRadius: "24px",
          padding: "2.25rem 1.75rem",
          boxShadow: "0 20px 45px -10px rgba(0, 0, 0, 0.7), 0 0 30px rgba(16, 185, 129, 0.12)",
          position: "relative",
          overflow: "hidden",
        }}
      >
        {/* Glow accent */}
        <div
          style={{
            position: "absolute",
            top: "-60px",
            left: "50%",
            transform: "translateX(-50%)",
            width: "180px",
            height: "120px",
            background: "radial-gradient(circle, rgba(16, 185, 129, 0.35) 0%, transparent 70%)",
            pointerEvents: "none",
          }}
        />

        {/* Security / Google Header */}
        <div style={{ textAlign: "center", marginBottom: "1.75rem" }}>
          <div
            style={{
              width: "60px",
              height: "60px",
              borderRadius: "18px",
              background: "rgba(16, 185, 129, 0.12)",
              border: "1px solid rgba(16, 185, 129, 0.35)",
              display: "grid",
              placeItems: "center",
              margin: "0 auto 1.25rem",
              boxShadow: "0 0 20px rgba(16, 185, 129, 0.25)",
            }}
          >
            <Icon name="shield" size={30} />
          </div>

          <h1 style={{ fontSize: "1.65rem", fontWeight: 800, color: "#ffffff", marginBottom: "0.5rem" }}>
            {mode === "register" ? "تسجيل حساب جديد" : "تسجيل الدخول"}
          </h1>
          <p style={{ color: "var(--text-dim)", fontSize: "0.9rem", lineHeight: 1.6, margin: 0 }}>
            المنصة الليبية المعتمدة لتداول USDT مقابل الدينار الليبي — تسجيل فوري وسلس عبر حساب Google فقط.
          </p>
        </div>

        {/* Google Single Sign-On Primary Button */}
        <div style={{ marginBottom: "1.75rem" }}>
          <GoogleButton
            label="المتابعة باستخدام Google"
            onSuccess={() => {
              navigate(next, { replace: true });
            }}
          />
        </div>

        {/* Security & Experience Guarantees */}
        <div
          style={{
            background: "rgba(255, 255, 255, 0.03)",
            border: "1px solid rgba(255, 255, 255, 0.07)",
            borderRadius: "16px",
            padding: "1rem",
            marginBottom: "1.5rem",
          }}
        >
          <div style={{ fontSize: "0.82rem", fontWeight: 700, color: "#6ee7b7", marginBottom: "0.65rem" }}>
            مزايا تسجيل الدخول الموحد عبر Google:
          </div>
          <div style={{ display: "grid", gap: "0.6rem", fontSize: "0.82rem", color: "#cbd5e1" }}>
            <div className="row" style={{ gap: "8px", alignItems: "flex-start" }}>
              <span style={{ color: "#10b981", fontSize: "0.9rem" }}>✓</span>
              <span><strong>تسجيل فوري:</strong> ينشئ حسابك أو يفتح محفظتك بنقرة واحدة دون الحاجة لحفظ كلمات مرور.</span>
            </div>
            <div className="row" style={{ gap: "8px", alignItems: "flex-start" }}>
              <span style={{ color: "#10b981", fontSize: "0.9rem" }}>✓</span>
              <span><strong>بقاء الجلسة دائمًا:</strong> يتم حفظ دخولك في هذا المتصفح ولن يُطلب منك تسجيل الدخول في كل مرة.</span>
            </div>
            <div className="row" style={{ gap: "8px", alignItems: "flex-start" }}>
              <span style={{ color: "#10b981", fontSize: "0.9rem" }}>✓</span>
              <span><strong>حماية مشددة:</strong> مدعوم بحماية Google الثنائية وتشفير كامل للبيانات والمعاملات المالية.</span>
            </div>
            <div className="row" style={{ gap: "8px", alignItems: "flex-start" }}>
              <span style={{ color: "#10b981", fontSize: "0.9rem" }}>✓</span>
              <span><strong>تكامل مع DPay:</strong> محفظة الدينار الليبي جاهزة للشحن الفوري فور إتمام الدخول.</span>
            </div>
          </div>
        </div>

        {/* Terms and Disclaimer */}
        <p style={{ textAlign: "center", fontSize: "0.78rem", color: "var(--muted)", lineHeight: 1.5, margin: 0 }}>
          بالمتابعة عبر Google، أنت توافق على{" "}
          <Link to="/info/terms" target="_blank" style={{ color: "var(--accent)", textDecoration: "underline" }}>
            شروط الاستخدام
          </Link>{" "}
          و
          <Link to="/info/privacy" target="_blank" style={{ color: "var(--accent)", textDecoration: "underline" }}>
            سياسة الخصوصية
          </Link>
          .
        </p>

        {/* Home link */}
        <div style={{ textAlign: "center", marginTop: "1.25rem" }}>
          <Link to="/" style={{ color: "var(--muted)", fontSize: "0.82rem" }}>
            ← العودة للصفحة الرئيسية
          </Link>
        </div>
      </div>
    </div>
  );
}

export function Login() {
  return <UnifiedGoogleAuth mode="login" />;
}

export function Register() {
  return <UnifiedGoogleAuth mode="register" />;
}

export function ForgotPassword() {
  return <UnifiedGoogleAuth mode="login" />;
}

export function ResetPassword() {
  return <UnifiedGoogleAuth mode="login" />;
}
