/**
 * Safe integer-paise financial arithmetic & timezone-aware date helpers.
 * Never uses floating-point addition/multiplication for totals.
 */

function toPaise(input) {
  if (typeof input === 'number') {
    if (!Number.isFinite(input) || input < 0) {
      throw new Error('Amount must be a non-negative finite number');
    }
    input = input.toFixed(2);
  }
  if (typeof input !== 'string') {
    throw new Error('Invalid amount format');
  }
  const cleaned = input.replace(/[₹,\s]/g, '').trim();
  if (!/^\d+(\.\d{1,2})?$/.test(cleaned)) {
    throw new Error('Amount must be a valid positive decimal with up to 2 decimal places');
  }
  const [whole, frac = ''] = cleaned.split('.');
  const paddedFrac = (frac + '00').slice(0, 2);
  const paise = Number(whole) * 100 + Number(paddedFrac);
  if (!Number.isSafeInteger(paise)) {
    throw new Error('Amount exceeds safe integer range');
  }
  return paise;
}

function formatINR(paise, locale = 'en-IN', currency = 'INR') {
  const value = Number(paise || 0) / 100;
  try {
    return new Intl.NumberFormat(locale || 'en-IN', {
      style: 'currency',
      currency: currency || 'INR',
      minimumFractionDigits: 2,
      maximumFractionDigits: 2
    }).format(value);
  } catch {
    return `₹${value.toFixed(2)}`;
  }
}

function getDatePartsInTz(dateInput = new Date(), timeZone = 'Asia/Kolkata') {
  const d = dateInput instanceof Date ? dateInput : new Date(dateInput);
  if (Number.isNaN(d.getTime())) {
    throw new Error('Invalid date');
  }
  let tz = timeZone || 'Asia/Kolkata';
  let parts;
  try {
    parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false
    }).formatToParts(d);
  } catch {
    tz = 'Asia/Kolkata';
    parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false
    }).formatToParts(d);
  }
  const map = {};
  for (const p of parts) {
    if (p.type !== 'literal') map[p.type] = p.value;
  }
  const hour = map.hour === '24' ? '00' : map.hour;
  return {
    localDate: `${map.year}-${map.month}-${map.day}`,
    monthKey: `${map.year}-${map.month}`,
    hhmm: `${hour}:${map.minute}`,
    isoLocal: `${map.year}-${map.month}-${map.day}T${hour}:${map.minute}:${map.second}`
  };
}

function getPreviousMonthKey(monthKey) {
  const [y, m] = monthKey.split('-').map(Number);
  if (m === 1) return `${y - 1}-12`;
  return `${y}-${String(m - 1).padStart(2, '0')}`;
}

function shiftDate(localDate, daysDelta) {
  const [y, m, d] = localDate.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + daysDelta));
  return dt.toISOString().slice(0, 10);
}

module.exports = {
  toPaise,
  formatINR,
  getDatePartsInTz,
  getPreviousMonthKey,
  shiftDate
};
