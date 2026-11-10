// UI <-> Edge Functions <-> database contract. Fails when the frontend calls something the backend does not provide.
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { read, walk, loadSchema, splitSelect } from "./_lib.mjs";

const schema = loadSchema();
const src = walk("src", (f) => /\.(ts|tsx)$/.test(f)).map((f) => [f, read(f)]);
const uniq = (arr) => [...new Set(arr)];
const used = (re) => uniq(src.flatMap(([, t]) => [...t.matchAll(re)].map((m) => m[1])));

const gateway = read("supabase/functions/api/index.ts");
const actions = new Map();
for (const line of gateway.split("\n")) {
  const m = /^\s*"([a-z_]+\.[a-z_]+)"\s*:(.*)$/.exec(line);
  if (m) actions.set(m[1], /rpc:\s*"(\w+)"/.exec(m[2])?.[1] ?? null);
}
const edgeFunctions = walk("supabase/functions", (f) => f.endsWith("/index.ts")).map((f) => f.split("/")[2]).filter((n) => !n.startsWith("_"));

test("gateway exposes actions", () => assert.ok(actions.size >= 30, `found ${actions.size}`));

test("every api(action) used by the UI exists in the gateway", () => {
  const missing = used(/\bapi(?:<[^>]*>)?\(\s*"([a-z_]+\.[a-z_]+)"/g).filter((a) => !actions.has(a));
  assert.deepEqual(missing, []);
});

test("every Edge Function invoked by the UI exists", () => {
  const names = used(/\bfn(?:<[^>]*>)?\(\s*"([\w-]+)"/g);
  assert.ok(names.length >= 2);
  assert.deepEqual(names.filter((n) => !edgeFunctions.includes(n)), []);
});

test("every database function called by the gateway or an Edge Function exists", () => {
  const direct = uniq(walk("supabase/functions", (f) => f.endsWith(".ts") && !f.includes("_tests")).flatMap((f) => [...read(f).matchAll(/\brpc(?:<[^>]*>)?\(\s*"(\w+)"/g)].map((m) => m[1])));
  const all = uniq([...actions.values()].filter(Boolean).concat(direct));
  assert.deepEqual(all.filter((n) => !schema.functions.has(n)), []);
});

test("the browser only calls database functions that are intentionally client-callable", () => {
  const rpcs = used(/\.rpc\(\s*"(\w+)"/g);
  const bad = rpcs.filter((n) => !schema.functions.has(n) || schema.closed.has(n));
  assert.deepEqual(bad, [], "client code must go through the api Edge Function for privileged operations");
});

test("every table/view read by the UI exists, and plain selected columns exist", () => {
  const problems = [];
  for (const [file, text] of src) {
    for (const m of text.matchAll(/(?<!storage)\.from\(\s*"(\w+)"\s*\)(\s*\.select\(\s*(?:"([^"]*)"|`([^`]*)`))?/g)) {
      const t = m[1];
      if (!schema.tables.has(t) && !schema.views.has(t)) { problems.push(`${file}: unknown table/view "${t}"`); continue; }
      const sel = m[3] ?? m[4];
      if (!sel || !schema.tables.has(t)) continue;
      for (const item of splitSelect(sel)) {
        if (item === "*" ) continue;
        const embed = /^(?:\w+:)?(\w+)(?:!\w+)?\(/.exec(item);
        if (embed) {
          const other = embed[1];
          const linked = schema.tables.has(other) && (new RegExp(`references\\s+public\\.${other}\\b`, "i").test(schema.tables.get(t).ddl) || new RegExp(`references\\s+public\\.${t}\\b`, "i").test(schema.tables.get(other).ddl));
          if (!linked) problems.push(`${file}: embed ${t} -> ${other} has no foreign key`);
          continue;
        }
        const col = item.split(":").pop().trim();
        if (/^\w+$/.test(col) && !schema.tables.get(t).cols.has(col.toLowerCase())) problems.push(`${file}: ${t}.${col} does not exist`);
      }
    }
  }
  assert.deepEqual(problems, []);
});

test("every storage bucket used by the UI is created by a migration", () => {
  const buckets = used(/storage\.from\(\s*"(\w+)"\s*\)/g);
  assert.ok(buckets.length >= 1);
  assert.deepEqual(buckets.filter((b) => !schema.buckets.has(b)), []);
});

test("every Edge Function has an explicit verify_jwt entry, and only self-authenticating ones disable it", () => {
  const cfg = read("supabase/config.toml");
  const entries = new Map([...cfg.matchAll(/\[functions\.([\w-]+)\]\s*\n\s*verify_jwt\s*=\s*(true|false)/g)].map((m) => [m[1], m[2] === "true"]));
  assert.deepEqual(edgeFunctions.filter((n) => !entries.has(n)), [], "missing config entry");
  assert.deepEqual([...entries.keys()].filter((n) => !edgeFunctions.includes(n)), [], "config entry without a function");
  const selfAuth = ["dpay-webhook", "reconcile-deposits", "ops-cron", "push-dispatch"];
  for (const [name, jwt] of entries) assert.equal(jwt, !selfAuth.includes(name), `${name}: verify_jwt=${jwt}`);
});

test("scheduled jobs call Edge Functions that exist", () => {
  const wf = read(".github/workflows/cron.yml");
  const called = uniq([...wf.matchAll(/FUNCTIONS_URL\s*\}\}\/([\w-]+)/g)].map((m) => m[1]));
  assert.ok(called.length >= 2);
  assert.deepEqual(called.filter((n) => !edgeFunctions.includes(n)), []);
  for (const n of called) assert.ok(existsSync(new URL(`../supabase/functions/${n}/index.ts`, import.meta.url)));
});
