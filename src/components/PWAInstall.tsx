import React, { useEffect, useState } from "react";
import { Icon } from "./Icon";

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed"; platform: string }>;
}

export function usePWAInstall() {
  const [deferredPrompt, setDeferredPrompt] = useState<BeforeInstallPromptEvent | null>(null);
  const [isInstalled, setIsInstalled] = useState(false);
  const [isIOS, setIsIOS] = useState(false);

  useEffect(() => {
    // Detect standalone mode (already installed as PWA or APK/iOS standalone)
    const isStandalone =
      window.matchMedia("(display-mode: standalone)").matches ||
      (window.navigator as unknown as { standalone?: boolean }).standalone === true;
    setIsInstalled(isStandalone);

    // Detect iOS devices
    const ua = window.navigator.userAgent.toLowerCase();
    const isIOSDevice = /iphone|ipad|ipod/.test(ua) && !isStandalone;
    setIsIOS(isIOSDevice);

    const handleBeforeInstallPrompt = (e: Event) => {
      e.preventDefault();
      setDeferredPrompt(e as BeforeInstallPromptEvent);
    };

    const handleAppInstalled = () => {
      setIsInstalled(true);
      setDeferredPrompt(null);
    };

    window.addEventListener("beforeinstallprompt", handleBeforeInstallPrompt);
    window.addEventListener("appinstalled", handleAppInstalled);

    return () => {
      window.removeEventListener("beforeinstallprompt", handleBeforeInstallPrompt);
      window.removeEventListener("appinstalled", handleAppInstalled);
    };
  }, []);

  const install = async () => {
    if (!deferredPrompt) return false;
    await deferredPrompt.prompt();
    const { outcome } = await deferredPrompt.userChoice;
    if (outcome === "accepted") {
      setIsInstalled(true);
      setDeferredPrompt(null);
      return true;
    }
    return false;
  };

  return {
    isInstallable: Boolean(deferredPrompt),
    isInstalled,
    isIOS,
    install,
  };
}

export const PWAInstallButton: React.FC<{ className?: string; variant?: "badge" | "button" }> = ({
  className = "",
  variant = "button",
}) => {
  const { isInstallable, isInstalled, isIOS, install } = usePWAInstall();
  const [showIOSGuide, setShowIOSGuide] = useState(false);

  // If already installed, hide button
  if (isInstalled) return null;

  // Android / Chromium / Desktop PWA install
  if (isInstallable) {
    return (
      <button
        onClick={install}
        className={`btn accent ${className}`}
        style={{ fontSize: "0.825rem", padding: "0.4rem 0.75rem", display: "inline-flex", alignItems: "center", gap: "0.35rem" }}
        title="تثبيت التطبيق على جهازك كـ تطبيق مستقل أو APK"
      >
        <Icon name="download" size={15} />
        <span>تثبيت التطبيق</span>
      </button>
    );
  }

  // iOS Safari flow
  if (isIOS) {
    return (
      <>
        <button
          onClick={() => setShowIOSGuide(true)}
          className={`btn ghost ${className}`}
          style={{ fontSize: "0.825rem", padding: "0.4rem 0.75rem", display: "inline-flex", alignItems: "center", gap: "0.35rem" }}
          title="تثبيت التطبيق على آيفون أو آيباد"
        >
          <Icon name="phone" size={15} />
          <span>تثبيت على iPhone</span>
        </button>

        {showIOSGuide && (
          <div
            className="dialog-bg"
            onClick={() => setShowIOSGuide(false)}
            style={{ zIndex: 9999, display: "flex", alignItems: "center", justifyContent: "center", padding: "1rem" }}
          >
            <div
              className="card"
              onClick={(e) => e.stopPropagation()}
              style={{ maxWidth: "380px", width: "100%", textAlign: "right" }}
            >
              <div className="row between" style={{ marginBottom: "0.75rem" }}>
                <h3 style={{ margin: 0, fontSize: "1.1rem" }}>تثبيت التطبيق على iPhone / iPad</h3>
                <button
                  className="btn ghost"
                  style={{ padding: "0.2rem 0.5rem" }}
                  onClick={() => setShowIOSGuide(false)}
                >
                  ✕
                </button>
              </div>
              <p style={{ fontSize: "0.9rem", color: "var(--muted)", lineHeight: 1.6 }}>
                لتحويل المنصة إلى تطبيق على شاشتك الرئيسية في نظام iOS:
              </p>
              <ol className="steps" style={{ margin: "1rem 0", paddingRight: "1.2rem", fontSize: "0.9rem" }}>
                <li style={{ marginBottom: "0.5rem" }}>
                  اضغط على زر <strong>المشاركة (Share)</strong> في شريط متصفح Safari أسفل الشاشة.
                </li>
                <li style={{ marginBottom: "0.5rem" }}>
                  مرر للأسفل واضغط على <strong>إضافة إلى الشاشة الرئيسية (Add to Home Screen)</strong>.
                </li>
                <li>
                  اضغط <strong>إضافة (Add)</strong> في أعلى الزاوية ليظهر كأيقونة تطبيق مستقلة.
                </li>
              </ol>
              <button
                className="btn accent"
                style={{ width: "100%", marginTop: "0.5rem" }}
                onClick={() => setShowIOSGuide(false)}
              >
                فهمت ذلك
              </button>
            </div>
          </div>
        )}
      </>
    );
  }

  // Fallback direct download prompt for converting to APK or desktop shortcut
  return (
    <>
      <button
        onClick={() => setShowIOSGuide(true)}
        className={`btn ghost ${className}`}
        style={{ fontSize: "0.825rem", padding: "0.4rem 0.75rem", display: "inline-flex", alignItems: "center", gap: "0.35rem" }}
        title="تثبيت التطبيق على هاتفك"
      >
        <Icon name="download" size={15} />
        <span>تطبيق الهاتف</span>
      </button>

      {showIOSGuide && (
        <div
          className="dialog-bg"
          onClick={() => setShowIOSGuide(false)}
          style={{ zIndex: 9999, display: "flex", alignItems: "center", justifyContent: "center", padding: "1rem" }}
        >
          <div
            className="card"
            onClick={(e) => e.stopPropagation()}
            style={{ maxWidth: "380px", width: "100%", textAlign: "right" }}
          >
            <div className="row between" style={{ marginBottom: "0.75rem" }}>
              <h3 style={{ margin: 0, fontSize: "1.1rem" }}>جاهز للتحويل إلى تطبيق (APK / iOS)</h3>
              <button className="btn ghost" style={{ padding: "0.2rem 0.5rem" }} onClick={() => setShowIOSGuide(false)}>✕</button>
            </div>
            <p style={{ fontSize: "0.9rem", color: "var(--muted)", lineHeight: 1.6 }}>
              التطبيق مجهز بمعايير PWA الكاملة (Service Worker + Manifest + Icons):
            </p>
            <ul style={{ margin: "0.75rem 0", paddingRight: "1.2rem", fontSize: "0.85rem", lineHeight: 1.6 }}>
              <li><strong>على أندرويد:</strong> افتح القائمة (⋮) ثم اضغط "تثبيت التطبيق" أو "إضافة للشاشة الرئيسية" ليتم تثبيته فورًا كـ WebAPK.</li>
              <li><strong>على آيفون:</strong> من متصفح Safari اضغط زر المشاركة ثم "إضافة إلى الشاشة الرئيسية".</li>
              <li><strong>كحزمة APK مستقلة:</strong> يمكن تجميع ملف الـ Manifest بضغطة زر عبر أداة PWABuilder أو Bubblewrap لنشره على متجر Google Play.</li>
            </ul>
            <button className="btn accent" style={{ width: "100%", marginTop: "0.5rem" }} onClick={() => setShowIOSGuide(false)}>حسناً</button>
          </div>
        </div>
      )}
    </>
  );
};

export const OfflineIndicator: React.FC = () => {
  const [isOnline, setIsOnline] = useState(typeof navigator !== "undefined" ? navigator.onLine : true);

  useEffect(() => {
    const handleOnline = () => setIsOnline(true);
    const handleOffline = () => setIsOnline(false);

    window.addEventListener("online", handleOnline);
    window.addEventListener("offline", handleOffline);

    return () => {
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("offline", handleOffline);
    };
  }, []);

  if (isOnline) return null;

  return (
    <div
      style={{
        position: "fixed",
        bottom: "1rem",
        left: "1rem",
        zIndex: 9999,
        backgroundColor: "#b45309",
        color: "#ffffff",
        padding: "0.5rem 0.85rem",
        borderRadius: "0.5rem",
        fontSize: "0.825rem",
        display: "flex",
        alignItems: "center",
        gap: "0.5rem",
        boxShadow: "0 4px 12px rgba(0,0,0,0.25)",
      }}
    >
      <span
        style={{
          width: "8px",
          height: "8px",
          borderRadius: "50%",
          backgroundColor: "#ffffff",
          display: "inline-block",
        }}
      />
      وضع العمل دون إنترنت — يتم عرض البيانات المحفوظة محليًا.
    </div>
  );
};
