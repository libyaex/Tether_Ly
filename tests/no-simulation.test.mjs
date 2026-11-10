// Guards against demo/mock/simulated code and leaked secrets coming back into the repository.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { read, walk, ROOT } from "./_lib.mjs";
import { join } from "node:path";

const textFiles = walk(".", (f) => /\.(ts|tsx|mjs|json|md|sql|toml|yml|yaml|html|css|webmanifest|example|sh|py)$/.test(f) || /(^|\/)\.(env|gitignore)/.test(f))
  .filter((f) => !f.startsWith("tests/fixtures") && !f.includes("_tests") && f !== "package-lock.json");

test("no demo / mock / simulated code in the application", () => {
  const forbidden = /mockEngine|createMockSupabase|switchDemoUser|DEMO_USERS|DpaySandboxSimulator|RoleSwitcher|open-payment-session|verify-payment-session|completeSuccessPayment/;
  const hits = walk("src", (f) => /\.(ts|tsx)$/.test(f)).filter((f) => forbidden.test(read(f)));
  assert.deepEqual(hits, []);
});

test("the browser never calls apply_checkout or other server-only payment functions", () => {
  const hits = walk("src", (f) => /\.(ts|tsx)$/.test(f)).filter((f) => /rpc\(\s*"(apply_checkout|attach_checkout_session|create_deposit_order)"/.test(read(f)));
  assert.deepEqual(hits, []);
});

test("the app refuses to run without real configuration (no silent fallback)", () => {
  const t = read("src/lib/supabase.ts");
  assert.match(t, /export const configured = Boolean\(/);
  assert.doesNotMatch(t, /configured\s*=\s*true/);
  assert.match(read("src/App.tsx"), /if \(!configured\) return <NotConfigured \/>/);
});

test("no leftover AI-studio / duplicate project folders or files", () => {
  for (const p of ["extracted_app", "libya-usdt-exchange", ".aistudio", "metadata.json", "public/assets", "scripts/run-readiness-tests.mjs", "scripts/run-sync-tests.mjs"])
    assert.equal(existsSync(join(ROOT, p)), false, `${p} must not exist`);
});

test("public/ contains only deliberate static assets", () => {
  const allowed = /^public\/(favicon\.svg|manifest\.webmanifest|offline\.html|sw\.js|_headers|_redirects|icons\/[\w-]+\.png)$/;
  assert.deepEqual(walk("public").filter((f) => !allowed.test(f)), []);
});

test("no unused or template dependencies", () => {
  const pkg = JSON.parse(read("package.json"));
  const all = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies });
  assert.deepEqual(all.filter((d) => ["express", "@google/genai", "dotenv", "motion", "lucide-react", "tsx", "autoprefixer", "esbuild"].includes(d)), []);
});

test("no secrets committed", () => {
  const patterns = [
    [/eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}/, "JWT"],
    [/sb_secret_[A-Za-z0-9_-]{10,}/, "Supabase secret key"],
    [/whsec_[A-Za-z0-9]{16,}/, "webhook secret"],
    [/BEGIN (RSA |EC )?PRIVATE KEY/, "private key"],
    [/(SERVICE_ROLE_KEY|VAPID_PRIVATE_KEY|CRON_SECRET|DPAY_TOKEN_[A-Z]+|DPAY_WEBHOOK_SECRET_[A-Z]+)[ \t]*=[ \t]*['"]?[A-Za-z0-9._-]{16,}/, "assigned secret"],
  ];
  const hits = [];
  for (const f of textFiles) { const t = read(f); for (const [re, label] of patterns) if (re.test(t)) hits.push(`${f}: ${label}`); }
  assert.deepEqual(hits, []);
});

test("no real .env files are present", () => {
  assert.deepEqual(walk(".", (f) => /(^|\/)\.env(\.|$)/.test(f) && !f.endsWith(".example")), []);
});
