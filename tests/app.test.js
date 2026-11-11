const test = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

process.env.NODE_ENV = 'test';
process.env.DATABASE_URL = 'sqlite::memory:';
process.env.AUTH_SECRET = 'test-auth-secret-paisapilot-unit-tests-12345';
process.env.BREVO_API_KEY = '';
process.env.GEMINI_API_KEY = '';
process.env.CRON_SECRET = 'test-cron-secret';

const db = require('../lib/db');
const { createApp } = require('../server');
const { toPaise, getDatePartsInTz, shiftDate } = require('../lib/money');
const { tickDailyScheduler } = require('../lib/scheduler');

let app;
let agentA;
let agentB;
let catFoodId;
let catGroceriesId;
let txCreatedId;

test.before(async () => {
  await db.initDatabase('sqlite::memory:');
  app = createApp();
  agentA = request.agent(app);
  agentB = request.agent(app);
});

test.after(async () => {
  await db.closeDatabase();
});

test('1. Exact paise arithmetic avoids floating-point drift', () => {
  assert.equal(toPaise('19.99'), 1999);
  assert.equal(toPaise('1000.50'), 100050);
  assert.equal(toPaise('₹1,250.25'), 125025);
  assert.equal(toPaise('0.1') + toPaise('0.2'), 30);
});

test('2. Health endpoint reports readiness without leaking secrets', async () => {
  const res = await request(app).get('/health');
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.database.ok, true);
  const bodyStr = JSON.stringify(res.body);
  if (process.env.GEMINI_API_KEY) assert.ok(!bodyStr.includes(process.env.GEMINI_API_KEY));
  assert.ok(!bodyStr.includes(process.env.AUTH_SECRET));
});

test('3. User registration, login, and categories seeding', async () => {
  const regA = await agentA.post('/api/v1/auth/register').send({
    email: 'alice@example.com',
    name: 'Alice',
    password: 'Password123!'
  });
  assert.equal(regA.status, 201);
  assert.equal(regA.body.user.email, 'alice@example.com');

  const regB = await agentB.post('/api/v1/auth/register').send({
    email: 'bob@example.com',
    name: 'Bob',
    password: 'Password123!'
  });
  assert.equal(regB.status, 201);

  const cats = await agentA.get('/api/v1/categories');
  assert.equal(cats.status, 200);
  catFoodId = cats.body.categories.find((c) => c.slug === 'food').id;
  catGroceriesId = cats.body.categories.find((c) => c.slug === 'groceries').id;
  assert.ok(catFoodId && catGroceriesId);
});

test('4. Transactions CRUD, splits, refunds, transfers, and IDOR isolation', async () => {
  // Create expense
  const tx1 = await agentA.post('/api/v1/transactions').send({
    amount: '420.50',
    type: 'expense',
    merchant: 'Swiggy',
    localDate: '2026-11-10',
    categoryId: catFoodId,
    paymentMethod: 'PhonePe UPI'
  });
  assert.equal(tx1.status, 201);
  txCreatedId = tx1.body.transaction.id;
  assert.equal(tx1.body.transaction.amount_paise, 42050);

  // Split transaction
  const txSplit = await agentA.post('/api/v1/transactions').send({
    amount: '1000.00',
    type: 'expense',
    merchant: 'Blinkit Mega Mart',
    localDate: '2026-11-10',
    paymentMethod: 'PhonePe UPI',
    splits: [
      { categoryId: catGroceriesId, amount: '700.00' },
      { categoryId: catFoodId, amount: '300.00' }
    ]
  });
  assert.equal(txSplit.status, 201);
  assert.equal(txSplit.body.transaction.is_split, 1);

  // Refund & self-transfer & income
  await agentA.post('/api/v1/transactions').send({ amount: '120.50', type: 'refund', merchant: 'Swiggy Refund', localDate: '2026-11-10', categoryId: catFoodId });
  await agentA.post('/api/v1/transactions').send({ amount: '5000.00', type: 'transfer', merchant: 'Own Savings Account', localDate: '2026-11-10', paymentMethod: 'Bank Transfer' });
  await agentA.post('/api/v1/transactions').send({ amount: '50000.00', type: 'income', merchant: 'Salary', localDate: '2026-11-10', paymentMethod: 'Bank Transfer' });

  // Dashboard summary reflects exact paise: (42050 + 100000) - 12050 = 130000 paise (₹1300.00); transfer excluded!
  const sumRes = await agentA.get('/api/v1/dashboard/summary?monthKey=2026-11');
  assert.equal(sumRes.status, 200);
  assert.equal(sumRes.body.summary.netSpentPaise, 130000);
  assert.equal(sumRes.body.summary.incomePaise, 5000000);
  assert.equal(sumRes.body.summary.transferPaise, 500000);

  // IDOR check: Bob cannot read or delete Alice's transaction
  const idorGet = await agentB.get(`/api/v1/transactions/${txCreatedId}`);
  assert.equal(idorGet.status, 404);
  const idorDel = await agentB.delete(`/api/v1/transactions/${txCreatedId}`);
  assert.equal(idorDel.status, 404);
});

test('5. PhonePe notification parser ignores OTPs, parses payments, queues unknown formats', async () => {
  const otpRes = await agentA.post('/api/v1/ingestion/events').send({
    provider: 'android_notification',
    rawText: 'Your PhonePe OTP is 492810. Do not share with anyone.'
  });
  assert.equal(otpRes.status, 201);
  assert.equal(otpRes.body.status, 'ignored');

  const payRes = await agentA.post('/api/v1/ingestion/events').send({
    provider: 'android_notification',
    rawText: 'Paid ₹250.00 to Metro Rail via PhonePe UPI. UTR PP99283711',
    externalId: 'PP99283711'
  });
  assert.equal(payRes.status, 201);
  assert.equal(payRes.body.status, 'processed');
  assert.equal(payRes.body.transaction.amount_paise, 25000);

  const unkRes = await agentA.post('/api/v1/ingestion/events').send({
    provider: 'android_notification',
    rawText: 'Something unusual happened with your wallet alert'
  });
  assert.equal(unkRes.status, 201);
  assert.equal(unkRes.body.status, 'needs_review');
});

test('6. CSV import preview & idempotent commit', async () => {
  const csvText = 'Date,Merchant,Amount,Type,Reference\n2026-11-09,Zomato,350.00,Debit,UTR-Z1\n2026-11-09,Zomato,350.00,Debit,UTR-Z1';
  const prev = await agentA.post('/api/v1/ingestion/import/csv-preview').send({ csvText });
  assert.equal(prev.status, 200);
  assert.equal(prev.body.totalRows, 2);

  const commit = await agentA.post('/api/v1/ingestion/import/commit').send({
    rows: prev.body.rows,
    mapping: prev.body.suggestedMapping,
    sourceType: 'csv',
    filename: 'test.csv'
  });
  assert.equal(commit.status, 200);
  assert.equal(commit.body.importedRows, 1);
  assert.equal(commit.body.duplicateRows, 1);
});

test('7. Budgets, Goals, Recurring, AI Guardrail, Brevo Gate, and Exports', async () => {
  const bRes = await agentA.put('/api/v1/budgets').send({ monthKey: '2026-11', overallLimit: '30000' });
  assert.equal(bRes.status, 200);

  const gRes = await agentA.post('/api/v1/goals').send({ name: 'Laptop', target: '80000', current: '10000' });
  assert.equal(gRes.status, 201);

  const rRes = await agentA.post('/api/v1/recurring').send({ title: 'Fiber', merchant: 'Airtel', amount: '999', cadence: 'monthly' });
  assert.equal(rRes.status, 201);

  const recPay = await agentA.post(`/api/v1/recurring/${rRes.body.rule.id}/record`);
  assert.equal(recPay.status, 200);

  // AI Investment guardrail
  const aiRes = await agentA.post('/api/v1/ai/ask').send({ question: 'Which stock should I invest in?' });
  assert.equal(aiRes.status, 200);
  assert.equal(aiRes.body.source, 'policy_guardrail');

  // Cannot enable daily email before confirming email
  const unverifiedEnable = await agentA.put('/api/v1/email/settings').send({ daily_email_enabled: true });
  assert.equal(unverifiedEnable.status, 400);

  // Test email fails honestly when BREVO_API_KEY is missing
  const testEmail = await agentA.post('/api/v1/email/send-test');
  assert.equal(testEmail.status, 502);
  assert.equal(testEmail.body.ok, false);

  // Exports work
  const csvOut = await agentA.get('/api/v1/reports/export/csv?startDate=2026-11-01&endDate=2026-11-30');
  assert.equal(csvOut.status, 200);
  assert.ok(csvOut.text.includes('Swiggy'));

  const pdfOut = await agentA.get('/api/v1/reports/export/pdf?startDate=2026-11-01&endDate=2026-11-30');
  assert.equal(pdfOut.status, 200);
  assert.equal(pdfOut.headers['content-type'], 'application/pdf');
});

test('8. Payment image preview, 4-day summary cadence, and immediate budget exceeded alert', async () => {
  // 8a. Image preview validates type and returns structured draft for receipt PNG
  const badImg = await agentA
    .post('/api/v1/ingestion/import/image-preview')
    .attach('file', Buffer.from('not-an-image'), { filename: 'bad.txt', contentType: 'text/plain' });
  assert.equal(badImg.status, 400);

  const pngStub = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010802000000907753de', 'hex');
  const imgPrev = await agentA
    .post('/api/v1/ingestion/import/image-preview')
    .attach('file', pngStub, { filename: 'phonepe-receipt.png', contentType: 'image/png' });
  assert.equal(imgPrev.status, 200);
  assert.equal(imgPrev.body.filename, 'phonepe-receipt.png');
  assert.ok(imgPrev.body.draft);

  // 8b. 4-day email preview builds 4-day window
  const prevRes = await agentA.get('/api/v1/email/preview?date=2026-11-10');
  assert.equal(prevRes.status, 200);
  assert.equal(prevRes.body.summary.windowDays, 4);
  assert.equal(prevRes.body.summary.startDate, '2026-11-07');
  assert.equal(prevRes.body.summary.endDate, '2026-11-10');
  assert.ok(prevRes.body.subject.includes('4-Day Expenses'));

  // 8c. Scheduler respects 4-day interval (skips if last sent < 4 days ago)
  const me = await agentA.get('/api/v1/auth/me');
  const userIdA = me.body.user.id;
  const today = getDatePartsInTz(new Date(), 'Asia/Kolkata').localDate;
  const twoDaysAgo = shiftDate(today, -2);
  await db.run(
    `UPDATE user_settings SET email_verified = 1, daily_email_enabled = 1, daily_email_time = '00:00' WHERE user_id = ?`,
    [userIdA]
  );
  await db.run(
    `INSERT INTO daily_reports (id, user_id, report_date, timezone, idempotency_key, summary_json, html_preview, status, created_at)
     VALUES (?, ?, ?, 'Asia/Kolkata', ?, '{}', '', 'sent', ?)`,
    ['rep_recent_2d', userIdA, twoDaysAgo, `${userIdA}:${twoDaysAgo}:daily_summary`, new Date().toISOString()]
  );
  await tickDailyScheduler();
  const skippedReport = await db.get(
    `SELECT id FROM daily_reports WHERE idempotency_key = ?`,
    [`${userIdA}:${today}:daily_summary`]
  );
  assert.equal(skippedReport, null);

  // 8d. Exceeding budget immediately attempts/logs a budget_exceeded email alert
  const activeMonth = today.slice(0, 7);
  await agentA.put('/api/v1/budgets').send({ monthKey: activeMonth, overallLimit: '500' });
  const overTx = await agentA.post('/api/v1/transactions').send({
    amount: '850.00',
    type: 'expense',
    localDate: today,
    merchant: 'Over Budget Test Store',
    categoryId: catFoodId,
    paymentMethod: 'Other UPI'
  });
  assert.equal(overTx.status, 201);

  const alertLog = await db.get(
    `SELECT report_type, idempotency_key FROM email_delivery_logs WHERE user_id = ? AND report_type = 'budget_exceeded' ORDER BY created_at DESC LIMIT 1`,
    [userIdA]
  );
  assert.ok(alertLog);
  assert.equal(alertLog.report_type, 'budget_exceeded');
  assert.equal(alertLog.idempotency_key, `${userIdA}:${activeMonth}:overall_budget_exceeded`);
});
