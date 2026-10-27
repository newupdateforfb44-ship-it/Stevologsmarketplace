#!/usr/bin/env node
/**
 * stevo-fix.js
 * Upload this file to the ROOT of your repo (next to server.js), then in the
 * Codespaces terminal run:   node stevo-fix.js
 *
 * It edits the right files in public/, public/js and public/css for you:
 *   1. English only (removes the language switch / Portuguese)
 *   2. Fixes broken logo + pictures (code pointed to a /img/ folder that doesn't exist)
 *   3. Removes the Back button on the dashboard after sign in / sign up
 *
 * Safe to run more than once.
 */
const fs = require('fs');
const path = require('path');

const ROOT = process.cwd();
const PUB = path.join(ROOT, 'public');
if (!fs.existsSync(path.join(ROOT, 'server.js')) || !fs.existsSync(PUB)) {
  console.error('\nRun this from the repo root (the folder that has server.js and public/).');
  process.exit(1);
}

function edit(rel, fn, label) {
  const p = path.join(PUB, rel);
  if (!fs.existsSync(p)) { console.log('!!  missing: public/' + rel); return; }
  const before = fs.readFileSync(p, 'utf8');
  const after = fn(before);
  if (after === before) { console.log('--  already done: public/' + rel); return; }
  fs.writeFileSync(p, after);
  console.log('OK  public/' + rel + (label ? '  (' + label + ')' : ''));
}

/* ───────── 1. English only ───────── */
const I18N = `/* public/js/i18n.js - English only. Language switcher and auto-translation removed. */
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
`;
edit('js/i18n.js', () => I18N, 'English only');

/* ───────── 2. Logo + pictures ───────── */
// Code points at /img/..., but the images live directly in public/.
// stevo-loader.svg never existed, so the brand icon is used instead.
const fixImg = (s) => s
  .replace(/\/img\/stevo-loader\.svg/g, '/stevelogsmarketplace-icon.svg')
  .replace(/\/img\//g, '/');
['home.html', 'login.html', 'register.html', 'manifest.json', 'css/stevo-brand.css']
  .forEach((f) => edit(f, fixImg, 'image paths'));

/* ───────── 3. No Back button on dashboard ───────── */
edit('js/back-button.js', (s) => s.replace(
  "var path = location.pathname.replace(/\\/+$/, '') || '/';",
  "var path = location.pathname.replace(/\\/+$/, '').replace(/\\.html$/i, '') || '/';"
), 'ignores /dashboard.html');

const fixRedirect = (s) => s.replace(/location\.href\s*=\s*'\/dashboard\.html'/g, "location.href='/dashboard'");
['login.html', 'register.html'].forEach((f) => edit(f, fixRedirect, 'redirect to /dashboard'));

console.log('\nAll done. Now run:\n  rm stevo-fix.js\n  git add -A\n  git commit -m "English only, fix images, no dashboard back button"\n  git push\n');
