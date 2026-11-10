// Shared helpers for the repository tests (no dependencies).
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = fileURLToPath(new URL("..", import.meta.url));
export const read = (p) => readFileSync(join(ROOT, p), "utf8");

export function walk(dir, accept = () => true, out = []) {
  for (const name of readdirSync(join(ROOT, dir))) {
    if (name === "node_modules" || name === "dist" || name === ".git") continue;
    const rel = join(dir, name);
    if (statSync(join(ROOT, rel)).isDirectory()) walk(rel, accept, out);
    else if (accept(rel)) out.push(rel);
  }
  return out;
}

/**
 * Minimal SQL tokenizer: removes comments, understands '…' strings, "…" identifiers and $tag$…$tag$ bodies (recursively),
 * and reports unterminated strings/comments/dollar quotes and unbalanced parentheses.
 * Returns { full, errors }: `full` is the SQL with comments removed (strings and dollar bodies preserved).
 */
export function lintSql(sql, name = "") {
  const errors = [];
  function scan(src, label) {
    let i = 0, parens = 0, out = "";
    while (i < src.length) {
      const c = src[i], n = src[i + 1];
      if (c === "-" && n === "-") { const e = src.indexOf("\n", i); i = e < 0 ? src.length : e; continue; }
      if (c === "/" && n === "*") {
        const e = src.indexOf("*/", i + 2);
        if (e < 0) { errors.push(`${name}: unterminated /* comment`); break; }
        i = e + 2; continue;
      }
      if (c === "'") {
        let j = i + 1;
        for (;;) {
          if (j >= src.length) { errors.push(`${name}: unterminated string literal`); break; }
          if (src[j] === "'") { if (src[j + 1] === "'") { j += 2; continue; } j++; break; }
          j++;
        }
        out += src.slice(i, j); i = j; continue;
      }
      if (c === '"') {
        const e = src.indexOf('"', i + 1);
        if (e < 0) { errors.push(`${name}: unterminated quoted identifier`); break; }
        out += src.slice(i, e + 1); i = e + 1; continue;
      }
      if (c === "$") {
        const m = /^\$([A-Za-z_][A-Za-z_0-9]*)?\$/.exec(src.slice(i, i + 64));
        if (m) {
          const tag = m[0], e = src.indexOf(tag, i + tag.length);
          if (e < 0) { errors.push(`${name}: unterminated dollar quote ${tag}`); break; }
          const inner = scan(src.slice(i + tag.length, e), tag);
          out += tag + inner + tag; i = e + tag.length; continue;
        }
      }
      if (c === "(") parens++;
      if (c === ")") { parens--; if (parens < 0) { errors.push(`${name}: unbalanced ")" in ${label || "top level"}`); parens = 0; } }
      out += c; i++;
    }
    if (parens !== 0) errors.push(`${name}: unbalanced parentheses (${parens > 0 ? "+" : ""}${parens}) in ${label || "top level"}`);
    return out;
  }
  const full = scan(sql, "");
  if (full.trim() && !full.trim().endsWith(";")) errors.push(`${name}: file does not end with a ";"`);
  return { full, errors };
}

/** Parses all migrations into a schema model used by the audit and contract tests. */
export function loadSchema() {
  const files = readdirSync(join(ROOT, "supabase/migrations")).filter((f) => f.endsWith(".sql")).sort();
  const lint = files.map((f) => ({ file: f, ...lintSql(read(`supabase/migrations/${f}`), f) }));
  const code = lint.map((l) => l.full).join("\n");

  const tables = new Map();   // name -> Set(columns)
  for (const m of code.matchAll(/create\s+table\s+(?:if\s+not\s+exists\s+)?(?:public\.)?(\w+)\s*\(([\s\S]*?)\n\);/gi)) {
    const cols = new Set();
    for (const raw of m[2].split("\n")) {
      const line = raw.trim().replace(/,$/, "");
      const mm = /^(\w+)\s+(?!primary\b|unique\b|check\b|constraint\b|foreign\b)(\w+)/i.exec(line);
      if (mm) cols.add(mm[1].toLowerCase());
    }
    tables.set(m[1].toLowerCase(), { cols, ddl: m[2] });
  }
  for (const m of code.matchAll(/alter\s+table\s+(?:if\s+exists\s+)?(?:public\.)?(\w+)\s+add\s+column\s+(?:if\s+not\s+exists\s+)?(\w+)/gi)) {
    tables.get(m[1].toLowerCase())?.cols.add(m[2].toLowerCase());
  }
  const views = new Set([...code.matchAll(/create\s+(?:or\s+replace\s+)?view\s+(?:public\.)?(\w+)/gi)].map((m) => m[1].toLowerCase()));
  const rls = new Set([...code.matchAll(/alter\s+table\s+(?:if\s+exists\s+)?(?:public\.)?(\w+)\s+enable\s+row\s+level\s+security/gi)].map((m) => m[1].toLowerCase()));

  const functions = new Map();  // name -> { definer, searchPath, trigger, args }
  for (const m of code.matchAll(/create\s+(?:or\s+replace\s+)?function\s+(?:public\.)?(\w+)\s*\(([\s\S]*?)\)\s*([\s\S]*?)\bas\s+\$(\w*)\$/gi)) {
    const header = m[3].toLowerCase();
    functions.set(m[1].toLowerCase(), {
      args: m[2], definer: header.includes("security definer"), searchPath: header.includes("search_path"), trigger: /returns\s+trigger/.test(header),
    });
  }
  // Functions closed to browser roles: explicit REVOKE statements and the name-list loops used by the migrations.
  const closed = new Set();
  for (const m of code.matchAll(/revoke\s+all\s+on\s+function\s+(?:public\.)?(\w+)\s*\([^)]*\)\s+from\s+([\w,\s]+);/gi)) {
    const roles = m[2].toLowerCase();
    if (roles.includes("anon") && roles.includes("authenticated")) closed.add(m[1].toLowerCase());
  }
  for (const m of code.matchAll(/proname\s+in\s*\(([\s\S]*?)\)\s*loop([\s\S]*?)end\s+loop/gi)) {
    if (/revoke\s+all\s+on\s+function/i.test(m[2]) && /authenticated/i.test(m[2])) for (const n of m[1].matchAll(/'(\w+)'/g)) closed.add(n[1].toLowerCase());
  }
  const buckets = new Set([...code.matchAll(/storage\.buckets\s*\([^)]*\)\s*values([\s\S]*?);/gi)].flatMap((m) => [...m[1].matchAll(/\(\s*'(\w+)'/g)].map((x) => x[1])));
  return { files, lint, code, tables, views, rls, functions, closed, buckets };
}

/** Splits a PostgREST select list on top-level commas. */
export function splitSelect(sel) {
  const out = []; let depth = 0, cur = "";
  for (const ch of sel) {
    if (ch === "(") depth++; if (ch === ")") depth--;
    if (ch === "," && depth === 0) { out.push(cur.trim()); cur = ""; } else cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}
