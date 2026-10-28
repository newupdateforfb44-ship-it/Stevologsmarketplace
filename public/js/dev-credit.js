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
