const db = require('./db');
const { toPaise, formatINR } = require('./money');
const logger = require('./logger');

const BUILTIN_MERCHANT_KEYWORDS = [
  { pattern: /swiggy|zomato|eatsure|dominos|pizza|kfc|mcdonald|starbucks|cafe|chai|restaurant|biryani|bakery/i, slug: 'food', reason: 'Food & dining merchant keyword' },
  { pattern: /blinkit|zepto|instamart|bigbasket|dmart|reliance\s*smart|more\s*supermarket|kirana|grocery|milk|dairy|fruits|vegetables/i, slug: 'groceries', reason: 'Groceries merchant keyword' },
  { pattern: /uber|ola|rapido|metro|irctc|redbus|fuel|petrol|diesel|bpcl|hpcl|iocl|shell|fastag|parking|auto/i, slug: 'transport', reason: 'Transport & commute keyword' },
  { pattern: /amazon|flipkart|myntra|ajio|meesho|nykaa|croma|decathlon|ikea|mall|retail/i, slug: 'shopping', reason: 'Retail & shopping merchant keyword' },
  { pattern: /rent|landlord|nobroker|housing|society|maintenance/i, slug: 'rent', reason: 'Rent & housing keyword' },
  { pattern: /bescom|tatapower|electricity|water|gas|piped|airtel|jio|vi\b|bsnl|broadband|fiber|recharge|billdesk|bharatbill/i, slug: 'utilities', reason: 'Utility or telecom bill keyword' },
  { pattern: /netflix|spotify|prime\s*video|hotstar|youtube|apple\.com|google\s*one|icloud|chatgpt|openai|claude/i, slug: 'subscriptions', reason: 'Recurring subscription keyword' },
  { pattern: /apollo|pharmeasy|1mg|medplus|hospital|clinic|pharmacy|medical|doctor|dental|lab|diag/i, slug: 'health', reason: 'Medical or pharmacy keyword' },
  { pattern: /makemytrip|goibibo|indigo|air\s*india|vistara|oyo|hotel|flight|airbnb/i, slug: 'travel', reason: 'Travel & stay keyword' },
  { pattern: /udemy|coursera|school|college|tuition|books|exam|byju|unacademy/i, slug: 'education', reason: 'Education keyword' },
  { pattern: /bookmyshow|pvr|inox|cinema|movie|game|steam|playstation/i, slug: 'entertainment', reason: 'Entertainment keyword' },
  { pattern: /zerodha|groww|kite|sip|mutual\s*fund|ppf|nps|rd\b|fd\b|savings/i, slug: 'savings', reason: 'Savings & investment keyword' },
  { pattern: /salon|urban\s*company|barber|grooming|spa/i, slug: 'personal_care', reason: 'Personal care keyword' },
  { pattern: /salary|payroll|dividend|interest\s*credit|cashback|stipend/i, slug: 'income', reason: 'Income keyword' }
];

function isGeminiConfigured() {
  const key = (process.env.GEMINI_API_KEY || '').trim();
  return Boolean(key && key !== 'YOUR_GEMINI_API_KEY');
}

function getAiStatus() {
  return {
    geminiConfigured: isGeminiConfigured(),
    model: process.env.GEMINI_MODEL || 'gemini-3-flash-preview',
    mode: isGeminiConfigured() ? 'gemini+rules' : 'rules-only'
  };
}

function getModelCandidates() {
  const primary = process.env.GEMINI_MODEL || 'gemini-3-flash-preview';
  return Array.from(new Set([primary, 'gemini-3-flash-preview', 'gemini-flash-latest', 'gemini-3.1-flash-lite-preview']));
}

async function callGeminiRequest(promptText, responseMimeType = null) {
  if (!isGeminiConfigured()) return null;
  const apiKey = process.env.GEMINI_API_KEY.trim();
  const models = getModelCandidates();

  for (const model of models) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 9000);
    try {
      const generationConfig = { temperature: responseMimeType ? 0.1 : 0.25 };
      if (responseMimeType) generationConfig.responseMimeType = responseMimeType;

      const resp = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': apiKey
        },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: promptText }] }],
          generationConfig
        }),
        signal: controller.signal
      });
      if (resp.status === 404 || resp.status === 503) {
        logger.warn('Gemini model unavailable, trying fallback model', { model, status: resp.status });
        continue;
      }
      if (!resp.ok) {
        logger.warn('Gemini API returned non-OK status', { model, status: resp.status });
        return null;
      }
      const data = await resp.json();
      return data?.candidates?.[0]?.content?.parts?.[0]?.text || null;
    } catch (err) {
      logger.warn('Gemini API call failed; trying fallback or rules', { model, error: err.message });
    } finally {
      clearTimeout(timer);
    }
  }
  return null;
}

async function callGeminiJson(promptText) {
  const text = await callGeminiRequest(promptText, 'application/json');
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function callGeminiText(promptText) {
  return callGeminiRequest(promptText, null);
}

async function suggestCategory({ userId, merchant = '', description = '', type = 'expense', paymentMethod = '' }) {
  const categories = await db.query(
    `SELECT id, slug, name, kind FROM categories WHERE user_id = ?`,
    [userId]
  );
  const bySlug = new Map(categories.map((c) => [c.slug, c]));
  const byId = new Map(categories.map((c) => [c.id, c]));

  if (type === 'transfer' && bySlug.has('transfer')) {
    const c = bySlug.get('transfer');
    return { categoryId: c.id, slug: c.slug, name: c.name, confidence: 'high', source: 'type_rule', reason: 'Self transfer transaction type' };
  }
  if (type === 'income' && bySlug.has('income')) {
    const c = bySlug.get('income');
    return { categoryId: c.id, slug: c.slug, name: c.name, confidence: 'high', source: 'type_rule', reason: 'Income transaction type' };
  }

  // 1. Check user's learned/custom merchant rules first
  const rules = await db.query(
    `SELECT * FROM merchant_category_rules WHERE user_id = ? ORDER BY priority ASC, hit_count DESC`,
    [userId]
  );
  const haystack = `${merchant} ${description}`.trim();
  const hayLower = haystack.toLowerCase();

  for (const r of rules) {
    const pat = (r.merchant_pattern || '').toLowerCase();
    if (!pat) continue;
    let matched = false;
    if (r.match_type === 'exact') matched = merchant.trim().toLowerCase() === pat;
    else if (r.match_type === 'regex') {
      try { matched = new RegExp(r.merchant_pattern, 'i').test(haystack); } catch { matched = false; }
    } else {
      matched = hayLower.includes(pat);
    }
    if (matched && byId.has(r.category_id)) {
      const c = byId.get(r.category_id);
      return {
        categoryId: c.id,
        slug: c.slug,
        name: c.name,
        confidence: 'high',
        source: 'user_rule',
        ruleId: r.id,
        reason: `Matched your saved rule "${r.merchant_pattern}"`
      };
    }
  }

  // 2. Built-in Indian merchant keyword rules
  for (const kw of BUILTIN_MERCHANT_KEYWORDS) {
    if (kw.pattern.test(haystack) && bySlug.has(kw.slug)) {
      const c = bySlug.get(kw.slug);
      return {
        categoryId: c.id,
        slug: c.slug,
        name: c.name,
        confidence: 'medium',
        source: 'keyword_rule',
        reason: kw.reason
      };
    }
  }

  // 3. Gemini AI classification if configured
  if (isGeminiConfigured() && haystack) {
    const slugList = categories.map((c) => `${c.slug} (${c.name})`).join(', ');
    const aiResp = await callGeminiJson(
      `Classify this Indian personal-finance transaction into exactly one category slug from: [${slugList}].
Merchant: ${JSON.stringify(merchant)}
Description: ${JSON.stringify(description)}
Payment Method: ${JSON.stringify(paymentMethod)}
Return JSON: {"slug":"<slug>","confidence":"high|medium|low","reason":"<brief 6-12 word reason>"}`
    );
    if (aiResp && aiResp.slug && bySlug.has(aiResp.slug)) {
      const c = bySlug.get(aiResp.slug);
      return {
        categoryId: c.id,
        slug: c.slug,
        name: c.name,
        confidence: ['high', 'medium', 'low'].includes(aiResp.confidence) ? aiResp.confidence : 'medium',
        source: 'gemini_ai',
        reason: String(aiResp.reason || 'Classified by Gemini AI').slice(0, 120)
      };
    }
  }

  const fallback = bySlug.get('uncategorized') || categories[0];
  return {
    categoryId: fallback?.id || null,
    slug: fallback?.slug || 'uncategorized',
    name: fallback?.name || 'Uncategorized',
    confidence: 'low',
    source: 'fallback',
    reason: 'No merchant match; marked for review'
  };
}

async function parseNaturalLanguageExpense({ userId, text, todayLocalDate }) {
  const raw = String(text || '').trim();
  if (!raw) throw new Error('Input text is required');

  const categories = await db.query(`SELECT id, slug, name FROM categories WHERE user_id = ?`, [userId]);
  const slugList = categories.map((c) => c.slug).join(', ');

  // Try Gemini first
  if (isGeminiConfigured()) {
    const parsed = await callGeminiJson(
      `Extract structured transaction details from this user note or PhonePe/UPI payment message in India.
Today's local date is ${todayLocalDate}.
Valid types: expense, income, transfer, refund.
Valid payment_method: PhonePe UPI, Other UPI, Debit Card, Credit Card, Cash, Bank Transfer, Wallet, Other.
Valid category_slug: [${slugList}].
Text: ${JSON.stringify(raw)}
Return JSON: {"amount":"<decimal string like 420.00 or null>","merchant":"<string>","type":"expense|income|transfer|refund","payment_method":"<valid method>","category_slug":"<slug>","local_date":"YYYY-MM-DD","notes":"<short note>","confidence":"high|medium|low"}`
    );
    if (parsed && parsed.amount && !Number.isNaN(Number(parsed.amount))) {
      try {
        const amountPaise = toPaise(String(parsed.amount));
        const cat = categories.find((c) => c.slug === parsed.category_slug) || categories.find((c) => c.slug === 'uncategorized');
        return {
          amountPaise,
          amountRupees: (amountPaise / 100).toFixed(2),
          merchant: String(parsed.merchant || 'Unknown Merchant').slice(0, 100),
          type: ['expense', 'income', 'transfer', 'refund'].includes(parsed.type) ? parsed.type : 'expense',
          paymentMethod: parsed.payment_method || 'PhonePe UPI',
          categoryId: cat?.id || null,
          categorySlug: cat?.slug || 'uncategorized',
          localDate: /^\d{4}-\d{2}-\d{2}$/.test(parsed.local_date || '') ? parsed.local_date : todayLocalDate,
          notes: String(parsed.notes || raw).slice(0, 200),
          confidence: parsed.confidence || 'medium',
          parsedBy: 'gemini_ai'
        };
      } catch {
        // fall through to deterministic parser
      }
    }
  }

  // Deterministic regex fallback for Indian UPI/PhonePe/plain notes
  const amtMatch = raw.match(/(?:rs\.?|inr|₹)\s*([0-9,]+(?:\.[0-9]{1,2})?)/i) || raw.match(/\b([0-9,]+(?:\.[0-9]{1,2})?)\b/);
  if (!amtMatch) {
    throw new Error('Could not find a rupee amount in that text. Please include an amount like "Rs 420" or "₹250".');
  }
  const amountPaise = toPaise(amtMatch[1]);
  const isIncome = /\b(received|credited|salary|income|got from)\b/i.test(raw);
  const isRefund = /\b(refund|reversed|cashback|reversal)\b/i.test(raw);
  const isTransfer = /\b(self transfer|own account|transferred to own)\b/i.test(raw);
  const type = isTransfer ? 'transfer' : isRefund ? 'refund' : isIncome ? 'income' : 'expense';

  let paymentMethod = 'PhonePe UPI';
  if (/gpay|google pay|paytm|bhim|upi/i.test(raw) && !/phonepe/i.test(raw)) paymentMethod = 'Other UPI';
  else if (/credit card/i.test(raw)) paymentMethod = 'Credit Card';
  else if (/debit card/i.test(raw)) paymentMethod = 'Debit Card';
  else if (/cash/i.test(raw)) paymentMethod = 'Cash';
  else if (/neft|imps|rtgs|bank/i.test(raw)) paymentMethod = 'Bank Transfer';

  const merchantMatch = raw.match(/(?:to|at|from)\s+([A-Za-z0-9 &._-]{2,40}?)(?:\s+(?:via|using|on|for|through)\b|$)/i);
  const merchant = merchantMatch ? merchantMatch[1].trim() : 'Quick Entry';

  const catSuggestion = await suggestCategory({ userId, merchant, description: raw, type, paymentMethod });

  return {
    amountPaise,
    amountRupees: (amountPaise / 100).toFixed(2),
    merchant,
    type,
    paymentMethod,
    categoryId: catSuggestion.categoryId,
    categorySlug: catSuggestion.slug,
    localDate: todayLocalDate,
    notes: raw.slice(0, 200),
    confidence: catSuggestion.confidence,
    parsedBy: 'rule_parser'
  };
}

async function askMoneyAssistant({ question, summary }) {
  const q = String(question || '').trim();
  if (!q) throw new Error('Question is required');

  // Guardrail: Refuse investment, tax, or credit advice per spec Section D
  if (/\b(stock|mutual fund pick|crypto|which share|tax saving|itr|credit card apply|loan|invest in)\b/i.test(q)) {
    return {
      answer:
        'PaisaPilot is a spending tracker and money-organization tool. I can summarize your persisted expenses, category spikes, budgets, and reconciliation gaps, but I do not provide investment, tax, or credit advice.',
      source: 'policy_guardrail'
    };
  }

  if (isGeminiConfigured()) {
    const prompt = `You are PaisaPilot Assistant, a calm, non-judgmental personal spending analyst for a user in India.
Strict rules:
- Use ONLY the persisted numeric facts provided below. Never invent transactions or numbers.
- Format Indian Rupee figures clearly (e.g. ₹1,240.00).
- Do NOT give investment, tax, or credit advice.
- Keep your answer concise (3-5 sentences or bullet points) and cite the exact window/totals used.

Persisted Summary JSON:
${JSON.stringify(summary)}

User Question: ${JSON.stringify(q)}`;

    const text = await callGeminiText(prompt);
    if (text) {
      return { answer: text.trim(), source: 'gemini_ai' };
    }
  }

  // Deterministic grounded fallback
  const spent = formatINR(summary.monthSpentPaise || 0);
  const income = formatINR(summary.monthIncomePaise || 0);
  const topCat = summary.topCategories?.[0];
  const topMerch = summary.topMerchants?.[0];
  return {
    answer: `For ${summary.monthKey}, your persisted spending is ${spent} across ${summary.txCount || 0} transactions, with ${income} in recorded income.${
      topCat ? ` Your top spending category is ${topCat.name} (${formatINR(topCat.totalPaise)}).` : ''
    }${topMerch ? ` Your top merchant is ${topMerch.merchant} (${formatINR(topMerch.totalPaise)}).` : ''}`,
    source: 'deterministic_summary'
  };
}

module.exports = {
  isGeminiConfigured,
  getAiStatus,
  suggestCategory,
  parseNaturalLanguageExpense,
  askMoneyAssistant
};
