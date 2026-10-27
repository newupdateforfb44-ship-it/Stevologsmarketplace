/* Full-screen three-dot loader for the Boost pages. */
(function () {
  if (window.SlmBoostLoader) return;
  var css = '#slm-boost-loader{position:fixed;inset:0;z-index:2147483000;background:#0b0d11;display:none;align-items:center;justify-content:center;flex-direction:column;gap:14px;color:#f3e3b0;font:800 15px system-ui,sans-serif}' +
    '#slm-boost-loader.on{display:flex}' +
    '#slm-boost-loader .bl-dots{display:inline-flex;gap:8px}' +
    '#slm-boost-loader .bl-dots i{display:block;width:12px;height:12px;border-radius:50%;background:#ffc933;animation:slmBl 1.1s infinite ease-in-out both}' +
    '#slm-boost-loader .bl-dots i:nth-child(2){animation-delay:.16s}#slm-boost-loader .bl-dots i:nth-child(3){animation-delay:.32s}' +
    '@keyframes slmBl{0%,80%,100%{transform:translateY(0);opacity:.35}40%{transform:translateY(-9px);opacity:1}}';
  var st = document.createElement('style'); st.textContent = css; document.head.appendChild(st);
  var el = document.createElement('div');
  el.id = 'slm-boost-loader'; el.className = 'on'; el.setAttribute('role', 'status'); el.setAttribute('aria-live', 'polite');
  el.innerHTML = '<span class="bl-dots"><i></i><i></i><i></i></span>';
  document.documentElement.appendChild(el);
  var timer = null;
  function show() {
    el.classList.add('on'); document.documentElement.style.overflow = 'hidden';
    clearTimeout(timer); timer = setTimeout(hide, 45000); // safety: never block the page forever
  }
  function hide() {
    clearTimeout(timer); el.classList.remove('on'); document.documentElement.style.overflow = '';
  }
  window.SlmBoostLoader = { show: show, hide: hide };
  show();
})();
