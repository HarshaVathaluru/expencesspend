# PaisaPilot Manual QA & 3D Acceptance Checklist

## Core & Financial Integrity
- [ ] Start app with single command `npm start` and verify `GET /health` returns `{ ok: true }`.
- [ ] Register a new account and verify a new expense can be added in under 10 seconds (both manually and via AI Quick Add).
- [ ] Add a split transaction across two categories and confirm dashboard category totals equal the exact sum.
- [ ] Add a refund and a self-transfer; confirm transfers do not inflate spending/income and refunds net cleanly.
- [ ] Import a CSV statement with duplicate UTR/rows; confirm duplicates are skipped and reported in batch history.
- [ ] Upload a PhonePe/bank PDF statement in Import Center and preview extracted rows.
- [ ] Test PhonePe notification simulator with a payment text and an OTP text; confirm OTP is ignored and unknown text goes to Reconciliation Review Queue.

## 3D Scenes, Transitions & Accessibility
- [ ] Confirm 3D Financial Orb, Budget Ring, and Coin Stacks render on Dashboard and update immediately when adding/editing/deleting an expense.
- [ ] Drag and click segments in the 3D Category Explorer and verify keyboard category chips update HUD values.
- [ ] Toggle `3D: Off` in the topbar or enable Reduced Motion in Settings; confirm smooth 2D SVG fallback renders with identical INR figures.
- [ ] Switch Dark/Light theme and verify contrast and legibility across all 14 screens.

## Brevo 11 PM Digest
- [ ] Confirm recipient email before enabling daily schedule.
- [ ] Inspect live HTML digest preview and verify full account numbers/private references are excluded.
- [ ] Configure `BREVO_API_KEY` + verified `BREVO_SENDER_EMAIL` in `.env` and test `Send Test Email`.
