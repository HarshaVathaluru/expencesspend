import { api, state, esc, fmtINR, animateCountUp, showToast, getTodayInUserTz } from './api.js?v=7';
import { mountDashboardHero3D, mountCategoryExplorer3D, cleanupAllScenes } from './scenes3d.js?v=7';
import {
  renderImportView,
  renderBudgetsView,
  renderGoalsView,
  renderReportsView,
  renderEmailSettingsView,
  renderSettingsView
} from './views-extra.js?v=7';

const ROUTE_TITLES = {
  dashboard: 'Dashboard',
  transactions: 'Transactions',
  import: 'Import Statements & Payment Scan',
  budgets: 'Budgets & Category Limits',
  goals: 'Savings Goals',
  reports: 'Reports & Exports',
  'email-settings': '4-Day & Budget Alert Emails',
  settings: 'Settings, Privacy & Security'
};

function txStatusPill(status) {
  const s = String(status || '').toLowerCase();
  if (s === 'verified') return 'pp-pill-verified';
  if (s === 'captured') return 'pp-pill-captured';
  if (s === 'possible_duplicate') return 'pp-pill-possible_duplicate';
  if (s === 'needs_review') return 'pp-pill-needs_review';
  return 'pp-pill-neutral';
}

function setSidebarOpen(open) {
  const sb = document.getElementById('sidebar');
  const bd = document.getElementById('sidebar-backdrop');
  if (sb) {
    sb.classList.toggle('translate-x-0', open);
    sb.classList.toggle('-translate-x-full', !open);
  }
  if (bd) bd.classList.toggle('hidden', !open);
}

function applyThemeAndMotion() {
  const isLight = state.settings.theme === 'light';
  document.documentElement.dataset.theme = isLight ? 'light' : 'dark';
  document.documentElement.dataset.reducedMotion = state.settings.reduced_motion ? 'true' : 'false';
  const btn3d = document.getElementById('btn-toggle-3d');
  if (btn3d) btn3d.textContent = state.settings.enable_3d && !state.settings.reduced_motion ? '3D: On' : '3D: Off';
  const btnTheme = document.getElementById('btn-toggle-theme');
  if (btnTheme) btnTheme.textContent = isLight ? 'Theme: Light' : 'Theme: Dark';
  const tzEl = document.getElementById('sidebar-tz');
  if (tzEl) tzEl.textContent = `${state.settings.timezone || 'Asia/Kolkata'} · ${state.settings.currency || 'INR'}`;
}

function getDateFilterParams() {
  const today = getTodayInUserTz();
  const dt = new Date(`${today}T12:00:00Z`);
  const shift = (days) => new Date(dt.getTime() + days * 86400000).toISOString().slice(0, 10);
  const monthKey = today.slice(0, 7);

  if (state.datePreset === 'today') return { startDate: today, endDate: today, monthKey };
  if (state.datePreset === 'yesterday') {
    const y = shift(-1);
    return { startDate: y, endDate: y, monthKey: y.slice(0, 7) };
  }
  if (state.datePreset === 'this_week') return { startDate: shift(-6), endDate: today, monthKey };
  if (state.datePreset === 'last_month') {
    const [y, m] = monthKey.split('-').map(Number);
    const pm = m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`;
    return { startDate: `${pm}-01`, endDate: `${pm}-31`, monthKey: pm };
  }
  if (state.datePreset === 'custom' && state.customRange.startDate && state.customRange.endDate) {
    return { startDate: state.customRange.startDate, endDate: state.customRange.endDate, monthKey: state.customRange.startDate.slice(0, 7) };
  }
  return { startDate: `${monthKey}-01`, endDate: `${monthKey}-31`, monthKey };
}

function renderDailyTrendSvg(dailyTrend) {
  if (!dailyTrend || dailyTrend.length === 0) {
    return `<div class="flex flex-col items-center justify-center gap-2 py-6 text-center"><img src="/images/empty-transactions.svg" alt="" width="110"><div class="text-xs text-slate-400">No daily expense points in this range.</div></div>`;
  }
  const w = 520;
  const h = 160;
  const pad = 20;
  const maxP = Math.max(...dailyTrend.map((d) => d.totalPaise), 100);
  const pts = dailyTrend.map((d, i) => {
    const x = pad + (dailyTrend.length === 1 ? (w - pad * 2) / 2 : (i / (dailyTrend.length - 1)) * (w - pad * 2));
    const y = h - pad - (d.totalPaise / maxP) * (h - pad * 2);
    return { x, y, d };
  });
  const pathD = pts.map((p, idx) => `${idx === 0 ? 'M' : 'L'} ${p.x.toFixed(1)} ${p.y.toFixed(1)}`).join(' ');
  const areaD = `${pathD} L ${pts[pts.length - 1].x.toFixed(1)} ${h - pad} L ${pts[0].x.toFixed(1)} ${h - pad} Z`;

  return `
    <svg viewBox="0 0 ${w} ${h}" class="h-40 w-full overflow-visible" role="img" aria-label="Daily spending trend chart">
      <defs>
        <linearGradient id="trendGrad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stop-color="#10B981" stop-opacity="0.28"/>
          <stop offset="100%" stop-color="#10B981" stop-opacity="0.0"/>
        </linearGradient>
      </defs>
      <path d="${areaD}" fill="url(#trendGrad)"/>
      <path d="${pathD}" fill="none" stroke="#10B981" stroke-width="2.25" stroke-linecap="round" stroke-linejoin="round"/>
      ${pts.map((p) => `
        <circle cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="3.75" fill="#10B981">
          <title>${p.d.date}: ${fmtINR(p.d.totalPaise)}</title>
        </circle>
      `).join('')}
      <text x="${pad}" y="${h - 4}" fill="#94A3B8" font-size="10">${dailyTrend[0].date}</text>
      <text x="${w - pad}" y="${h - 4}" text-anchor="end" fill="#94A3B8" font-size="10">${dailyTrend[dailyTrend.length - 1].date}</text>
    </svg>
  `;
}

// --- DASHBOARD VIEW (Strictly Required Sections) ---
async function renderDashboardView(root) {
  root.innerHTML = `
    <div class="space-y-4">
      <div class="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">${'<div class="skeleton h-24"></div>'.repeat(4)}</div>
      <div class="skeleton h-72"></div>
    </div>
  `;
  const range = getDateFilterParams();
  state.monthKey = range.monthKey;

  const { summary } = await api(`/api/v1/dashboard/summary?startDate=${range.startDate}&endDate=${range.endDate}&monthKey=${range.monthKey}`);

  const budgetRemain = summary.overallBudgetPaise > 0 ? summary.budgetRemainingPaise : null;
  const maxCmp = Math.max(summary.prevMonthSpentPaise, summary.netSpentPaise, 100);
  const prevW = Math.round((summary.prevMonthSpentPaise / maxCmp) * 100);
  const curW = Math.round((summary.netSpentPaise / maxCmp) * 100);

  root.innerHTML = `
    <div class="space-y-4">
      ${summary.latestEmailFailure ? `
        <div class="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-rose-500/35 bg-rose-500/10 px-4 py-2.5 text-xs">
          <span><strong class="text-rose-400">Email Failed:</strong> ${esc(summary.latestEmailFailure.failure_reason || 'Brevo did not accept the last digest.')}</span>
          <button type="button" class="pp-btn pp-btn-ghost pp-btn-sm" data-nav="email-settings">Check Email Settings</button>
        </div>
      ` : ''}
      ${summary.demoCount > 0 ? `
        <div class="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-sky-500/35 bg-sky-500/10 px-4 py-2.5 text-xs">
          <span><strong class="text-sky-400">Demo Mode:</strong> Showing ${summary.demoCount} sample transaction(s).</span>
          <button type="button" class="pp-btn pp-btn-secondary pp-btn-sm" id="btn-dash-clear-demo">Remove Demo Data</button>
        </div>
      ` : ''}

      <!-- Period Filter Bar -->
      <div class="pp-card space-y-3 p-3.5 sm:p-4">
        <div class="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2.5">
          <div class="flex items-center gap-1.5 overflow-x-auto no-scrollbar pb-0.5">
            ${[
              ['today', 'Today'],
              ['yesterday', 'Yesterday'],
              ['this_week', 'This Week'],
              ['this_month', 'This Month'],
              ['last_month', 'Last Month'],
              ['custom', 'Custom']
            ].map(([k, lbl]) => `<button type="button" class="pp-btn pp-btn-sm shrink-0 whitespace-nowrap ${state.datePreset === k ? 'pp-btn-primary' : 'pp-btn-ghost'}" data-preset="${k}">${lbl}</button>`).join('')}
          </div>
          <div class="${state.datePreset === 'custom' ? 'flex' : 'hidden'} flex-wrap items-center gap-2" id="custom-range-box">
            <input type="date" id="dash-start" value="${range.startDate}" class="pp-input w-36 text-xs">
            <input type="date" id="dash-end" value="${range.endDate}" class="pp-input w-36 text-xs">
            <button type="button" class="pp-btn pp-btn-secondary pp-btn-sm" id="btn-apply-custom">Apply</button>
          </div>
        </div>
      </div>

      <!-- 4 Core KPIs -->
      <div class="pp-stagger grid grid-cols-2 gap-3 lg:grid-cols-4">
        <div class="pp-card pp-card-interactive p-3.5 sm:p-4">
          <div class="text-[11px] sm:text-xs text-slate-500 dark:text-slate-400">Spent Today</div>
          <div class="pp-num mt-1 text-lg sm:text-2xl font-bold tracking-tight" id="kpi-today">₹0.00</div>
          <div class="pp-num mt-0.5 text-[11px] text-slate-500 dark:text-slate-400 truncate">${esc(summary.todayDate)} · 7d: ${fmtINR(summary.weekSpentPaise)}</div>
        </div>
        <div class="pp-card pp-card-interactive p-3.5 sm:p-4">
          <div class="text-[11px] sm:text-xs text-slate-500 dark:text-slate-400">Period Net Spent</div>
          <div class="pp-num mt-1 text-lg sm:text-2xl font-bold tracking-tight" id="kpi-month">₹0.00</div>
          <div class="pp-num mt-0.5 text-[11px] truncate ${summary.deltaPaise > 0 ? 'text-rose-500 dark:text-rose-400' : 'text-emerald-600 dark:text-emerald-400'}">${summary.deltaPaise >= 0 ? '+' : ''}${fmtINR(summary.deltaPaise)} (${summary.deltaPercent}%)</div>
        </div>
        <div class="pp-card pp-card-interactive p-3.5 sm:p-4">
          <div class="text-[11px] sm:text-xs text-slate-500 dark:text-slate-400">Income</div>
          <div class="pp-num mt-1 text-lg sm:text-2xl font-bold tracking-tight text-emerald-600 dark:text-emerald-400" id="kpi-income">₹0.00</div>
          <div class="pp-num mt-0.5 text-[11px] text-slate-500 dark:text-slate-400 truncate">Net flow: ${fmtINR(summary.netCashFlowPaise)}</div>
        </div>
        <div class="pp-card pp-card-interactive p-3.5 sm:p-4">
          <div class="text-[11px] sm:text-xs text-slate-500 dark:text-slate-400">Budget Remaining</div>
          <div class="pp-num mt-1 text-lg sm:text-2xl font-bold tracking-tight ${budgetRemain !== null && budgetRemain < 0 ? 'text-rose-500 dark:text-rose-400' : ''}" id="kpi-budget">${budgetRemain !== null ? '₹0.00' : 'Not set'}</div>
          <div class="pp-num mt-0.5 text-[11px] text-slate-500 dark:text-slate-400 truncate">${summary.overallBudgetPaise > 0 ? `${summary.budgetUsedPercent}% of ${fmtINR(summary.overallBudgetPaise)}` : '<button type="button" class="text-teal-700 dark:text-emerald-400 hover:underline" data-nav="budgets">Set monthly budget</button>'}</div>
        </div>
      </div>

      <!-- 3D Ledger Visuals -->
      <div class="pp-stagger grid gap-4 lg:grid-cols-2">
        <div class="pp-card pp-card-interactive space-y-2.5 p-4">
          <div class="flex items-center justify-between gap-2">
            <strong class="text-sm">Balance &amp; Budget Ring</strong>
            <span class="text-[11px] text-slate-500 dark:text-slate-400">${state.settings.enable_3d && !state.settings.reduced_motion ? 'Interactive 3D' : '2D View'}</span>
          </div>
          <div id="hero-3d-stage" class="scene-stage"></div>
        </div>
        <div class="pp-card pp-card-interactive space-y-2.5 p-4">
          <div class="flex items-center justify-between gap-2">
            <strong class="text-sm">Category Breakdown</strong>
            <span class="text-[11px] text-slate-500 dark:text-slate-400">${summary.categories.length} categories</span>
          </div>
          <div id="cat-3d-stage" class="scene-stage"></div>
          <div id="cat-chip-bar" class="flex flex-wrap gap-1.5"></div>
        </div>
      </div>

      <!-- Trend & Monthly Comparison -->
      <div class="grid gap-4 lg:grid-cols-2">
        <div class="pp-card space-y-2 p-4">
          <div class="flex items-center justify-between gap-2">
            <h3 class="text-sm font-semibold">Daily Spending Trend</h3>
            <span class="text-[11px] text-slate-400">${esc(range.startDate)} &rarr; ${esc(range.endDate)}</span>
          </div>
          ${renderDailyTrendSvg(summary.dailyTrend)}
        </div>

        <div class="pp-card space-y-3 p-4">
          <div class="flex items-center justify-between gap-2">
            <h3 class="text-sm font-semibold">Month-over-Month &amp; Cash Flow</h3>
            <span class="text-[11px] text-slate-400">${summary.transactionCount} transactions</span>
          </div>
          <div class="space-y-2">
            <div class="flex justify-between text-xs"><span class="text-slate-400">${esc(summary.prevMonthKey)} (Previous)</span><strong>${fmtINR(summary.prevMonthSpentPaise)}</strong></div>
            <div class="h-2 w-full overflow-hidden rounded-full bg-slate-500/20"><div class="h-full rounded-full bg-slate-500" style="width:${prevW}%"></div></div>
            <div class="flex justify-between pt-1 text-xs"><span class="text-slate-400">${esc(summary.monthKey)} (Current)</span><strong>${fmtINR(summary.netSpentPaise)}</strong></div>
            <div class="h-2 w-full overflow-hidden rounded-full bg-slate-500/20"><div class="h-full rounded-full bg-teal-600 dark:bg-emerald-400" style="width:${curW}%"></div></div>
          </div>
          <div class="grid grid-cols-3 gap-2 border-t border-slate-500/15 pt-2.5 text-center text-xs">
            <div><div class="text-slate-400">Income</div><strong class="text-emerald-400">${fmtINR(summary.incomePaise)}</strong></div>
            <div><div class="text-slate-400">Spent</div><strong class="text-rose-400">${fmtINR(summary.netSpentPaise)}</strong></div>
            <div><div class="text-slate-400">Balance</div><strong class="text-sky-400">${fmtINR(summary.netCashFlowPaise)}</strong></div>
          </div>
        </div>
      </div>

      <!-- Top Merchants & Payment Methods -->
      <div class="grid gap-4 lg:grid-cols-2">
        <div class="pp-card space-y-3 p-4">
          <div class="flex items-center justify-between gap-2">
            <h3 class="text-sm font-semibold">Top Merchants</h3>
            <button type="button" class="pp-btn pp-btn-ghost pp-btn-sm" data-nav="transactions">View Ledger</button>
          </div>
          ${summary.topMerchants.length === 0 ? `
            <div class="text-xs text-slate-400">Add expenses to see your top merchants.</div>
          ` : `
            <div class="space-y-2 text-xs">
              ${summary.topMerchants.slice(0, 5).map((m) => `
                <div class="flex justify-between"><span>${esc(m.merchant)} <span class="text-slate-400">(${m.count}x)</span></span><strong>${fmtINR(m.totalPaise)}</strong></div>
              `).join('')}
            </div>
          `}
        </div>

        <div class="pp-card space-y-3 p-4">
          <div class="flex items-center justify-between gap-2">
            <h3 class="text-sm font-semibold">Payment Methods</h3>
            <button type="button" class="pp-btn pp-btn-ghost pp-btn-sm" data-nav="reports">Export</button>
          </div>
          ${summary.paymentMethods.length === 0 ? `
            <div class="text-xs text-slate-400">No payments recorded in this period.</div>
          ` : `
            <div class="space-y-2 text-xs">
              ${summary.paymentMethods.map((pm) => `
                <div class="flex justify-between"><span>${esc(pm.method)}</span><strong>${fmtINR(pm.totalPaise)}</strong></div>
              `).join('')}
            </div>
          `}
        </div>
      </div>
    </div>
  `;

  animateCountUp(root.querySelector('#kpi-today'), summary.todaySpentPaise);
  animateCountUp(root.querySelector('#kpi-month'), summary.netSpentPaise);
  animateCountUp(root.querySelector('#kpi-income'), summary.incomePaise);
  if (budgetRemain !== null) animateCountUp(root.querySelector('#kpi-budget'), budgetRemain);

  mountDashboardHero3D(root.querySelector('#hero-3d-stage'), summary, {
    enable3d: state.settings.enable_3d,
    reducedMotion: state.settings.reduced_motion
  });

  const chipBar = root.querySelector('#cat-chip-bar');
  const selectCat = (cat) => {
    chipBar.querySelectorAll('.cat-chip').forEach((el) => {
      const isAct = el.dataset.slug === cat.slug;
      el.classList.toggle('border-sky-400', isAct);
      el.classList.toggle('bg-sky-500/15', isAct);
      el.classList.toggle('text-sky-400', isAct);
    });
    showToast(`${cat.name}: ${fmtINR(cat.totalPaise)} (${cat.sharePercent}%, ${cat.count} txns)`);
  };
  if (summary.categories.length > 0) {
    chipBar.innerHTML = summary.categories.slice(0, 6).map((c, idx) => `
      <button type="button" class="pp-surface-sub cat-chip flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium transition ${idx === 0 ? 'border-sky-400 bg-sky-500/15 text-sky-400' : ''}" data-slug="${esc(c.slug)}">
        <img src="${c.iconPath}" alt="" width="16" height="16">
        <span>${esc(c.name)}</span>
      </button>
    `).join('');
    chipBar.querySelectorAll('.cat-chip').forEach((btn, idx) => {
      btn.addEventListener('click', () => selectCat(summary.categories[idx]));
    });
  }
  mountCategoryExplorer3D(root.querySelector('#cat-3d-stage'), summary.categories, selectCat, {
    enable3d: state.settings.enable_3d,
    reducedMotion: state.settings.reduced_motion
  });

  root.querySelectorAll('[data-preset]').forEach((b) => {
    b.addEventListener('click', () => {
      state.datePreset = b.dataset.preset;
      renderDashboardView(root);
    });
  });
  root.querySelector('#btn-apply-custom')?.addEventListener('click', () => {
    state.customRange.startDate = root.querySelector('#dash-start').value;
    state.customRange.endDate = root.querySelector('#dash-end').value;
    renderDashboardView(root);
  });
  root.querySelector('#btn-dash-clear-demo')?.addEventListener('click', async () => {
    const r = await api('/api/v1/transactions/demo-seed', { method: 'DELETE' });
    showToast(`Removed ${r.deleted} demo transaction(s)`);
    renderDashboardView(root);
  });
  root.querySelectorAll('[data-nav]').forEach((el) => {
    el.addEventListener('click', () => navigateTo(el.dataset.nav));
  });
}

// --- TRANSACTIONS LIST VIEW ---
async function renderTransactionsView(root) {
  root.innerHTML = `<div class="skeleton h-48"></div>`;
  const filters = { q: '', type: '', categoryId: '', paymentMethod: '', page: 1 };

  const loadList = async () => {
    const qs = new URLSearchParams();
    Object.entries(filters).forEach(([k, v]) => { if (v) qs.set(k, v); });
    qs.set('limit', '25');
    const data = await api(`/api/v1/transactions?${qs.toString()}`);

    root.innerHTML = `
      <div class="space-y-4">
        <div class="pp-card flex flex-wrap items-center gap-2 p-3">
          <input type="search" id="tx-f-q" value="${esc(filters.q)}" placeholder="Search merchant, notes, tags..." class="pp-input min-w-[180px] flex-1 text-xs">
          <select id="tx-f-type" class="pp-input w-32 text-xs">
            <option value="">All Types</option>
            ${['expense', 'income', 'transfer', 'refund'].map((t) => `<option value="${t}" ${filters.type === t ? 'selected' : ''}>${t}</option>`).join('')}
          </select>
          <select id="tx-f-cat" class="pp-input w-40 text-xs">
            <option value="">All Categories</option>
            ${state.categories.map((c) => `<option value="${c.id}" ${filters.categoryId === c.id ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}
          </select>
          <select id="tx-f-pm" class="pp-input w-36 text-xs">
            <option value="">All Methods</option>
            ${['PhonePe UPI', 'Other UPI', 'Debit Card', 'Credit Card', 'Cash', 'Bank Transfer', 'Wallet', 'Other'].map((m) => `<option value="${m}" ${filters.paymentMethod === m ? 'selected' : ''}>${m}</option>`).join('')}
          </select>
          <button type="button" class="pp-btn pp-btn-primary pp-btn-sm" id="tx-f-apply">Filter</button>
          <a class="pp-btn pp-btn-ghost pp-btn-sm" href="/api/v1/reports/export/csv?startDate=2000-01-01&endDate=2099-12-31">Export CSV</a>
        </div>

        <div class="pp-card p-4">
          ${data.items.length === 0 ? `
            <div class="flex flex-col items-center justify-center gap-3 py-8 text-center">
              <img src="/images/empty-transactions.svg" alt="" width="132">
              <strong class="text-sm">No transactions match these filters</strong>
              <button type="button" class="pp-btn pp-btn-primary pp-btn-sm" id="btn-empty-add">+ Add First Expense</button>
            </div>
          ` : `
            <div class="overflow-x-auto">
              <table class="w-full text-left text-xs">
                <thead class="border-b border-slate-500/20 text-[11px] uppercase tracking-wide text-slate-400">
                  <tr>
                    <th class="py-2 pr-3">Date</th>
                    <th class="py-2 pr-3">Merchant</th>
                    <th class="py-2 pr-3">Category</th>
                    <th class="py-2 pr-3">Method</th>
                    <th class="py-2 pr-3">Status</th>
                    <th class="py-2 text-right">Amount</th>
                  </tr>
                </thead>
                <tbody class="divide-y divide-slate-500/15">
                  ${data.items.map((t) => `
                    <tr class="tx-row cursor-pointer transition hover:bg-sky-500/5" data-tx-id="${t.id}">
                      <td class="py-2.5 pr-3 whitespace-nowrap text-slate-400">${esc(t.local_date)}</td>
                      <td class="py-2.5 pr-3">
                        <strong class="font-semibold">${esc(t.merchant)}</strong>
                        ${t.is_demo ? `<span class="pp-pill pp-pill-demo ml-1">Demo</span>` : ''}
                        ${t.is_split ? `<span class="pp-pill pp-pill-neutral ml-1">Split (${t.splits.length})</span>` : ''}
                      </td>
                      <td class="py-2.5 pr-3">
                        <span class="flex items-center gap-1.5">
                          <img src="${t.category_icon || '/images/categories/uncategorized.svg'}" alt="" width="18" height="18">
                          <span>${t.is_split ? 'Split Categories' : esc(t.category_name || 'Uncategorized')}</span>
                        </span>
                      </td>
                      <td class="py-2.5 pr-3">${esc(t.payment_method)}</td>
                      <td class="py-2.5 pr-3">
                        <span class="text-[11px] text-slate-400 mr-1">${esc(t.import_source)}</span>
                        <span class="pp-pill ${txStatusPill(t.reconciliation_status)}">${esc(t.reconciliation_status)}</span>
                      </td>
                      <td class="py-2.5 text-right font-bold ${t.type === 'income' || t.type === 'refund' ? 'text-emerald-400' : ''}">
                        ${t.type === 'income' ? '+' : t.type === 'transfer' ? '⇄ ' : ''}${fmtINR(t.amount_paise)}
                      </td>
                    </tr>
                  `).join('')}
                </tbody>
              </table>
            </div>
            <div class="mt-3 flex items-center justify-between border-t border-slate-500/15 pt-3">
              <span class="text-xs text-slate-400">Showing ${data.items.length} of ${data.total} (Page ${data.page})</span>
              <div class="flex gap-2">
                <button type="button" class="pp-btn pp-btn-ghost pp-btn-sm" id="tx-prev" ${data.page <= 1 ? 'disabled' : ''}>Prev</button>
                <button type="button" class="pp-btn pp-btn-ghost pp-btn-sm" id="tx-next" ${data.page * data.limit >= data.total ? 'disabled' : ''}>Next</button>
              </div>
            </div>
          `}
        </div>
      </div>
    `;

    root.querySelector('#tx-f-apply')?.addEventListener('click', () => {
      filters.q = root.querySelector('#tx-f-q').value;
      filters.type = root.querySelector('#tx-f-type').value;
      filters.categoryId = root.querySelector('#tx-f-cat').value;
      filters.paymentMethod = root.querySelector('#tx-f-pm').value;
      filters.page = 1;
      loadList();
    });
    root.querySelector('#btn-empty-add')?.addEventListener('click', () => openTxModal());
    root.querySelector('#tx-prev')?.addEventListener('click', () => { filters.page--; loadList(); });
    root.querySelector('#tx-next')?.addEventListener('click', () => { filters.page++; loadList(); });
    root.querySelectorAll('.tx-row').forEach((tr) => {
      tr.addEventListener('click', async () => {
        const res = await api(`/api/v1/transactions/${tr.dataset.txId}`);
        openTxModal(res.transaction);
      });
    });
  };
  await loadList();
}

// --- ADD / EDIT / SPLIT TRANSACTION MODAL ---
const txModal = document.getElementById('tx-modal');
const txForm = document.getElementById('tx-form');
let editingTxOrigCat = null;

function addSplitRow(split = { categoryId: '', amount_paise: 0, note: '' }) {
  const list = document.getElementById('tx-splits-list');
  const row = document.createElement('div');
  row.className = 'flex items-center gap-2 split-item';
  row.innerHTML = `
    <select class="pp-input sp-cat flex-1 text-xs">
      ${state.categories.map((c) => `<option value="${c.id}" ${c.id === split.categoryId || c.id === split.category_id ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}
    </select>
    <input type="number" step="0.01" class="pp-input sp-amt w-28 text-xs" value="${split.amount_paise ? (split.amount_paise / 100).toFixed(2) : ''}" placeholder="Amount ₹">
    <button type="button" class="pp-btn pp-btn-ghost pp-btn-sm sp-rm">&times;</button>
  `;
  row.querySelector('.sp-rm').addEventListener('click', () => row.remove());
  list.appendChild(row);
}

function openTxModal(existingTx = null, aiDraft = null) {
  const catSel = document.getElementById('tx-category');
  catSel.innerHTML = state.categories.map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join('');
  document.getElementById('tx-splits-list').innerHTML = '';

  const isEdit = Boolean(existingTx);
  document.getElementById('tx-modal-title').textContent = isEdit ? 'Edit / Reconcile Transaction' : 'Add Transaction';
  document.getElementById('btn-delete-tx').classList.toggle('hidden', !isEdit);
  document.getElementById('tx-learn-rule-wrap').classList.toggle('hidden', !isEdit);
  document.getElementById('tx-receipt-box').classList.toggle('hidden', !isEdit);

  if (existingTx) {
    editingTxOrigCat = existingTx.category_id;
    document.getElementById('tx-id').value = existingTx.id;
    document.getElementById('tx-amount').value = (existingTx.amount_paise / 100).toFixed(2);
    document.getElementById('tx-type').value = existingTx.type;
    document.getElementById('tx-merchant').value = existingTx.merchant;
    document.getElementById('tx-date').value = existingTx.local_date;
    catSel.value = existingTx.category_id || state.categories[0]?.id || '';
    document.getElementById('tx-method').value = existingTx.payment_method;
    document.getElementById('tx-ref').value = existingTx.reference_id || '';
    document.getElementById('tx-status').value = existingTx.reconciliation_status;
    document.getElementById('tx-notes').value = existingTx.notes || '';
    document.getElementById('tx-tags').value = (existingTx.tags || []).join(', ');
    if (existingTx.splits?.length) existingTx.splits.forEach(addSplitRow);
    document.getElementById('tx-receipt-status').innerHTML = existingTx.receipt_path
      ? `<a href="/api/v1/transactions/${existingTx.id}/receipt" target="_blank" class="text-sky-400 hover:underline">View uploaded receipt</a>`
      : 'Attach receipt (PNG/JPG/PDF ≤5MB)';
  } else if (aiDraft) {
    editingTxOrigCat = null;
    document.getElementById('tx-id').value = '';
    document.getElementById('tx-amount').value = aiDraft.amountRupees || '';
    document.getElementById('tx-type').value = aiDraft.type || 'expense';
    document.getElementById('tx-merchant').value = aiDraft.merchant || '';
    document.getElementById('tx-date').value = aiDraft.localDate || getTodayInUserTz();
    if (aiDraft.categoryId) catSel.value = aiDraft.categoryId;
    document.getElementById('tx-method').value = aiDraft.paymentMethod || 'PhonePe UPI';
    document.getElementById('tx-ref').value = '';
    document.getElementById('tx-status').value = 'verified';
    document.getElementById('tx-notes').value = aiDraft.notes || '';
    document.getElementById('tx-tags').value = '';
    showToast(`Parsed via ${aiDraft.parsedBy} — review & Save!`);
  } else {
    editingTxOrigCat = null;
    txForm.reset();
    document.getElementById('tx-id').value = '';
    document.getElementById('tx-date').value = getTodayInUserTz();
    document.getElementById('tx-status').value = 'verified';
  }
  txModal.showModal();
}

document.getElementById('btn-close-tx-modal').addEventListener('click', () => txModal.close());
document.getElementById('btn-cancel-tx').addEventListener('click', () => txModal.close());
document.getElementById('btn-add-split').addEventListener('click', () => addSplitRow());

document.getElementById('btn-ai-parse').addEventListener('click', async () => {
  const text = document.getElementById('ai-parse-input').value.trim();
  if (!text) return showToast('Type a sentence like "Paid Rs 420 to Swiggy"', true);
  try {
    const { draft } = await api('/api/v1/ai/parse-expense', { method: 'POST', body: { text } });
    document.getElementById('tx-amount').value = draft.amountRupees;
    document.getElementById('tx-type').value = draft.type;
    document.getElementById('tx-merchant').value = draft.merchant;
    document.getElementById('tx-date').value = draft.localDate;
    if (draft.categoryId) document.getElementById('tx-category').value = draft.categoryId;
    document.getElementById('tx-method').value = draft.paymentMethod;
    document.getElementById('tx-notes').value = draft.notes || '';
    showToast(`AI extracted (${draft.parsedBy})`);
  } catch (e) { showToast(e.message, true); }
});

document.getElementById('btn-ai-cat').addEventListener('click', async () => {
  const merchant = document.getElementById('tx-merchant').value;
  if (!merchant) return showToast('Enter a merchant name first', true);
  try {
    const { suggestion } = await api('/api/v1/ai/suggest-category', {
      method: 'POST',
      body: { merchant, description: document.getElementById('tx-notes').value, type: document.getElementById('tx-type').value }
    });
    if (suggestion.categoryId) document.getElementById('tx-category').value = suggestion.categoryId;
    showToast(`Suggested: ${suggestion.name} (${suggestion.reason})`);
  } catch (e) { showToast(e.message, true); }
});

document.getElementById('btn-tx-add-cat')?.addEventListener('click', () => {
  const row = document.getElementById('tx-new-cat-row');
  row?.classList.toggle('hidden');
  if (!row?.classList.contains('hidden')) document.getElementById('tx-new-cat-name')?.focus();
});

document.getElementById('btn-tx-new-cat-save')?.addEventListener('click', async () => {
  const input = document.getElementById('tx-new-cat-name');
  const name = (input?.value || '').trim();
  if (name.length < 2) return showToast('Enter at least 2 characters for category name', true);
  try {
    const txType = document.getElementById('tx-type')?.value || 'expense';
    const kind = txType === 'income' ? 'income' : txType === 'transfer' ? 'transfer' : 'expense';
    const res = await api('/api/v1/categories', { method: 'POST', body: { name, kind } });
    const catRes = await api('/api/v1/categories');
    state.categories = catRes.categories;
    const catSel = document.getElementById('tx-category');
    catSel.innerHTML = state.categories.map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join('');
    if (res.category?.id) catSel.value = res.category.id;
    input.value = '';
    document.getElementById('tx-new-cat-row')?.classList.add('hidden');
    showToast(res.created ? `Category "${res.category.name}" added` : `Selected "${res.category.name}"`);
  } catch (e) { showToast(e.message, true); }
});

txForm.addEventListener('submit', async (e) => {
  e.preventDefault();
  const id = document.getElementById('tx-id').value;
  const splits = Array.from(document.querySelectorAll('#tx-splits-list .split-item')).map((row) => ({
    categoryId: row.querySelector('.sp-cat').value,
    amount: row.querySelector('.sp-amt').value
  })).filter((s) => Number(s.amount) > 0);

  const payload = {
    amount: document.getElementById('tx-amount').value,
    type: document.getElementById('tx-type').value,
    merchant: document.getElementById('tx-merchant').value,
    localDate: document.getElementById('tx-date').value,
    categoryId: document.getElementById('tx-category').value,
    paymentMethod: document.getElementById('tx-method').value,
    referenceId: document.getElementById('tx-ref').value || null,
    reconciliationStatus: document.getElementById('tx-status').value,
    notes: document.getElementById('tx-notes').value,
    tags: document.getElementById('tx-tags').value.split(',').map((t) => t.trim()).filter(Boolean),
    splits: splits.length > 1 ? splits : undefined,
    learnRule: Boolean(id && document.getElementById('tx-learn-rule').checked && document.getElementById('tx-category').value !== editingTxOrigCat)
  };

  try {
    let savedId = id;
    if (id) {
      await api(`/api/v1/transactions/${id}`, { method: 'PUT', body: payload });
      showToast('Transaction updated');
    } else {
      const res = await api('/api/v1/transactions', { method: 'POST', body: payload });
      savedId = res.transaction?.id;
      showToast(res.duplicateWarning ? `Saved (Flagged: ${res.duplicateWarning})` : 'Transaction added');
    }
    const rcpFile = document.getElementById('tx-receipt-file')?.files?.[0];
    if (savedId && rcpFile) {
      const fd = new FormData();
      fd.append('receipt', rcpFile);
      await api(`/api/v1/transactions/${savedId}/receipt`, { method: 'POST', body: fd });
    }
    txModal.close();
    navigateTo(state.route, false);
  } catch (err) { showToast(err.message, true); }
});

document.getElementById('btn-delete-tx').addEventListener('click', async () => {
  const id = document.getElementById('tx-id').value;
  if (!id || !confirm('Delete this transaction permanently?')) return;
  await api(`/api/v1/transactions/${id}`, { method: 'DELETE' });
  txModal.close();
  showToast('Transaction deleted');
  navigateTo(state.route, false);
});

// --- ROUTER & NAVIGATION ---
function trigger3DEntrance(el) {
  if (!el) return;
  el.classList.remove('pp-view-enter');
  void el.offsetWidth;
  el.classList.add('pp-view-enter');
}

async function renderActiveRoute(route) {
  cleanupAllScenes();
  document.querySelectorAll('.view-section').forEach((s) => s.classList.add('hidden'));
  document.querySelectorAll('.pp-nav-item, .pp-dock-item').forEach((a) => {
    if (a.dataset.route) a.classList.toggle('active', a.dataset.route === route);
  });

  const target = document.getElementById(`view-${route}`) || document.getElementById('view-dashboard');
  target.classList.remove('hidden');
  trigger3DEntrance(target);
  document.getElementById('page-title').textContent = ROUTE_TITLES[route] || 'Dashboard';

  const refreshAll = () => bootstrapUser().then(() => renderActiveRoute(state.route));

  try {
    if (route === 'dashboard') await renderDashboardView(target);
    else if (route === 'transactions' || route === 'transactions/new') await renderTransactionsView(target);
    else if (route === 'import') await renderImportView(target, refreshAll);
    else if (route === 'budgets') await renderBudgetsView(target);
    else if (route === 'goals') await renderGoalsView(target);
    else if (route === 'reports') await renderReportsView(target);
    else if (route === 'email-settings') await renderEmailSettingsView(target);
    else if (route === 'settings') await renderSettingsView(target, refreshAll);
  } catch (err) {
    target.innerHTML = `<div class="rounded-xl border border-rose-500/35 bg-rose-500/10 p-4 text-xs text-rose-700 dark:text-rose-300">Failed to load view: ${esc(err.message)}</div>`;
  }
}

function navigateTo(route, pushHistory = true) {
  const clean = ROUTE_TITLES[route] ? route : 'dashboard';
  state.route = clean;
  if (pushHistory) window.history.pushState({ route: clean }, '', `/${clean}`);
  setSidebarOpen(false);

  if (document.startViewTransition && !state.settings.reduced_motion) {
    document.startViewTransition(() => renderActiveRoute(clean));
  } else {
    renderActiveRoute(clean);
  }
}

async function bootstrapUser() {
  const [me, catRes, aiRes] = await Promise.all([
    api('/api/v1/auth/me'),
    api('/api/v1/categories'),
    api('/api/v1/ai/status')
  ]);
  state.user = me.user;
  state.settings = me.settings;
  state.categories = catRes.categories;
  state.aiStatus = aiRes;
  applyThemeAndMotion();
  document.getElementById('user-name-label').textContent = me.user.name;
  document.getElementById('user-email-label').textContent = me.user.email;
  const aiPill = document.getElementById('ai-status-pill');
  if (aiPill) aiPill.textContent = aiRes.geminiConfigured ? 'Gemini AI: Connected' : 'Smart Rules: Active';
  const chatMode = document.getElementById('ai-chat-mode');
  if (chatMode) chatMode.textContent = aiRes.geminiConfigured ? 'Assistant Ready · Grounded in ledger' : 'Rule Engine · Grounded in ledger';
}

// --- AUTH SCREEN WIRING ---
function showAuthAlert(msg, isInfo = false) {
  const el = document.getElementById('auth-alert');
  el.textContent = msg;
  el.className = `rounded-xl border px-3.5 py-2.5 text-xs font-medium ${
    isInfo
      ? 'border-sky-500/40 bg-sky-500/10 text-sky-700 dark:text-sky-300'
      : 'border-rose-500/40 bg-rose-500/10 text-rose-700 dark:text-rose-300'
  }`;
  el.classList.remove('hidden');
}

document.querySelectorAll('[data-auth-tab]').forEach((btn) => {
  btn.addEventListener('click', () => {
    const tab = btn.dataset.authTab;
    document.querySelectorAll('[data-auth-tab]').forEach((b) => {
      const isAct = b === btn;
      b.classList.toggle('active', isAct);
      b.classList.toggle('bg-sky-500/20', isAct);
      b.classList.toggle('text-sky-400', isAct);
      b.classList.toggle('text-slate-400', !isAct);
    });
    document.getElementById('form-login').classList.toggle('hidden', tab !== 'login');
    document.getElementById('form-register').classList.toggle('hidden', tab !== 'register');
    document.getElementById('form-reset').classList.toggle('hidden', tab !== 'reset');
    document.getElementById('auth-alert').classList.add('hidden');
  });
});

document.getElementById('form-login').addEventListener('submit', async (e) => {
  e.preventDefault();
  const fd = new FormData(e.target);
  try {
    await api('/api/v1/auth/login', { method: 'POST', body: Object.fromEntries(fd.entries()) });
    await enterApp('dashboard');
  } catch (err) { showAuthAlert(err.message); }
});

document.getElementById('form-register').addEventListener('submit', async (e) => {
  e.preventDefault();
  const fd = new FormData(e.target);
  try {
    await api('/api/v1/auth/register', {
      method: 'POST',
      body: { email: fd.get('email'), name: fd.get('name'), password: fd.get('password'), timezone: fd.get('timezone') }
    });
    if (fd.get('loadDemo')) {
      await api('/api/v1/transactions/demo-seed', { method: 'POST' });
    }
    await enterApp('dashboard');
  } catch (err) { showAuthAlert(err.message); }
});

document.getElementById('form-reset').addEventListener('submit', async (e) => {
  e.preventDefault();
  const fd = new FormData(e.target);
  try {
    const r = await api('/api/v1/auth/password-reset/request', { method: 'POST', body: { email: fd.get('email') } });
    document.getElementById('reset-confirm-box').classList.remove('hidden');
    if (r.devResetToken) {
      document.getElementById('reset-token-input').value = r.devResetToken;
      showAuthAlert(`Reset token generated (dev preview): ${r.devResetToken}`, true);
    } else {
      showAuthAlert(r.message, true);
    }
  } catch (err) { showAuthAlert(err.message); }
});

document.getElementById('btn-confirm-reset').addEventListener('click', async () => {
  try {
    await api('/api/v1/auth/password-reset/confirm', {
      method: 'POST',
      body: {
        token: document.getElementById('reset-token-input').value,
        newPassword: document.getElementById('reset-new-password').value
      }
    });
    showAuthAlert('Password reset! You can now sign in.', true);
  } catch (err) { showAuthAlert(err.message); }
});

async function enterApp(initialRoute) {
  await bootstrapUser();
  document.getElementById('auth-shell').classList.add('hidden');
  document.getElementById('app-shell').classList.remove('hidden');
  navigateTo(initialRoute || 'dashboard', false);
  if (window.location.pathname === '/transactions/new') openTxModal();
}

// Global shell actions
document.querySelectorAll('.pp-nav-item, .pp-dock-item[data-route]').forEach((a) => {
  a.addEventListener('click', (e) => {
    e.preventDefault();
    navigateTo(a.dataset.route);
  });
});

document.getElementById('btn-quick-add')?.addEventListener('click', () => openTxModal());
document.getElementById('btn-dock-add')?.addEventListener('click', () => openTxModal());
document.getElementById('btn-open-sidebar')?.addEventListener('click', () => setSidebarOpen(true));
document.getElementById('btn-mobile-more')?.addEventListener('click', () => setSidebarOpen(true));
document.getElementById('btn-close-sidebar')?.addEventListener('click', () => setSidebarOpen(false));
document.getElementById('sidebar-backdrop')?.addEventListener('click', () => setSidebarOpen(false));
document.getElementById('btn-logout').addEventListener('click', async () => {
  await api('/api/v1/auth/logout', { method: 'POST' });
  window.location.href = '/auth';
});

document.getElementById('btn-toggle-theme').addEventListener('click', async () => {
  state.settings.theme = state.settings.theme === 'dark' ? 'light' : 'dark';
  applyThemeAndMotion();
  await api('/api/v1/settings', { method: 'PUT', body: { theme: state.settings.theme } });
});

document.getElementById('btn-toggle-3d').addEventListener('click', async () => {
  state.settings.enable_3d = !state.settings.enable_3d;
  applyThemeAndMotion();
  await api('/api/v1/settings', { method: 'PUT', body: { enable_3d: state.settings.enable_3d } });
  if (state.route === 'dashboard') renderActiveRoute('dashboard');
});

// Floating round AI Insights chatbot (bottom-right)
let aiChatLoaded = false;

function appendChatBubble(role, htmlBody) {
  const list = document.getElementById('ai-chat-messages');
  if (!list) return null;
  const wrap = document.createElement('div');
  wrap.className = role === 'user' ? 'flex justify-end' : 'flex justify-start';
  const bubble = document.createElement('div');
  bubble.className = role === 'user'
    ? 'max-w-[85%] rounded-2xl rounded-br-sm bg-slate-900 text-white dark:bg-emerald-500 dark:text-slate-950 px-3 py-2 font-medium shadow-sm'
    : 'max-w-[90%] rounded-2xl rounded-bl-sm border border-slate-500/20 bg-slate-500/10 px-3 py-2 leading-relaxed';
  bubble.innerHTML = htmlBody;
  wrap.appendChild(bubble);
  list.appendChild(wrap);
  list.scrollTop = list.scrollHeight;
  return bubble;
}

async function ensureAiChatBootstrap() {
  if (aiChatLoaded) return;
  aiChatLoaded = true;
  const monthKey = state.monthKey || getTodayInUserTz().slice(0, 7);
  appendChatBubble('bot', `<strong>Hi ${esc(state.user?.name || 'there')}!</strong> Ask any question about your spending or budgets.`);
  try {
    const data = await api(`/api/v1/insights?monthKey=${encodeURIComponent(monthKey)}`);
    if (data.insights?.length) {
      const topHtml = data.insights.slice(0, 3).map((ins) => `<div class="mt-1"><strong>${esc(ins.title)}:</strong> ${esc(ins.detail)}</div>`).join('');
      appendChatBubble('bot', `<span class="text-[11px] font-semibold text-sky-600 dark:text-sky-400">Latest Insights (${esc(data.monthKey)})</span>${topHtml}`);
    }
    if (data.recurringCandidates?.length) {
      const repHtml = data.recurringCandidates.slice(0, 3).map((rc) => `<div class="flex justify-between gap-2 mt-1"><span>${esc(rc.merchant)} (${rc.cnt}x)</span><strong>${fmtINR(rc.amt)}</strong></div>`).join('');
      appendChatBubble('bot', `<span class="text-[11px] font-semibold text-emerald-600 dark:text-emerald-400">Repeat Merchants</span>${repHtml}`);
    }
  } catch {
    // Non-blocking: chat works even if initial insights summary isn't loaded
  }
}

async function askAiChat(question) {
  const q = String(question || '').trim();
  if (!q) return;
  const monthKey = state.monthKey || getTodayInUserTz().slice(0, 7);
  appendChatBubble('user', esc(q));
  const pending = appendChatBubble('bot', '<span class="text-slate-400">Analyzing your ledger...</span>');
  try {
    const res = await api('/api/v1/ai/ask', { method: 'POST', body: { question: q, monthKey } });
    if (pending) {
      pending.innerHTML = `<div class="mb-1 text-[10px] font-semibold uppercase tracking-wide text-sky-600 dark:text-sky-400">${esc(res.source)}</div><div class="whitespace-pre-line">${esc(res.answer)}</div>`;
    }
  } catch (err) {
    if (pending) pending.textContent = err.message;
  }
}

document.getElementById('ai-chat-fab')?.addEventListener('click', () => {
  const panel = document.getElementById('ai-chat-panel');
  if (!panel) return;
  const opening = panel.classList.contains('hidden');
  panel.classList.toggle('hidden', !opening);
  if (opening) {
    ensureAiChatBootstrap();
    document.getElementById('ai-chat-input')?.focus();
  }
});

document.getElementById('btn-close-ai-chat')?.addEventListener('click', () => {
  document.getElementById('ai-chat-panel')?.classList.add('hidden');
});

document.querySelectorAll('.ai-chat-chip').forEach((btn) => {
  btn.addEventListener('click', () => {
    ensureAiChatBootstrap().then(() => askAiChat(btn.dataset.q));
  });
});

document.getElementById('ai-chat-form')?.addEventListener('submit', (e) => {
  e.preventDefault();
  const inp = document.getElementById('ai-chat-input');
  const q = inp.value;
  inp.value = '';
  ensureAiChatBootstrap().then(() => askAiChat(q));
});

window.addEventListener('popstate', () => {
  const pathRoute = window.location.pathname.replace(/^\/+/, '') || 'dashboard';
  if (state.user) navigateTo(pathRoute, false);
});

function dismissLaunchSplash() {
  const splash = document.getElementById('pp-launch-splash');
  if (!splash) return;
  const reduced = document.documentElement.dataset.reducedMotion === 'true'
    || window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  const delay = reduced ? 0 : 520;
  setTimeout(() => {
    splash.classList.add('is-leaving');
    setTimeout(() => splash.remove(), reduced ? 0 : 400);
  }, delay);
}

// Boot
(async () => {
  const path = window.location.pathname.replace(/^\/+/, '') || 'dashboard';
  try {
    await enterApp(path === 'auth' ? 'dashboard' : path);
  } catch {
    document.getElementById('app-shell').classList.add('hidden');
    document.getElementById('auth-shell').classList.remove('hidden');
  } finally {
    dismissLaunchSplash();
  }
})();
