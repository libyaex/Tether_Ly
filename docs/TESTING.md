# Testing

## 1. Repository tests — `npm test`

Run with Node 20.19+ and no database. They cover:

| File | What it proves |
| --- | --- |
| `tests/decimal.test.mjs` | Price/fee maths match an independent Python `Decimal` reference on 1,800 generated vectors (`tests/fixtures/`), input cleaning, validation. |
| `tests/contract.test.mjs` | Every `api(...)`, `fn(...)`, `.from(...)`, `.select(...)`, `.rpc(...)` and storage bucket the UI uses exists in the gateway, Edge Functions or migrations; every Edge Function has an explicit JWT setting; the scheduler calls real functions. |
| `tests/sql-audit.test.mjs` | Migrations are sequential and structurally balanced; every table has RLS; every SECURITY DEFINER function pins `search_path`; privileged functions are closed to browsers; no float money columns; the ledger is append-only; webhook/cron endpoints authenticate; provider secrets are not in code. |
| `tests/no-simulation.test.mjs` | No demo/mock code, no leaked secrets, no real `.env`, `public/` contains only deliberate assets, no unused dependencies. |
| `supabase/functions/_tests/*.test.mjs` | Webhook signature handling, DPay payload normalisation, the payment lifecycle state machine. |

The SQL audit is static: it reads the migrations, it does not execute them. Execution is covered by the next section.

## 2. Database tests — requires Postgres 15+ with Supabase auth schema

`supabase/tests/*.test.sql` run inside a transaction that is rolled back. They are executed by CI (`database` job, using `supabase start`) and can be run locally:

```bash
supabase start
supabase db reset
for f in supabase/tests/*.test.sql; do psql "postgresql://postgres:postgres@127.0.0.1:54322/postgres" -v ON_ERROR_STOP=1 -f "$f"; done
```

A failing `ASSERT` stops the run with the message. These tests were written against the migrations but had not been executed when this repository was assembled; treat their first run as part of the launch checklist and fix any small issues it reveals.

## 3. Build and types

```bash
npm run typecheck
npm run build
```

## 4. Manual end-to-end checklist (sandbox)

1. Register → confirm email → complete profile → account becomes active.
2. Top up 100 LYD through DPay sandbox → wallet credited once.
3. Buy USDT with LYD → staff process it → order completes, ledger balanced.
4. Sell USDT for LYD → deposit detected → payout approved → order completes.
5. Open a support ticket; staff reply; customer sees the reply and a notification.
6. Staff: grant/revoke a role, adjust a rate, export a CSV, see the audit log entry for each.
7. Install the PWA on Android and iOS; confirm the offline page and the shortcuts.
