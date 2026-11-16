// Admin → "Gift Delivery" tab. Loaded by admin.html; talks to /api/admin/gifts/*.
(function () {
  var root;
  var S = { products: [], orders: [], stats: {}, filter: '', editing: null, settings: {}, psearch: '', reqs: [], reqStats: {}, reqFilter: '' };
  var esc = function (s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); };
  var naira = function (n) { return '₦' + Math.round(Number(n || 0)).toLocaleString('en-NG'); };
  var $ = function (id) { return document.getElementById(id); };
  var inp = 'width:100%;padding:10px 12px;border-radius:8px;border:1px solid var(--border2,#333);background:var(--bg3,#111);color:var(--t1,#fff);font:inherit;box-sizing:border-box';
  var card = 'border:1px solid var(--border2,#333);border-radius:12px;padding:14px;margin-bottom:12px;background:var(--bg2,transparent)';

  function hdr(json) {
    var h = {}; if (json) h['Content-Type'] = 'application/json';
    try { if (typeof currentRole !== 'undefined' && currentRole === 'staff') h.Authorization = 'Bearer ' + staffToken; else h['x-admin-passcode'] = adminPass; } catch (e) {}
    return h;
  }
  async function call(method, url, body, isForm) {
    var opt = { method: method, headers: hdr(!isForm) };
    if (body) opt.body = isForm ? body : JSON.stringify(body);
    var r = await fetch(url, opt);
    var j = await r.json().catch(function () { return {}; });
    if (!r.ok) throw new Error(j.error || ('Request failed (' + r.status + ')'));
    return j;
  }
  function say(id, msg, bad) {
    var f = $(id); if (!f) return;
    f.style.color = bad ? '#ff9ea6' : '#7be0a4'; f.textContent = msg;
    if (msg) setTimeout(function () { if (f.textContent === msg) f.textContent = ''; }, 5000);
  }

  window.gdAdmLoad = async function () {
    root = $('gdAdmRoot'); if (!root) return;
    if (!S.settings.effectiveWhatsapp && !S.products.length) root.innerHTML = 'Loading…';
    try {
      var r = await Promise.all([
        call('GET', '/api/admin/gifts/settings'),
        call('GET', '/api/admin/gifts/products'),
        call('GET', '/api/admin/gifts/orders' + (S.filter ? '?status=' + S.filter : '')),
        call('GET', '/api/admin/gifts/requests' + (S.reqFilter ? '?status=' + S.reqFilter : ''))
      ]);
      S.settings = r[0]; S.products = r[1].products || []; S.orders = r[2].orders || []; S.stats = r[2].stats || {};
      S.reqs = r[3].requests || []; S.reqStats = r[3].stats || {};
      render();
    } catch (e) { root.innerHTML = '<div style="color:#ff9ea6">' + esc(e.message) + '</div>'; }
  };

  function stat(label, val, color) {
    return '<div style="flex:1;min-width:120px;border:1px solid var(--border2,#333);border-radius:12px;padding:12px 14px"><div style="font-size:12px;color:var(--t2)">' + label + '</div><div style="font-size:22px;font-weight:800;color:' + color + '">' + val + '</div></div>';
  }
  function tab(val, label, n) {
    var on = S.filter === val;
    return '<button class="btn-sm" style="' + (on ? 'background:var(--gold);color:#000;border-color:var(--gold)' : '') + '" onclick="gdFilter(\'' + val + '\')">' + label + (n != null ? ' (' + n + ')' : '') + '</button>';
  }

  function render() {
    var s = S.settings, st = S.stats;
    root.innerHTML =
      (s.emailConfigured ? '' : '<div class="info-box" style="margin:8px 0;border-color:#ff9ea6">⚠ Order emails are <b>not active</b>. Set <code>ADMIN_ALERT_EMAIL</code> and <code>RESEND_API_KEY</code> in Render so you are emailed the moment a customer pays. Orders still appear below either way.</div>') +
      '<div style="display:flex;gap:10px;flex-wrap:wrap;margin:8px 0 16px">' +
      stat('Pending', st.pending || 0, '#f5b81c') + stat('Gifted', st.gifted || 0, '#7be0a4') + stat('Cancelled', st.cancelled || 0, '#ff9ea6') + stat('Revenue', naira(st.revenue), 'var(--t1)') + '</div>' +

      '<div class="sec"><div class="sec-title">Orders</div>' +
      '<div style="display:flex;gap:8px;margin-bottom:12px;flex-wrap:wrap">' + tab('', 'All') + tab('pending', 'Pending', st.pending || 0) + tab('gifted', 'Gifted', st.gifted || 0) + tab('cancelled', 'Cancelled', st.cancelled || 0) +
      '<button class="btn-sm" onclick="gdAdmLoad()">↻ Refresh</button></div>' +
      '<div id="gdOrders">' + (S.orders.length ? S.orders.map(orderCard).join('') : '<div style="color:var(--t2);padding:14px 0">No orders here yet. Paid orders appear instantly.</div>') + '</div></div>' +

      '<div class="sec"><div class="sec-title">Customer requests (' + (S.reqStats['new'] || 0) + ' new)</div>' +
      '<div style="font-size:13px;color:var(--t2);margin-bottom:10px">When a customer cannot find a gift, they fill in the item and details, then are sent to your WhatsApp for a price quote.</div>' +
      '<div style="display:flex;gap:8px;margin-bottom:12px;flex-wrap:wrap">' + rtab('', 'All') + rtab('new', 'New', S.reqStats['new'] || 0) + rtab('contacted', 'Contacted', S.reqStats.contacted || 0) + rtab('closed', 'Closed', S.reqStats.closed || 0) + '</div>' +
      '<div id="gdReqs">' + (S.reqs.length ? S.reqs.map(reqCard).join('') : '<div style="color:var(--t2);padding:10px 0">No requests yet.</div>') + '</div></div>' +

      '<div class="sec"><div class="sec-title" id="gdFormTitle">' + (S.editing ? 'Edit gift' : 'Add a gift') + '</div>' + productForm() + '</div>' +

      '<div class="sec"><div class="sec-title">Gifts (' + S.products.length + ')</div>' +
      '<input id="gdPSearch" style="' + inp + ';margin-bottom:10px" placeholder="Search gifts…" value="' + esc(S.psearch) + '" oninput="gdPSearch(this.value)">' +
      '<div id="gdProducts">' + productList() + '</div></div>' +

      '<div class="sec"><div class="sec-title">Settings</div>' +
      '<label style="display:flex;gap:8px;align-items:center;margin-bottom:10px"><input type="checkbox" id="gdOn" ' + (s.enabled ? 'checked' : '') + '> Gift Delivery is ON for customers</label>' +
      '<div class="fg"><label>Delivery fee per order (₦) — charged only when the order has a gift without the “free shipping” label. 0 = no fee.</label><input id="gdFee" style="' + inp + '" inputmode="numeric" value="' + (s.deliveryFee || 0) + '"></div>' +
      '<div class="fg"><label>Support WhatsApp number (blank = site WhatsApp number, currently ' + esc(s.effectiveWhatsapp || 'not set') + ')</label><input id="gdWa" style="' + inp + '" inputmode="numeric" placeholder="e.g. 2348012345678" value="' + esc(s.whatsappNumber) + '"></div>' +
      '<div class="fg"><label>Banner on the shop (optional)</label><input id="gdNotice" style="' + inp + '" maxlength="300" value="' + esc(s.notice) + '" placeholder="e.g. Valentine orders close on 10 Feb"></div>' +
      '<div class="fg"><label>Checkout message (shown to the customer on the payment page, with a WhatsApp button for final price confirmation)</label><textarea id="gdCkNote" style="' + inp + ';min-height:70px" maxlength="400">' + esc(s.checkoutNote) + '</textarea></div>' +
      '<div class="fg"><label>Delivery note</label><input id="gdDelNote" style="' + inp + '" maxlength="300" value="' + esc(s.deliveryNote) + '"></div>' +
      '<button class="btn-gold" onclick="gdSaveSettings()">Save settings</button><div id="gdSetFb" class="fb"></div></div>';
  }

  function orderCard(o) {
    var c = o.customer || {}, ph = String(o.contactPhone || o.recipientPhone || '').replace(/\D/g, '');
    if (ph.length === 11 && ph[0] === '0') ph = '234' + ph.slice(1);
    var col = o.status === 'gifted' ? '#7be0a4' : o.status === 'cancelled' ? '#ff9ea6' : '#f5b81c';
    var id = o._id, btns = '';
    if (o.status === 'pending') btns += '<button class="btn-gold" style="padding:9px 16px" onclick="gdSetStatus(\'' + id + '\',\'gifted\')">✓ Mark as gifted</button>';
    if (o.status === 'gifted') btns += '<button class="btn-sm" onclick="gdSetStatus(\'' + id + '\',\'pending\')">Mark as pending</button>';
    if (o.status !== 'cancelled') btns += '<button class="btn-sm" style="color:#ff9ea6" onclick="gdCancel(\'' + id + '\',' + (o.total || 0) + ')">Cancel &amp; refund</button>';
    return '<div style="' + card + '">' +
      '<div style="display:flex;justify-content:space-between;gap:8px;flex-wrap:wrap;margin-bottom:6px"><b>' + esc(o.ref) + '</b><span style="color:' + col + ';font-weight:700">' + esc(o.statusLabel || o.status) + '</span></div>' +
      '<div style="font-size:13px;color:var(--t2);margin-bottom:8px">' + esc(c.name) + (c.email ? ' · ' + esc(c.email) : '') + ' · paid ' + (o.paidAt ? new Date(o.paidAt).toLocaleString() : new Date(o.createdAt).toLocaleString()) + '</div>' +
      '<div style="font-size:14px;margin-bottom:8px">' + (o.items || []).map(function (i) { return esc(i.qty + ' × ' + i.name) + ' <span style="color:var(--t2)">(' + naira(i.price) + ')</span>'; }).join('<br>') + '</div>' +
      '<div style="font-size:14px;margin-bottom:8px"><b>Paid:</b> ' + naira(o.total) + (o.deliveryFee ? ' <span style="color:var(--t2)">(incl. ' + naira(o.deliveryFee) + ' delivery)</span>' : '') + '</div>' +
      '<div style="font-size:14px;line-height:1.55;margin-bottom:10px;padding:10px 12px;border-radius:8px;background:var(--bg3,rgba(255,255,255,.04))"><b>Deliver to:</b> ' + esc(o.recipientName) + ' · ' + esc(o.recipientPhone) + '<br>' + esc(o.address) + (o.landmark ? ' (' + esc(o.landmark) + ')' : '') + ', ' + esc(o.city) + ', ' + esc(o.state) +
      (o.deliveryDate ? '<br><b>Preferred date:</b> ' + esc(o.deliveryDate) : '') + (o.giftMessage ? '<br><b>Card message:</b> ' + esc(o.giftMessage) : '') + '</div>' +
      '<div style="display:flex;gap:8px;margin-bottom:8px"><input id="gdNt_' + id + '" style="' + inp + '" maxlength="500" placeholder="Note shown to the customer (optional)" value="' + esc(o.adminNote) + '"><button class="btn-sm" onclick="gdSaveNote(\'' + id + '\')">Save note</button></div>' +
      '<div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">' + btns +
      (ph.length >= 10 ? '<a class="btn-sm" style="text-decoration:none" target="_blank" rel="noopener" href="https://wa.me/' + ph + '">WhatsApp customer</a>' : '') +
      '<span id="gdOFb_' + id + '" style="font-size:13px"></span></div></div>';
  }

  function productForm() {
    var p = S.editing ? (S.products.filter(function (x) { return x._id === S.editing; })[0] || {}) : {};
    var chk = function (v, d) { return (v === undefined ? d : v) ? 'checked' : ''; };
    var cats = []; S.products.forEach(function (x) { if (x.category && cats.indexOf(x.category) < 0) cats.push(x.category); });
    return '<div class="fg"><label>Name *</label><input id="gdpName" style="' + inp + '" maxlength="140" value="' + esc(p.name) + '"></div>' +
      '<div style="display:grid;grid-template-columns:1fr 1fr;gap:10px"><div class="fg"><label>Price (₦) *</label><input id="gdpPrice" style="' + inp + '" inputmode="numeric" value="' + (p.price || '') + '"></div>' +
      '<div class="fg"><label>Category</label><input id="gdpCat" list="gdCats" style="' + inp + '" maxlength="60" placeholder="e.g. Flowers" value="' + esc(p.category || '') + '"><datalist id="gdCats">' + cats.map(function (c) { return '<option value="' + esc(c) + '">'; }).join('') + '</datalist></div></div>' +
      '<div class="fg"><label>Description</label><textarea id="gdpDesc" style="' + inp + ';min-height:80px" maxlength="1500" placeholder="What is included, size, colour…">' + esc(p.description) + '</textarea></div>' +
      (S.editing && (p.images || []).length ? '<div class="fg"><label>Current pictures (first one is the main picture)</label><div style="display:flex;gap:10px;flex-wrap:wrap">' + p.images.map(function (u, i) {
        return '<div style="width:92px"><img src="' + esc(u) + '" style="width:92px;height:92px;object-fit:cover;border-radius:8px;background:#fff;display:block;' + (i === 0 ? 'outline:2px solid var(--gold)' : '') + '">' +
          '<div style="display:flex;gap:4px;margin-top:4px">' + (i > 0 ? '<button class="btn-sm" style="padding:3px 6px;font-size:11px" data-u="' + esc(u) + '" onclick="gdImg(\'' + p._id + '\',\'makePrimary\',this)">Main</button>' : '<span style="font-size:11px;color:var(--gold);padding:4px">Main</span>') +
          '<button class="btn-sm" style="padding:3px 6px;font-size:11px;color:#ff9ea6" data-u="' + esc(u) + '" onclick="gdImg(\'' + p._id + '\',\'removeImage\',this)">Remove</button></div></div>';
      }).join('') + '</div></div>' : '') +
      '<div class="fg"><label>' + (S.editing ? 'Add more pictures' : 'Pictures') + ' (up to 5, JPG/PNG/WEBP)</label><input id="gdpImgs" type="file" accept="image/*" multiple style="' + inp + '" onchange="gdPreview(this)"><div id="gdPrev" style="display:flex;gap:8px;flex-wrap:wrap;margin-top:8px"></div></div>' +
      '<div class="fg"><label>…or paste an image link</label><input id="gdpUrl" style="' + inp + '" placeholder="https://…"></div>' +
      '<div style="display:flex;gap:16px;flex-wrap:wrap;margin-bottom:12px">' +
      '<label><input type="checkbox" id="gdpShip" ' + chk(p.freeShipping, true) + '> Free shipping label</label>' +
      '<label><input type="checkbox" id="gdpStock" ' + chk(p.inStock, true) + '> In stock</label>' +
      '<label><input type="checkbox" id="gdpBest" ' + chk(p.bestSelling, false) + '> Best selling</label>' +
      '<label><input type="checkbox" id="gdpActive" ' + chk(p.active, true) + '> Visible to customers</label></div>' +
      '<button class="btn-gold" onclick="gdSaveProduct()">' + (S.editing ? 'Save changes' : 'Add gift') + '</button>' +
      (S.editing ? ' <button class="btn-sm" onclick="gdCancelEdit()">Cancel</button>' : '') + '<div id="gdPFb" class="fb"></div>';
  }

  function productList() {
    var q = S.psearch.trim().toLowerCase();
    var list = S.products.filter(function (p) { return !q || (p.name + ' ' + p.category).toLowerCase().indexOf(q) > -1; });
    if (!list.length) return '<div style="color:var(--t2)">' + (S.products.length ? 'No match.' : 'No gifts yet. Add your first gift above.') + '</div>';
    return list.map(function (p) {
      var tags = [esc(p.category), naira(p.price)];
      if (p.bestSelling) tags.push('★ best selling'); if (p.inStock === false) tags.push('<span style="color:#ff9ea6">out of stock</span>'); if (p.active === false) tags.push('<span style="color:#ff9ea6">hidden</span>');
      return '<div style="display:flex;gap:12px;align-items:center;padding:10px 0;border-top:1px solid var(--border2,#333)">' +
        '<div style="width:56px;height:56px;border-radius:8px;background:#fff;overflow:hidden;flex:none">' + ((p.images || [])[0] ? '<img src="' + esc(p.images[0]) + '" style="width:100%;height:100%;object-fit:contain">' : '') + '</div>' +
        '<div style="flex:1;min-width:0"><b style="display:block;font-size:14px">' + esc(p.name) + '</b><span style="font-size:12px;color:var(--t2)">' + tags.join(' · ') + '</span></div>' +
        '<button class="btn-sm" onclick="gdEdit(\'' + p._id + '\')">Edit</button> <button class="btn-sm" style="color:#ff9ea6" onclick="gdDelete(\'' + p._id + '\')">Delete</button></div>';
    }).join('');
  }

  function rtab(val, label, n) {
    var on = S.reqFilter === val;
    return '<button class="btn-sm" style="' + (on ? 'background:var(--gold);color:#000;border-color:var(--gold)' : '') + '" onclick="gdReqFilter(\'' + val + '\')">' + label + (n != null ? ' (' + n + ')' : '') + '</button>';
  }
  function reqCard(r) {
    var ph = String(r.contactPhone || '').replace(/\D/g, '');
    if (ph.length === 11 && ph[0] === '0') ph = '234' + ph.slice(1);
    var col = r.status === 'closed' ? '#9aa0aa' : r.status === 'contacted' ? '#7be0a4' : '#f5b81c', id = r._id;
    var opts = ['new', 'contacted', 'closed'].map(function (v) { return '<option value="' + v + '"' + (r.status === v ? ' selected' : '') + '>' + v.charAt(0).toUpperCase() + v.slice(1) + '</option>'; }).join('');
    return '<div style="' + card + '">' +
      '<div style="display:flex;justify-content:space-between;gap:8px;flex-wrap:wrap;margin-bottom:6px"><b>' + esc(r.itemName) + (r.quantity > 1 ? ' × ' + r.quantity : '') + '</b><span style="color:' + col + ';font-weight:700">' + esc(r.statusLabel) + '</span></div>' +
      '<div style="font-size:12px;color:var(--t2);margin-bottom:8px">' + esc(r.ref) + ' · ' + esc(r.username) + (r.userEmail ? ' · ' + esc(r.userEmail) : '') + ' · ' + new Date(r.createdAt).toLocaleString() + '</div>' +
      '<div style="font-size:14px;line-height:1.55;white-space:pre-line;margin-bottom:8px">' + esc(r.details) + '</div>' +
      (r.budget || r.recipientCity ? '<div style="font-size:13px;color:var(--t2);margin-bottom:8px">' + (r.budget ? 'Budget: ' + esc(r.budget) : '') + (r.budget && r.recipientCity ? ' · ' : '') + (r.recipientCity ? 'City: ' + esc(r.recipientCity) : '') + '</div>' : '') +
      '<div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">' +
      '<select style="' + inp + ';width:auto" onchange="gdReqStatus(\'' + id + '\',this.value)">' + opts + '</select>' +
      (ph.length >= 10 ? '<a class="btn-sm" style="text-decoration:none" target="_blank" rel="noopener" href="https://wa.me/' + ph + '">WhatsApp customer</a>' : '') +
      '<button class="btn-sm" style="color:#ff9ea6" onclick="gdReqDelete(\'' + id + '\')">Delete</button><span id="gdRFb_' + id + '" style="font-size:13px"></span></div></div>';
  }
  window.gdReqFilter = function (v) { S.reqFilter = v; gdAdmLoad(); };
  window.gdReqStatus = async function (id, status) {
    try { await call('PATCH', '/api/admin/gifts/requests/' + id, { status: status }); await gdAdmLoad(); }
    catch (e) { say('gdRFb_' + id, e.message, true); }
  };
  window.gdReqDelete = async function (id) {
    if (!confirm('Delete this request?')) return;
    try { await call('DELETE', '/api/admin/gifts/requests/' + id); gdAdmLoad(); } catch (e) { alert(e.message); }
  };

  window.gdFilter = function (v) { S.filter = v; gdAdmLoad(); };
  window.gdPSearch = function (v) { S.psearch = v; var el = $('gdProducts'); if (el) el.innerHTML = productList(); };
  window.gdPreview = function (inpEl) {
    var box = $('gdPrev'); if (!box) return; box.innerHTML = '';
    Array.prototype.slice.call(inpEl.files || [], 0, 5).forEach(function (f) { var im = document.createElement('img'); im.src = URL.createObjectURL(f); im.style.cssText = 'width:64px;height:64px;object-fit:cover;border-radius:8px'; box.appendChild(im); });
  };
  window.gdSaveSettings = async function () {
    try {
      await call('POST', '/api/admin/gifts/settings', { enabled: $('gdOn').checked, deliveryFee: $('gdFee').value || 0, whatsappNumber: $('gdWa').value, notice: $('gdNotice').value, deliveryNote: $('gdDelNote').value, checkoutNote: $('gdCkNote').value });
      await gdAdmLoad(); say('gdSetFb', 'Saved ✔');
    } catch (e) { say('gdSetFb', e.message, true); }
  };
  window.gdSetStatus = async function (id, status) {
    try { await call('PATCH', '/api/admin/gifts/orders/' + id, { status: status }); await gdAdmLoad(); }
    catch (e) { say('gdOFb_' + id, e.message, true); }
  };
  window.gdCancel = async function (id, amt) {
    if (!confirm('Cancel this order and refund ' + naira(amt) + ' to the customer’s wallet? This cannot be undone.')) return;
    try { await call('PATCH', '/api/admin/gifts/orders/' + id, { status: 'cancelled' }); await gdAdmLoad(); }
    catch (e) { say('gdOFb_' + id, e.message, true); }
  };
  window.gdSaveNote = async function (id) {
    try { await call('PATCH', '/api/admin/gifts/orders/' + id, { adminNote: $('gdNt_' + id).value }); say('gdOFb_' + id, 'Note saved ✔'); }
    catch (e) { say('gdOFb_' + id, e.message, true); }
  };
  window.gdEdit = function (id) { S.editing = id; render(); var t = $('gdFormTitle'); if (t) t.scrollIntoView({ behavior: 'smooth', block: 'start' }); };
  window.gdCancelEdit = function () { S.editing = null; render(); };
  window.gdSaveProduct = async function () {
    var price = $('gdpPrice').value.replace(/[^\d.]/g, '');
    var fd = new FormData();
    fd.append('name', $('gdpName').value); fd.append('price', price);
    fd.append('category', $('gdpCat').value); fd.append('description', $('gdpDesc').value);
    ['Ship:freeShipping', 'Stock:inStock', 'Best:bestSelling', 'Active:active'].forEach(function (x) { var p = x.split(':'); fd.append(p[1], $('gdp' + p[0]).checked ? 'true' : 'false'); });
    var url = $('gdpUrl').value.trim(); if (url) fd.append('imageUrl', url);
    Array.prototype.forEach.call($('gdpImgs').files || [], function (f) { fd.append('images', f); });
    try {
      var wasEdit = !!S.editing;
      if (S.editing) await call('PUT', '/api/admin/gifts/products/' + S.editing, fd, true);
      else await call('POST', '/api/admin/gifts/products', fd, true);
      S.editing = null; await gdAdmLoad(); say('gdPFb', wasEdit ? 'Changes saved ✔' : 'Gift added ✔');
    } catch (e) { say('gdPFb', e.message, true); }
  };
  window.gdImg = async function (id, field, btn) {
    try { var fd = new FormData(); fd.append(field, btn.getAttribute('data-u')); await call('PUT', '/api/admin/gifts/products/' + id, fd, true); await gdAdmLoad(); }
    catch (e) { say('gdPFb', e.message, true); }
  };
  window.gdDelete = async function (id) {
    if (!confirm('Delete this gift? Past orders keep their own copy of it.')) return;
    try { await call('DELETE', '/api/admin/gifts/products/' + id); gdAdmLoad(); } catch (e) { alert(e.message); }
  };
})();
