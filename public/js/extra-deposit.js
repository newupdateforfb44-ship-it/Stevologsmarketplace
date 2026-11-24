/* Extra deposit methods on the Deposit page: Manual Payment (upload receipt) and Paymonetra.
   The deposit page is loaded into #page-deposit as a fragment, so this script watches for the
   Payment Link card and adds two cards under it. Each card only appears while the admin has
   that method switched ON. Backend: lib/extra-deposits.js */
(function () {
  'use strict';
  var state = null;

  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]; }); }
  function tok() { try { return (typeof token !== 'undefined' && token) || localStorage.getItem('ksl_token') || ''; } catch (e) { return ''; } }
  function money(n) { return '₦' + Number(n || 0).toLocaleString('en-NG', { maximumFractionDigits: 2 }); }

  async function api(url, opts) {
    opts = opts || {};
    opts.headers = Object.assign({ Authorization: 'Bearer ' + tok() }, opts.headers || {});
    opts.cache = 'no-store';
    var r = await fetch(url, opts);
    var d = await r.json().catch(function () { return {}; });
    if (!r.ok) throw new Error(d.error || 'Request failed');
    return d;
  }

  function injectStyles() {
    if (document.getElementById('xdStyles')) return;
    var st = document.createElement('style');
    st.id = 'xdStyles';
    st.textContent =
      '.xd-ov{position:fixed;inset:0;z-index:9999;background:rgba(0,0,0,.65);display:flex;align-items:flex-end;justify-content:center}' +
      '.xd-box{background:var(--card,#1b1b2a);color:var(--t1,#fff);width:100%;max-width:480px;max-height:92vh;overflow:auto;border-radius:18px 18px 0 0;padding:18px 18px calc(22px + env(safe-area-inset-bottom,0px));border:1px solid var(--border2,rgba(255,255,255,.12))}' +
      '@media(min-width:560px){.xd-ov{align-items:center}.xd-box{border-radius:18px}}' +
      '.xd-h{display:flex;justify-content:space-between;align-items:center;margin-bottom:12px}.xd-h h3{margin:0;font-size:1.1rem}' +
      '.xd-x{background:none;border:0;color:var(--t2,#aaa);font-size:1.6rem;line-height:1;cursor:pointer}' +
      '.xd-bank{background:rgba(245,184,28,.1);border:1px solid rgba(245,184,28,.3);border-radius:12px;padding:12px 14px;margin-bottom:12px}' +
      '.xd-row{display:flex;justify-content:space-between;align-items:center;gap:10px;padding:5px 0;font-size:.9rem}' +
      '.xd-row span{color:var(--t2,#aaa)}.xd-row b{word-break:break-all;text-align:right}' +
      '.xd-copy{background:rgba(245,184,28,.18);border:1px solid rgba(245,184,28,.4);color:var(--accent,#f5b81c);border-radius:8px;padding:3px 9px;font:inherit;font-size:.72rem;font-weight:700;cursor:pointer;margin-left:8px}' +
      '.xd-l{display:block;font-size:.78rem;font-weight:700;color:var(--t2,#aaa);margin:12px 0 5px}' +
      '.xd-in{width:100%;box-sizing:border-box;padding:12px;border-radius:10px;border:1px solid var(--border2,rgba(255,255,255,.18));background:rgba(255,255,255,.05);color:inherit;font:inherit}' +
      '.xd-btn{width:100%;margin-top:16px;padding:14px;border:0;border-radius:12px;background:var(--accent,#f5b81c);color:#111;font:inherit;font-weight:800;cursor:pointer}.xd-btn:disabled{opacity:.6;cursor:default}' +
      '.xd-fb{margin-top:10px;font-size:.85rem;min-height:1.2em}.xd-fb.err{color:#ef4444}.xd-fb.ok{color:#22c55e}' +
      '.xd-note{font-size:.8rem;color:var(--t2,#aaa);margin-top:8px;line-height:1.45}' +
      '.xd-hist{margin-top:18px;border-top:1px solid var(--border2,rgba(255,255,255,.12));padding-top:12px}.xd-hist h4{margin:0 0 8px;font-size:.85rem;color:var(--t2,#aaa)}' +
      '.xd-hi{display:flex;justify-content:space-between;gap:8px;padding:7px 0;font-size:.85rem;border-bottom:1px solid rgba(255,255,255,.06)}' +
      '.xd-st{font-weight:800;font-size:.74rem;padding:2px 8px;border-radius:99px;white-space:nowrap}' +
      '.xd-st.pending{background:rgba(245,184,28,.18);color:#f5b81c}.xd-st.approved{background:rgba(34,197,94,.18);color:#22c55e}.xd-st.rejected{background:rgba(239,68,68,.18);color:#ef4444}';
    document.head.appendChild(st);
  }

  function cardHtml(id, title, sub, badge) {
    return '<div class="dep-method-card" id="' + id + '" role="button" tabindex="0">' +
      '<div class="dmc-left"><div class="dmc-icon-box dmc-icon-link"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="5" width="20" height="14" rx="2"/><path d="M2 10h20"/></svg></div>' +
      '<div><div class="dmc-title">' + esc(title) + '</div><div class="dmc-sub">' + esc(sub) + '</div></div></div>' +
      '<div class="dmc-right"><div class="dmc-badge dmc-badge-blue">' + esc(badge) + '</div><div class="dmc-arrow">›</div></div></div>';
  }

  function closeModal() { var o = document.getElementById('xdOverlay'); if (o) o.remove(); }
  function openModal(title, bodyHtml) {
    closeModal();
    var o = document.createElement('div');
    o.className = 'xd-ov'; o.id = 'xdOverlay';
    o.innerHTML = '<div class="xd-box"><div class="xd-h"><h3>' + esc(title) + '</h3><button class="xd-x" aria-label="Close" type="button">×</button></div>' + bodyHtml + '</div>';
    o.addEventListener('click', function (e) { if (e.target === o) closeModal(); });
    o.querySelector('.xd-x').addEventListener('click', closeModal);
    document.body.appendChild(o);
    return o;
  }
  function setFb(el, msg, kind) { el.textContent = msg || ''; el.className = 'xd-fb ' + (kind || ''); }

  // ── Manual payment ─────────────────────────────────────────────────────────────
  async function openManual() {
    var m = state && state.manual;
    if (!m || !m.available) return;
    var b = m.bank;
    var o = openModal('Manual Payment',
      '<div class="xd-bank">' +
      '<div class="xd-row"><span>Bank</span><b>' + esc(b.bankName) + '</b></div>' +
      '<div class="xd-row"><span>Account name</span><b>' + esc(b.accountName) + '</b></div>' +
      '<div class="xd-row"><span>Account number</span><span style="display:flex;align-items:center"><b>' + esc(b.accountNumber) + '</b><button type="button" class="xd-copy" id="xdCopy">Copy</button></span></div>' +
      '</div>' +
      (b.instructions ? '<div class="xd-note" style="margin:0 0 6px">' + esc(b.instructions) + '</div>' : '') +
      '<div class="xd-note" style="margin-top:0">1. Transfer the amount to the account above. &nbsp; 2. Upload your payment receipt here. &nbsp; 3. An admin checks it and credits your wallet.</div>' +
      '<label class="xd-l" for="xdAmt">Amount you sent (₦)</label><input class="xd-in" id="xdAmt" type="number" inputmode="decimal" min="' + m.min + '" placeholder="e.g. 5000"/>' +
      '<label class="xd-l" for="xdName">Name on the sending account</label><input class="xd-in" id="xdName" maxlength="80" placeholder="Your bank account name"/>' +
      '<label class="xd-l" for="xdFile">Payment receipt (screenshot or PDF)</label><input class="xd-in" id="xdFile" type="file" accept="image/*,application/pdf"/>' +
      '<label class="xd-l" for="xdNote">Note (optional)</label><input class="xd-in" id="xdNote" maxlength="300" placeholder="Anything the admin should know"/>' +
      '<button class="xd-btn" id="xdSubmit" type="button">Submit receipt</button><div class="xd-fb" id="xdFb"></div>' +
      '<div class="xd-hist"><h4>Your recent submissions</h4><div id="xdHist"><div class="xd-note">Loading…</div></div></div>');
    o.querySelector('#xdCopy').addEventListener('click', function () {
      var btn = this;
      try { navigator.clipboard.writeText(b.accountNumber); btn.textContent = 'Copied'; setTimeout(function () { btn.textContent = 'Copy'; }, 1500); } catch (e) { /* ignore */ }
    });
    var fb = o.querySelector('#xdFb'), btn = o.querySelector('#xdSubmit');
    btn.addEventListener('click', async function () {
      var amt = parseFloat(o.querySelector('#xdAmt').value);
      var file = o.querySelector('#xdFile').files[0];
      if (!amt || amt < m.min) return setFb(fb, 'Enter the amount you sent (minimum ₦' + m.min + ').', 'err');
      if (!file) return setFb(fb, 'Please choose your payment receipt.', 'err');
      if (file.size > 8 * 1024 * 1024) return setFb(fb, 'Receipt is too large (max 8 MB).', 'err');
      var fd = new FormData();
      fd.append('amount', String(amt));
      fd.append('senderName', o.querySelector('#xdName').value);
      fd.append('note', o.querySelector('#xdNote').value);
      fd.append('receipt', file);
      btn.disabled = true; btn.textContent = 'Uploading…'; setFb(fb, '', '');
      try {
        var d = await api('/api/deposit/manual', { method: 'POST', body: fd });
        setFb(fb, d.message || 'Receipt submitted.', 'ok');
        o.querySelector('#xdAmt').value = ''; o.querySelector('#xdFile').value = ''; o.querySelector('#xdNote').value = '';
        loadHistory(o);
      } catch (e) { setFb(fb, e.message, 'err'); }
      btn.disabled = false; btn.textContent = 'Submit receipt';
    });
    loadHistory(o);
  }
  async function loadHistory(o) {
    var box = o.querySelector('#xdHist');
    try {
      var rows = await api('/api/deposit/manual/mine');
      if (!rows.length) { box.innerHTML = '<div class="xd-note">No submissions yet.</div>'; return; }
      box.innerHTML = rows.map(function (r) {
        return '<div class="xd-hi"><div><b>' + money(r.amount) + '</b><div class="xd-note" style="margin:2px 0 0">' + esc(new Date(r.createdAt).toLocaleString()) +
          (r.status === 'rejected' && r.adminNote ? ' · ' + esc(r.adminNote) : '') + '</div></div><span class="xd-st ' + esc(r.status) + '">' + esc(r.status) + '</span></div>';
      }).join('');
    } catch (e) { box.innerHTML = '<div class="xd-note">Could not load your submissions.</div>'; }
  }

  // ── Paymonetra ─────────────────────────────────────────────────────────────────
  function toast(msg) {
    var t = document.createElement('div');
    t.textContent = msg;
    t.style.cssText = 'position:fixed;left:50%;bottom:90px;transform:translateX(-50%);background:#22c55e;color:#06220f;font-weight:800;padding:12px 18px;border-radius:12px;z-index:10000;max-width:90vw;text-align:center';
    document.body.appendChild(t);
    setTimeout(function () { t.remove(); }, 6000);
  }
  // Ask the server to confirm the customer's latest Paymonetra payment (it credits the wallet when paid).
  async function checkLatest(quiet) {
    try {
      var d = await api('/api/deposit/paymonetra/latest');
      if (d.status === 'success' && d.credited) {
        toast(money(d.credited) + ' added to your wallet');
        try { if (typeof refreshBalance === 'function') refreshBalance(); } catch (e) { /* ignore */ }
      }
      try { localStorage.removeItem('xdPmWait'); } catch (e) { /* ignore */ }
      return d;
    } catch (e) { if (!quiet) throw e; return null; }
  }
  function openPaymonetra() {
    var p = state && state.paymonetra;
    if (!p || !p.available) return;
    var o = openModal('Pay with Paymonetra',
      '<label class="xd-l" for="xdPAmt">Amount to credit your wallet (₦)</label><input class="xd-in" id="xdPAmt" type="number" inputmode="decimal" min="100" placeholder="e.g. 5000"/>' +
      '<button class="xd-btn" id="xdPGo" type="button">Continue to payment</button><div class="xd-fb" id="xdPFb"></div>' +
      '<div class="xd-note">You will be taken to Paymonetra’s secure checkout page with a bank account to pay into. <b>Send exactly the amount shown there, including the kobo</b> — that is how your payment is matched. Your wallet is credited automatically once the bank confirms it.</div>' +
      '<button class="xd-copy" id="xdPCheck" type="button" style="margin:14px 0 0;padding:9px 12px;font-size:.8rem">I’ve paid — check now</button>');
    var fb = o.querySelector('#xdPFb'), btn = o.querySelector('#xdPGo');
    o.querySelector('#xdPCheck').addEventListener('click', async function () {
      setFb(fb, 'Checking…', '');
      try {
        var d = await checkLatest(false);
        if (d && d.status === 'success') setFb(fb, d.credited ? 'Payment confirmed — wallet credited.' : 'This payment was already credited.', 'ok');
        else if (d && d.status === 'none') setFb(fb, 'No pending Paymonetra payment found.', '');
        else setFb(fb, 'Not confirmed by the bank yet — try again in a minute.', '');
      } catch (e) { setFb(fb, e.message, 'err'); }
    });
    btn.addEventListener('click', async function () {
      var amt = parseFloat(o.querySelector('#xdPAmt').value);
      if (!amt || amt < 100) return setFb(fb, 'Enter a valid amount (minimum ₦100).', 'err');
      btn.disabled = true; btn.textContent = 'Preparing payment…'; setFb(fb, '', '');
      try {
        var d = await api('/api/deposit/paymonetra/create', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ amount: amt }) });
        try { localStorage.setItem('xdPmWait', '1'); } catch (e) { /* ignore */ }
        window.location.href = d.link;
      } catch (e) { setFb(fb, e.message, 'err'); btn.disabled = false; btn.textContent = 'Continue to payment'; }
    });
  }

  // ── Mount cards under the Payment Link card ───────────────────────────────────
  function mount() {
    var anchor = document.getElementById('depChoosePL');
    if (!anchor || !state) return;
    injectStyles();
    ['xdCardManual', 'xdCardPaymonetra'].forEach(function (id) { var e = document.getElementById(id); if (e) e.remove(); });
    var after = anchor;
    function add(id, title, sub, badge, on, msg, handler) {
      var wrap = document.createElement('div');
      wrap.innerHTML = cardHtml(id, title, sub, badge);
      var card = wrap.firstChild;
      if (!on) {
        card.classList.add('dep-disabled');
        card.querySelector('.dmc-badge').textContent = 'Unavailable';
        card.querySelector('.dmc-badge').className = 'dmc-badge dmc-badge-red';
        if (msg) card.querySelector('.dmc-sub').textContent = msg;
      } else {
        card.addEventListener('click', handler);
        card.addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); handler(); } });
      }
      after.parentNode.insertBefore(card, after.nextSibling);
      after = card;
    }
    // A method the admin has switched OFF is hidden unless the admin left a message for customers.
    if (state.manual.enabled || state.manual.disabledMessage) add('xdCardManual', 'Manual Payment', 'Bank transfer · upload your receipt', 'Admin approval', state.manual.available, state.manual.disabledMessage, openManual);
    if (state.paymonetra.enabled || state.paymonetra.disabledMessage) add('xdCardPaymonetra', 'Paymonetra', 'Pay securely on Paymonetra checkout', 'Instant', state.paymonetra.available, state.paymonetra.disabledMessage, openPaymonetra);
  }

  async function refresh() {
    if (!tok()) return;
    try { state = await api('/api/deposit/extra-methods'); mount(); } catch (e) { /* not logged in / offline: leave the page as it is */ }
    // coming back from Paymonetra's checkout: confirm the payment right away
    try { if (localStorage.getItem('xdPmWait')) checkLatest(true); } catch (e) { /* ignore */ }
  }

  // The fragment is inserted asynchronously (and again on each visit), so watch for the anchor card.
  var timer = null, lastAnchor = null;
  new MutationObserver(function () {
    var anchor = document.getElementById('depChoosePL');
    // refresh only when a NEW copy of the deposit fragment appears (not on every DOM change)
    if (anchor && anchor !== lastAnchor && !timer) {
      timer = setTimeout(function () { timer = null; lastAnchor = document.getElementById('depChoosePL'); refresh(); }, 150);
    }
  }).observe(document.documentElement, { childList: true, subtree: true });
  document.addEventListener('DOMContentLoaded', refresh);
  window.addEventListener('focus', function () { if (document.getElementById('depChoosePL')) refresh(); });
})();
