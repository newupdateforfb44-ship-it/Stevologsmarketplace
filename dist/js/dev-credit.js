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
          '<span class="slm-devbar-txt">Designed and engineered by developer <strong>Marvel</strong></span>' +
        '</div>' +
        '<div class="slm-devbar-buy">' +
          'Want to buy this website? <a href="' + OWNER_WHATSAPP + '" target="_blank" rel="noopener noreferrer" class="slm-devbar-cta">Contact the admin / owner on WhatsApp: +234 812 835 8120</a>' +
        '</div>' +
      '</div>';
    document.body.appendChild(bar);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount);
  else mount();
})();
