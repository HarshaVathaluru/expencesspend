import { api, state, esc, fmtINR, showToast, getTodayInUserTz } from './api.js?v=2';

function pillClass(status) {
  const s = String(status || '').toLowerCase();
  if (s === 'verified' || s === 'active' || s === 'processed' || s === 'sent') return 'pp-pill-verified';
  if (s === 'captured') return 'pp-pill-captured';
  if (s === 'possible_duplicate' || s === 'failed') return 'pp-pill-possible_duplicate';
  if (s === 'needs_review' || s === 'paused' || s === 'pending') return 'pp-pill-needs_review';
  return 'pp-pill-neutral';
}

// 5. IMPORT CENTER
export async function renderImportView(root, onRefreshAll) {
  root.innerHTML = `<div class="skeleton h-40"></div>`;
  const batchesRes = await api('/api/v1/ingestion/batches');
  let previewData = null;

  const render = () => {
    root.innerHTML = `
      <div class="space-y-4">
        <div class="grid gap-4 lg:grid-cols-2">
          <div class="pp-card space-y-3 p-4">
            <div>
              <h3 class="text-sm font-semibold">Import PhonePe / Bank Statement</h3>
              <p class="mt-0.5 text-xs text-slate-400">Upload CSV or PDF statements. Column mapping &amp; duplicate checks run before saving.</p>
            </div>
            <div class="flex flex-wrap items-center gap-2">
              <input type="file" id="imp-file" accept=".csv,.pdf" class="pp-input flex-1 text-xs">
              <button type="button" class="pp-btn pp-btn-primary pp-btn-sm" id="btn-imp-upload">Preview File</button>
            </div>
            <label class="pp-label">Or Paste CSV Text
              <textarea id="imp-csv-text" rows="3" class="pp-input mt-1 font-mono text-xs" placeholder="Date,Merchant,Amount,Type,Reference&#10;2026-11-10,Swiggy,380.00,Debit,UTR991203"></textarea>
            </label>
            <button type="button" class="pp-btn pp-btn-secondary pp-btn-sm" id="btn-imp-paste">Preview Pasted CSV</button>
          </div>

          <div class="pp-card space-y-3 p-4">
            <h3 class="text-sm font-semibold">Recent Import Batches</h3>
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

        ${previewData ? `
          <div class="pp-card space-y-3 p-4">
            <div class="flex flex-wrap items-center justify-between gap-2">
              <h3 class="text-sm font-semibold">Preview &amp; Column Mapping (${previewData.totalRows} rows in ${esc(previewData.filename)})</h3>
              <button type="button" class="pp-btn pp-btn-primary pp-btn-sm" id="btn-imp-commit">Commit ${previewData.totalRows} Row(s)</button>
            </div>
            <div class="grid gap-2.5 sm:grid-cols-3 lg:grid-cols-6">
              ${['date', 'merchant', 'amount', 'type', 'paymentMethod', 'reference'].map((field) => `
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
      if (!f) return showToast('Choose a CSV or PDF file first', true);
      const fd = new FormData();
      fd.append('file', f);
      const isPdf = f.name.toLowerCase().endsWith('.pdf');
      try {
        previewData = await api(isPdf ? '/api/v1/ingestion/import/pdf-preview' : '/api/v1/ingestion/import/csv-preview', { method: 'POST', body: fd });
        previewData.sourceType = isPdf ? 'pdf' : 'csv';
        render();
      } catch (e) { showToast(e.message, true); }
    });

    root.querySelector('#btn-imp-paste')?.addEventListener('click', async () => {
      const csvText = root.querySelector('#imp-csv-text').value;
      try {
        previewData = await api('/api/v1/ingestion/import/csv-preview', { method: 'POST', body: { csvText } });
        previewData.sourceType = 'csv';
        render();
      } catch (e) { showToast(e.message, true); }
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

// 6. CONNECTED SOURCES & PHONEPE CAPTURE SETUP
export async function renderSourcesView(root, onRefreshAll) {
  root.innerHTML = `<div class="skeleton h-40"></div>`;
  const [arch, stateRes] = await Promise.all([
    api('/api/v1/ingestion/architecture'),
    api('/api/v1/ingestion/connections')
  ]);

  root.innerHTML = `
    <div class="space-y-4">
      <div class="rounded-xl border border-sky-500/30 bg-sky-500/10 px-4 py-3 text-xs leading-relaxed">
        <strong class="text-sky-700 dark:text-sky-400">Consented Capture Architecture:</strong> ${esc(arch.honestDisclosure)}
      </div>

      <div class="grid gap-4 lg:grid-cols-2">
        <div class="pp-card space-y-3 p-4">
          <h3 class="text-sm font-semibold">Connect Capture Source</h3>
          <form id="form-new-source" class="space-y-3">
            <label class="pp-label">Capture Adapter
              <select name="provider" class="pp-input mt-1">
                <option value="android_notification">Android Notification Listener (PhonePe / UPI Companion)</option>
                <option value="sms_parser">Bank / UPI SMS Transaction Alert Parser</option>
                <option value="email_receipt">Authorized Email Receipt Parser</option>
                <option value="statement_import">Manual Statement CSV/PDF Workflow</option>
              </select>
            </label>
            <label class="pp-label">Label
              <input type="text" name="displayName" required class="pp-input mt-1" placeholder="My Pixel PhonePe Listener">
            </label>
            <label class="flex items-start gap-2 text-xs text-slate-600 dark:text-slate-300">
              <input type="checkbox" name="consentGranted" required class="mt-0.5 rounded border-slate-600">
              <span>I consent to parse only payment amount, merchant, and timestamp. I can pause or revoke anytime.</span>
            </label>
            <button type="submit" class="pp-btn pp-btn-primary pp-btn-sm">Enable Source &amp; Generate Token</button>
          </form>
          <div id="source-token-box" class="hidden rounded-xl border border-amber-500/40 bg-amber-500/10 p-3 text-xs"></div>
        </div>

        <div class="pp-card space-y-3 p-4">
          <h3 class="text-sm font-semibold">Test Payment Alert / SMS Parser</h3>
          <p class="text-xs text-slate-400">Simulate a PhonePe notification or bank SMS (OTPs are ignored automatically).</p>
          <form id="form-test-ingest" class="space-y-3">
            <label class="pp-label">Provider
              <select name="provider" class="pp-input mt-1">
                <option value="android_notification">Android Notification (PhonePe)</option>
                <option value="sms_parser">Bank SMS Alert</option>
              </select>
            </label>
            <label class="pp-label">Notification / SMS Text
              <textarea name="rawText" rows="3" required class="pp-input mt-1 text-xs">Paid ₹349.00 to Zomato via PhonePe UPI. UTR 631290884122</textarea>
            </label>
            <button type="submit" class="pp-btn pp-btn-secondary pp-btn-sm">Process Event</button>
          </form>
        </div>
      </div>

      <div class="pp-card space-y-3 p-4">
        <div class="flex flex-wrap items-center justify-between gap-2">
          <h3 class="text-sm font-semibold">Connected Sources (${stateRes.connections.length})</h3>
          <details class="text-xs text-slate-400">
            <summary class="cursor-pointer font-medium text-sky-600 dark:text-sky-400 hover:underline">Android Webhook Payload Example</summary>
            <pre class="mt-2 overflow-x-auto rounded-lg border border-slate-500/20 bg-slate-100 p-2.5 text-[11px] text-slate-800 dark:bg-slate-950/70 dark:text-slate-200">curl -X POST ${esc(window.location.origin)}/api/v1/ingestion/webhook \
  -H "Content-Type: application/json" -H "X-Webhook-Token: YOUR_TOKEN" \
  -d '{"packageName":"com.phonepe.app","rawText":"Paid ₹420.00 to Swiggy via PhonePe UPI. UTR 63129088","externalId":"PP-63129088"}'</pre>
          </details>
        </div>
        ${stateRes.connections.length === 0 ? `
          <div class="flex flex-col items-center justify-center gap-2 py-6 text-center">
            <img src="/images/empty-sources.svg" alt="" width="112">
            <div class="text-xs text-slate-400">No active capture adapters yet. Enable one above or upload statements in Import Center.</div>
          </div>
        ` : `
          <div class="overflow-x-auto">
            <table class="w-full text-left text-xs">
              <thead class="border-b border-slate-500/20 text-[11px] uppercase tracking-wide text-slate-400">
                <tr><th class="py-2 pr-3">Source</th><th class="py-2 pr-3">Adapter</th><th class="py-2 pr-3">Status</th><th class="py-2 pr-3">Last Sync</th><th class="py-2 pr-3">Pending</th><th class="py-2">Actions</th></tr>
              </thead>
              <tbody class="divide-y divide-slate-500/15">
                ${stateRes.connections.map((c) => `
                  <tr>
                    <td class="py-2 pr-3 font-semibold">${esc(c.display_name)}</td>
                    <td class="py-2 pr-3 text-slate-400">${esc(c.provider)}</td>
                    <td class="py-2 pr-3"><span class="pp-pill ${pillClass(c.status)}">${esc(c.status)}</span></td>
                    <td class="py-2 pr-3 text-slate-400">${c.last_sync_at ? esc(c.last_sync_at.slice(0, 19).replace('T', ' ')) : 'Never'}</td>
                    <td class="py-2 pr-3">${c.pending_count}</td>
                    <td class="py-2">
                      <div class="flex flex-wrap gap-1.5">
                        <button type="button" class="pp-btn pp-btn-ghost pp-btn-sm" data-src-act="test" data-id="${c.id}">Test</button>
                        <button type="button" class="pp-btn pp-btn-ghost pp-btn-sm" data-src-act="${c.status === 'active' ? 'paused' : 'active'}" data-id="${c.id}">${c.status === 'active' ? 'Pause' : 'Resume'}</button>
                        <button type="button" class="pp-btn pp-btn-danger pp-btn-sm" data-src-act="delete" data-id="${c.id}">Revoke</button>
                      </div>
                    </td>
                  </tr>
                `).join('')}
              </tbody>
            </table>
          </div>
        `}
      </div>

      <div class="pp-card space-y-3 p-4">
        <h3 class="text-sm font-semibold">Recent Ingestion Events</h3>
        <div class="overflow-x-auto">
          <table class="w-full text-left text-xs">
            <thead class="border-b border-slate-500/20 text-[11px] uppercase tracking-wide text-slate-400">
              <tr><th class="py-2 pr-3">Time</th><th class="py-2 pr-3">Provider</th><th class="py-2 pr-3">Summary</th><th class="py-2 pr-3">Confidence</th><th class="py-2">Status</th></tr>
            </thead>
            <tbody class="divide-y divide-slate-500/15">
              ${stateRes.recentEvents.length === 0 ? `<tr><td colspan="5" class="py-3 text-slate-400">No events captured yet.</td></tr>` : stateRes.recentEvents.map((ev) => `
                <tr>
                  <td class="py-2 pr-3 text-slate-400">${esc(ev.created_at.slice(0, 19).replace('T', ' '))}</td>
                  <td class="py-2 pr-3">${esc(ev.provider)}</td>
                  <td class="py-2 pr-3">${esc(ev.payload_summary)}</td>
                  <td class="py-2 pr-3">${esc(ev.confidence)}</td>
                  <td class="py-2"><span class="pp-pill ${pillClass(ev.status)}">${esc(ev.status)}</span></td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  `;

  root.querySelector('#form-new-source')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    try {
      const res = await api('/api/v1/ingestion/connections', {
        method: 'POST',
        body: { provider: fd.get('provider'), displayName: fd.get('displayName'), consentGranted: true }
      });
      const box = root.querySelector('#source-token-box');
      box.innerHTML = `<strong>Copy webhook token now (shown once):</strong><div class="mt-1 break-all font-mono text-amber-800 dark:text-amber-200">${esc(res.webhookTokenOnce)}</div><div class="mt-1 text-[11px] text-slate-600 dark:text-slate-300">POST to <code>/api/v1/ingestion/webhook</code> with header <code>X-Webhook-Token</code>.</div>`;
      box.classList.remove('hidden');
      showToast('Capture source connected');
    } catch (err) { showToast(err.message, true); }
  });

  root.querySelector('#form-test-ingest')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    try {
      const res = await api('/api/v1/ingestion/events', {
        method: 'POST',
        body: { provider: fd.get('provider'), rawText: fd.get('rawText') }
      });
      showToast(`Event ${res.status}: ${res.transaction ? res.transaction.merchant + ' ' + fmtINR(res.transaction.amount_paise) : res.reason || 'Recorded'}`);
      if (onRefreshAll) onRefreshAll();
      renderSourcesView(root, onRefreshAll);
    } catch (err) { showToast(err.message, true); }
  });

  root.querySelectorAll('[data-src-act]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const id = btn.dataset.id;
      const act = btn.dataset.srcAct;
      try {
        if (act === 'delete') {
          if (!confirm('Revoke this capture source?')) return;
          await api(`/api/v1/ingestion/connections/${id}`, { method: 'DELETE' });
        } else if (act === 'test') {
          const r = await api(`/api/v1/ingestion/connections/${id}`, { method: 'PATCH', body: { action: 'test' } });
          showToast(r.message);
        } else {
          await api(`/api/v1/ingestion/connections/${id}`, { method: 'PATCH', body: { status: act } });
        }
        renderSourcesView(root, onRefreshAll);
      } catch (err) { showToast(err.message, true); }
    });
  });
}

// 7. RECONCILIATION CENTER
export async function renderReconciliationView(root, onRefreshAll) {
  root.innerHTML = `<div class="skeleton h-40"></div>`;
  const monthKey = state.monthKey || getTodayInUserTz().slice(0, 7);
  const rec = await api(`/api/v1/reconciliation?monthKey=${encodeURIComponent(monthKey)}`);

  root.innerHTML = `
    <div class="space-y-4">
      <div class="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <div class="pp-card p-4"><div class="text-xs text-slate-400">Verified</div><div class="mt-1 text-2xl font-bold text-emerald-400">${rec.verifiedCount}</div><div class="mt-0.5 text-[11px] text-slate-400">Confirmed entries</div></div>
        <div class="pp-card p-4"><div class="text-xs text-slate-400">Captured</div><div class="mt-1 text-2xl font-bold text-sky-400">${rec.capturedCount}</div><div class="mt-0.5 text-[11px] text-slate-400">Notifications / imports</div></div>
        <div class="pp-card p-4"><div class="text-xs text-slate-400">Needs Review</div><div class="mt-1 text-2xl font-bold text-amber-400">${rec.needsReviewCount + rec.pendingIngestionEventsCount}</div><div class="mt-0.5 text-[11px] text-slate-400">Ambiguous or unparsed</div></div>
        <div class="pp-card p-4"><div class="text-xs text-slate-400">Possible Duplicates</div><div class="mt-1 text-2xl font-bold text-rose-400">${rec.possibleDuplicatesCount}</div><div class="mt-0.5 text-[11px] text-slate-400">Flagged, never auto-deleted</div></div>
      </div>

      <div class="grid gap-4 lg:grid-cols-2">
        <div class="pp-card space-y-3 p-4">
          <h3 class="text-sm font-semibold">Unparsed Event Queue (${rec.pendingEvents.length})</h3>
          ${rec.pendingEvents.length === 0 ? `<div class="text-xs text-slate-400">All captured events parsed cleanly.</div>` : rec.pendingEvents.map((ev) => `
            <div class="pp-surface-sub space-y-2 p-3">
              <div class="text-[11px] text-slate-400">${esc(ev.provider)} · ${esc(ev.created_at.slice(0, 10))}</div>
              <div class="text-xs">${esc(ev.payload_summary)}</div>
              <form class="resolve-ev-form flex flex-wrap gap-2" data-ev-id="${ev.id}">
                <input type="text" name="merchant" placeholder="Merchant" required class="pp-input flex-1 text-xs">
                <input type="number" step="0.01" name="amount" placeholder="Amount ₹" required class="pp-input w-28 text-xs">
                <button type="submit" class="pp-btn pp-btn-primary pp-btn-sm">Confirm</button>
                <button type="button" class="pp-btn pp-btn-ghost pp-btn-sm" data-dismiss-ev="${ev.id}">Dismiss</button>
              </form>
            </div>
          `).join('')}
        </div>

        <div class="pp-card space-y-3 p-4">
          <h3 class="text-sm font-semibold">Flagged Transactions &amp; Unverified Days</h3>
          ${[...rec.possibleDuplicates, ...rec.needsReview].length === 0 ? `<div class="text-xs text-slate-400">Zero flagged transactions for ${esc(rec.monthKey)}.</div>` : `
            <div class="divide-y divide-slate-500/15">
              ${[...rec.possibleDuplicates, ...rec.needsReview].map((t) => `
                <div class="flex flex-wrap items-center justify-between gap-2 py-2.5">
                  <div>
                    <div class="text-xs font-semibold">${esc(t.merchant)} <span class="font-normal text-slate-400">(${esc(t.local_date)})</span></div>
                    <div class="mt-0.5 flex items-center gap-2 text-xs text-slate-400">${fmtINR(t.amount_paise)} <span class="pp-pill ${pillClass(t.reconciliation_status)}">${esc(t.reconciliation_status)}</span></div>
                  </div>
                  <div class="flex gap-1.5">
                    <button type="button" class="pp-btn pp-btn-secondary pp-btn-sm" data-verify-tx="${t.id}">Verify</button>
                    <button type="button" class="pp-btn pp-btn-danger pp-btn-sm" data-del-tx="${t.id}">Delete</button>
                  </div>
                </div>
              `).join('')}
            </div>
          `}

          <div class="border-t border-slate-500/15 pt-3">
            <h4 class="text-xs font-semibold uppercase tracking-wide text-slate-400">Unverified Days (${rec.unverifiedDays.length})</h4>
            ${rec.unverifiedDays.length === 0 ? `<div class="mt-1.5 text-xs text-slate-400">Every recorded day is 100% verified.</div>` : `
              <div class="mt-2 space-y-1">
                ${rec.unverifiedDays.map((d) => `<div class="flex justify-between text-xs"><span>${esc(d.date)}</span><span class="text-slate-400">${d.verified}/${d.total} verified</span></div>`).join('')}
              </div>
            `}
          </div>
        </div>
      </div>
    </div>
  `;

  root.querySelectorAll('.resolve-ev-form').forEach((f) => {
    f.addEventListener('submit', async (e) => {
      e.preventDefault();
      const fd = new FormData(f);
      try {
        await api(`/api/v1/reconciliation/resolve-event/${f.dataset.evId}`, {
          method: 'POST',
          body: { merchant: fd.get('merchant'), amount: fd.get('amount') }
        });
        showToast('Event verified into ledger');
        if (onRefreshAll) onRefreshAll();
        renderReconciliationView(root, onRefreshAll);
      } catch (err) { showToast(err.message, true); }
    });
  });

  root.querySelectorAll('[data-dismiss-ev]').forEach((b) => {
    b.addEventListener('click', async () => {
      await api(`/api/v1/reconciliation/resolve-event/${b.dataset.dismissEv}`, { method: 'POST', body: { action: 'dismiss' } });
      renderReconciliationView(root, onRefreshAll);
    });
  });

  root.querySelectorAll('[data-verify-tx]').forEach((b) => {
    b.addEventListener('click', async () => {
      await api(`/api/v1/transactions/${b.dataset.verifyTx}`, { method: 'PUT', body: { reconciliationStatus: 'verified' } });
      showToast('Marked verified');
      if (onRefreshAll) onRefreshAll();
      renderReconciliationView(root, onRefreshAll);
    });
  });

  root.querySelectorAll('[data-del-tx]').forEach((b) => {
    b.addEventListener('click', async () => {
      if (!confirm('Delete this flagged duplicate?')) return;
      await api(`/api/v1/transactions/${b.dataset.delTx}`, { method: 'DELETE' });
      showToast('Transaction deleted');
      if (onRefreshAll) onRefreshAll();
      renderReconciliationView(root, onRefreshAll);
    });
  });
}

// 8. BUDGETS
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

// 10. RECURRING PAYMENTS
export async function renderRecurringView(root, onRefreshAll) {
  root.innerHTML = `<div class="skeleton h-40"></div>`;
  const { recurring } = await api('/api/v1/recurring');
  root.innerHTML = `
    <div class="space-y-4">
      <div class="pp-card space-y-3 p-4">
        <h3 class="text-sm font-semibold">Add Recurring Bill / Subscription</h3>
        <form id="form-rec" class="grid gap-3 sm:grid-cols-2 lg:grid-cols-6">
          <label class="pp-label">Title <input type="text" name="title" required placeholder="House Rent" class="pp-input mt-1"></label>
          <label class="pp-label">Merchant <input type="text" name="merchant" required placeholder="Landlord UPI" class="pp-input mt-1"></label>
          <label class="pp-label">Amount (INR) <input type="number" step="0.01" name="amount" required placeholder="18500" class="pp-input mt-1"></label>
          <label class="pp-label">Cadence
            <select name="cadence" class="pp-input mt-1">
              <option value="monthly">Monthly</option>
              <option value="weekly">Weekly</option>
              <option value="yearly">Yearly</option>
              <option value="daily">Daily</option>
            </select>
          </label>
          <label class="pp-label">Next Due <input type="date" name="nextDueDate" value="${getTodayInUserTz()}" required class="pp-input mt-1"></label>
          <label class="pp-label">Category
            <select name="categoryId" class="pp-input mt-1">${state.categories.map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join('')}</select>
          </label>
          <div class="sm:col-span-2 lg:col-span-6">
            <button type="submit" class="pp-btn pp-btn-primary pp-btn-sm">Save Recurring Schedule</button>
          </div>
        </form>
      </div>

      <div class="pp-card space-y-3 p-4">
        <h3 class="text-sm font-semibold">Scheduled Recurring Rules</h3>
        <div class="overflow-x-auto">
          <table class="w-full text-left text-xs">
            <thead class="border-b border-slate-500/20 text-[11px] uppercase tracking-wide text-slate-400">
              <tr><th class="py-2 pr-3">Title</th><th class="py-2 pr-3">Amount</th><th class="py-2 pr-3">Cadence</th><th class="py-2 pr-3">Next Due</th><th class="py-2 pr-3">Last Recorded</th><th class="py-2">Actions</th></tr>
            </thead>
            <tbody class="divide-y divide-slate-500/15">
              ${recurring.length === 0 ? `<tr><td colspan="6" class="py-3 text-slate-400">No recurring schedules configured.</td></tr>` : recurring.map((r) => `
                <tr>
                  <td class="py-2 pr-3 font-semibold">${esc(r.title)} <span class="font-normal text-slate-400">(${esc(r.merchant)})</span></td>
                  <td class="py-2 pr-3">${fmtINR(r.amount_paise)}</td>
                  <td class="py-2 pr-3 capitalize">${esc(r.cadence)}</td>
                  <td class="py-2 pr-3">${esc(r.next_due_date)}</td>
                  <td class="py-2 pr-3 text-slate-400">${esc(r.last_matched_date || 'Predicted')}</td>
                  <td class="py-2">
                    <div class="flex gap-1.5">
                      <button type="button" class="pp-btn pp-btn-secondary pp-btn-sm" data-rec-pay="${r.id}">Record Actual</button>
                      <button type="button" class="pp-btn pp-btn-danger pp-btn-sm" data-rec-del="${r.id}">Delete</button>
                    </div>
                  </td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  `;

  root.querySelector('#form-rec').addEventListener('submit', async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    await api('/api/v1/recurring', { method: 'POST', body: Object.fromEntries(fd.entries()) });
    showToast('Recurring rule added');
    renderRecurringView(root, onRefreshAll);
  });

  root.querySelectorAll('[data-rec-pay]').forEach((b) => {
    b.addEventListener('click', async () => {
      const r = await api(`/api/v1/recurring/${b.dataset.recPay}/record`, { method: 'POST' });
      showToast(`Recorded actual transaction. Next due: ${r.nextDueDate}`);
      if (onRefreshAll) onRefreshAll();
      renderRecurringView(root, onRefreshAll);
    });
  });

  root.querySelectorAll('[data-rec-del]').forEach((b) => {
    b.addEventListener('click', async () => {
      await api(`/api/v1/recurring/${b.dataset.recDel}`, { method: 'DELETE' });
      renderRecurringView(root, onRefreshAll);
    });
  });
}

// 11. INSIGHTS & GEMINI AI ASSISTANT
export async function renderInsightsView(root) {
  root.innerHTML = `<div class="skeleton h-40"></div>`;
  const monthKey = state.monthKey || getTodayInUserTz().slice(0, 7);
  const data = await api(`/api/v1/insights?monthKey=${encodeURIComponent(monthKey)}`);

  root.innerHTML = `
    <div class="space-y-4">
      <div class="pp-card space-y-3 p-4">
        <div class="flex flex-wrap items-center justify-between gap-2">
          <h3 class="text-sm font-semibold">Ask PaisaPilot AI (${state.aiStatus.geminiConfigured ? 'Gemini Enabled' : 'Rule Engine'})</h3>
          <span class="text-xs text-slate-400">Grounded strictly in your persisted ledger</span>
        </div>
        <form id="form-ai-ask" class="flex flex-wrap gap-2">
          <input type="text" id="ai-ask-input" required class="pp-input flex-1" placeholder="e.g. How much did I spend on food this month? Top merchants?">
          <button type="submit" class="pp-btn pp-btn-primary">Ask AI</button>
        </form>
        <div id="ai-ask-reply" class="hidden rounded-xl border border-sky-500/30 bg-sky-500/10 p-3 text-xs leading-relaxed"></div>
      </div>

      <div class="grid gap-4 lg:grid-cols-2">
        <div class="pp-card space-y-2.5 p-4">
          <h3 class="text-sm font-semibold">Spending Insights (${esc(data.monthKey)})</h3>
          ${data.insights.length === 0 ? `<div class="text-xs text-slate-400">Add more transactions across months to unlock anomaly &amp; trend insights.</div>` : data.insights.map((ins) => `
            <div class="rounded-xl border px-3.5 py-2.5 text-xs ${
              ins.kind === 'warning'
                ? 'border-rose-500/35 bg-rose-500/10'
                : ins.kind === 'attention'
                  ? 'border-amber-500/35 bg-amber-500/10'
                  : 'border-sky-500/30 bg-sky-500/10'
            }">
              <strong class="block font-semibold">${esc(ins.title)}</strong>
              <div class="mt-1 text-slate-700 dark:text-slate-300">${esc(ins.detail)}</div>
              <div class="mt-1 text-[11px] text-slate-500 dark:text-slate-400">Window: ${esc(ins.window)}</div>
            </div>
          `).join('')}
        </div>

        <div class="pp-card space-y-2.5 p-4">
          <h3 class="text-sm font-semibold">Detected Repeat Merchants</h3>
          ${data.recurringCandidates.length === 0 ? `<div class="text-xs text-slate-400">No repeated merchant charges detected yet.</div>` : `
            <div class="divide-y divide-slate-500/15">
              ${data.recurringCandidates.map((rc) => `
                <div class="flex items-center justify-between py-2 text-xs">
                  <span><strong>${esc(rc.merchant)}</strong> <span class="text-slate-400">(${rc.cnt} times)</span></span>
                  <strong>${fmtINR(rc.amt)}</strong>
                </div>
              `).join('')}
            </div>
          `}
        </div>
      </div>
    </div>
  `;

  root.querySelector('#form-ai-ask').addEventListener('submit', async (e) => {
    e.preventDefault();
    const q = root.querySelector('#ai-ask-input').value;
    const replyBox = root.querySelector('#ai-ask-reply');
    replyBox.textContent = 'Analyzing your persisted transactions...';
    replyBox.classList.remove('hidden');
    try {
      const res = await api('/api/v1/ai/ask', { method: 'POST', body: { question: q, monthKey } });
      replyBox.innerHTML = `<strong class="text-sky-700 dark:text-sky-400">Answer (${esc(res.source)}):</strong><div class="mt-1.5 whitespace-pre-line">${esc(res.answer)}</div>`;
    } catch (err) {
      replyBox.textContent = err.message;
    }
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
          <h3 class="text-sm font-semibold">Daily 11:00 PM Summary Settings</h3>
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
              <label class="pp-label">Delivery Time
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
              <span>Enable automatic server-scheduled daily digest</span>
            </label>
            <div class="flex flex-wrap gap-2">
              <button type="submit" class="pp-btn pp-btn-primary pp-btn-sm">Save Schedule</button>
              <button type="button" class="pp-btn pp-btn-secondary pp-btn-sm" id="btn-send-test">Send Test</button>
              <button type="button" class="pp-btn pp-btn-ghost pp-btn-sm" id="btn-send-today">Send Today's Report</button>
            </div>
          </form>
        </div>

        <div class="pp-card space-y-3 p-4">
          <h3 class="text-sm font-semibold">Live Digest Preview</h3>
          <iframe title="Daily Email Preview" srcdoc="${esc(preview.html)}" class="h-[360px] w-full rounded-xl border border-slate-500/20 bg-slate-950"></iframe>
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

  root.querySelector('#btn-verify-email').addEventListener('click', async () => {
    const email = root.querySelector('[name="email_recipient"]').value;
    const res = await api('/api/v1/email/verify/request', { method: 'POST', body: { email_recipient: email } });
    root.querySelector('#verify-code-box').classList.remove('hidden');
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
  const [cfg, rulesRes, auditRes] = await Promise.all([
    api('/api/v1/settings'),
    api('/api/v1/rules'),
    api('/api/v1/audit-logs')
  ]);

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
