// Site-wide banner / pop-up colours + per-page notice pop-ups.
// 1) Applies the admin's colour theme to every banner, confirm pop-up and notice (CSS variables on <html>).
// 2) On Rentals, Temp Email, Airtime & Data, Websites, Boost, Marketplace and Gift Delivery, shows that
//    page's admin-written notice once per session (again if the admin edits it).
(function () {
  if (window.__kslPageNotice) return; window.__kslPageNotice = true;
  var KEYS = { bg: '--kn-bg', text: '--kn-text', muted: '--kn-muted', border: '--kn-border', accent: '--kn-accent', accentText: '--kn-accent-text', ok: '--kn-ok', err: '--kn-err' };
  function apply(colors) {
    if (!colors) return;
    var st = document.documentElement.style;
    Object.keys(KEYS).forEach(function (k) { if (/^#[0-9a-f]{6}$/i.test(colors[k] || '')) st.setProperty(KEYS[k], colors[k]); });
  }
  try { apply(JSON.parse(localStorage.getItem('ksl_ui_theme') || 'null')); } catch (e) {}
  fetch('/api/ui-theme', { cache: 'no-store' }).then(function (r) { return r.json(); }).then(function (d) {
    if (d && d.colors) { apply(d.colors); try { localStorage.setItem('ksl_ui_theme', JSON.stringify(d.colors)); } catch (e) {} }
  }).catch(function () {});

  var path = location.pathname.replace(/\/+$/, '').replace(/\.html$/i, '').replace(/^\//, '');
  var PAGE = { rental: 'rental', 'temp-email': 'temp-email', vtu: 'vtu', websites: 'websites', boost: 'boost', boost1: 'boost', boost2: 'boost', 'boost-services': 'boost',
    marketplace: 'marketplace', marketplace2: 'marketplace', marketplace3: 'marketplace', marketplace4: 'marketplace', 'gift-delivery': 'gift-delivery' }[path];
  if (!PAGE) return;
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]; }); }
  function run() {
    fetch('/api/page-notice?page=' + encodeURIComponent(PAGE), { cache: 'no-store' }).then(function (r) { return r.json(); }).then(function (n) {
      if (!n || !n.enabled) return;
      var key = 'ksl_pgnotice_' + PAGE + '_' + (n.version || 0);
      try { if (sessionStorage.getItem(key)) return; } catch (e) {}
      var css = document.createElement('style');
      css.textContent = '.kn-ov{position:fixed;inset:0;z-index:99999;background:rgba(0,0,0,.72);display:flex;align-items:center;justify-content:center;padding:16px}' +
        '.kn-box{width:100%;max-width:480px;max-height:88vh;max-height:88dvh;overflow-y:auto;background:var(--kn-bg,#14141f);color:var(--kn-text,#f5f5fa);border:1px solid var(--kn-border,#2e2e42);border-top:4px solid var(--kn-accent,#f5b81c);border-radius:18px;padding:20px;box-shadow:0 20px 60px rgba(0,0,0,.5)}' +
        '.kn-box h3{margin:0 0 10px;font-size:18px;line-height:1.3;color:var(--kn-text,#f5f5fa)}.kn-msg{white-space:pre-line;font-size:14px;line-height:1.6;color:var(--kn-muted,#cbd0dc);margin:0 0 16px}' +
        '.kn-btn{width:100%;min-height:48px;border:0;border-radius:12px;background:var(--kn-accent,#f5b81c);color:var(--kn-accent-text,#111);font-weight:800;font-size:15px;cursor:pointer}';
      document.head.appendChild(css);
      var ov = document.createElement('div'); ov.className = 'kn-ov';
      ov.innerHTML = '<div class="kn-box" role="dialog" aria-modal="true"><h3>' + esc(n.title) + '</h3><p class="kn-msg">' + esc(n.message) + '</p><button type="button" class="kn-btn">' + esc(n.buttonText) + '</button></div>';
      document.body.appendChild(ov); document.body.style.overflow = 'hidden';
      ov.querySelector('.kn-btn').onclick = function () { try { sessionStorage.setItem(key, '1'); } catch (e) {} document.body.style.overflow = ''; ov.remove(); };
    }).catch(function () {});
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', run); else run();
})();
