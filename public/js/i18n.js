/* public/js/i18n.js - English only. Language switcher and auto-translation removed. */
(function (global) {
  'use strict';
  try {
    localStorage.setItem('slm_lang', 'en');
    Object.keys(localStorage).forEach(function (k) {
      if (k.indexOf('slm_i18n_') === 0) localStorage.removeItem(k);
    });
  } catch (e) {}
  try { document.documentElement.lang = 'en'; document.documentElement.dir = 'ltr'; } catch (e) {}
  var noop = function () {};
  global.SLMi18n = {
    languages: [{ code: 'en', name: 'English', native: 'English', flag: '' }],
    current: 'en',
    t: function (text) { return text; },
    setLanguage: noop,
    translate: noop,
    mountSwitcher: noop
  };
})(window);
