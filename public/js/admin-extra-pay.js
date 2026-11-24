/* Admin panel for the extra deposit methods (Manual Payment + Paymonetra).
   - Payment methods tab : on/off switches, manual bank details, customer-facing messages
   - Deposit receipts tab: manual receipts waiting for review -> view receipt, approve or decline
   Uses aFetch() from admin.html. Backend: lib/extra-deposits.js */
(function () {
  'use strict';
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]; }); }
  function $(id) { return document.getElementById(id); }
  function money(n) { return '₦' + Number(n || 0).toLocaleString('en-NG', { maximumFractionDigits: 2 }); }
  function fb(id, msg, kind) { var e = $(id); if (e) { e.textContent = msg || ''; e.className = 'form-feedback ' + (kind || ''); } }
  var cfg = null, filter = 'pending';

  // ── Settings panel (Payment Methods tab) ───────────────────────────────────────
  function buildSettings() {
    var tab = $('tab-deptutorials');
    if (!tab || $('xpSettings')) return;
    var sec = document.createElement('div');
    sec.className = 'sec owner-only';
    sec.id = 'xpSettings';
    sec.innerHTML =
      '<div class="sec-title">More Payment Methods — Manual Payment &amp; Paymonetra</div>' +
      '<div class="info-box">Both start <b>OFF</b>. Switching takes effect immediately on the customers’ Deposit page.</div>' +
      // Manual
      '<div class="pm-row" style="margin-bottom:14px"><div class="pm-row-head"><span class="pm-row-title">Manual Payment (upload receipt)</span>' +
      '<label class="pm-switch"><input type="checkbox" id="xpManualOn"/><span class="pm-slider"></span></label></div>' +
      '<p style="font-size:.8rem;color:var(--t2);margin:6px 0 8px">Customers transfer to the account below, upload their receipt, and you approve or decline it under <b>Deposit receipts</b>. When OFF, the card is greyed out for customers.</p>' +
      '<div class="fg"><label>Bank name</label><input type="text" id="xpBank" maxlength="80"/></div>' +
      '<div class="fg"><label>Account name</label><input type="text" id="xpAccName" maxlength="80"/></div>' +
      '<div class="fg"><label>Account number</label><input type="text" id="xpAccNo" maxlength="30" inputmode="numeric"/></div>' +
      '<div class="fg"><label>Extra instructions shown to customers (optional)</label><textarea id="xpInstr" rows="2" maxlength="600" placeholder="e.g. Use your email as the transfer narration."></textarea></div>' +
      '<div class="fg"><label>Message shown when switched OFF (optional)</label><input type="text" id="xpManualMsg" maxlength="300" placeholder="e.g. Manual payment is paused — use Payment Link."/></div>' +
      '<button class="btn-primary" id="xpSaveManual" type="button">Save Manual Payment settings</button><div id="xpManualFb" class="form-feedback"></div></div>' +
      // Paymonetra
      '<div class="pm-row"><div class="pm-row-head"><span class="pm-row-title">Paymonetra</span>' +
      '<label class="pm-switch"><input type="checkbox" id="xpPmOn"/><span class="pm-slider"></span></label></div>' +
      '<p style="font-size:.8rem;color:var(--t2);margin:6px 0 8px" id="xpPmStatus"></p>' +
      '<div class="fg"><label>Message shown when switched OFF (optional)</label><input type="text" id="xpPmMsg" maxlength="300"/></div>' +
      '<button class="btn-secondary" id="xpSavePm" type="button">Save Message</button><div id="xpPmFb" class="form-feedback"></div>' +
      '<p style="font-size:.74rem;color:var(--t2);margin:6px 0 0">Webhook URL for the Paymonetra dashboard: <code id="xpPmHook"></code></p></div>';
    tab.insertBefore(sec, tab.firstElementChild);
    $('xpManualOn').addEventListener('change', function () { toggle('manual', this.checked, 'xpManualFb', this); });
    $('xpPmOn').addEventListener('change', function () { toggle('paymonetra', this.checked, 'xpPmFb', this); });
    $('xpSaveManual').addEventListener('click', saveManual);
    $('xpSavePm').addEventListener('click', function () { post('paymonetra', { disabledMessage: $('xpPmMsg').value }, 'xpPmFb', 'Saved'); });
  }
  async function post(method, body, fbId, okMsg) {
    try { await aFetch('/api/admin/extra-methods/' + method, 'POST', body); fb(fbId, okMsg || 'Saved', 'ok'); await loadSettings(); return true; }
    catch (e) { fb(fbId, e.message, 'err'); await loadSettings(); return false; }
  }
  async function toggle(method, on, fbId) {
    await post(method, { enabled: on }, fbId, on ? 'Switched ON' : 'Switched OFF');
  }
  function saveManual() {
    post('manual', { bankName: $('xpBank').value, accountName: $('xpAccName').value, accountNumber: $('xpAccNo').value, instructions: $('xpInstr').value, disabledMessage: $('xpManualMsg').value }, 'xpManualFb', 'Saved');
  }
  async function loadSettings() {
    try {
      cfg = await aFetch('/api/admin/extra-methods');
      buildSettings();
      if (!$('xpManualOn')) return;
      $('xpManualOn').checked = !!cfg.manual.enabled;
      $('xpBank').value = cfg.manual.bankName; $('xpAccName').value = cfg.manual.accountName; $('xpAccNo').value = cfg.manual.accountNumber;
      $('xpInstr').value = cfg.manual.instructions; $('xpManualMsg').value = cfg.manual.disabledMessage;
      $('xpPmOn').checked = !!cfg.paymonetra.enabled; $('xpPmMsg').value = cfg.paymonetra.disabledMessage;
      $('xpPmHook').textContent = cfg.paymonetra.webhookUrl;
      $('xpPmStatus').textContent = !cfg.paymonetra.keySet
        ? 'PAYMONETRA_SECRET_KEY is not set on the server — add it (your sk_live_… key) to be able to switch this on.'
        : (cfg.paymonetra.webhookSecretSet ? 'Ready. When OFF, the Paymonetra card is greyed out for customers.' : 'Ready. Recommended: also set PAYMONETRA_WEBHOOK_SECRET (your whsec_… secret) so webhooks are signature-checked. When OFF, the card is greyed out for customers.');
    } catch (e) { /* staff (sub-admin) can still use the receipts panel */ }
  }

  // ── Receipts review (Deposit receipts tab) ─────────────────────────────────────
  function buildReceipts() {
    var tab = $('tab-receipts');
    if (!tab || $('xpReceipts')) return;
    var sec = document.createElement('div');
    sec.className = 'sec';
    sec.id = 'xpReceipts';
    sec.innerHTML =
      '<div class="sec-title">Manual Payment Receipts</div>' +
      '<div class="info-box">Customers who paid by bank transfer upload their receipt here. Open the receipt, check it against your bank, then approve (wallet credited) or decline.</div>' +
      '<div style="display:flex;gap:8px;margin:0 0 10px;flex-wrap:wrap">' +
      ['pending', 'approved', 'rejected', 'all'].map(function (s) { return '<button type="button" class="btn-secondary xp-f" data-s="' + s + '">' + s[0].toUpperCase() + s.slice(1) + '</button>'; }).join('') + '</div>' +
      '<div class="tbl-wrap"><table><thead><tr><th>Customer</th><th>Amount</th><th>Sender</th><th>Receipt</th><th>Date</th><th>Status</th><th>Action</th></tr></thead>' +
      '<tbody id="xpRecBody"><tr><td colspan="7" style="text-align:center;padding:20px">Loading…</td></tr></tbody></table></div><div id="xpRecFb" class="form-feedback"></div>';
    tab.insertBefore(sec, tab.firstElementChild);
    sec.querySelectorAll('.xp-f').forEach(function (b) { b.addEventListener('click', function () { filter = b.getAttribute('data-s'); loadReceipts(); }); });
    $('xpRecBody').addEventListener('click', onRowClick);
  }
  async function loadReceipts() {
    buildReceipts();
    var body = $('xpRecBody');
    if (!body) return;
    try {
      var rows = await aFetch('/api/admin/manual-deposits?status=' + encodeURIComponent(filter));
      body.innerHTML = rows.length ? rows.map(row).join('') : '<tr><td colspan="7" style="text-align:center;color:var(--t2);padding:16px">No ' + (filter === 'all' ? '' : esc(filter) + ' ') + 'manual deposits</td></tr>';
    } catch (e) { body.innerHTML = '<tr><td colspan="7" style="color:#ef4444;padding:16px">' + esc(e.message) + '</td></tr>'; }
  }
  function row(r) {
    var u = r.userId || {};
    var pend = r.status === 'pending';
    // proofUrl is server-generated (our /receipts path or Cloudinary https), but never trust it blindly in an href
    var safeUrl = /^(\/receipts\/|https:\/\/)/.test(r.proofUrl || '') ? r.proofUrl : '';
    return '<tr data-id="' + esc(r._id) + '">' +
      '<td>' + esc(u.name || '—') + '<div style="font-size:.74rem;color:var(--t2)">' + esc(u.email || '') + '</div></td>' +
      '<td><b>' + money(r.amount) + '</b>' + (r.status === 'approved' && r.creditedAmount !== r.amount ? '<div style="font-size:.74rem;color:var(--t2)">credited ' + money(r.creditedAmount) + '</div>' : '') + '</td>' +
      '<td>' + esc(r.senderName || '—') + (r.note ? '<div style="font-size:.74rem;color:var(--t2)">' + esc(r.note) + '</div>' : '') + '</td>' +
      '<td>' + (safeUrl ? '<a href="' + esc(safeUrl) + '" target="_blank" rel="noopener noreferrer">' + (r.proofIsPdf ? 'Open PDF' : '<img src="' + esc(safeUrl) + '" alt="receipt" style="width:70px;height:70px;object-fit:cover;border-radius:8px;display:block"/>') + '</a>' : '—') + '</td>' +
      '<td style="font-size:.78rem">' + esc(new Date(r.createdAt).toLocaleString()) + '<div style="color:var(--t2)">' + esc(r.reference) + '</div></td>' +
      '<td>' + esc(r.status) + (r.reviewedBy ? '<div style="font-size:.74rem;color:var(--t2)">by ' + esc(r.reviewedBy) + '</div>' : '') + (r.adminNote ? '<div style="font-size:.74rem;color:var(--t2)">' + esc(r.adminNote) + '</div>' : '') + '</td>' +
      '<td>' + (pend ? '<button type="button" class="btn-primary xp-a" data-a="approved" style="padding:6px 10px;margin:0 4px 4px 0">Approve</button><button type="button" class="btn-secondary xp-a" data-a="rejected" style="padding:6px 10px">Decline</button>' : '—') + '</td></tr>';
  }
  async function onRowClick(ev) {
    var btn = ev.target.closest('.xp-a');
    if (!btn) return;
    var tr = btn.closest('tr'), id = tr.getAttribute('data-id'), action = btn.getAttribute('data-a');
    var body = { action: action };
    if (action === 'approved') {
      var shown = tr.children[1].querySelector('b').textContent;
      var amt = prompt('Amount to credit this customer (₦). They claimed ' + shown + '. Change it only if the receipt shows a different amount:', shown.replace(/[^0-9.]/g, ''));
      if (amt === null) return;
      body.amount = amt;
    } else {
      var note = prompt('Reason for declining (shown to the customer, optional):');
      if (note === null) return;
      body.note = note;
    }
    tr.querySelectorAll('button').forEach(function (b) { b.disabled = true; });
    try {
      var d = await aFetch('/api/admin/manual-deposits/' + encodeURIComponent(id) + '/action', 'POST', body);
      fb('xpRecFb', d.message || 'Done', 'ok');
      try { if (typeof loadDashboard === 'function') loadDashboard(); } catch (e) { /* ignore */ }
    } catch (e) { fb('xpRecFb', e.message, 'err'); }
    loadReceipts();
  }

  function init() {
    loadSettings(); loadReceipts();
    // refresh whenever the admin opens one of the two tabs
    document.addEventListener('click', function (e) {
      if (!e.target.closest('[data-tab],.nav-item,.sb-item,button,a')) return;
      setTimeout(function () {
        var r = $('tab-receipts'), p = $('tab-deptutorials');
        if (r && r.classList.contains('active')) loadReceipts();
        if (p && p.classList.contains('active')) loadSettings();
      }, 350);
    });
  }
  // aFetch only works after the admin has logged in; wait for the app to be ready
  var tries = 0, t = setInterval(function () {
    tries++;
    var logged = (typeof currentRole !== 'undefined' && currentRole === 'staff' && typeof staffToken !== 'undefined' && staffToken) || (typeof adminPass !== 'undefined' && adminPass);
    if (logged && typeof aFetch === 'function') { clearInterval(t); init(); }
    else if (tries > 600) clearInterval(t);
  }, 1000);
})();
