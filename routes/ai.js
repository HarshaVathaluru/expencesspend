const express = require('express');
const rateLimit = require('express-rate-limit');
const { requireAuth } = require('../lib/auth');
const ai = require('../lib/ai');
const { getDatePartsInTz } = require('../lib/money');
const { getAnalyticsSummary } = require('../lib/transactions');

const router = express.Router();
router.use(requireAuth);

const aiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 25,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'AI rate limit reached; please wait a moment.' }
});

router.get('/status', (req, res) => {
  res.json(ai.getAiStatus());
});

router.post('/parse-expense', aiLimiter, async (req, res, next) => {
  try {
    const tz = req.userSettings.timezone || 'Asia/Kolkata';
    const todayLocalDate = getDatePartsInTz(new Date(), tz).localDate;
    const draft = await ai.parseNaturalLanguageExpense({
      userId: req.user.id,
      text: req.body?.text,
      todayLocalDate
    });
    res.json({ draft });
  } catch (err) {
    err.statusCode = 400;
    next(err);
  }
});

router.post('/suggest-category', aiLimiter, async (req, res, next) => {
  try {
    const suggestion = await ai.suggestCategory({
      userId: req.user.id,
      merchant: req.body?.merchant || '',
      description: req.body?.description || '',
      type: req.body?.type || 'expense',
      paymentMethod: req.body?.paymentMethod || ''
    });
    res.json({ suggestion });
  } catch (err) {
    next(err);
  }
});

router.post('/ask', aiLimiter, async (req, res, next) => {
  try {
    const tz = req.userSettings.timezone || 'Asia/Kolkata';
    const monthKey = req.body?.monthKey || getDatePartsInTz(new Date(), tz).monthKey;
    const analytics = await getAnalyticsSummary(req.user.id, { monthKey, timezone: tz });
    const groundedSummary = {
      monthKey: analytics.monthKey,
      todayDate: analytics.todayDate,
      todaySpentPaise: analytics.todaySpentPaise,
      weekSpentPaise: analytics.weekSpentPaise,
      monthSpentPaise: analytics.netSpentPaise,
      monthIncomePaise: analytics.incomePaise,
      netCashFlowPaise: analytics.netCashFlowPaise,
      overallBudgetPaise: analytics.overallBudgetPaise,
      budgetUsedPercent: analytics.budgetUsedPercent,
      txCount: analytics.transactionCount,
      topCategories: analytics.categories.slice(0, 6).map((c) => ({ name: c.name, totalPaise: c.totalPaise, count: c.count })),
      topMerchants: analytics.topMerchants.slice(0, 5),
      reconciliationCounts: analytics.reconciliationCounts
    };
    const reply = await ai.askMoneyAssistant({
      question: req.body?.question,
      summary: groundedSummary
    });
    res.json({ ...reply, monthKey });
  } catch (err) {
    err.statusCode = 400;
    next(err);
  }
});

module.exports = router;
