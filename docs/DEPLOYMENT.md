# Deployment guide

Order matters. Each step lists what it depends on.

## 1. Supabase project

1. Create a project (region close to your users). Note the **Project URL** and the **anon / publishable key** (Settings → API).
2. Enable **Google** sign-in (Authentication → Providers) if you use the Google button; add your site URL to *Redirect URLs*.
3. Link the repository: `supabase link --project-ref <ref>`.

## 2. Database

```bash
supabase db push            # applies supabase/migrations/0001 … 00NN in order
```

Do not edit an applied migration; add a new numbered one.

Optional but recommended before going live: run the SQL tests against a disposable database, as described in `docs/TESTING.md`.

## 3. Edge Function secrets

Copy `supabase/functions/.env.example` to `supabase/functions/.env` (git-ignored), fill it, then:

```bash
supabase secrets set --env-file supabase/functions/.env
```

Required for payments: `APP_BASE_URL`, `ALLOWED_ORIGINS`, `CRON_SECRET`, `DPAY_TOKEN_SANDBOX` / `DPAY_TOKEN_LIVE`, `DPAY_WEBHOOK_SECRET_SANDBOX` / `DPAY_WEBHOOK_SECRET_LIVE`. Use the sandbox pair first. `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` are provided by Supabase automatically; never copy the service-role key into any file in this repository or into the frontend.

Generate `CRON_SECRET` with `openssl rand -hex 32`.

## 4. Deploy Edge Functions

```bash
supabase functions deploy     # deploys all functions; per-function JWT settings come from supabase/config.toml
```

`supabase/config.toml` disables JWT verification only for functions that authenticate themselves (`dpay-webhook`, `reconcile-deposits`, `ops-cron`, `push-dispatch`). Confirm the Dashboard shows the same.

## 5. First super admin (one time)

1. Open the site and register the operator account normally (email + password or Google).
2. Run:
   ```bash
   psql "$SUPABASE_DB_URL" -v admin_email='operator@example.com' -f supabase/bootstrap/first_super_admin.sql
   ```
   The script refuses to run if a super admin already exists. Afterwards, grant every other role from **Staff** in the admin console.

## 6. Frontend build and hosting

Set the build-time variables in your host (Netlify, Vercel, Cloudflare Pages, or any static host):

| Variable | Value |
| --- | --- |
| `VITE_SUPABASE_URL` | `https://<ref>.supabase.co` |
| `VITE_SUPABASE_ANON_KEY` | the anon / publishable key |
| `VITE_SITE_URL` | the public https origin, no trailing slash |
| `VITE_VAPID_PUBLIC_KEY` | optional, for web push |

Build command `npm run build`, output directory `dist`. The build fails if these are missing or if a service-role key is supplied. The repository ships `public/_headers`, `public/_redirects` (Netlify / Cloudflare) and `vercel.json` (Vercel) with the security headers, the SPA fallback and cache rules; use the file that matches your host.

## 7. Scheduler (required)

The `cron` workflow calls `reconcile-deposits` and `ops-cron` every five minutes. In GitHub → Settings → Secrets and variables → Actions, add:

* `SUPABASE_FUNCTIONS_URL` = `https://<ref>.supabase.co/functions/v1`
* `CRON_SECRET` = the same value as the Edge Function secret

Run the workflow manually once (`workflow_dispatch`) and check that `/admin/health` shows fresh results. Without this, payment reconciliation and health alerts do not run.

## 8. DPay

1. In the DPay dashboard, create the **sandbox** integration, copy the token and webhook secret into the Edge Function secrets, and register the webhook URL `https://<ref>.supabase.co/functions/v1/dpay-webhook`.
2. In the admin console → Settings → DPay: keep mode `sandbox`, enable top-ups, and set the min/max limits. Run **Check connection with DPay**.
3. Make a test top-up. Confirm the deposit becomes `paid`, the wallet is credited once, and a duplicate webhook is ignored.
4. Only after DPay confirms the live activation in writing, a super admin sets `payments.dpay_live_approved` (Settings), then switches the mode to `live` after the live tokens are configured. The app refuses to switch to live without this approval.

## 9. Go-live checklist

* [ ] All migrations applied; SQL tests passed on a disposable database.
* [ ] Edge Function secrets set; `dpay-check` returns OK in sandbox and live.
* [ ] Scheduler runs; `/admin/health` shows all checks fresh.
* [ ] First super admin created; MFA (TOTP) enabled for every staff account in Supabase Auth. The application does not enforce MFA itself, so this is an operating rule.
* [ ] Terms, privacy, fees and risk pages reviewed by your legal adviser (their text is placeholder content in this repository until you approve it).
* [ ] Backups enabled (Supabase → Database → Backups) and a restore was tested.
* [ ] Monitoring/alerts configured for the scheduler failures and for `/admin/health` degraded states.
