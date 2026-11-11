# PaisaPilot Threat Model & Security Checklist

## Threat Model Summary
| Threat / Abuse Case | Mitigation Implemented |
|---|---|
| **IDOR (Cross-user data access)** | Every SQL query scopes `WHERE user_id = ?` using `req.user.id` from verified JWT; receipts stored in per-user `uploads/<userId>/` and verified before `sendFile`. |
| **Secret Leakage (Gemini, Brevo, Auth)** | Loaded exclusively on server via `.env`; `.env` is gitignored; `.env.example` contains placeholders only; `lib/logger.js` redacts keys, tokens, OTPs, and raw notification bodies. |
| **Credential / PIN / OTP Harvesting** | UI and parsers explicitly prohibit UPI PIN, OTP, and banking passwords; `parsePaymentNotificationText` detects OTP messages and discards them without storage. |
| **SQL Injection** | Parameterized prepared statements (`?` / `$1`) across both SQLite and PostgreSQL. |
| **XSS & CSP** | `helmet` Content-Security-Policy restricts scripts/objects to `'self'`; all client HTML rendering escapes user strings via `esc()`. |
| **Brute Force & Ingestion Abuse** | `express-rate-limit` enforced on `/auth/*`, `/ingestion/*`, `/ai/*`, and `/email/send-*`. |
| **Duplicate Financial Entries** | Unique partial index on `(user_id, import_source, external_id)` plus cautious fingerprint flagging (`possible_duplicate`, never auto-deleted). |
| **Floating-Point Rounding Errors** | All amounts stored and summed in integer paise (`toPaise`). |
