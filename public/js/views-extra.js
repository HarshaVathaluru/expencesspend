import { api, state, esc, fmtINR, showToast, getTodayInUserTz } from './api.js?v=7';

function pillClass(status) {
  const s = String(status || '').toLowerCase();
  if (s === 'verified' || s === 'active' || s === 'processed' || s === 'sent') return 'pp-pill-verified';
  if (s === 'captured') return 'pp-pill-captured';
  if (s === 'possible_duplicate' || s === 'failed') return 'pp-pill-possible_duplicate';
  if (s === 'needs_review' || s === 'paused' || s === 'pending') return 'pp-pill-needs_review';
  return 'pp-pill-neutral';
}

// 5. IMPORT CENTER & PAYMENT IMAGE SCANNER
export async function renderImportView(root, onRefreshAll) {
  root.innerHTML = `<div class="skeleton h-40"></div>`;
  const batchesRes = await api('/api/v1/ingestion/batches');
  let previewData = null;
  let imageDraft = null;
  let imageFile = null;
  let imagePreviewUrl = null;

  const revokePreview = () => {
    if (imagePreviewUrl) {
      URL.revokeObjectURL(imagePreviewUrl);
      imagePreviewUrl = null;
    }
  };

  const render = () => {
    const paymentMethods = ['PhonePe UPI', 'Other UPI', 'Debit Card', 'Credit Card', 'Cash', 'Bank Transfer', 'Wallet', 'Other'];
    root.innerHTML = `
      <div class="space-y-4">
        <div class="grid gap-4 lg:grid-cols-2">
          <div class="pp-card space-y-3 p-4">
            <div>
              <h3 class="text-sm font-semibold">Upload Payment Image or Statement</h3>
              <p class="mt-0.5 text-xs text-slate-400">Upload a payment screenshot/receipt (PNG, JPG, WEBP) to detect payment details, or a CSV/PDF statement.</p>
            </div>
            <div class="flex flex-wrap items-center gap-2">
              <input type="file" id="imp-file" accept=".png,.jpg,.jpeg,.webp,.csv,.pdf" class="pp-input flex-1 text-xs">
              <button type="button" class="pp-btn pp-btn-primary pp-btn-sm" id="btn-imp-upload">Detect &amp; Preview</button>
            </div>
            <label class="pp-label">Or Paste CSV Statement Text
              <textarea id="imp-csv-text" rows="3" class="pp-input mt-1 font-mono text-xs" placeholder="Date,Merchant,Amount,Type,Reference&#10;2026-11-10,Swiggy,380.00,Debit,UTR991203"></textarea>
            </label>
            <button type="button" class="pp-btn pp-btn-secondary pp-btn-sm" id="btn-imp-paste">Preview Pasted CSV</button>
          </div>

          <div class="pp-card space-y-3 p-4">
            <h3 class="text-sm font-semibold">Recent Statement Imports</h3>
            ${batchesRes.batches.length === 0 ? `
              <div class="flex flex-col items-center justify-center gap-2 py-6 text-center">
                <img src="/images/empty-reports.svg" alt="" width="104">
                <div class="text-xs text-slate-400">No statement imports yet.</div>
              </div>
            ` : `
              <div class="overflow-x-auto">
                <table class="w-full text-left text-xs">
                  <thead class="border-b border-slate-500/20 text-[11px] uppercase tracking-wide text-slate-400">
                    <tr><th class="py-2 pr-3">File</th><th class="py-2 pr-3">Source</th><th class="py-2 pr-3">Imported</th><th class="py-2 pr-3">Dupes</th><th class="py-2">Failed</th></tr>
                  </thead>
                  <tbody class="divide-y divide-slate-500/15">
                    ${batchesRes.batches.map((b) => `
                      <tr>
                        <td class="py-2 pr-3 font-medium">${esc(b.filename)}</td>
                        <td class="py-2 pr-3">${esc(b.source_type.toUpperCase())}</td>
                        <td class="py-2 pr-3 text-emerald-400 font-semibold">${b.imported_rows}</td>
                        <td class="py-2 pr-3">${b.duplicate_rows}</td>
                        <td class="py-2 ${b.failed_rows ? 'text-rose-400 font-semibold' : ''}">${b.failed_rows}</td>
                      </tr>
                    `).join('')}
                  </tbody>
                </table>
              </div>
            `}
          </div>
        </div>

        ${imageDraft ? `
          <div class="pp-card space-y-4 p-4">
            <div class="flex flex-wrap items-center justify-between gap-2">
              <div>
                <h3 class="text-sm font-semibold">Detected Payment Details</h3>
                <p class="text-xs text-slate-400">${imageDraft.detected ? 'Payment details detected from image. Review or adjust before saving.' : 'Image attached. Enter or confirm payment details below.'}</p>
              </div>
              <span class="pp-pill ${imageDraft.detected ? 'pp-pill-verified' : 'pp-pill-needs_review'}">
                ${imageDraft.detected ? 'Auto-Detected' : 'Manual Review'}
              </span>
            </div>
            <div class="grid gap-4 md:grid-cols-[200px_1fr]">
              <div class="rounded-xl border border-slate-500/20 bg-slate-950/30 p-2 flex items-center justify-center">
                ${imagePreviewUrl ? `<img src="${imagePreviewUrl}" alt="Uploaded payment receipt" class="max-h-56 w-auto rounded-lg object-contain">` : ''}
              </div>
              <form id="form-img-tx" class="grid gap-3 sm:grid-cols-2">
                <label class="pp-label">Amount (INR)
                  <input type="number" step="0.01" min="0.01" name="amount" required value="${esc(imageDraft.amountRupees || '')}" class="pp-input mt-1">
                </label>
                <label class="pp-label">Merchant / Payee
                  <input type="text" name="merchant" required value="${esc(imageDraft.merchant || '')}" placeholder="e.g. Swiggy, Zomato" class="pp-input mt-1">
                </label>
                <label class="pp-label">Type
                  <select name="type" class="pp-input mt-1">
                    ${['expense', 'income', 'transfer', 'refund'].map((tp) => `<option value="${tp}" ${imageDraft.type === tp ? 'selected' : ''}>${tp}</option>`).join('')}
                  </select>
                </label>
                <label class="pp-label">Payment Method
                  <select name="paymentMethod" class="pp-input mt-1">
                    ${paymentMethods.map((m) => `<option value="${m}" ${imageDraft.paymentMethod === m ? 'selected' : ''}>${m}</option>`).join('')}
                  </select>
                </label>
                <label class="pp-label">Category ${imageDraft.autoCreatedCategory ? `<span class="ml-1 text-[10px] text-emerald-400">(Auto-added)</span>` : ''}
                  <div class="mt-1 flex gap-1.5">
                    <select name="categoryId" id="img-tx-cat" class="pp-input flex-1">
                      ${(state.categories || []).map((c) => `<option value="${c.id}" ${imageDraft.categoryId === c.id ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}
                    </select>
                    <button type="button" class="pp-btn pp-btn-ghost pp-btn-sm shrink-0" id="btn-img-add-cat" title="Add custom category">+</button>
                  </div>
                  <div id="img-new-cat-row" class="mt-1.5 hidden flex gap-1.5">
                    <input type="text" id="img-new-cat-name" placeholder="New category name" maxlength="40" class="pp-input text-xs">
                    <button type="button" class="pp-btn pp-btn-secondary pp-btn-sm shrink-0" id="btn-img-new-cat-save">Add</button>
                  </div>
                </label>
                <label class="pp-label">Date
                  <input type="date" name="localDate" required value="${esc(imageDraft.localDate || getTodayInUserTz())}" class="pp-input mt-1">
                </label>
                <label class="pp-label">Reference / UTR
                  <input type="text" name="referenceId" value="${esc(imageDraft.reference || '')}" class="pp-input mt-1">
                </label>
                <label class="pp-label">Notes
                  <input type="text" name="notes" value="${esc(imageDraft.notes || '')}" class="pp-input mt-1">
                </label>
                <div class="sm:col-span-2 flex justify-end gap-2 pt-1">
                  <button type="button" class="pp-btn pp-btn-ghost pp-btn-sm" id="btn-img-cancel">Discard</button>
                  <button type="submit" class="pp-btn pp-btn-primary pp-btn-sm">Save Detected Payment</button>
                </div>
              </form>
            </div>
          </div>
        ` : ''}

        ${previewData ? `
          <div class="pp-card space-y-3 p-4">
            <div class="flex flex-wrap items-center justify-between gap-2">
              <h3 class="text-sm font-semibold">Preview &amp; Column Mapping (${previewData.totalRows} rows in ${esc(previewData.filename)})</h3>
              <button type="button" class="pp-btn pp-btn-primary pp-btn-sm" id="btn-imp-commit">Commit ${previewData.totalRows} Row(s)</button>
            </div>
            <div class="grid gap-2.5 sm:grid-cols-4 lg:grid-cols-7">
              ${['date', 'merchant', 'amount', 'type', 'category', 'paymentMethod', 'reference'].map((field) => `
                <label class="pp-label">${field}
                  <select class="pp-input imp-map-select mt-1" data-field="${field}">
                    <option value="">(None)</option>
                    ${previewData.headers.map((h) => `<option value="${esc(h)}" ${previewData.suggestedMapping[field] === h ? 'selected' : ''}>${esc(h)}</option>`).join('')}
                  </select>
                </label>
              `).join('')}
            </div>
            <div class="overflow-x-auto">
              <table class="w-full text-left text-xs">
                <thead class="border-b border-slate-500/20 text-[11px] uppercase tracking-wide text-slate-400">
                  <tr>${previewData.headers.map((h) => `<th class="py-2 pr-3">${esc(h)}</th>`).join('')}</tr>
                </thead>
                <tbody class="divide-y divide-slate-500/15">
                  ${previewData.previewRows.map((r) => `<tr>${previewData.headers.map((h) => `<td class="py-1.5 pr-3">${esc(r[h])}</td>`).join('')}</tr>`).join('')}
                </tbody>
              </table>
            </div>
          </div>
        ` : ''}
      </div>
    `;

    root.querySelector('#btn-imp-upload')?.addEventListener('click', async () => {
      const f = root.querySelector('#imp-file')?.files?.[0];
      if (!f) return showToast('Choose an image, CSV, or PDF file first', true);
      const fd = new FormData();
      fd.append('file', f);
      const lower = f.name.toLowerCase();
      const isImg = f.type.startsWith('image/') || /\.(png|jpe?g|webp)$/.test(lower);
      const isPdf = lower.endsWith('.pdf');
      try {
        if (isImg) {
          showToast('Detecting payment details from image...');
          const res = await api('/api/v1/ingestion/import/image-preview', { method: 'POST', body: fd });
          if (Array.isArray(res.categories)) state.categories = res.categories;
          revokePreview();
          imageFile = f;
          imagePreviewUrl = URL.createObjectURL(f);
          imageDraft = res.draft;
          previewData = null;
          if (res.draft?.autoCreatedCategory) {
            showToast(`Auto-added category: ${res.draft.categoryName}`);
          }
          render();
        } else {
          revokePreview();
          imageDraft = null;
          imageFile = null;
          previewData = await api(isPdf ? '/api/v1/ingestion/import/pdf-preview' : '/api/v1/ingestion/import/csv-preview', { method: 'POST', body: fd });
          previewData.sourceType = isPdf ? 'pdf' : 'csv';
          render();
        }
      } catch (e) { showToast(e.message, true); }
    });

    root.querySelector('#btn-imp-paste')?.addEventListener('click', async () => {
      const csvText = root.querySelector('#imp-csv-text').value;
      try {
        revokePreview();
        imageDraft = null;
        imageFile = null;
        previewData = await api('/api/v1/ingestion/import/csv-preview', { method: 'POST', body: { csvText } });
        previewData.sourceType = 'csv';
        render();
      } catch (e) { showToast(e.message, true); }
    });

    root.querySelector('#btn-img-cancel')?.addEventListener('click', () => {
      revokePreview();
      imageDraft = null;
      imageFile = null;
      render();
    });

    root.querySelector('#btn-img-add-cat')?.addEventListener('click', () => {
      const row = root.querySelector('#img-new-cat-row');
      row?.classList.toggle('hidden');
      if (!row?.classList.contains('hidden')) root.querySelector('#img-new-cat-name')?.focus();
    });

    root.querySelector('#btn-img-new-cat-save')?.addEventListener('click', async () => {
      const input = root.querySelector('#img-new-cat-name');
      const name = (input?.value || '').trim();
      if (name.length < 2) return showToast('Enter at least 2 characters for category name', true);
      try {
        const res = await api('/api/v1/categories', { method: 'POST', body: { name, kind: imageDraft?.type === 'income' ? 'income' : 'expense' } });
        const catRes = await api('/api/v1/categories');
        state.categories = catRes.categories;
        if (res.category?.id && imageDraft) imageDraft.categoryId = res.category.id;
        showToast(res.created ? `Category "${res.category.name}" added` : `Selected "${res.category.name}"`);
        render();
      } catch (err) { showToast(err.message, true); }
    });

    root.querySelector('#form-img-tx')?.addEventListener('submit', async (e) => {
      e.preventDefault();
      const fd = new FormData(e.target);
      try {
        const res = await api('/api/v1/transactions', {
          method: 'POST',
          body: {
            amount: fd.get('amount'),
            merchant: fd.get('merchant'),
            type: fd.get('type'),
            paymentMethod: fd.get('paymentMethod'),
            categoryId: fd.get('categoryId') || null,
            localDate: fd.get('localDate'),
            referenceId: fd.get('referenceId') || null,
            notes: fd.get('notes') || '',
            importSource: 'receipt_scan',
            reconciliationStatus: 'verified'
          }
        });
        const savedId = res.transaction?.id;
        if (savedId && imageFile) {
          const rfd = new FormData();
          rfd.append('receipt', imageFile);
          await api(`/api/v1/transactions/${savedId}/receipt`, { method: 'POST', body: rfd });
        }
        showToast('Detected payment saved to ledger');
        revokePreview();
        imageDraft = null;
        imageFile = null;
        if (onRefreshAll) onRefreshAll();
        else renderImportView(root, onRefreshAll);
      } catch (err) { showToast(err.message, true); }
    });

    root.querySelector('#btn-imp-commit')?.addEventListener('click', async () => {
      const mapping = {};
      root.querySelectorAll('.imp-map-select').forEach((s) => { if (s.value) mapping[s.dataset.field] = s.value; });
      try {
        const res = await api('/api/v1/ingestion/import/commit', {
          method: 'POST',
          body: { rows: previewData.rows, mapping, sourceType: previewData.sourceType, filename: previewData.filename }
        });
        showToast(`Imported ${res.importedRows} transactions (${res.duplicateRows} duplicates skipped, ${res.failedRows} failed).`);
        previewData = null;
        if (onRefreshAll) onRefreshAll();
        renderImportView(root, onRefreshAll);
      } catch (e) { showToast(e.message, true); }
    });
  };
  render();
}

// 7. BUDGETS
export async function renderBudgetsView(root) {
  root.innerHTML = `<div class="skeleton h-40"></div>`;
  const monthKey = state.monthKey || getTodayInUserTz().slice(0, 7);
  const data = await api(`/api/v1/budgets?monthKey=${encodeURIComponent(monthKey)}`);
  const spentMap = new Map((data.spentByCategory || []).map((c) => [c.categoryId, c.totalPaise]));
  const limitMap = new Map((data.categoryLimits || []).map((l) => [l.category_id, l.limit_paise]));
  const overall = data.budget?.overall_limit_paise || 0;
  const pct = overall > 0 ? Math.min(100, Math.round((data.netSpentPaise / overall) * 100)) : 0;

  root.innerHTML = `
    <div class="pp-card space-y-4 p-4">
      <div class="flex flex-wrap items-center justify-between gap-2">
        <h3 class="text-sm font-semibold">Monthly Budget (${esc(data.monthKey)})</h3>
        <strong class="text-sm">${overall > 0 ? `${fmtINR(data.netSpentPaise)} / ${fmtINR(overall)} (${pct}%)` : 'Not configured'}</strong>
      </div>
      <div class="h-2.5 w-full overflow-hidden rounded-full bg-slate-500/20">
        <div class="h-full rounded-full transition-all duration-300 ${pct >= 95 ? 'bg-rose-400' : pct >= 75 ? 'bg-amber-400' : 'bg-emerald-400'}" style="width:${pct}%"></div>
      </div>

      <form id="form-budget" class="space-y-4">
        <div class="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <label class="pp-label">Overall Monthly Budget (INR)
            <input type="number" step="1" name="overallLimit" value="${overall ? (overall / 100).toFixed(0) : ''}" placeholder="45000" required class="pp-input mt-1">
          </label>
          <label class="pp-label">Alert Thresholds (%)
            <input type="text" name="thresholds" value="${esc((data.budget?.alertThresholds || [50, 75, 90, 100]).join(','))}" class="pp-input mt-1">
          </label>
          <label class="pp-label">Reset Day (1-28)
            <input type="number" min="1" max="28" name="resetDay" value="${data.budget?.reset_day || 1}" class="pp-input mt-1">
          </label>
          <label class="flex items-center gap-2 self-end pb-2 text-xs">
            <input type="checkbox" name="rolloverEnabled" ${data.budget?.rollover_enabled ? 'checked' : ''}>
            <span>Enable unspent rollover</span>
          </label>
        </div>

        <div>
          <h4 class="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-400">Per-Category Limits</h4>
          <div class="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            ${state.categories.filter((c) => c.kind === 'expense').map((c) => {
              const lim = limitMap.get(c.id) || 0;
              const sp = spentMap.get(c.id) || 0;
              return `
                <div class="pp-surface-sub space-y-2 p-3">
                  <div class="flex items-center justify-between gap-2">
                    <span class="flex items-center gap-2 text-xs font-semibold"><img src="${c.icon_path}" alt="" width="20" height="20">${esc(c.name)}</span>
                    <span class="text-[11px] text-slate-400">Spent ${fmtINR(sp)}</span>
                  </div>
                  <input type="number" step="1" min="0" class="pp-input cat-limit-input text-xs" data-cat-id="${c.id}" value="${lim ? (lim / 100).toFixed(0) : ''}" placeholder="Limit ₹ (optional)">
                </div>
              `;
            }).join('')}
          </div>
        </div>

        <button type="submit" class="pp-btn pp-btn-primary">Save Budget Settings</button>
      </form>
    </div>
  `;

  root.querySelector('#form-budget').addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const categoryLimits = [];
    root.querySelectorAll('.cat-limit-input').forEach((inp) => {
      if (Number(inp.value) > 0) categoryLimits.push({ categoryId: inp.dataset.catId, limit: inp.value });
    });
    const alertThresholds = String(fd.get('thresholds') || '50,75,90,100').split(',').map((x) => Number(x.trim())).filter(Boolean);
    await api('/api/v1/budgets', {
      method: 'PUT',
      body: {
        monthKey: data.monthKey,
        overallLimit: fd.get('overallLimit'),
        alertThresholds,
        resetDay: Number(fd.get('resetDay') || 1),
        rolloverEnabled: Boolean(fd.get('rolloverEnabled')),
        categoryLimits
      }
    });
    showToast('Budget updated');
    renderBudgetsView(root);
  });
}

// 9. SAVINGS GOALS
export async function renderGoalsView(root) {
  root.innerHTML = `<div class="skeleton h-40"></div>`;
  const { goals } = await api('/api/v1/goals');
  root.innerHTML = `
    <div class="space-y-4">
      <div class="pp-card space-y-3 p-4">
        <h3 class="text-sm font-semibold">Create Savings Goal</h3>
        <form id="form-goal" class="grid gap-3 sm:grid-cols-2 lg:grid-cols-6">
          <label class="pp-label">Goal Name <input type="text" name="name" required placeholder="Emergency Fund" class="pp-input mt-1"></label>
          <label class="pp-label">Target (INR) <input type="number" step="1" min="1" name="target" required placeholder="150000" class="pp-input mt-1"></label>
          <label class="pp-label">Saved (INR) <input type="number" step="1" min="0" name="current" value="0" class="pp-input mt-1"></label>
          <label class="pp-label">Target Date <input type="date" name="targetDate" class="pp-input mt-1"></label>
          <label class="pp-label">Monthly (INR) <input type="number" step="1" min="0" name="monthlyContribution" placeholder="10000" class="pp-input mt-1"></label>
          <div class="self-end"><button type="submit" class="pp-btn pp-btn-primary w-full">Add Goal</button></div>
        </form>
      </div>

      <div class="grid gap-4 md:grid-cols-2">
        ${goals.length === 0 ? `
          <div class="pp-card flex flex-col items-center justify-center gap-2 p-6 text-center md:col-span-2">
            <img src="/images/empty-budgets.svg" alt="" width="108">
            <div class="text-xs text-slate-400">No savings goals yet.</div>
          </div>
        ` : goals.map((g) => {
          const pct = Math.min(100, Math.round((g.current_paise / g.target_paise) * 100));
          return `
            <div class="pp-card space-y-3 p-4">
              <div class="flex items-center justify-between gap-2">
                <strong class="text-sm">${esc(g.name)}</strong>
                <span class="pp-pill pp-pill-verified">${pct}% · ${esc(g.status)}</span>
              </div>
              <div class="text-xs text-slate-400">${fmtINR(g.current_paise)} of ${fmtINR(g.target_paise)} ${g.target_date ? '· Target ' + esc(g.target_date) : ''}</div>
              <div class="h-2 w-full overflow-hidden rounded-full bg-slate-500/20">
                <div class="h-full rounded-full bg-emerald-400 transition-all duration-300" style="width:${pct}%"></div>
              </div>
              <div class="flex flex-wrap gap-2">
                <button type="button" class="pp-btn pp-btn-secondary pp-btn-sm" data-goal-add="${g.id}">+ ₹1,000</button>
                <button type="button" class="pp-btn pp-btn-ghost pp-btn-sm" data-goal-custom="${g.id}">Add Custom</button>
                <button type="button" class="pp-btn pp-btn-danger pp-btn-sm" data-goal-del="${g.id}">Delete</button>
              </div>
            </div>
          `;
        }).join('')}
      </div>
    </div>
  `;

  root.querySelector('#form-goal').addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    await api('/api/v1/goals', { method: 'POST', body: Object.fromEntries(fd.entries()) });
    showToast('Goal created');
    renderGoalsView(root);
  });

  root.querySelectorAll('[data-goal-add]').forEach((b) => {
    b.addEventListener('click', async () => {
      await api(`/api/v1/goals/${b.dataset.goalAdd}`, { method: 'PATCH', body: { deltaAmount: 1000, action: 'add' } });
      showToast('Added ₹1,000 to goal');
      renderGoalsView(root);
    });
  });

  root.querySelectorAll('[data-goal-custom]').forEach((b) => {
    b.addEventListener('click', async () => {
      const val = prompt('Enter INR amount to contribute:');
      if (!val || Number.isNaN(Number(val))) return;
      await api(`/api/v1/goals/${b.dataset.goalCustom}`, { method: 'PATCH', body: { deltaAmount: Number(val), action: 'add' } });
      renderGoalsView(root);
    });
  });

  root.querySelectorAll('[data-goal-del]').forEach((b) => {
    b.addEventListener('click', async () => {
      if (!confirm('Delete this savings goal?')) return;
      await api(`/api/v1/goals/${b.dataset.goalDel}`, { method: 'DELETE' });
      renderGoalsView(root);
    });
  });
}

// 12. REPORTS & EXPORTS
export async function renderReportsView(root) {
  const monthKey = state.monthKey || getTodayInUserTz().slice(0, 7);
  const start = `${monthKey}-01`;
  const end = getTodayInUserTz();
  root.innerHTML = `
    <div class="pp-card max-w-3xl space-y-4 p-4">
      <div>
        <h3 class="text-sm font-semibold">Statements &amp; Data Exports</h3>
        <p class="mt-0.5 text-xs text-slate-400">Exports include only your authenticated transactions, categories, payment methods, and reconciliation status.</p>
      </div>
      <div class="grid gap-3 sm:grid-cols-2">
        <label class="pp-label">Start Date <input type="date" id="rep-start" value="${start}" class="pp-input mt-1"></label>
        <label class="pp-label">End Date <input type="date" id="rep-end" value="${end}" class="pp-input mt-1"></label>
      </div>
      <div class="flex flex-wrap gap-2">
        <a class="pp-btn pp-btn-primary pp-btn-sm" id="btn-dl-csv" href="/api/v1/reports/export/csv?startDate=${start}&endDate=${end}">Download CSV Statement</a>
        <a class="pp-btn pp-btn-secondary pp-btn-sm" id="btn-dl-pdf" href="/api/v1/reports/export/pdf?startDate=${start}&endDate=${end}">Download PDF Statement</a>
        <a class="pp-btn pp-btn-ghost pp-btn-sm" href="/api/v1/reports/export/json">Export Full Account JSON</a>
      </div>
    </div>
  `;
  const syncLinks = () => {
    const s = root.querySelector('#rep-start').value;
    const e = root.querySelector('#rep-end').value;
    root.querySelector('#btn-dl-csv').href = `/api/v1/reports/export/csv?startDate=${s}&endDate=${e}`;
    root.querySelector('#btn-dl-pdf').href = `/api/v1/reports/export/pdf?startDate=${s}&endDate=${e}`;
  };
  root.querySelector('#rep-start').addEventListener('change', syncLinks);
  root.querySelector('#rep-end').addEventListener('change', syncLinks);
}

// 13. BREVO 11 PM EMAIL SETTINGS
export async function renderEmailSettingsView(root) {
  root.innerHTML = `<div class="skeleton h-40"></div>`;
  const [emailCfg, preview] = await Promise.all([
    api('/api/v1/email/settings'),
    api('/api/v1/email/preview')
  ]);

  root.innerHTML = `
    <div class="space-y-4">
      ${!emailCfg.brevoConfigured ? `
        <div class="rounded-xl border border-amber-500/35 bg-amber-500/10 px-4 py-3 text-xs">
          <strong class="text-amber-400">Brevo Credentials Needed:</strong> Set <code>BREVO_API_KEY</code> and verified <code>BREVO_SENDER_EMAIL</code> in server <code>.env</code> to dispatch live emails. Preview &amp; schedule configuration remain active.
        </div>
      ` : ''}

      <div class="grid gap-4 lg:grid-cols-2">
        <div class="pp-card space-y-3 p-4">
          <h3 class="text-sm font-semibold">4-Day Expenses &amp; Budget Alert Settings</h3>
          <p class="text-xs text-slate-400">Receive a 4-day expenses summary every 4 days, plus a budget-exceeded alert email 1 hour after uploading a bill that crosses your budget.</p>
          <form id="form-email-cfg" class="space-y-3">
            <label class="pp-label">Recipient Email
              <input type="email" name="email_recipient" value="${esc(emailCfg.settings.email_recipient)}" required class="pp-input mt-1">
            </label>
            <div class="flex flex-wrap items-center justify-between gap-2">
              <span class="pp-pill ${emailCfg.settings.email_verified ? 'pp-pill-verified' : 'pp-pill-needs_review'}">
                ${emailCfg.settings.email_verified ? 'Email Confirmed' : 'Confirmation Required'}
              </span>
              <button type="button" class="pp-btn pp-btn-secondary pp-btn-sm" id="btn-verify-email">Confirm Email Address</button>
            </div>
            <div id="verify-code-box" class="hidden flex gap-2">
              <input type="text" id="verify-code-input" placeholder="6-digit code" class="pp-input flex-1 text-xs">
              <button type="button" class="pp-btn pp-btn-primary pp-btn-sm" id="btn-confirm-code">Verify</button>
            </div>
            <div class="grid gap-3 sm:grid-cols-2">
              <label class="pp-label">Digest Delivery Time (Every 4 Days)
                <input type="time" name="daily_email_time" value="${esc(emailCfg.settings.daily_email_time)}" class="pp-input mt-1">
              </label>
              <label class="pp-label">Timezone
                <select name="timezone" class="pp-input mt-1">
                  ${['Asia/Kolkata', 'UTC', 'America/New_York', 'Europe/London', 'Asia/Singapore'].map((tz) => `<option value="${tz}" ${emailCfg.settings.timezone === tz ? 'selected' : ''}>${tz}</option>`).join('')}
                </select>
              </label>
            </div>
            <label class="flex items-center gap-2 text-xs">
              <input type="checkbox" name="daily_email_enabled" ${emailCfg.settings.daily_email_enabled ? 'checked' : ''}>
              <span>Enable automatic 4-day expenses summary email</span>
            </label>
            <div class="flex flex-wrap gap-2">
              <button type="submit" class="pp-btn pp-btn-primary pp-btn-sm">Save Schedule</button>
              <button type="button" class="pp-btn pp-btn-secondary pp-btn-sm" id="btn-send-test">Send Test</button>
              <button type="button" class="pp-btn pp-btn-ghost pp-btn-sm" id="btn-send-today">Send 4-Day Report Now</button>
            </div>
          </form>
        </div>

        <div class="pp-card space-y-3 p-4">
          <div class="flex flex-wrap items-center justify-between gap-2">
            <h3 class="text-sm font-semibold">Live Email Template Preview</h3>
            <div class="flex gap-1.5">
              <button type="button" class="pp-btn pp-btn-primary pp-btn-sm" id="btn-prev-digest">4-Day Digest</button>
              <button type="button" class="pp-btn pp-btn-secondary pp-btn-sm" id="btn-prev-alert">Budget Alert (1 hr)</button>
            </div>
          </div>
          <iframe id="email-preview-frame" title="PaisaPilot Email Preview" srcdoc="${esc(preview.html)}" class="h-[380px] w-full rounded-xl border border-slate-500/20 bg-slate-100"></iframe>
        </div>
      </div>

      <div class="pp-card space-y-3 p-4">
        <h3 class="text-sm font-semibold">Delivery Logs</h3>
        <div class="overflow-x-auto">
          <table class="w-full text-left text-xs">
            <thead class="border-b border-slate-500/20 text-[11px] uppercase tracking-wide text-slate-400">
              <tr><th class="py-2 pr-3">Time</th><th class="py-2 pr-3">Type</th><th class="py-2 pr-3">Recipient</th><th class="py-2 pr-3">Status</th><th class="py-2 pr-3">Retries</th><th class="py-2">Details</th></tr>
            </thead>
            <tbody class="divide-y divide-slate-500/15">
              ${emailCfg.logs.length === 0 ? `<tr><td colspan="6" class="py-3 text-slate-400">No email dispatches recorded yet.</td></tr>` : emailCfg.logs.map((l) => `
                <tr>
                  <td class="py-2 pr-3 text-slate-400">${esc(l.created_at.slice(0, 19).replace('T', ' '))}</td>
                  <td class="py-2 pr-3">${esc(l.report_type)}</td>
                  <td class="py-2 pr-3">${esc(l.recipient_email)}</td>
                  <td class="py-2 pr-3"><span class="pp-pill ${pillClass(l.status)}">${esc(l.status)}</span></td>
                  <td class="py-2 pr-3">${l.retry_count}</td>
                  <td class="py-2 text-slate-400">${esc(l.failure_reason || l.provider_message_id || 'OK')}</td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  `;

  const previewFrame = root.querySelector('#email-preview-frame');
  const btnPrevDigest = root.querySelector('#btn-prev-digest');
  const btnPrevAlert = root.querySelector('#btn-prev-alert');
  btnPrevDigest?.addEventListener('click', () => {
    if (previewFrame) previewFrame.srcdoc = preview.html;
    btnPrevDigest.className = 'pp-btn pp-btn-primary pp-btn-sm';
    if (btnPrevAlert) btnPrevAlert.className = 'pp-btn pp-btn-secondary pp-btn-sm';
  });
  btnPrevAlert?.addEventListener('click', () => {
    if (previewFrame && preview.budgetAlertHtml) previewFrame.srcdoc = preview.budgetAlertHtml;
    btnPrevAlert.className = 'pp-btn pp-btn-primary pp-btn-sm';
    if (btnPrevDigest) btnPrevDigest.className = 'pp-btn pp-btn-secondary pp-btn-sm';
  });

  root.querySelector('#btn-verify-email').addEventListener('click', async () => {
    const email = root.querySelector('[name="email_recipient"]').value;
    const res = await api('/api/v1/email/verify/request', { method: 'POST', body: { email_recipient: email } });
    const box = root.querySelector('#verify-code-box');
    const inp = root.querySelector('#verify-code-input');
    box.classList.remove('hidden');
    if (res.verificationCodePreview && inp) inp.value = res.verificationCodePreview;
    showToast(`Confirmation code issued: ${res.verificationCodePreview}`);
  });

  root.querySelector('#btn-confirm-code').addEventListener('click', async () => {
    const code = root.querySelector('#verify-code-input').value;
    try {
      await api('/api/v1/email/verify/confirm', { method: 'POST', body: { code } });
      showToast('Recipient email confirmed!');
      renderEmailSettingsView(root);
    } catch (e) { showToast(e.message, true); }
  });

  root.querySelector('#form-email-cfg').addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    try {
      await api('/api/v1/email/settings', {
        method: 'PUT',
        body: {
          email_recipient: fd.get('email_recipient'),
          daily_email_time: fd.get('daily_email_time'),
          timezone: fd.get('timezone'),
          daily_email_enabled: Boolean(fd.get('daily_email_enabled'))
        }
      });
      showToast('Email schedule saved');
      renderEmailSettingsView(root);
    } catch (err) { showToast(err.message, true); }
  });

  const dispatch = async (url) => {
    try {
      const r = await api(url, { method: 'POST' });
      showToast(`Email sent via Brevo (${r.messageId || 'accepted'})`);
      renderEmailSettingsView(root);
    } catch (err) {
      showToast(err.data?.error || err.message, true);
      renderEmailSettingsView(root);
    }
  };
  root.querySelector('#btn-send-test').addEventListener('click', () => dispatch('/api/v1/email/send-test'));
  root.querySelector('#btn-send-today').addEventListener('click', () => dispatch('/api/v1/email/send-today'));
}

// 14. SETTINGS, PRIVACY & RULES
export async function renderSettingsView(root, onRefreshAll) {
  root.innerHTML = `<div class="skeleton h-40"></div>`;
  const [cfg, rulesRes, auditRes, catRes] = await Promise.all([
    api('/api/v1/settings'),
    api('/api/v1/rules'),
    api('/api/v1/audit-logs'),
    api('/api/v1/categories')
  ]);
  state.categories = catRes.categories || state.categories;

  root.innerHTML = `
    <div class="space-y-4">
      <div class="grid gap-4 lg:grid-cols-2">
        <div class="pp-card space-y-3 p-4">
          <h3 class="text-sm font-semibold">Profile, Display &amp; Motion Preferences</h3>
          <form id="form-settings" class="space-y-3">
            <label class="pp-label">Name <input type="text" name="name" value="${esc(cfg.profile.name)}" required class="pp-input mt-1"></label>
            <div class="grid gap-3 sm:grid-cols-2">
              <label class="pp-label">Timezone
                <select name="timezone" class="pp-input mt-1">
                  ${['Asia/Kolkata', 'UTC', 'America/New_York', 'Europe/London', 'Asia/Singapore'].map((tz) => `<option value="${tz}" ${cfg.settings.timezone === tz ? 'selected' : ''}>${tz}</option>`).join('')}
                </select>
              </label>
              <label class="pp-label">Currency
                <select name="currency" class="pp-input mt-1">
                  <option value="INR" ${cfg.settings.currency === 'INR' ? 'selected' : ''}>INR (₹)</option>
                  <option value="USD" ${cfg.settings.currency === 'USD' ? 'selected' : ''}>USD ($)</option>
                </select>
              </label>
              <label class="pp-label">Theme
                <select name="theme" class="pp-input mt-1">
                  <option value="dark" ${cfg.settings.theme === 'dark' ? 'selected' : ''}>Dark Navy</option>
                  <option value="light" ${cfg.settings.theme === 'light' ? 'selected' : ''}>Light</option>
                </select>
              </label>
              <label class="pp-label">Retention Days (0 = Forever)
                <input type="number" min="0" max="3650" name="data_retention_days" value="${cfg.settings.data_retention_days || 0}" class="pp-input mt-1">
              </label>
            </div>
            <label class="flex items-center gap-2 text-xs"><input type="checkbox" name="enable_3d" ${cfg.settings.enable_3d ? 'checked' : ''}><span>Enable 3D Money Orb &amp; 3D Category Scenes</span></label>
            <label class="flex items-center gap-2 text-xs"><input type="checkbox" name="reduced_motion" ${cfg.settings.reduced_motion ? 'checked' : ''}><span>Reduced Motion Mode (2D Accessible Fallback)</span></label>
            <button type="submit" class="pp-btn pp-btn-primary pp-btn-sm">Save Preferences</button>
          </form>
        </div>

        <div class="pp-card space-y-3 p-4">
          <h3 class="text-sm font-semibold">Merchant-to-Category Rules (${rulesRes.rules.length})</h3>
          <form id="form-new-rule" class="flex flex-wrap gap-2">
            <input type="text" name="merchantPattern" placeholder="Merchant pattern (e.g. Zepto)" required class="pp-input flex-1 text-xs">
            <select name="categoryId" class="pp-input w-40 text-xs">${state.categories.map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join('')}</select>
            <button type="submit" class="pp-btn pp-btn-secondary pp-btn-sm">Add Rule</button>
          </form>
          <div class="max-h-56 divide-y divide-slate-500/15 overflow-y-auto">
            ${rulesRes.rules.map((r) => `
              <div class="flex items-center justify-between py-2 text-xs">
                <span>"${esc(r.merchant_pattern)}" &rarr; <strong>${esc(r.category_name)}</strong></span>
                <button type="button" class="pp-btn pp-btn-ghost pp-btn-sm" data-del-rule="${r.id}">&times;</button>
              </div>
            `).join('') || '<div class="py-2 text-xs text-slate-400">No custom rules yet.</div>'}
          </div>
        </div>
      </div>

      <div class="pp-card space-y-3 p-4">
        <div class="flex flex-wrap items-center justify-between gap-2">
          <div>
            <h3 class="text-sm font-semibold">Custom Categories (Your Preferences)</h3>
            <p class="text-xs text-slate-400">Add your own categories or remove unused ones. Uploaded receipts and statements also auto-add new categories.</p>
          </div>
          <span class="text-xs text-slate-400">${state.categories.length} total</span>
        </div>
        <form id="form-new-category" class="flex flex-wrap items-center gap-2">
          <input type="text" name="name" placeholder="Category name (e.g. Fuel, Gym, Coffee)" required maxlength="40" class="pp-input flex-1 text-xs">
          <select name="kind" class="pp-input w-32 text-xs">
            <option value="expense">Expense</option>
            <option value="income">Income</option>
            <option value="savings">Savings</option>
            <option value="transfer">Transfer</option>
          </select>
          <input type="color" name="color" value="#10B981" title="Category color" class="h-8 w-10 cursor-pointer rounded border border-slate-500/30 bg-transparent p-0.5">
          <button type="submit" class="pp-btn pp-btn-primary pp-btn-sm">Add Category</button>
        </form>
        <div class="flex flex-wrap gap-2 pt-1">
          ${state.categories.map((c) => `
            <span class="inline-flex items-center gap-1.5 rounded-full border border-slate-500/20 bg-slate-500/5 px-2.5 py-1 text-xs">
              <span class="h-2.5 w-2.5 rounded-full" style="background:${esc(c.color || '#38BDF8')}"></span>
              <span class="font-medium">${esc(c.name)}</span>
              <span class="text-[10px] text-slate-400">${esc(c.kind)}</span>
              ${c.slug !== 'uncategorized' ? `<button type="button" class="ml-0.5 text-slate-400 hover:text-rose-400" data-del-cat="${c.id}" title="Delete category">&times;</button>` : ''}
            </span>
          `).join('')}
        </div>
      </div>

      <div class="grid gap-4 lg:grid-cols-2">
        <div class="pp-card space-y-3 p-4">
          <h3 class="text-sm font-semibold">Data Controls &amp; Account Deletion</h3>
          <div class="flex flex-wrap gap-2">
            <button type="button" class="pp-btn pp-btn-secondary pp-btn-sm" id="btn-seed-demo">Load Demo Data</button>
            <button type="button" class="pp-btn pp-btn-ghost pp-btn-sm" id="btn-clear-demo">Remove Demo Data</button>
          </div>
          <div class="border-t border-slate-500/15 pt-3">
            <div class="flex flex-wrap gap-2">
              <input type="password" id="del-acct-pwd" placeholder="Confirm password to delete account" class="pp-input flex-1 text-xs">
              <button type="button" class="pp-btn pp-btn-danger pp-btn-sm" id="btn-del-acct">Delete Account</button>
            </div>
          </div>
        </div>

        <div class="pp-card space-y-3 p-4">
          <h3 class="text-sm font-semibold">Security Audit Log</h3>
          <div class="max-h-52 divide-y divide-slate-500/15 overflow-y-auto">
            ${auditRes.logs.map((l) => `
              <div class="py-1.5 text-xs">
                <strong>${esc(l.action)}</strong> <span class="text-slate-400">(${esc(l.resource_type)}) · ${esc(l.created_at.slice(0, 19).replace('T', ' '))}</span>
              </div>
            `).join('')}
          </div>
        </div>
      </div>
    </div>
  `;

  root.querySelector('#form-settings').addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    await api('/api/v1/settings', {
      method: 'PUT',
      body: {
        name: fd.get('name'),
        timezone: fd.get('timezone'),
        currency: fd.get('currency'),
        theme: fd.get('theme'),
        data_retention_days: Number(fd.get('data_retention_days') || 0),
        enable_3d: Boolean(fd.get('enable_3d')),
        reduced_motion: Boolean(fd.get('reduced_motion'))
      }
    });
    showToast('Settings saved');
    if (onRefreshAll) onRefreshAll();
  });

  root.querySelector('#form-new-rule').addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    await api('/api/v1/rules', { method: 'POST', body: Object.fromEntries(fd.entries()) });
    showToast('Rule added');
    renderSettingsView(root, onRefreshAll);
  });

  root.querySelectorAll('[data-del-rule]').forEach((b) => {
    b.addEventListener('click', async () => {
      await api(`/api/v1/rules/${b.dataset.delRule}`, { method: 'DELETE' });
      renderSettingsView(root, onRefreshAll);
    });
  });

  root.querySelector('#form-new-category')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    try {
      const res = await api('/api/v1/categories', { method: 'POST', body: Object.fromEntries(fd.entries()) });
      showToast(res.created ? `Category "${res.category.name}" added` : `Category "${res.category.name}" already exists`);
      if (onRefreshAll) await onRefreshAll();
      renderSettingsView(root, onRefreshAll);
    } catch (err) { showToast(err.message, true); }
  });

  root.querySelectorAll('[data-del-cat]').forEach((b) => {
    b.addEventListener('click', async () => {
      try {
        await api(`/api/v1/categories/${b.dataset.delCat}`, { method: 'DELETE' });
        showToast('Category deleted');
        if (onRefreshAll) await onRefreshAll();
        renderSettingsView(root, onRefreshAll);
      } catch (err) { showToast(err.message, true); }
    });
  });

  root.querySelector('#btn-seed-demo').addEventListener('click', async () => {
    const r = await api('/api/v1/transactions/demo-seed', { method: 'POST' });
    showToast(`Loaded ${r.created} demo transactions`);
    if (onRefreshAll) onRefreshAll();
  });

  root.querySelector('#btn-clear-demo').addEventListener('click', async () => {
    const r = await api('/api/v1/transactions/demo-seed', { method: 'DELETE' });
    showToast(`Removed ${r.deleted} demo transactions`);
    if (onRefreshAll) onRefreshAll();
  });

  root.querySelector('#btn-del-acct').addEventListener('click', async () => {
    const password = root.querySelector('#del-acct-pwd').value;
    if (!password) return showToast('Enter your password to confirm deletion', true);
    if (!confirm('Permanently delete your account and all financial records? This cannot be undone.')) return;
    try {
      await api('/api/v1/auth/account', { method: 'DELETE', body: { password } });
      window.location.href = '/auth';
    } catch (e) { showToast(e.message, true); }
  });
}
