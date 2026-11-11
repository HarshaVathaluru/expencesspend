# PaisaPilot API Documentation (v1)

Base URL: `/api/v1` (same origin as UI). Authenticated routes require either the `paisapilot_session` HttpOnly cookie or `Authorization: Bearer <token>`.

## Health
- `GET /health` — Returns `{ ok, app, env, database, ai: { enabled, mode }, brevoConfigured, uptimeSeconds }`.

## Authentication (`/api/v1/auth`)
- `POST /auth/register` — `{ email, name, password, timezone? }` → `201 { user, token }`
- `POST /auth/login` — `{ email, password }` → `200 { user, token }`
- `POST /auth/logout` — Clears session cookie.
- `GET /auth/me` — Returns current user & `settings`.
- `POST /auth/password-reset/request` — `{ email }`
- `POST /auth/password-reset/confirm` — `{ token, newPassword }`
- `DELETE /auth/account` — `{ password }` Permanently deletes account & user data.

## Transactions & Dashboard (`/api/v1`)
- `GET /dashboard/summary?startDate&endDate&monthKey` — Authoritative totals in integer `paise`, categories, dailyTrend, topMerchants, paymentMethods, reconciliationCounts.
- `GET /transactions?q&type&categoryId&paymentMethod&importSource&reconciliationStatus&startDate&endDate&minPaise&maxPaise&sortBy&sortDir&page&limit`
- `POST /transactions` — `{ amount|amountPaise, type, merchant, localDate, categoryId, paymentMethod, referenceId, notes, tags, splits? }`
- `GET /transactions/:id`, `PUT /transactions/:id` (`learnRule: true` saves merchant rule), `DELETE /transactions/:id`
- `POST /transactions/:id/receipt` (multipart `receipt` ≤5MB PNG/JPG/WebP/PDF) & `GET /transactions/:id/receipt`
- `POST /transactions/demo-seed` & `DELETE /transactions/demo-seed`

## Ingestion & Reconciliation (`/api/v1`)
- `GET /ingestion/architecture` — Honest PhonePe/UPI capability statement.
- `GET /ingestion/connections`, `POST /ingestion/connections`, `PATCH /ingestion/connections/:id`, `DELETE /ingestion/connections/:id`
- `POST /ingestion/webhook` — Authenticated via `X-Webhook-Token` for Android Companion app.
- `POST /ingestion/events` — Session-authenticated notification/SMS ingestion.
- `POST /ingestion/import/csv-preview`, `POST /ingestion/import/pdf-preview`, `POST /ingestion/import/commit`, `GET /ingestion/batches`
- `GET /reconciliation?monthKey` & `POST /reconciliation/resolve-event/:id`

## Planning, AI, Reports, Email & Settings
- `GET /budgets?monthKey`, `PUT /budgets`
- `GET /goals`, `POST /goals`, `PATCH /goals/:id`, `DELETE /goals/:id`
- `GET /recurring`, `POST /recurring`, `POST /recurring/:id/record`, `DELETE /recurring/:id`
- `GET /rules`, `POST /rules`, `DELETE /rules/:id`
- `GET /insights?monthKey`
- `GET /ai/status`, `POST /ai/parse-expense`, `POST /ai/suggest-category`, `POST /ai/ask`
- `GET /reports/export/csv`, `GET /reports/export/pdf`, `GET /reports/export/json`
- `GET /email/settings`, `PUT /email/settings`, `POST /email/verify/request`, `POST /email/verify/confirm`, `GET /email/preview`, `POST /email/send-test`, `POST /email/send-today`
- `POST /cron/daily-reports` (requires `X-Cron-Secret`) & `POST /webhooks/brevo`
- `GET /settings`, `PUT /settings`, `GET /audit-logs`
