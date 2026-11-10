// Service worker for Libya USDT Exchange.
// Caches only the static app shell (built JS/CSS/fonts/icons). NEVER caches API calls, Supabase REST/Auth/Realtime,
// or the DPay checkout flow — a financial app must not show stale balances or let an action "succeed" while offline.
const VERSION = "v1";
const SHELL_CACHE = `shell-${VERSION}`;
const APP_SHELL = ["/", "/offline.html", "/manifest.webmanifest"];

const NEVER_CACHE = [/\/rest\/v1\//, /\/auth\/v1\//, /\/functions\/v1\//, /\/realtime\/v1\//, /\/storage\/v1\//, /supabase\.co/, /dpay\.ly/];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(SHELL_CACHE).then((c) => c.addAll(APP_SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== SHELL_CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});
self.addEventListener("message", (event) => { if (event.data === "SKIP_WAITING") self.skipWaiting(); });

function isNeverCache(url) { return NEVER_CACHE.some((re) => re.test(url)); }

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;                      // POST/PUT/DELETE (all money moves) always hit the network
  const url = new URL(req.url);
  if (isNeverCache(url.href)) return;                     // let the browser handle it normally; no cache read or write

  if (req.mode === "navigate") {
    event.respondWith(
      fetch(req).catch(() => caches.match("/offline.html").then((r) => r || caches.match("/")))
    );
    return;
  }
  if (url.origin === self.location.origin && /\.(js|css|woff2?|ttf|otf|svg|png|webp|ico)$/.test(url.pathname)) {
    event.respondWith(
      caches.match(req).then((cached) => {
        const fetchPromise = fetch(req).then((res) => {
          if (res.ok) caches.open(SHELL_CACHE).then((c) => c.put(req, res.clone()));
          return res;
        }).catch(() => cached);
        return cached || fetchPromise;                    // stale-while-revalidate for static assets only
      })
    );
  }
});

// Web Push (see push-dispatch Edge Function). Payload carries no amounts/balances by design.
self.addEventListener("push", (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch { /* ignore malformed payload */ }
  const title = data.title || "Libya USDT Exchange";
  event.waitUntil(self.registration.showNotification(title, {
    body: data.body || "افتح التطبيق لعرض التفاصيل",
    icon: "/icons/icon-192.png", badge: "/icons/icon-192.png", tag: data.tag || "notification", data: { url: data.url || "/notifications" },
  }));
});
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = event.notification.data?.url || "/notifications";
  event.waitUntil(self.clients.matchAll({ type: "window" }).then((list) => {
    for (const c of list) if (c.url.includes(url) && "focus" in c) return c.focus();
    return self.clients.openWindow(url);
  }));
});
