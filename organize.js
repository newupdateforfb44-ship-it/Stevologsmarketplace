#!/usr/bin/env node
/**
 * organize.js — arranges the flat Stevelogsmarketplace files into the folders
 * that server.js expects:
 *
 *   /                 server.js, package.json, site.config.js, README.md ...
 *   lib/              server-side modules (require('./lib/...'))
 *   public/           html pages, images, root-level scripts (script.js ...)
 *   public/css/       stylesheets loaded as /css/...
 *   public/js/        browser scripts loaded as /js/...
 *   public/uploads|receipts|files/   (with .gitkeep)
 *
 * Usage (from the repo root, in the Codespace terminal):
 *   node organize.js --dry     # preview only, changes nothing
 *   node organize.js           # do it
 *
 * Safe to run twice: files already in folders are never touched,
 * and nothing is overwritten (except the one noted below).
 */
const fs = require('fs');
const path = require('path');

const DRY = process.argv.includes('--dry');
const ROOT = process.cwd();
const SELF = path.basename(__filename);

// ── Where each file goes ────────────────────────────────────────────────────

// Stays in the project root
const ROOT_FILES = new Set([
  'server.js', 'package.json', 'package-lock.json', 'README.md', 'site.config.js',
]);

// Server-side modules -> lib/
const LIB_FILES = new Set([
  'boost2.js', 'brand-logos.js', 'campaigns.js', 'countries.js', 'countries.data.json',
  'engagement.js', 'flw-methods.js', 'fx.js', 'geo.js', 'global-payments.js',
  'mailer.js', 'minipdf.js', 'mysql.js', 'opaque-ref.js', 'otp-suite.js',
  'platform.js', 'restock-notify.js', 'settings.js', 'stevo-upgrade.js',
  'tutorials.js', 'welcomepopup.js',
]);

// Files that exist twice with a " (1)" copy: the "(1)" one is the SERVER version
const LIB_FROM_COPY = {
  'boost (1).js': 'lib/boost.js',
  'market2 (1).js': 'lib/market2.js',
  'market3 (1).js': 'lib/market3.js',
  'market4 (1).js': 'lib/market4.js',
};

// Browser scripts that pages load from the site root (e.g. /script.js)
const PUBLIC_ROOT_JS = new Set([
  'script.js', 'market2.js', 'market3.js', 'market4.js', 'marketplace.js',
  'tools.js', 'game.js', 'welcome-popup.js',
]);

// Stylesheets that pages load from the site root (e.g. /style.css)
const PUBLIC_ROOT_CSS = new Set(['style.css', 'theme.css']);

// Dotfiles that were uploaded with a "1" in front of the name
const RENAMES = {
  '1.gitignore': '.gitignore',
  '1.npmrc': '.npmrc',
  '1.gitkeep': 'public/uploads/.gitkeep',
  'gitkeep (1)': 'public/receipts/.gitkeep',
  'gitkeep (2)': 'public/files/.gitkeep',
};

// The "(1)" copy is the newer one (adds the Marketplace 4 admin panel).
// It replaces the older admin-stevo.js.
const REPLACE = { 'admin-stevo (1).js': 'public/js/admin-stevo.js' };

const PUBLIC_ROOT_EXT = new Set([
  '.html', '.png', '.svg', '.webp', '.ico', '.jpg', '.jpeg', '.gif', '.json', '.txt',
]);

function destinationFor(name) {
  if (name === SELF) return null;
  if (name === 'admin-stevo.js') return null; // old copy, handled below
  if (name.startsWith('.') && !RENAMES[name]) return null; // .gitignore, .npmrc etc. already in place
  if (REPLACE[name]) return { to: REPLACE[name], replace: true };
  if (RENAMES[name]) return { to: RENAMES[name] };
  if (LIB_FROM_COPY[name]) return { to: LIB_FROM_COPY[name] };
  if (ROOT_FILES.has(name)) return null;
  if (LIB_FILES.has(name)) return { to: 'lib/' + name };
  if (PUBLIC_ROOT_JS.has(name) || PUBLIC_ROOT_CSS.has(name)) return { to: 'public/' + name };

  const ext = path.extname(name).toLowerCase();
  if (ext === '.css') return { to: 'public/css/' + name };
  if (ext === '.js') return { to: 'public/js/' + name };
  if (PUBLIC_ROOT_EXT.has(ext)) return { to: 'public/' + name };
  return undefined; // unknown
}

// ── Do the work ─────────────────────────────────────────────────────────────
let moved = 0, skipped = 0;
const unknown = [];

for (const d of ['lib', 'public', 'public/css', 'public/js',
                 'public/uploads', 'public/receipts', 'public/files']) {
  if (!DRY) fs.mkdirSync(path.join(ROOT, d), { recursive: true });
}

const entries = fs.readdirSync(ROOT, { withFileTypes: true });
for (const e of entries) {
  if (!e.isFile()) continue; // folders (.git, node_modules, lib, public...) are left alone
  const dest = destinationFor(e.name);
  if (dest === null) continue;
  if (dest === undefined) { unknown.push(e.name); continue; }

  const from = path.join(ROOT, e.name);
  const to = path.join(ROOT, dest.to);

  if (fs.existsSync(to) && !dest.replace) {
    console.log(`SKIP   ${e.name}  (already exists: ${dest.to})`);
    skipped++;
    continue;
  }
  console.log(`${DRY ? 'WOULD ' : ''}MOVE   ${e.name}  ->  ${dest.to}`);
  if (!DRY) {
    fs.mkdirSync(path.dirname(to), { recursive: true });
    if (dest.replace && fs.existsSync(to)) fs.unlinkSync(to);
    fs.renameSync(from, to);
  }
  moved++;
}

// Old admin-stevo.js at the root is replaced by the newer "(1)" copy above
const oldAdmin = path.join(ROOT, 'admin-stevo.js');
if (fs.existsSync(oldAdmin)) {
  console.log(`${DRY ? 'WOULD ' : ''}DELETE admin-stevo.js (older copy, replaced by "admin-stevo (1).js")`);
  if (!DRY) fs.unlinkSync(oldAdmin);
}

console.log(`\n${DRY ? 'Preview' : 'Done'}: ${moved} moved, ${skipped} skipped.`);
if (unknown.length) {
  console.log('\nNot sure where these go (left in place):');
  unknown.forEach((n) => console.log('  - ' + n));
}
if (!DRY) {
  console.log('\nNext: npm install && npm start');
}
