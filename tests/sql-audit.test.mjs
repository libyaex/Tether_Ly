// Static audit of the database layer. This does NOT execute SQL — see docs/TESTING.md for the Postgres test run.
import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync } from "node:fs";
import { loadSchema, lintSql, read, ROOT } from "./_lib.mjs";
import { join } from "node:path";

const s = loadSchema();
const ALLOWED_CLIENT = ["has_permission", "mark_all_notifications_read", "my_permissions", "my_summary", "preview_calc"];

test("migrations are numbered consecutively", () => {
  s.files.forEach((f, i) => assert.ok(f.startsWith(String(i + 1).padStart(4, "0") + "_"), `${f} is out of sequence`));
});

test("SQL files are structurally sound (strings, comments, dollar quotes and parentheses balance)", () => {
  const errors = s.lint.flatMap((l) => l.errors);
  for (const f of readdirSync(join(ROOT, "supabase/tests")).filter((x) => x.endsWith(".sql"))) errors.push(...lintSql(read(`supabase/tests/${f}`), `tests/${f}`).errors);
  assert.deepEqual(errors, []);
});

test("every table has row level security enabled", () => {
  assert.deepEqual([...s.tables.keys()].filter((t) => !s.rls.has(t)), []);
});

test("every SECURITY DEFINER function pins search_path", () => {
  assert.deepEqual([...s.functions].filter(([, f]) => f.definer && !f.searchPath).map(([n]) => n), []);
});

test("privileged functions are closed to anon/authenticated (only the allow-list is client-callable)", () => {
  const open = [...s.functions].filter(([n, f]) => f.definer && !f.trigger && !s.closed.has(n) && !ALLOWED_CLIENT.includes(n)).map(([n]) => n);
  assert.deepEqual(open, []);
  for (const n of ALLOWED_CLIENT) assert.ok(s.functions.has(n), `allow-listed function ${n} does not exist`);
});

test("money is never stored in floating point or money columns", () => {
  const bad = [];
  for (const [t, { ddl }] of s.tables) for (const line of ddl.split("\n")) {
    const m = /^\s*(\w+)\s+(float4|float8|real|double|money)\b/i.exec(line);
    if (m) bad.push(`${t}.${m[1]} is ${m[2]}`);
  }
  assert.deepEqual(bad, []);
});

test("the ledger is append-only and balanced", () => {
  for (const name of ["ledger_entries_immutable", "ledger_entries_no_truncate", "ledger_entries_balanced"]) assert.ok(s.code.includes(name), `${name} trigger missing`);
});

test("self-authenticating endpoints actually authenticate", () => {
  for (const fn of ["ops-cron", "push-dispatch", "reconcile-deposits"]) assert.match(read(`supabase/functions/${fn}/index.ts`), /requireCronSecret\(/, fn);
  const hook = read("supabase/functions/dpay-webhook/index.ts");
  assert.match(hook, /webhookSecrets\(/);
  assert.match(hook, /signature/i);
});

test("provider secrets live only in Edge Function environment variables", () => {
  const hits = [];
  for (const f of ["supabase/functions", "src", "supabase/migrations"].flatMap((d) => walk2(d))) {
    if (/dpay_(sandbox|live)_(token|webhook_secret)/i.test(read(f))) hits.push(f);
  }
  assert.deepEqual(hits, []);
});

function walk2(dir) {
  const out = [];
  for (const e of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
    const rel = join(dir, e.name);
    if (e.isDirectory()) out.push(...walk2(rel)); else if (/\.(ts|tsx|sql)$/.test(e.name) && !rel.includes("_tests")) out.push(rel);
  }
  return out;
}
