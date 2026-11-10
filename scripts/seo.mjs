// Writes robots.txt and sitemap.xml into dist/ using VITE_SITE_URL. Runs automatically after `npm run build`.
import { writeFileSync } from "node:fs";
import { loadEnv } from "vite";

const env = { ...loadEnv("production", process.cwd(), "VITE_"), ...process.env };
const site = (env.VITE_SITE_URL ?? "").replace(/\/+$/, "");
if (!site.startsWith("https://")) throw new Error("VITE_SITE_URL is required to generate robots.txt / sitemap.xml");

const PUBLIC_PATHS = ["/", "/prices", "/info/about", "/info/how-it-works", "/info/fees", "/info/faq", "/info/terms", "/info/privacy", "/info/complaints", "/info/refunds", "/info/risk"];
const PRIVATE_PATHS = ["/admin", "/app", "/wallet", "/buy", "/sell", "/orders", "/transactions", "/payout-methods", "/notifications", "/support", "/more", "/profile", "/login", "/register", "/forgot-password", "/reset-password"];

writeFileSync("dist/robots.txt", ["User-agent: *", "Allow: /", ...PRIVATE_PATHS.map((p) => `Disallow: ${p}`), "", `Sitemap: ${site}/sitemap.xml`, ""].join("\n"));
const day = new Date().toISOString().slice(0, 10);
writeFileSync("dist/sitemap.xml", `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${PUBLIC_PATHS.map((p) => `  <url><loc>${site}${p === "/" ? "/" : p}</loc><lastmod>${day}</lastmod></url>`).join("\n")}\n</urlset>\n`);
console.log("robots.txt and sitemap.xml written");
