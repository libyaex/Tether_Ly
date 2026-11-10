import React, { useState, useEffect } from "react";
import { Link } from "../lib/router";
import { supabase, must } from "../lib/supabase";
import { useAuth } from "../lib/auth";
import { useAsync } from "../lib/hooks";
import { Icon } from "./Icon";
import { ago } from "../lib/format";

export interface NotificationItem {
  id: string;
  type: string;
  level: "info" | "success" | "warning" | "critical";
  title: string;
  body: string;
  entity_type?: string;
  entity_id?: string;
  link?: string;
  read: boolean;
  created_at: string;
}

export const NotificationCenter: React.FC = () => {
  const { session } = useAuth();
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState<"all" | "unread" | "financial">("all");
  const [soundEnabled, setSoundEnabled] = useState(true);

  const notifs = useAsync(async () => {
    if (!session) return [];
    return must<NotificationItem[]>(
      supabase
        .from("notifications")
        .select("*")
        .eq("user_id", session.user.id)
        .order("created_at", { ascending: false })
        .limit(30)
    ).catch(() => []);
  }, [session]);

  const items = notifs.data || [];
  const unreadCount = items.filter((n) => !n.read).length;

  const filtered = items.filter((n) => {
    if (filter === "unread") return !n.read;
    if (filter === "financial") return n.type.includes("deposit") || n.type.includes("buy") || n.type.includes("sell");
    return true;
  });

  const markAllRead = async () => {
    if (!session) return;
    await supabase.from("notifications").update({ read: true }).eq("user_id", session.user.id);
    notifs.reload();
  };

  const markItemRead = async (id: string) => {
    await supabase.from("notifications").update({ read: true }).eq("id", id);
    notifs.reload();
  };

  // Play subtle sound on new notification
  useEffect(() => {
    if (unreadCount > 0 && soundEnabled && typeof Audio !== "undefined") {
      // Gentle notification tone using Web Audio API
      try {
        const ctx = new (window.AudioContext || (window as any).webkitAudioContext)();
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.type = "sine";
        osc.frequency.setValueAtTime(587.33, ctx.currentTime); // D5
        osc.frequency.exponentialRampToValueAtTime(880, ctx.currentTime + 0.15); // A5
        gain.gain.setValueAtTime(0.08, ctx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.3);
        osc.start();
        osc.stop(ctx.currentTime + 0.3);
      } catch {}
    }
  }, [unreadCount, soundEnabled]);

  const getLevelStyle = (lvl: string) => {
    switch (lvl) {
      case "success":
        return { color: "#10b981", bg: "#10b98115", icon: "check" as const };
      case "warning":
        return { color: "#f59e0b", bg: "#f59e0b15", icon: "alert" as const };
      case "critical":
        return { color: "#ef4444", bg: "#ef444415", icon: "alert" as const };
      default:
        return { color: "#3b82f6", bg: "#3b82f615", icon: "clock" as const };
    }
  };

  return (
    <div style={{ position: "relative" }}>
      {/* Bell Button with Badge */}
      <button
        onClick={() => setOpen((prev) => !prev)}
        className="btn ghost"
        style={{
          position: "relative",
          padding: "0.45rem",
          borderRadius: "50%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          border: "none",
        }}
        title="مركز الإشعارات اللحظية"
        aria-label="الإشعارات"
      >
        <Icon name="bell" size={20} />
        {unreadCount > 0 && (
          <span
            style={{
              position: "absolute",
              top: "2px",
              right: "2px",
              backgroundColor: "#ef4444",
              color: "#ffffff",
              fontSize: "0.68rem",
              fontWeight: "bold",
              borderRadius: "10px",
              padding: "1px 5px",
              minWidth: "16px",
              textAlign: "center",
              lineHeight: "1.2",
              boxShadow: "0 0 0 2px var(--card-bg, #fff)",
            }}
          >
            {unreadCount > 9 ? "9+" : unreadCount}
          </span>
        )}
      </button>

      {/* Flyout Panel */}
      {open && (
        <>
          <div
            style={{
              position: "fixed",
              top: 0,
              left: 0,
              right: 0,
              bottom: 0,
              zIndex: 999,
            }}
            onClick={() => setOpen(false)}
          />
          <div
            style={{
              position: "absolute",
              top: "120%",
              left: 0,
              width: "360px",
              maxWidth: "90vw",
              backgroundColor: "var(--card-bg, #ffffff)",
              boxShadow: "0 10px 25px -5px rgba(0, 0, 0, 0.2), 0 8px 10px -6px rgba(0, 0, 0, 0.1)",
              borderRadius: "12px",
              border: "1px solid var(--border)",
              zIndex: 1000,
              overflow: "hidden",
              textAlign: "right",
            }}
          >
            {/* Header */}
            <div
              className="row between"
              style={{
                padding: "0.75rem 1rem",
                borderBottom: "1px solid var(--border)",
                backgroundColor: "rgba(0,0,0,0.02)",
              }}
            >
              <div className="row" style={{ gap: "0.4rem" }}>
                <strong>الإشعارات</strong>
                {unreadCount > 0 && <span className="badge ok">{unreadCount} جديد</span>}
              </div>
              <div className="row" style={{ gap: "0.5rem" }}>
                <button
                  onClick={() => setSoundEnabled((p) => !p)}
                  className="small"
                  style={{ background: "none", border: "none", cursor: "pointer", color: soundEnabled ? "#0d9488" : "var(--muted)" }}
                  title={soundEnabled ? "كتم الصوت" : "تفعيل التنبيه الصوتي"}
                >
                  <Icon name={soundEnabled ? "check" : "close"} size={14} />
                </button>
                {unreadCount > 0 && (
                  <button
                    onClick={markAllRead}
                    className="small"
                    style={{ background: "none", border: "none", color: "#0d9488", cursor: "pointer", fontWeight: 600 }}
                  >
                    تحديد الكل كمقروء
                  </button>
                )}
              </div>
            </div>

            {/* Filter Tabs */}
            <div
              className="row"
              style={{
                padding: "0.35rem 0.75rem",
                gap: "0.35rem",
                borderBottom: "1px solid var(--border)",
                fontSize: "0.75rem",
              }}
            >
              <button
                onClick={() => setFilter("all")}
                style={{
                  padding: "0.2rem 0.5rem",
                  borderRadius: "4px",
                  border: "none",
                  cursor: "pointer",
                  backgroundColor: filter === "all" ? "var(--accent)" : "transparent",
                  color: filter === "all" ? "#fff" : "var(--muted)",
                }}
              >
                الكل
              </button>
              <button
                onClick={() => setFilter("unread")}
                style={{
                  padding: "0.2rem 0.5rem",
                  borderRadius: "4px",
                  border: "none",
                  cursor: "pointer",
                  backgroundColor: filter === "unread" ? "var(--accent)" : "transparent",
                  color: filter === "unread" ? "#fff" : "var(--muted)",
                }}
              >
                غير المقروءة ({unreadCount})
              </button>
              <button
                onClick={() => setFilter("financial")}
                style={{
                  padding: "0.2rem 0.5rem",
                  borderRadius: "4px",
                  border: "none",
                  cursor: "pointer",
                  backgroundColor: filter === "financial" ? "var(--accent)" : "transparent",
                  color: filter === "financial" ? "#fff" : "var(--muted)",
                }}
              >
                العمليات المالية
              </button>
            </div>

            {/* Notification List */}
            <div style={{ maxHeight: "360px", overflowY: "auto" }}>
              {filtered.length === 0 ? (
                <div style={{ padding: "2rem", textAlign: "center", color: "var(--muted)", fontSize: "0.85rem" }}>
                  لا توجد إشعارات حالياً
                </div>
              ) : (
                filtered.map((item) => {
                  const sty = getLevelStyle(item.level);
                  return (
                    <div
                      key={item.id}
                      onClick={() => markItemRead(item.id)}
                      style={{
                        padding: "0.75rem 1rem",
                        borderBottom: "1px solid var(--border)",
                        backgroundColor: item.read ? "transparent" : "rgba(13, 148, 136, 0.05)",
                        cursor: "pointer",
                        display: "flex",
                        alignItems: "flex-start",
                        gap: "0.6rem",
                        transition: "background-color 0.2s",
                      }}
                    >
                      <div
                        style={{
                          width: "28px",
                          height: "28px",
                          borderRadius: "50%",
                          backgroundColor: sty.bg,
                          color: sty.color,
                          display: "flex",
                          alignItems: "center",
                          justifyContent: "center",
                          flexShrink: 0,
                          marginTop: "2px",
                        }}
                      >
                        <Icon name={sty.icon} size={15} />
                      </div>
                      <div style={{ flex: 1 }}>
                        <div className="row between" style={{ marginBottom: "0.15rem" }}>
                          <strong style={{ fontSize: "0.85rem", color: item.read ? "inherit" : "#0f766e" }}>
                            {item.title}
                          </strong>
                          <span style={{ fontSize: "0.7rem", color: "var(--muted)" }}>{ago(item.created_at)}</span>
                        </div>
                        <p style={{ margin: 0, fontSize: "0.8rem", color: "var(--muted)", lineHeight: 1.4 }}>
                          {item.body}
                        </p>
                        {item.link && (
                          <Link
                            to={item.link}
                            onClick={() => setOpen(false)}
                            style={{ fontSize: "0.75rem", color: "var(--accent)", marginTop: "0.25rem", display: "inline-block" }}
                          >
                            عرض التفاصيل ←
                          </Link>
                        )}
                      </div>
                    </div>
                  );
                })
              )}
            </div>

            {/* Footer */}
            <div style={{ padding: "0.5rem 1rem", textAlign: "center", borderTop: "1px solid var(--border)", backgroundColor: "rgba(0,0,0,0.01)" }}>
              <Link to="/notifications" onClick={() => setOpen(false)} className="small">
                عرض جميع الإشعارات
              </Link>
            </div>
          </div>
        </>
      )}
    </div>
  );
};
