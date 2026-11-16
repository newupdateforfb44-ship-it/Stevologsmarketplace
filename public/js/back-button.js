/* Adds a slim "Back" bar at the top of every inner page. */
(function () {
  if (window.__kslBackBar) return; window.__kslBackBar = true;
  var path = location.pathname.replace(/\/+$/, '').replace(/\.html$/i, '') || '/';
  var skip = ['/', '/dashboard', '/login', '/register', '/welcome', '/terms'];
  if (skip.indexOf(path) !== -1 || /admin/i.test(path)) return;
  function mount() {
    if (document.getElementById('kslBackBar') || !document.body) return;
    var st = document.createElement('style');
    st.textContent = '#kslBackBar{position:relative!important;top:auto!important;z-index:1!important;display:flex;align-items:center;padding:10px 14px 4px;background:transparent!important;border-bottom:0!important}' +
      '#kslBackBar button{display:inline-flex;align-items:center;gap:6px;padding:7px 14px;border:1px solid #f5b81c;background:transparent;color:#f5b81c;border-radius:999px;font-weight:700;font-size:13px;cursor:pointer}' +
      'html body .navbar{z-index:600!important}' +
      '#slmMenuTrigger{position:relative;z-index:601}';
    document.head.appendChild(st);
    var bar = document.createElement('div');
    bar.id = 'kslBackBar';
    bar.innerHTML = '<button type="button" aria-label="Go back">\u2190 Back</button>';
    bar.querySelector('button').onclick = function () {
      /* deposit sub-screens (Bank Transfer / Payment Link): go back to the method list first */
      var depOpen = ['depScreen1', 'depScreen2'].some(function (id) {
        var e = document.getElementById(id);
        return e && e.style.display !== 'none' && e.offsetParent !== null;
      });
      if (depOpen && typeof window.depGoHome === 'function') { window.depGoHome(); return; }
      if (path === '/boost1' || path === '/boost2') { location.href = '/boost'; return; }
      if (path === '/boost') { location.href = '/dashboard'; return; }
      var sameSite = document.referrer && document.referrer.indexOf(location.origin) === 0;
      if (sameSite && history.length > 1) history.back(); else location.href = '/dashboard';
    };
    /* slm-after-navbar */ var nav = document.querySelector('.navbar');
    if (nav && nav.parentNode) nav.parentNode.insertBefore(bar, nav.nextSibling);
    else document.body.insertBefore(bar, document.body.firstChild);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount); else mount();
})();
