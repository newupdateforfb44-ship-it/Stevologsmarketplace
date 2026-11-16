// Admin → "Page notices & colours". Talks to /api/admin/page-notices and /api/admin/ui-theme.
(function () {
  var root, D = null, sel = 'rental';
  var esc = function (s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); };
  var $ = function (id) { return document.getElementById(id); };
  var inp = 'width:100%;padding:10px 12px;border-radius:8px;border:1px solid var(--border2,#333);background:var(--bg3,#111);color:var(--t1,#fff);font:inherit;box-sizing:border-box';
  var LABELS = { bg: 'Box background', text: 'Title text', muted: 'Message text', border: 'Border', accent: 'Accent / button', accentText: 'Button text', ok: 'Success banner', err: 'Error banner' };
  function hdr(json) {
    var h = {}; if (json) h['Content-Type'] = 'application/json';
    try { if (typeof currentRole !== 'undefined' && currentRole === 'staff') h.Authorization = 'Bearer ' + staffToken; else h['x-admin-passcode'] = adminPass; } catch (e) {}
    return h;
  }
  async function call(method, url, body) {
    var r = await fetch(url, { method: method, headers: hdr(!!body), body: body ? JSON.stringify(body) : undefined });
    var j = await r.json().catch(function () { return {}; });
    if (!r.ok) throw new Error(j.error || ('Request failed (' + r.status + ')'));
    return j;
  }
  function say(id, msg, bad) { var f = $(id); if (!f) return; f.style.color = bad ? '#ff9ea6' : '#7be0a4'; f.textContent = msg; if (msg) setTimeout(function () { if (f.textContent === msg) f.textContent = ''; }, 5000); }
  function cur() { return D.pages.filter(function (p) { return p.page === sel; })[0]; }
  function colors() { var c = {}; Object.keys(LABELS).forEach(function (k) { var e = $('pnc_' + k); c[k] = e ? e.value : D.theme[k]; }); return c; }

  window.pnLoad = async function () {
    root = $('pnRoot'); if (!root) return;
    try { D = await call('GET', '/api/admin/page-notices'); render(); }
    catch (e) { root.innerHTML = '<div style="color:#ff9ea6">' + esc(e.message) + '</div>'; }
  };

  function preview() {
    var c = colors();
    var p = $('pnPrev'); if (!p) return;
    p.style.cssText = 'background:' + c.bg + ';color:' + c.text + ';border:1px solid ' + c.border + ';border-top:4px solid ' + c.accent + ';border-radius:16px;padding:16px;max-width:380px';
    p.innerHTML = '<div style="font-weight:800;font-size:16px;margin-bottom:8px">' + esc(($('pnTitle') && $('pnTitle').value) || 'Notice title') + '</div>' +
      '<div style="font-size:13.5px;line-height:1.55;color:' + c.muted + ';white-space:pre-line;margin-bottom:12px">' + esc(($('pnMsg') && $('pnMsg').value) || 'Your message shows here.') + '</div>' +
      '<div style="background:' + c.accent + ';color:' + c.accentText + ';text-align:center;font-weight:800;border-radius:10px;padding:11px">' + esc(($('pnBtn') && $('pnBtn').value) || 'I understand, continue') + '</div>' +
      '<div style="display:flex;gap:8px;margin-top:12px;font-size:12.5px;font-weight:700"><span style="flex:1;padding:8px 10px;border-radius:8px;background:' + c.bg + ';border:1px solid ' + c.border + ';border-left:4px solid ' + c.ok + '">✓ Success banner</span><span style="flex:1;padding:8px 10px;border-radius:8px;background:' + c.bg + ';border:1px solid ' + c.border + ';border-left:4px solid ' + c.err + '">! Error banner</span></div>';
  }

  function render() {
    var n = cur(), t = D.theme;
    root.innerHTML =
      '<div class="info-box" style="margin:8px 0 14px">Show a pop-up message on any page, like the Buy Number notice. Customers tap the button to continue, and it appears again only when you edit the message. Colours apply to every notice, banner and confirmation pop-up on the site.</div>' +
      '<div class="sec"><div class="sec-title">Notice for a page</div>' +
      '<div class="fg"><label>Page</label><select id="pnPage" style="' + inp + '" onchange="pnPick(this.value)">' + D.pages.map(function (p) { return '<option value="' + p.page + '"' + (p.page === sel ? ' selected' : '') + '>' + esc(p.label) + (p.enabled ? ' — ON' : '') + '</option>'; }).join('') + '</select></div>' +
      '<label style="display:flex;gap:8px;align-items:center;margin:10px 0"><input type="checkbox" id="pnOn" ' + (n.enabled ? 'checked' : '') + '> Show this notice on <b>' + esc(n.label) + '</b></label>' +
      '<div class="fg"><label>Title</label><input id="pnTitle" style="' + inp + '" maxlength="120" value="' + esc(n.title) + '" oninput="pnPrev()"></div>' +
      '<div class="fg"><label>Message (line breaks are kept)</label><textarea id="pnMsg" style="' + inp + ';min-height:130px" maxlength="2500" oninput="pnPrev()">' + esc(n.message) + '</textarea></div>' +
      '<div class="fg"><label>Button text</label><input id="pnBtn" style="' + inp + '" maxlength="60" value="' + esc(n.buttonText) + '" oninput="pnPrev()"></div>' +
      '<button class="btn-gold" onclick="pnSave()">Save notice</button><div id="pnFb" class="fb"></div>' +
      '<div style="font-size:12px;opacity:.7;margin-top:8px">' + (n.updatedAt ? 'Last saved ' + new Date(n.updatedAt).toLocaleString() : 'Nothing saved for this page yet.') + '</div></div>' +
      '<div class="sec"><div class="sec-title">Banner &amp; pop-up colours</div>' +
      '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px;margin-bottom:12px">' +
      Object.keys(LABELS).map(function (k) { return '<label style="display:flex;flex-direction:column;gap:6px;font-size:13px"><span>' + LABELS[k] + '</span><input type="color" id="pnc_' + k + '" value="' + t[k] + '" oninput="pnPrev()" style="width:100%;height:42px;border:1px solid var(--border2,#333);border-radius:8px;background:none;padding:2px"></label>'; }).join('') + '</div>' +
      '<div style="margin-bottom:12px"><div style="font-size:12px;opacity:.7;margin-bottom:6px">Live preview</div><div id="pnPrev"></div></div>' +
      '<button class="btn-gold" onclick="pnSaveTheme()">Save colours</button> <button class="btn-sm" onclick="pnResetTheme()">Reset to default</button><div id="pnTFb" class="fb"></div></div>';
    preview();
  }
  window.pnPrev = preview;
  window.pnPick = function (v) { sel = v; render(); };
  window.pnSave = async function () {
    try {
      var r = await call('PUT', '/api/admin/page-notices/' + sel, { enabled: $('pnOn').checked, title: $('pnTitle').value, message: $('pnMsg').value, buttonText: $('pnBtn').value });
      D.pages = D.pages.map(function (p) { return p.page === sel ? r.notice : p; }); render(); say('pnFb', 'Saved ✔');
    } catch (e) { say('pnFb', e.message, true); }
  };
  window.pnSaveTheme = async function () {
    try { var r = await call('PUT', '/api/admin/ui-theme', { colors: colors() }); D.theme = r.colors; say('pnTFb', 'Colours saved ✔ — customers see them on their next page load'); }
    catch (e) { say('pnTFb', e.message, true); }
  };
  window.pnResetTheme = async function () {
    try { var r = await call('PUT', '/api/admin/ui-theme', { reset: true }); D.theme = r.colors; render(); say('pnTFb', 'Colours reset ✔'); }
    catch (e) { say('pnTFb', e.message, true); }
  };
})();
