// Fails the build when the production configuration is missing or unsafe. Runs automatically before `npm run build`.
import { loadEnv } from "vite";

const mode = process.env.NODE_ENV === "development" ? "development" : "production";
const env = { ...loadEnv(mode, process.cwd(), "VITE_"), ...Object.fromEntries(Object.entries(process.env).filter(([k]) => k.startsWith("VITE_"))) };
const errors = [];

const url = env.VITE_SUPABASE_URL ?? "";
const key = env.VITE_SUPABASE_ANON_KEY ?? "";
const site = env.VITE_SITE_URL ?? "";

if (!url.startsWith("https://")) errors.push("VITE_SUPABASE_URL must be set and start with https://");
if (!key) errors.push("VITE_SUPABASE_ANON_KEY must be set");
if (key.startsWith("sb_secret_")) errors.push("VITE_SUPABASE_ANON_KEY contains a secret key — only the public anon/publishable key may be used in the frontend");
try {
  const payload = JSON.parse(Buffer.from(key.split(".")[1] ?? "", "base64url").toString("utf8"));
  if (payload.role === "service_role") errors.push("VITE_SUPABASE_ANON_KEY is a service_role key — it must NEVER be shipped to browsers");
} catch { /* not a JWT (e.g. sb_publishable_…): nothing to inspect */ }
if (!/^https:\/\/[^/]+$/.test(site)) errors.push("VITE_SITE_URL must be an https origin without a trailing slash, e.g. https://example.com");

if (errors.length) {
  console.error("\nBuild configuration errors / أخطاء في إعدادات البناء:\n" + errors.map((e) => "  - " + e).join("\n") + "\n\nSee .env.example and docs/DEPLOYMENT.md\n");
  process.exit(1);
}
console.log("Build configuration OK");
