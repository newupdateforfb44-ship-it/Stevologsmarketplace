// Updates — customer page. Own file: does not touch the existing marketplace or My Orders code.
(function () {
  var token = '';
  try { token = localStorage.getItem('ksl_token') || ''; } catch (e) {}
  var items = [];

  function esc(s) { return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
  function money(n) { return '₦' + Number(n || 0).toLocaleString('en-NG'); }
  function when(d) { try { return new Date(d).toLocaleString('en-NG', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }); } catch (e) { return ''; } }

  function api(url, method, body) {
    var headers = { 'Content-Type': 'application/json' };
    if (token) headers.Authorization = 'Bearer ' + token;
    return fetch(url, { method: method || 'GET', headers: headers, body: body ? JSON.stringify(body) : undefined, cache: 'no-store' })
      .then(function (r) { return r.json().catch(function () { return {}; }).then(function (d) { if (!r.ok) throw new Error(d.error || 'Request failed'); return d; }); });
  }

  // What the buyer receives. Tutorial-only updates show no delivery block.
  function deliveryHtml(p, uid) {
    var dt = p.deliveryType;
    if (p.productMode === 'tutorial_only' || !dt || dt === 'none') return '';
    var url = esc(p.deliverableFile || '#'), fname = esc(p.deliverableFileName || '');
    if (dt === 'email') return '<div class="box"><div class="lbl">Sent to your email</div><pre>' + esc(p.logDetails) + '</pre></div>';
    if (dt === 'video') return '<div class="box"><div class="lbl">Your video</div><video controls playsinline src="' + url + '" style="width:100%;border-radius:8px"></video><p><a class="lnk" href="' + url + '" download="' + fname + '">Download video</a></p></div>';
    if (dt === 'image') return '<div class="box"><div class="lbl">Your picture</div><img src="' + url + '" alt="" style="width:100%;border-radius:8px"/><p><a class="lnk" href="' + url + '" download="' + fname + '">Download picture</a></p></div>';
    if (dt === 'file') return '<div class="box"><div class="lbl">Your file</div><a class="lnk" href="' + url + '" download="' + fname + '">Download ' + (fname || 'file') + '</a></div>';
    return '<div class="box"><div class="lbl">Your link</div><a class="lnk" href="' + esc(p.toolLink || '#') + '" target="_blank" rel="noopener">' + esc(p.toolLink || '') + '</a></div>';
  }
  function tutorialHtml(t) {
    if (!t || !t.tutorialType || t.tutorialType === 'none') return '';
    var inner = '';
    if (t.tutorialType === 'images') inner = '<div class="gal">' + (t.images || []).map(function (u) { return '<img src="' + esc(u) + '" alt="" onclick="window.open(this.src)"/>'; }).join('') + '</div>';
    if (t.tutorialType === 'video') inner = '<video controls playsinline src="' + esc(t.videoUrl) + '" style="width:100%;border-radius:8px"></video>';
    if (t.tutorialType === 'link') inner = '<a class="lnk" href="' + esc(t.linkUrl) + '" target="_blank" rel="noopener">Open tutorial</a>';
    return '<div class="box"><div class="lbl">Tutorial</div>' + inner + (t.note ? '<p class="msg">' + esc(t.note) + '</p>' : '') + '</div>';
  }
  function audioHtml(url) {
    if (!url) return '';
    return '<div class="box"><div class="lbl">Audio manual</div><audio controls preload="none" src="' + esc(url) + '"></audio><p><a class="lnk" href="' + esc(url) + '" download>Download audio</a></p></div>';
  }
  function messageHtml(m) { return m && String(m).trim() ? '<div class="box"><div class="lbl">Instructions</div><div class="msg">' + esc(m) + '</div></div>' : ''; }
  function deliveredHtml(p, uid) {
    return deliveryHtml(p, uid) + audioHtml(p.audioManual) + messageHtml(p.postPurchaseMessage) + tutorialHtml(p.purchaseTutorial);
  }

  function stockText(u) {
    if (u.soldOut) return '<span class="soldout">Sold out</span>';
    return u.qty > 0 ? '<span class="stock">' + u.remaining + ' left</span>' : '<span class="stock">Unlimited</span>';
  }

  function renderList() {
    var el = document.getElementById('list');
    if (!items.length) { el.innerHTML = '<div class="empty">No updates yet. Check back soon.</div>'; return; }
    el.innerHTML = items.map(function (u) {
      var pic = u.picture ? '<img class="pic" src="' + esc(u.picture) + '" alt="" loading="lazy"/>' : '';
      return '<div class="card" onclick="window.__upOpen(\'' + u.id + '\')">' + pic +
        '<div class="body"><div class="ttl">' + esc(u.title) + '</div>' +
        (u.description ? '<div class="desc">' + esc(u.description).slice(0, 160) + '</div>' : '') +
        '<div class="row"><span class="price">' + money(u.price) + '</span>' + stockText(u) + '</div></div></div>';
    }).join('');
  }

  function openSheet(html) {
    document.getElementById('sheet').innerHTML = '<button class="x" onclick="closeSheet()" aria-label="Close">&times;</button>' + html;
    document.getElementById('overlay').classList.add('open');
  }
  window.closeSheet = function () { document.getElementById('overlay').classList.remove('open'); };

  window.__upOpen = function (id) {
    var u = items.find(function (x) { return x.id === id; });
    if (!u) return;
    var gal = (u.workingPictures || []).length ? '<div class="box"><div class="lbl">Working proof</div><div class="gal">' + u.workingPictures.map(function (s) { return '<img src="' + esc(s) + '" alt="" onclick="window.open(this.src)"/>'; }).join('') + '</div></div>' : '';
    var action;
    if (!token) action = '<a class="btn" href="/login" style="display:block;text-align:center;text-decoration:none">Log in to buy</a>';
    else if (u.soldOut) action = '<button class="btn" disabled>Sold out</button>';
    else action = '<button class="btn" id="buyBtn" onclick="window.__upBuy(\'' + u.id + '\')">Buy now — ' + money(u.price) + '</button>';
    openSheet((u.picture ? '<img class="big" src="' + esc(u.picture) + '" alt=""/>' : '') +
      '<h2 style="margin-top:0">' + esc(u.title) + '</h2>' +
      (u.description ? '<div class="msg">' + esc(u.description) + '</div>' : '') +
      '<div class="row"><span class="price">' + money(u.price) + '</span>' + stockText(u) + '</div>' +
      gal +
      '<div style="margin-top:14px" id="buyArea">' + action + '</div><div id="buyMsg"></div>');
  };

  window.__upBuy = function (id) {
    var btn = document.getElementById('buyBtn');
    if (btn) { btn.disabled = true; btn.textContent = 'Processing…'; }
    api('/api/updates/buy/' + id, 'POST', {}).then(function (d) {
      var p = d.purchase;
      document.getElementById('buyArea').innerHTML = '<div class="ok">Purchase successful! New balance: ' + money(d.newBalance) + '</div>';
      document.getElementById('buyMsg').innerHTML = deliveredHtml(p, 'buy');
      loadHistory();
      loadList();
    }).catch(function (e) {
      document.getElementById('buyMsg').innerHTML = '<div class="err">' + esc(e.message) + '</div>';
      if (btn) { btn.disabled = false; btn.textContent = 'Buy now'; }
    });
  };

  function loadList() {
    return api('/api/updates').then(function (d) { items = d; renderList(); })
      .catch(function (e) { document.getElementById('list').innerHTML = '<div class="err">' + esc(e.message) + '</div>'; });
  }

  function loadHistory() {
    var el = document.getElementById('history');
    if (!token) { el.innerHTML = '<div class="empty">Log in to see your purchases.</div>'; return; }
    api('/api/updates/purchases').then(function (rows) {
      if (!rows.length) { el.innerHTML = '<div class="empty">No update purchases yet.</div>'; return; }
      el.innerHTML = rows.map(function (p) {
        return '<details><summary>' + esc(p.title) + ' — ' + money(p.pricePaid) + ' <span class="stock">· ' + esc(when(p.purchasedAt)) + '</span></summary>' + deliveredHtml(p, 'h' + p.id) + '</details>';
      }).join('');
    }).catch(function (e) { el.innerHTML = '<div class="err">' + esc(e.message) + '</div>'; });
  }

  loadList();
  loadHistory();
})();
