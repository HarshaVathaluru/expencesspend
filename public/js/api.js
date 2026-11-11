export const state = {
  user: null,
  settings: {
    timezone: 'Asia/Kolkata',
    currency: 'INR',
    locale: 'en-IN',
    theme: 'dark',
    enable_3d: true,
    reduced_motion: false
  },
  categories: [],
  aiStatus: { geminiConfigured: false, mode: 'rules-only' },
  route: 'dashboard',
  datePreset: 'this_month',
  monthKey: null,
  customRange: { startDate: '', endDate: '' }
};

export function esc(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function fmtINR(paise) {
  const val = Number(paise || 0) / 100;
  try {
    return new Intl.NumberFormat(state.settings?.locale || 'en-IN', {
      style: 'currency',
      currency: state.settings?.currency || 'INR',
      minimumFractionDigits: 2,
      maximumFractionDigits: 2
    }).format(val);
  } catch {
    return `₹${val.toFixed(2)}`;
  }
}

export function animateCountUp(el, targetPaise, isCount = false) {
  if (!el) return;
  if (state.settings.reduced_motion || (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches)) {
    el.textContent = isCount ? String(targetPaise) : fmtINR(targetPaise);
    return;
  }
  const startVal = Number(el.dataset.lastVal || 0);
  const endVal = Number(targetPaise || 0);
  el.dataset.lastVal = String(endVal);
  const startTs = performance.now();
  const dur = 360;
  const step = (now) => {
    const p = Math.min(1, (now - startTs) / dur);
    const eased = 1 - Math.pow(1 - p, 3);
    const cur = Math.round(startVal + (endVal - startVal) * eased);
    el.textContent = isCount ? String(cur) : fmtINR(cur);
    if (p < 1) requestAnimationFrame(step);
    else el.textContent = isCount ? String(endVal) : fmtINR(endVal);
  };
  requestAnimationFrame(step);
}

let toastTimer = null;
export function showToast(msg, isError = false) {
  const el = document.getElementById('global-toast');
  if (!el) return;
  el.textContent = msg;
  el.style.borderColor = isError ? 'var(--danger)' : 'var(--accent)';
  el.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('hidden'), 4200);
}

export async function api(path, options = {}) {
  const headers = { ...(options.headers || {}) };
  let body = options.body;
  if (body && !(body instanceof FormData) && typeof body === 'object') {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(body);
  }
  const res = await fetch(path, {
    credentials: 'include',
    ...options,
    headers,
    body
  });
  const text = await res.text();
  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch { data = { raw: text }; }
  if (!res.ok) {
    const err = new Error(data.error || `Request failed (${res.status})`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

export function getTodayInUserTz() {
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: state.settings.timezone || 'Asia/Kolkata',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    }).format(new Date());
  } catch {
    return new Date().toISOString().slice(0, 10);
  }
}
