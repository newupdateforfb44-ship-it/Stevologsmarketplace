// ── Page notices + banner / pop-up colours ──────────────────────────────────
// Admin can show a pop-up message (like the Buy Number notice) on other pages too:
// Rentals, Temp Email, Airtime & Data, Websites, Boost, Marketplace and Gift Delivery.
// Each page has its own message. One colour theme styles every notice, banner and
// confirmation pop-up across the site.
//
//   GET  /api/page-notice?page=rental   public  - the notice for one page (or enabled:false)
//   GET  /api/ui-theme                  public  - banner / pop-up colours
//   GET  /api/admin/page-notices        admin   - every page's notice + theme + defaults
//   PUT  /api/admin/page-notices/:page  admin   - save one page's notice
//   PUT  /api/admin/ui-theme            admin   - save colours (reset:true restores defaults)

const PAGES = Object.freeze({
  rental: 'Rent a Number',
  'temp-email': 'Temp Email',
  vtu: 'Airtime & Data',
  websites: 'Websites',
  boost: 'Boost',
  marketplace: 'Marketplace',
  'gift-delivery': 'Gift Delivery'
});
const LIMITS = { title: 120, message: 2500, buttonText: 60 };
const THEME_DEFAULTS = Object.freeze({
  bg: '#14141f', text: '#f5f5fa', muted: '#cbd0dc', border: '#2e2e42', accent: '#f5b81c', accentText: '#111111', ok: '#22c55e', err: '#ef4444'
});
const HEX = /^#[0-9a-fA-F]{6}$/;

function cleanText(v, max) {
  return String(v == null ? '' : v).replace(/<[^>]*>/g, '').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').trim().slice(0, max);
}

function register(app, deps) {
  const { mongoose, adminAuth } = deps;
  const noticeSchema = new mongoose.Schema({
    page: { type: String, unique: true, index: true },
    enabled: { type: Boolean, default: false },
    title: { type: String, default: '' },
    message: { type: String, default: '' },
    buttonText: { type: String, default: 'I understand, continue' },
    updatedAt: { type: Date, default: null }
  });
  const PageNotice = mongoose.models.PageNotice || mongoose.model('PageNotice', noticeSchema);
  const themeSchema = new mongoose.Schema({
    key: { type: String, default: 'main', unique: true },
    colors: { type: mongoose.Schema.Types.Mixed, default: {} },
    updatedAt: { type: Date, default: null }
  });
  const UiTheme = mongoose.models.UiTheme || mongoose.model('UiTheme', themeSchema);

  const pickTheme = (doc) => {
    const c = (doc && doc.colors) || {}; const out = {};
    Object.keys(THEME_DEFAULTS).forEach((k) => { out[k] = HEX.test(c[k] || '') ? c[k].toLowerCase() : THEME_DEFAULTS[k]; });
    return out;
  };
  const pickNotice = (page, d) => ({
    page, label: PAGES[page], enabled: !!(d && d.enabled), title: (d && d.title) || '', message: (d && d.message) || '',
    buttonText: (d && d.buttonText) || 'I understand, continue', updatedAt: (d && d.updatedAt) || null
  });

  app.get('/api/page-notice', async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const page = String(req.query.page || '');
    if (!PAGES[page]) return res.json({ enabled: false });
    try {
      const d = await PageNotice.findOne({ page }).lean();
      if (!d || !d.enabled || !d.title || !d.message) return res.json({ enabled: false });
      res.json({ enabled: true, title: d.title, message: d.message, buttonText: d.buttonText || 'I understand, continue', version: d.updatedAt ? new Date(d.updatedAt).getTime() : 0 });
    } catch (e) { res.json({ enabled: false }); }
  });

  app.get('/api/ui-theme', async (req, res) => {
    res.set('Cache-Control', 'no-store');
    try { res.json({ colors: pickTheme(await UiTheme.findOne({ key: 'main' }).lean()) }); }
    catch (e) { res.json({ colors: { ...THEME_DEFAULTS } }); }
  });

  app.get('/api/admin/page-notices', adminAuth, async (req, res) => {
    try {
      const [docs, theme] = await Promise.all([PageNotice.find({}).lean(), UiTheme.findOne({ key: 'main' }).lean()]);
      const byPage = new Map(docs.map((d) => [d.page, d]));
      res.json({ pages: Object.keys(PAGES).map((p) => pickNotice(p, byPage.get(p))), theme: pickTheme(theme), themeDefaults: THEME_DEFAULTS, limits: LIMITS });
    } catch (e) { res.status(500).json({ error: 'Could not load page notices.' }); }
  });

  app.put('/api/admin/page-notices/:page', adminAuth, async (req, res) => {
    const page = req.params.page;
    if (!PAGES[page]) return res.status(400).json({ error: 'Unknown page.' });
    const b = req.body || {};
    if (typeof b.enabled !== 'boolean') return res.status(400).json({ error: 'Status must be on or off.' });
    const out = { enabled: b.enabled };
    for (const k of ['title', 'message', 'buttonText']) {
      const raw = String(b[k] == null ? '' : b[k]);
      if (raw.length > LIMITS[k] * 3) return res.status(400).json({ error: k + ' is far too long (max ' + LIMITS[k] + ' characters).' });
      const v = cleanText(raw, LIMITS[k] + 1);
      if (v.length > LIMITS[k]) return res.status(400).json({ error: k + ' is too long (max ' + LIMITS[k] + ' characters).' });
      out[k] = v;
    }
    if (out.enabled && !out.title) return res.status(400).json({ error: 'Add a title before turning the notice on.' });
    if (out.enabled && !out.message) return res.status(400).json({ error: 'Add a message before turning the notice on.' });
    if (!out.buttonText) out.buttonText = 'I understand, continue';
    try {
      const d = await PageNotice.findOneAndUpdate({ page }, { $set: { ...out, updatedAt: new Date() }, $setOnInsert: { page } }, { upsert: true, new: true }).lean();
      res.json({ ok: true, notice: pickNotice(page, d) });
    } catch (e) { res.status(500).json({ error: 'Could not save. Please try again.' }); }
  });

  app.put('/api/admin/ui-theme', adminAuth, async (req, res) => {
    const b = req.body || {};
    try {
      let colors = {};
      if (!b.reset) {
        const src = b.colors || {};
        for (const k of Object.keys(THEME_DEFAULTS)) {
          if (src[k] === undefined) continue;
          if (!HEX.test(String(src[k]))) return res.status(400).json({ error: 'Colours must look like #f5b81c.' });
          colors[k] = String(src[k]).toLowerCase();
        }
      }
      const d = await UiTheme.findOneAndUpdate({ key: 'main' }, { $set: { colors, updatedAt: new Date() }, $setOnInsert: { key: 'main' } }, { upsert: true, new: true }).lean();
      res.json({ ok: true, colors: pickTheme(d) });
    } catch (e) { res.status(500).json({ error: 'Could not save the colours.' }); }
  });
}
module.exports = { register, PAGES, THEME_DEFAULTS };
