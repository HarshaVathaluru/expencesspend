const pdfParse = require('pdf-parse');
const db = require('./db');
const { newId, sha256 } = require('./crypto');
const { toPaise, getDatePartsInTz } = require('./money');
const { ensureOrCreateCategory } = require('./categories');
const { createTransaction } = require('./transactions');
const { recordAudit } = require('./audit');

/**
 * Honest PhonePe / UPI Capture & Statement Ingestion Layer.
 * Never claims a fictional PhonePe consumer API or requests UPI PIN / OTP / passwords.
 */

const PHONEPE_ARCHITECTURE_INFO = {
  officialConsumerApiAvailable: false,
  honestDisclosure:
    'PhonePe does not offer a public consumer-account transaction history API (PhonePe Developer APIs are for merchants accepting payments). PaisaPilot never requests your PhonePe login, UPI PIN, OTP, or banking password.',
  supportedCaptureMethods: [
    {
      provider: 'android_notification',
      title: 'Android Notification Listener (Companion Webhook)',
      reliability: 'High when notifications enabled; can miss silent/disabled alerts',
      privacy: 'Extracts only merchant, amount, and masked reference locally on your device. Revoke anytime.'
    },
    {
      provider: 'sms_parser',
      title: 'Bank & UPI SMS Transaction Alert Parser',
      reliability: 'Medium-High for debit SMS alerts; subject to Android SMS policy',
      privacy: 'Parses only financial alert patterns; OTPs are explicitly ignored and never stored.'
    },
    {
      provider: 'email_receipt',
      title: 'Authorized Email Receipt Parser',
      reliability: 'High for merchants emailing invoices (Swiggy, Zomato, Amazon, Uber)',
      privacy: 'Narrow read scope for receipt senders only. Disconnect & delete anytime.'
    },
    {
      provider: 'statement_import',
      title: 'PhonePe / Bank Statement CSV & PDF Import',
      reliability: 'Authoritative for completeness & daily reconciliation',
      privacy: 'Processed on your server; duplicate-safe via transaction ID & fingerprint checks.'
    }
  ]
};

/**
 * Resilient parser for PhonePe / UPI Android notification text.
 * Unknown formats are NEVER guessed — they are queued as needs_review.
 */
function parsePaymentNotificationText(rawText, packageName = 'com.phonepe.app') {
  const text = String(rawText || '').trim();
  if (!text) return { parsed: false, reason: 'Empty notification body' };

  // Explicitly refuse/ignore OTP messages so we never store OTP codes!
  if (/\b(otp|one time password|verification code|mpin|upi pin)\b/i.test(text)) {
    return { parsed: false, ignored: true, reason: 'Ignored security/OTP notification (never stored)' };
  }

  // Pattern 1: "Paid ₹420.00 to Swiggy" or "Sent Rs. 420 to Merchant"
  const paidMatch = text.match(/(?:paid|sent|debited)\s*(?:rs\.?|inr|₹)\s*([0-9,]+(?:\.[0-9]{1,2})?)\s*(?:to|at)\s+([A-Za-z0-9 &._@-]{2,50})/i);
  if (paidMatch) {
    const amountPaise = toPaise(paidMatch[1]);
    const merchant = paidMatch[2].replace(/\s+via\s+.*/i, '').trim();
    const refMatch = text.match(/(?:utr|ref|txn\s*id)[:\s#]*([A-Za-z0-9]{6,24})/i);
    return {
      parsed: true,
      confidence: 'high',
      data: {
        amountPaise,
        type: 'expense',
        merchant,
        paymentMethod: packageName.includes('phonepe') ? 'PhonePe UPI' : 'Other UPI',
        referenceId: refMatch ? refMatch[1] : null
      }
    };
  }

  // Pattern 2: "Received ₹1,500 from Rahul"
  const recvMatch = text.match(/(?:received|credited)\s*(?:rs\.?|inr|₹)\s*([0-9,]+(?:\.[0-9]{1,2})?)\s*(?:from|by)\s+([A-Za-z0-9 &._@-]{2,50})/i);
  if (recvMatch) {
    const amountPaise = toPaise(recvMatch[1]);
    const merchant = recvMatch[2].trim();
    return {
      parsed: true,
      confidence: 'high',
      data: {
        amountPaise,
        type: 'income',
        merchant,
        paymentMethod: packageName.includes('phonepe') ? 'PhonePe UPI' : 'Other UPI'
      }
    };
  }

  // Pattern 3: Bank SMS "A/c XX1234 debited for Rs 540.00 on 11-11-26; Info: UPI/ZOMATO"
  const smsMatch = text.match(/(?:debited|spent|charged)\s*(?:for|by|of)?\s*(?:rs\.?|inr|₹)\s*([0-9,]+(?:\.[0-9]{1,2})?)/i);
  if (smsMatch) {
    const amountPaise = toPaise(smsMatch[1]);
    const infoMatch = text.match(/(?:info|to|at|vpa|merchant)[:\s/]+([A-Za-z0-9 &._-]{2,40})/i);
    if (infoMatch) {
      return {
        parsed: true,
        confidence: 'medium',
        data: {
          amountPaise,
          type: 'expense',
          merchant: infoMatch[1].trim(),
          paymentMethod: /upi/i.test(text) ? 'Other UPI' : 'Bank Transfer'
        }
      };
    }
  }

  return { parsed: false, reason: 'Unrecognized notification format — queued for manual review' };
}

function redactPayloadSummary(rawText) {
  return String(rawText || '')
    .replace(/\b\d{10,16}\b/g, '••••')
    .slice(0, 140);
}

async function ingestNotificationEvent({ userId, userSettings, connectionId = null, provider = 'android_notification', payload, req = null }) {
  const rawText = String(payload.rawText || payload.message || '');
  const externalId = payload.externalId ? String(payload.externalId).slice(0, 80) : null;
  const rawHash = sha256(`${provider}|${externalId || rawText}`);
  const now = new Date().toISOString();
  const tz = userSettings?.timezone || 'Asia/Kolkata';

  // Idempotency check on ingestion_events
  const existingEv = await db.get(
    `SELECT id, status, transaction_id FROM ingestion_events WHERE user_id = ? AND raw_hash = ?`,
    [userId, rawHash]
  );
  if (existingEv) {
    return { duplicateEvent: true, eventId: existingEv.id, status: existingEv.status, transactionId: existingEv.transaction_id };
  }

  const parsed = parsePaymentNotificationText(rawText, payload.packageName || 'com.phonepe.app');
  if (parsed.ignored) {
    const evId = newId('iev');
    await db.run(
      `INSERT INTO ingestion_events (id, user_id, connection_id, provider, external_id, raw_hash, payload_summary, parsed_json, confidence, status, error_message, created_at)
       VALUES (?, ?, ?, ?, ?, ?, '[REDACTED SECURITY/OTP MESSAGE]', '{}', 'low', 'ignored', ?, ?)`,
      [evId, userId, connectionId, provider, externalId, rawHash, parsed.reason, now]
    );
    return { eventId: evId, status: 'ignored', reason: parsed.reason };
  }

  if (!parsed.parsed) {
    // Queue for manual review — never guess!
    const evId = newId('iev');
    await db.run(
      `INSERT INTO ingestion_events (id, user_id, connection_id, provider, external_id, raw_hash, payload_summary, parsed_json, confidence, status, error_message, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'low', 'needs_review', ?, ?)`,
      [evId, userId, connectionId, provider, externalId, rawHash, redactPayloadSummary(rawText), JSON.stringify({ packageName: payload.packageName || null }), parsed.reason, now]
    );
    if (connectionId) {
      await db.run(`UPDATE ingestion_connections SET pending_count = pending_count + 1, last_sync_at = ?, updated_at = ? WHERE id = ? AND user_id = ?`, [now, now, connectionId, userId]);
    }
    return { eventId: evId, status: 'needs_review', reason: parsed.reason };
  }

  const localDate = payload.occurredAt
    ? getDatePartsInTz(payload.occurredAt, tz).localDate
    : getDatePartsInTz(new Date(), tz).localDate;

  const txRes = await createTransaction({
    userId,
    userSettings,
    req,
    payload: {
      amountPaise: parsed.data.amountPaise,
      type: parsed.data.type,
      merchant: parsed.data.merchant,
      paymentMethod: parsed.data.paymentMethod,
      referenceId: parsed.data.referenceId || externalId,
      externalId: externalId || `iev_${rawHash.slice(0, 16)}`,
      importSource: provider,
      occurredAt: payload.occurredAt || now,
      localDate,
      confidence: parsed.confidence,
      reconciliationStatus: parsed.confidence === 'high' ? 'captured' : 'needs_review',
      notes: `Captured via ${provider.replace('_', ' ')}`,
      skipExactDuplicate: true
    }
  });

  const evId = newId('iev');
  const status = txRes.skipped ? 'duplicate' : (parsed.confidence === 'high' ? 'processed' : 'needs_review');
  await db.run(
    `INSERT INTO ingestion_events (id, user_id, connection_id, provider, external_id, raw_hash, payload_summary, parsed_json, confidence, status, transaction_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      evId,
      userId,
      connectionId,
      provider,
      externalId,
      rawHash,
      redactPayloadSummary(rawText),
      JSON.stringify(parsed.data),
      parsed.confidence,
      status,
      txRes.transaction?.id || txRes.existingId || null,
      now
    ]
  );

  if (connectionId) {
    await db.run(
      `UPDATE ingestion_connections SET last_sync_at = ?, last_error = NULL, updated_at = ? WHERE id = ? AND user_id = ?`,
      [now, now, connectionId, userId]
    );
  }

  await recordAudit({
    userId,
    action: 'ingestion.event_processed',
    resourceType: 'ingestion_event',
    resourceId: evId,
    req,
    metadata: { provider, status }
  });

  return { eventId: evId, status, transaction: txRes.transaction || null, duplicateWarning: txRes.duplicateWarning || null };
}

/**
 * Robust RFC-4180 style CSV parser supporting quoted fields.
 */
function parseCsvText(csvText) {
  const lines = [];
  let cur = '';
  let row = [];
  let inQuotes = false;
  const text = String(csvText || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"' && text[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (ch === '"') {
        inQuotes = false;
      } else {
        cur += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      row.push(cur.trim());
      cur = '';
    } else if (ch === '\n') {
      row.push(cur.trim());
      if (row.some((cell) => cell !== '')) lines.push(row);
      row = [];
      cur = '';
    } else {
      cur += ch;
    }
  }
  row.push(cur.trim());
  if (row.some((cell) => cell !== '')) lines.push(row);

  if (lines.length === 0) return { headers: [], rows: [] };
  const headers = lines[0];
  const rows = lines.slice(1).map((cols) => {
    const obj = {};
    headers.forEach((h, idx) => {
      obj[h] = cols[idx] !== undefined ? cols[idx] : '';
    });
    return obj;
  });
  return { headers, rows };
}

function guessCsvMapping(headers) {
  const find = (re) => headers.find((h) => re.test(h)) || '';
  return {
    date: find(/date|time|txn.*date/i),
    merchant: find(/merchant|payee|description|narration|particulars|details/i),
    amount: find(/amount|debit|withdrawal|value|inr/i),
    credit: find(/credit|deposit/i),
    type: find(/type|dr\/cr|direction/i),
    category: find(/category|cat|tag|group/i),
    reference: find(/ref|utr|txn.*id|transaction.*id/i),
    paymentMethod: find(/method|mode|channel|upi|instrument/i)
  };
}

function normalizeDateString(raw) {
  const s = String(raw || '').trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  // DD/MM/YYYY or DD-MM-YYYY
  const dmy = s.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})/);
  if (dmy) {
    const dd = dmy[1].padStart(2, '0');
    const mm = dmy[2].padStart(2, '0');
    const yy = dmy[3].length === 2 ? `20${dmy[3]}` : dmy[3];
    return `${yy}-${mm}-${dd}`;
  }
  const dt = new Date(s);
  if (!Number.isNaN(dt.getTime())) return dt.toISOString().slice(0, 10);
  return null;
}

/**
 * Extract statement-like rows from PhonePe / Indian bank PDF text.
 */
async function extractRowsFromPdfBuffer(buffer) {
  const data = await pdfParse(buffer);
  const lines = String(data.text || '')
    .split(/\n+/)
    .map((l) => l.trim())
    .filter(Boolean);

  const rows = [];
  for (const line of lines) {
    // Match lines containing a date and an INR/decimal amount
    const dateMatch = line.match(/(\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4}|\d{4}-\d{2}-\d{2})/);
    const amtMatch = line.match(/(?:₹|rs\.?|inr)?\s*([0-9,]+\.[0-9]{2})\b/i);
    if (dateMatch && amtMatch) {
      const dateStr = normalizeDateString(dateMatch[1]);
      if (!dateStr) continue;
      const isCredit = /\b(credit|cr|received|refund)\b/i.test(line);
      const cleanedDesc = line
        .replace(dateMatch[0], '')
        .replace(amtMatch[0], '')
        .replace(/\b(debit|credit|dr|cr)\b/gi, '')
        .replace(/\s+/g, ' ')
        .trim();
      rows.push({
        date: dateStr,
        merchant: cleanedDesc.slice(0, 80) || 'PDF Statement Entry',
        amount: amtMatch[1].replace(/,/g, ''),
        type: isCredit ? 'income' : 'expense',
        paymentMethod: /phonepe/i.test(line) ? 'PhonePe UPI' : /upi/i.test(line) ? 'Other UPI' : 'Bank Transfer',
        reference: (line.match(/\b([A-Z0-9]{10,22})\b/) || [])[1] || ''
      });
    }
  }
  return { rawLineCount: lines.length, rows };
}

async function runMappedImport({ userId, userSettings, rows, mapping, sourceType = 'csv', filename = 'statement.csv', req = null }) {
  const batchId = newId('bat');
  const now = new Date().toISOString();
  let importedRows = 0;
  let duplicateRows = 0;
  let reviewRows = 0;
  let failedRows = 0;
  const details = [];

  await db.run(
    `INSERT INTO import_batches (id, user_id, source_type, filename, total_rows, status, created_at)
     VALUES (?, ?, ?, ?, ?, 'processing', ?)`,
    [batchId, userId, sourceType, filename, rows.length, now]
  );

  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    try {
      const localDate = normalizeDateString(r[mapping.date] ?? r.date);
      const rawMerchant = String(r[mapping.merchant] ?? r.merchant ?? '').trim();
      let rawAmount = String(r[mapping.amount] ?? r.amount ?? '').replace(/[₹,\s]/g, '');
      let type = String(r[mapping.type] ?? r.type ?? '').toLowerCase();

      if ((!rawAmount || rawAmount === '0' || rawAmount === '0.00') && mapping.credit && r[mapping.credit]) {
        rawAmount = String(r[mapping.credit]).replace(/[₹,\s]/g, '');
        type = 'income';
      }

      if (!localDate || !rawAmount || Number.isNaN(Number(rawAmount)) || Number(rawAmount) <= 0) {
        failedRows++;
        details.push({ row: i + 1, status: 'failed', reason: 'Missing or invalid date/amount' });
        continue;
      }

      const normType = type.includes('refund')
        ? 'refund'
        : type.includes('transfer')
        ? 'transfer'
        : type.includes('cr') || type.includes('income') || type.includes('credit')
        ? 'income'
        : 'expense';

      const extId = String(r[mapping.reference] ?? r.reference ?? '').trim() || null;
      const pm = String(r[mapping.paymentMethod] ?? r.paymentMethod ?? '').trim() || (/phonepe/i.test(rawMerchant) ? 'PhonePe UPI' : 'Bank Transfer');
      const rawCat = String((mapping.category ? r[mapping.category] : null) ?? r.category ?? '').trim();
      let resolvedCategoryId = null;
      if (rawCat) {
        const catKind = normType === 'income' ? 'income' : normType === 'transfer' ? 'transfer' : 'expense';
        const ensured = await ensureOrCreateCategory(userId, { name: rawCat, kind: catKind });
        if (ensured?.category?.id) resolvedCategoryId = ensured.category.id;
      }

      const res = await createTransaction({
        userId,
        userSettings,
        req,
        payload: {
          amount: Math.abs(Number(rawAmount)).toFixed(2),
          type: normType,
          categoryId: resolvedCategoryId,
          localDate,
          occurredAt: `${localDate}T12:00:00.000Z`,
          merchant: rawMerchant || 'Imported Entry',
          paymentMethod: pm,
          referenceId: extId,
          externalId: extId,
          importSource: sourceType,
          batchId,
          reconciliationStatus: rawMerchant ? 'verified' : 'needs_review',
          skipExactDuplicate: true
        }
      });

      if (res.skipped) {
        duplicateRows++;
        details.push({ row: i + 1, status: 'duplicate', reason: res.reason });
      } else {
        importedRows++;
        if (res.transaction.reconciliation_status !== 'verified') reviewRows++;
        details.push({ row: i + 1, status: 'imported', id: res.transaction.id, warning: res.duplicateWarning });
      }
    } catch (err) {
      failedRows++;
      details.push({ row: i + 1, status: 'failed', reason: err.message });
    }
  }

  await db.run(
    `UPDATE import_batches SET imported_rows = ?, duplicate_rows = ?, review_rows = ?, failed_rows = ?, status = 'completed', summary_json = ?
     WHERE id = ?`,
    [importedRows, duplicateRows, reviewRows, failedRows, JSON.stringify({ details: details.slice(0, 100) }), batchId]
  );

  await recordAudit({
    userId,
    action: 'import.completed',
    resourceType: 'import_batch',
    resourceId: batchId,
    req,
    metadata: { sourceType, totalRows: rows.length, importedRows, duplicateRows, failedRows }
  });

  return { batchId, totalRows: rows.length, importedRows, duplicateRows, reviewRows, failedRows, details };
}

async function getReconciliationOverview(userId, monthKey) {
  const startDate = `${monthKey}-01`;
  const endDate = `${monthKey}-31`;

  const txs = await db.query(
    `SELECT t.*, c.name AS category_name, c.slug AS category_slug
     FROM transactions t
     LEFT JOIN categories c ON t.category_id = c.id
     WHERE t.user_id = ? AND t.local_date >= ? AND t.local_date <= ?
     ORDER BY t.local_date DESC`,
    [userId, startDate, endDate]
  );

  const pendingEvents = await db.query(
    `SELECT * FROM ingestion_events WHERE user_id = ? AND status = 'needs_review' ORDER BY created_at DESC LIMIT 50`,
    [userId]
  );

  const dayStatusMap = new Map();
  const needsReview = [];
  const possibleDuplicates = [];
  let verifiedCount = 0;
  let capturedCount = 0;

  for (const t of txs) {
    const d = dayStatusMap.get(t.local_date) || { date: t.local_date, total: 0, verified: 0, unverified: 0 };
    d.total += 1;
    if (t.reconciliation_status === 'verified') {
      verifiedCount++;
      d.verified += 1;
    } else {
      d.unverified += 1;
      if (t.reconciliation_status === 'captured') capturedCount++;
      if (t.reconciliation_status === 'needs_review') needsReview.push(t);
      if (t.reconciliation_status === 'possible_duplicate') possibleDuplicates.push(t);
    }
    dayStatusMap.set(t.local_date, d);
  }

  const unverifiedDays = Array.from(dayStatusMap.values())
    .filter((d) => d.unverified > 0)
    .sort((a, b) => b.date.localeCompare(a.date));

  return {
    monthKey,
    totalTransactions: txs.length,
    verifiedCount,
    capturedCount,
    needsReviewCount: needsReview.length,
    possibleDuplicatesCount: possibleDuplicates.length,
    pendingIngestionEventsCount: pendingEvents.length,
    needsReview,
    possibleDuplicates,
    pendingEvents,
    unverifiedDays
  };
}

module.exports = {
  PHONEPE_ARCHITECTURE_INFO,
  parsePaymentNotificationText,
  ingestNotificationEvent,
  parseCsvText,
  guessCsvMapping,
  extractRowsFromPdfBuffer,
  runMappedImport,
  getReconciliationOverview
};
