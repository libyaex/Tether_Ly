// Database Webhook (INSERT on public.notifications) → Web Push. Header x-cron-secret must equal CRON_SECRET.
// Payloads carry the (intentionally generic) notification title only — no amounts or balances on a lock screen.
// Needs VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY / VAPID_SUBJECT; without them nothing is sent (and we say so).
import webpush from "npm:web-push@3.6.7";
import { admin, json, requireCronSecret, serve } from "../_shared/lib.ts";

const pub = Deno.env.get("VAPID_PUBLIC_KEY"), priv = Deno.env.get("VAPID_PRIVATE_KEY"), subj = Deno.env.get("VAPID_SUBJECT");
const configured = Boolean(pub && priv && subj);
if (configured) webpush.setVapidDetails(subj!, pub!, priv!);

serve(async (req) => {
  requireCronSecret(req);
  if (!configured) return json(req, { sent: 0, skipped: "vapid_not_configured" });
  const payload = await req.json().catch(() => null);
  const n = payload?.record;
  if (payload?.type !== "INSERT" || !n?.user_id || !n?.title) return json(req, { sent: 0, skipped: "not_a_notification" });

  const { data: subs } = await admin.from("push_subscriptions").select("id,endpoint,p256dh,auth")
    .eq("user_id", n.user_id).is("revoked_at", null).limit(10);
  const body = JSON.stringify({
    title: String(n.title).slice(0, 120),
    body: "افتح التطبيق لعرض التفاصيل",
    url: typeof n.link === "string" && n.link.startsWith("/") ? n.link : "/notifications",
    tag: String(n.type ?? "notification"),
  });
  let sent = 0, revoked = 0;
  for (const s of subs ?? []) {
    try {
      await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, body,
        { TTL: 3600, urgency: n.level === "critical" ? "high" : "normal" });
      sent++;
      await admin.from("push_subscriptions").update({ last_seen_at: new Date().toISOString() }).eq("id", s.id);
    } catch (e) {
      const code = (e as { statusCode?: number }).statusCode;
      if (code === 404 || code === 410) {                       // expired / unsubscribed endpoint
        await admin.from("push_subscriptions").update({ revoked_at: new Date().toISOString() }).eq("id", s.id);
        revoked++;
      } else console.error("push_failed", code);
    }
  }
  return json(req, { sent, revoked });
});
