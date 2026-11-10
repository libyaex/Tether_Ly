# Security model

* **Browser** holds only the public anon key and the user's own session. Privileged operations go through the `api` Edge Function, which checks the caller's staff permission on the server.
* **Money** is recorded in a double-entry ledger that is append-only (triggers block UPDATE/DELETE). Wallet balances (`wallets`) are a cached view that must equal the ledger; `v_wallet_ledger_mismatch` finds any difference and the health page reports it.
* **Payments**: DPay webhooks are accepted only with a valid HMAC signature over the raw body and a timestamp within five minutes; sandbox and live events are kept apart; a webhook never credits an amount or reference that differs from the session created by the server; mismatches are quarantined for staff review (see *Payment notices* on the health page).
* **Secrets**: provider tokens, webhook secrets and the service-role key exist only as Edge Function environment variables. They are never stored in the database, shipped to the browser, or committed. `check-env` refuses to build with a service-role key.
* **Database**: RLS is enabled on every table. SECURITY DEFINER functions pin `search_path`. Functions that move money or change roles are not executable by `anon` or `authenticated`.
* **Staff**: permissions are role-based (`user_roles`, `role_permissions`); the only super-admin grant path is the bootstrap script (once) or an existing super admin. Staff actions are recorded in `audit_logs`; review coverage for each action before launch.
* **Headers**: strict CSP (`script-src 'self'`), HSTS, no framing, restrictive permissions policy (see `public/_headers` and `vercel.json`).

## Reporting

Report vulnerabilities privately to the operator of this deployment. Do not open public issues for security problems.
