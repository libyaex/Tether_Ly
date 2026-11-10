# Libya USDT Exchange

منصة لشراء وبيع USDT مقابل الدينار الليبي، مع شحن المحفظة عبر بوابة الدفع DPay وإدارة داخلية كاملة للعمليات والامتثال.

**Libya USDT Exchange** — a web/PWA platform to buy and sell USDT against LYD, fund wallets through the DPay hosted checkout, and run operations, compliance and support from a staff console.

## What is in this repository

| Path | Purpose |
| --- | --- |
| `src/` | React 19 + TypeScript + Vite frontend (customer app, public site, staff console). Arabic RTL. |
| `public/` | PWA manifest, service worker, offline page, icons, hosting headers/redirects. |
| `supabase/migrations/` | The database: schema, row-level security, ledger, RPCs. Apply in order. |
| `supabase/functions/` | Edge Functions: `api` (staff/customer gateway), `create-deposit`, `verify-deposit`, `dpay-webhook`, `reconcile-deposits`, `dpay-check`, `ops-cron`, `push-dispatch`, `export-csv`. |
| `supabase/bootstrap/` | One-time operator script that creates the first super admin. |
| `supabase/tests/` | SQL tests (run against a real Postgres, see `docs/TESTING.md`). |
| `tests/` | Repository tests: decimal maths, UI↔backend contract, database audit, no-simulation guard. |
| `scripts/` | Build-time checks (`check-env`) and SEO files (`seo`). |
| `.github/workflows/` | CI (tests, typecheck, build, SQL tests) and the 5-minute scheduler. |
| `docs/` | `DEPLOYMENT.md` (go live), `TESTING.md`, `SECURITY.md`. |

## Quick start (development)

Requirements: Node.js 20.19+ (22 recommended), a Supabase project.

```bash
npm install
cp .env.example .env.local      # fill VITE_SUPABASE_URL, VITE_SUPABASE_ANON_KEY, VITE_SITE_URL
npm run dev                     # http://localhost:3000
```

Without the Supabase variables the app shows a configuration notice and nothing else — there is no demo mode.

## Scripts

| Command | What it does |
| --- | --- |
| `npm run dev` | Development server. |
| `npm run build` | Checks configuration (`check-env`), builds to `dist/`, writes `robots.txt` and `sitemap.xml`. |
| `npm run typecheck` | `tsc --noEmit`. |
| `npm test` | Repository tests (`tests/` and the Edge Function unit tests). |
| `npm run preview` | Serves the production build locally. |

## Deployment

See [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md). In short: apply migrations, set Edge Function secrets, deploy functions, set the frontend variables, build and host `dist/`, create the first super admin, configure the DPay webhook, and set the scheduler secrets.

## Security

See [docs/SECURITY.md](docs/SECURITY.md). Provider tokens and webhook secrets exist only as Edge Function secrets; the browser holds only the public anon key; all money movement is recorded in an append-only double-entry ledger and changed only through server-side functions.

## Status and limits

* Everything in this repository is intended for production. The following must be verified in your own environment before launch, because they require credentials or services not available to the authors of this code: the database migrations and SQL tests on a real Postgres, the Edge Functions against your Supabase project, the DPay sandbox and live flows, and the push-notification and PWA install behaviour on real devices.
* The company's net profit is intentionally not calculated (it needs a USDT cost basis and network cost ledger that the system does not yet record); the financial report shows volumes, fees and reconciliation status instead.

## License

Proprietary. All rights reserved.
