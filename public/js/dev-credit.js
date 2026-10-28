/* Site credits and owner contact strip */
(function () {
  'use strict';
  if (window.__slmDevCredit) return;
  window.__slmDevCredit = true;
  var OWNER_WHATSAPP = '#';
  function mount() {
    if (document.querySelector('.slm-devbar')) return;
    var bar = document.createElement('div');
    bar.className = 'slm-devbar';
    // Extra bottom space so the fixed bottom menu and support button never cover the credit text
    bar.style.cssText = 'padding:18px 16px calc(160px + env(safe-area-inset-bottom, 0px));text-align:center;font-size:12.5px;line-height:1.6;opacity:.9;';
    bar.innerHTML =
      '<div class="slm-devbar-inner">' +
        '<div class="slm-devbar-main">' +
          '<span class="slm-devbar-dot" aria-hidden="true"></span>' +
          '<span class="slm-devbar-txt">Edited by <strong>Stevo</strong></span>' +
        '</div>' +
        '<div class="slm-devbar-buy">' +
          'You need something like this? DM <a href="https://t.me/stevotechdigital1" target="_blank" rel="noopener" style="color:inherit"><strong>@stevotechdigital1</strong></a> on Telegram' +
        '</div>' +
      '</div>';
    document.body.appendChild(bar);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount);
  else mount();
})();
