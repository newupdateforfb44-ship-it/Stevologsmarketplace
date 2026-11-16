'use strict';
// Websites for sale — the admin lists ready-made websites (a price, a CUSTOMER panel
// demo link, and optionally an ADMIN panel demo link). Customers open the demo links
// from the "Website" page on the dashboard to see how each site looks before buying.
//
// Routes:
//   GET    /api/websites            public  — published websites (for the customer page)
//   GET    /api/admin/websites      admin   — all websites (incl. hidden)
//   POST   /api/admin/websites      admin   — create
//   PUT    /api/admin/websites/:id  admin   — edit
//   DELETE /api/admin/websites/:id  admin   — delete
//   GET    /api/websites/suggestions        public — suggested website types customers can ask for
//   POST   /api/websites/requests           user   — customer sends a website request (type + description)
//   GET    /api/websites/requests           user   — the customer's own requests
//   GET    /api/admin/websites/requests     admin  — all customer requests (newest first)
//   PUT    /api/admin/websites/requests/:id admin  — set status (new / seen / done) and a private note
//   DELETE /api/admin/websites/requests/:id admin  — delete a request

module.exports.register = function register(app, deps) {
  const { mongoose, anyAdminAuth, auth, sendAdminEmail } = deps;

  const schema = new mongoose.Schema({
    title:            { type: String, required: true, trim: true, maxlength: 120 },
    description:      { type: String, default: '', maxlength: 2000 },
    price:            { type: Number, required: true, min: 0 },
    customerPanelUrl: { type: String, required: true },   // demo link anyone can open
    adminPanelUrl:    { type: String, default: '' },      // optional demo of the admin side
    demoNote:         { type: String, default: '', maxlength: 500 }, // e.g. demo login details
    imageUrl:         { type: String, default: '' },      // optional screenshot link
    sold:             { type: Boolean, default: false },
    published:        { type: Boolean, default: true },
    sortOrder:        { type: Number, default: 0 },
    createdAt:        { type: Date, default: Date.now },
    updatedAt:        { type: Date, default: Date.now },
  });
  const Website = mongoose.models.WebsiteListing || mongoose.model('WebsiteListing', schema);

  // Only real web links are accepted (no javascript:, data:, etc.).
  const safeLink = (u) => {
    u = String(u || '').trim();
    if (!u) return '';
    if (!/^https?:\/\//i.test(u)) u = 'https://' + u.replace(/^\/+/, '');
    try { const x = new URL(u); return /^https?:$/.test(x.protocol) ? x.toString() : ''; } catch (_) { return ''; }
  };

  const shape = (w) => ({
    id: String(w._id), title: w.title, description: w.description, price: w.price,
    customerPanelUrl: w.customerPanelUrl, adminPanelUrl: w.adminPanelUrl || '',
    demoNote: w.demoNote || '', imageUrl: w.imageUrl || '',
    sold: !!w.sold, published: w.published !== false, sortOrder: w.sortOrder || 0,
    createdAt: w.createdAt, updatedAt: w.updatedAt,
  });

  app.get('/api/websites', async (req, res) => {
    try {
      const docs = await Website.find({ published: true }).sort({ sortOrder: 1, createdAt: -1 }).lean();
      res.set('Cache-Control', 'no-store');
      res.json(docs.map(shape));
    } catch (e) { res.status(500).json({ error: 'Failed to load websites' }); }
  });

  app.get('/api/admin/websites', anyAdminAuth, async (req, res) => {
    try {
      const docs = await Website.find({}).sort({ sortOrder: 1, createdAt: -1 }).lean();
      res.json(docs.map(shape));
    } catch (e) { res.status(500).json({ error: 'Failed to load websites' }); }
  });

  const bool = (v) => v === true || v === 'true' || v === '1' || v === 'on';

  // Returns { data } or { error } so create and edit share the same validation.
  function readBody(b, isCreate) {
    const out = {};
    if (b.title !== undefined) out.title = String(b.title).trim();
    if (b.description !== undefined) out.description = String(b.description).trim();
    if (b.price !== undefined && b.price !== '') {
      const p = Number(String(b.price).replace(/,/g, ''));
      if (!isFinite(p) || p < 0) return { error: 'Enter a valid price' };
      out.price = Math.round(p * 100) / 100;
    }
    if (b.customerPanelUrl !== undefined) {
      out.customerPanelUrl = safeLink(b.customerPanelUrl);
      if (!out.customerPanelUrl) return { error: 'Enter a valid customer panel link (https://…)' };
    }
    if (b.adminPanelUrl !== undefined) {
      const raw = String(b.adminPanelUrl).trim();
      out.adminPanelUrl = raw ? safeLink(raw) : '';
      if (raw && !out.adminPanelUrl) return { error: 'The admin panel link is not a valid link' };
    }
    if (b.imageUrl !== undefined) {
      const raw = String(b.imageUrl).trim();
      out.imageUrl = raw ? safeLink(raw) : '';
      if (raw && !out.imageUrl) return { error: 'The picture link is not a valid link' };
    }
    if (b.demoNote !== undefined) out.demoNote = String(b.demoNote).trim();
    if (b.sortOrder !== undefined && b.sortOrder !== '') out.sortOrder = Number(b.sortOrder) || 0;
    if (b.sold !== undefined) out.sold = bool(b.sold);
    if (b.published !== undefined) out.published = bool(b.published);
    if (isCreate) {
      if (!out.title) return { error: 'Please enter the website name' };
      if (out.price === undefined) return { error: 'Please enter the price' };
      if (!out.customerPanelUrl) return { error: 'Please enter the customer panel link' };
    } else if (out.title === '') return { error: 'The website name cannot be empty' };
    return { data: out };
  }

  app.post('/api/admin/websites', anyAdminAuth, async (req, res) => {
    try {
      const r = readBody(req.body || {}, true);
      if (r.error) return res.status(400).json({ error: r.error });
      const doc = await Website.create(r.data);
      res.json(shape(doc));
    } catch (e) { res.status(500).json({ error: 'Failed to save website: ' + e.message }); }
  });

  app.put('/api/admin/websites/:id', anyAdminAuth, async (req, res) => {
    try {
      if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ error: 'Invalid id' });
      const r = readBody(req.body || {}, false);
      if (r.error) return res.status(400).json({ error: r.error });
      r.data.updatedAt = new Date();
      const doc = await Website.findByIdAndUpdate(req.params.id, r.data, { new: true });
      if (!doc) return res.status(404).json({ error: 'Website not found' });
      res.json(shape(doc));
    } catch (e) { res.status(500).json({ error: 'Failed to update website: ' + e.message }); }
  });

  app.delete('/api/admin/websites/:id', anyAdminAuth, async (req, res) => {
    try {
      if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ error: 'Invalid id' });
      await Website.findByIdAndDelete(req.params.id);
      res.json({ message: 'Website deleted' });
    } catch (e) { res.status(500).json({ error: 'Failed to delete website' }); }
  });

  // ───────── Website suggestions + customer requests ─────────
  const SUGGESTIONS = [
    { key: 'smm',      icon: '🚀', title: 'SMM Panel Website',        text: 'Sell followers, likes, views and other social media boosting with an automatic provider API.' },
    { key: 'ads',      icon: '📢', title: 'Ads / Advertising Website', text: 'A site where people buy ad slots, promotions, banners or sponsored posts.' },
    { key: 'numbers',  icon: '📱', title: 'Virtual Numbers Website',   text: 'Sell temporary numbers for SMS verification with automatic delivery.' },
    { key: 'logs',     icon: '🛒', title: 'Social Logs Marketplace',   text: 'A marketplace for verified social media accounts and digital products.' },
    { key: 'vtu',      icon: '📲', title: 'Airtime & Data (VTU) Website', text: 'Sell airtime, data, cable TV and electricity with a wallet system.' },
    { key: 'store',    icon: '🏬', title: 'Online Store / E-commerce', text: 'A shop with products, cart, checkout and order tracking.' },
    { key: 'business', icon: '💼', title: 'Business / Company Website', text: 'A professional website for your brand with pages, contact form and WhatsApp button.' },
    { key: 'other',    icon: '✍️', title: 'Something else',            text: 'Tell us exactly what kind of website you want.' },
  ];
  const reqSchema = new mongoose.Schema({
    userId:      { type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true },
    userName:    { type: String, default: '' },
    userEmail:   { type: String, default: '' },
    type:        { type: String, required: true, trim: true, maxlength: 120 },   // chosen suggestion or the customer's own words
    description: { type: String, required: true, trim: true, maxlength: 3000 },
    budget:      { type: String, default: '', maxlength: 60 },
    contact:     { type: String, default: '', maxlength: 120 },                  // WhatsApp / phone / Telegram
    status:      { type: String, enum: ['new', 'seen', 'done'], default: 'new', index: true },
    adminNote:   { type: String, default: '', maxlength: 1000 },
    createdAt:   { type: Date, default: Date.now },
  });
  const WebsiteRequest = mongoose.models.WebsiteRequest || mongoose.model('WebsiteRequest', reqSchema);
  const shapeReq = (r, admin) => ({
    id: String(r._id), type: r.type, description: r.description, budget: r.budget || '', contact: r.contact || '',
    status: r.status, createdAt: r.createdAt,
    ...(admin ? { userName: r.userName || '', userEmail: r.userEmail || '', adminNote: r.adminNote || '' } : {}),
  });

  app.get('/api/websites/suggestions', (req, res) => { res.set('Cache-Control', 'no-store'); res.json(SUGGESTIONS); });

  if (typeof auth === 'function') {
    app.post('/api/websites/requests', auth, async (req, res) => {
      try {
        const b = req.body || {};
        const type = String(b.type || '').trim().slice(0, 120);
        const description = String(b.description || '').trim().slice(0, 3000);
        if (!type) return res.status(400).json({ error: 'Choose a website type or type the one you want.' });
        if (description.length < 10) return res.status(400).json({ error: 'Please describe the website you want (at least a few words).' });
        const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
        if (await WebsiteRequest.countDocuments({ userId: req.user._id, createdAt: { $gte: since } }) >= 5)
          return res.status(429).json({ error: 'You have sent several requests today. Please wait and try again tomorrow.' });
        const doc = await WebsiteRequest.create({
          userId: req.user._id, userName: req.user.name || '', userEmail: req.user.email || '',
          type, description, budget: String(b.budget || '').trim().slice(0, 60), contact: String(b.contact || '').trim().slice(0, 120),
        });
        try { if (typeof sendAdminEmail === 'function') sendAdminEmail(null, 'New website request: ' + type, `From: ${doc.userName} <${doc.userEmail}>\nType: ${type}\nBudget: ${doc.budget || '-'}\nContact: ${doc.contact || '-'}\n\n${description}`).catch(() => {}); } catch (_) {}
        res.json({ ok: true, request: shapeReq(doc), message: 'Request sent. We will contact you about your website.' });
      } catch (e) { res.status(500).json({ error: 'Could not send your request. Please try again.' }); }
    });
    app.get('/api/websites/requests', auth, async (req, res) => {
      try {
        const rows = await WebsiteRequest.find({ userId: req.user._id }).sort({ createdAt: -1 }).limit(20).lean();
        res.set('Cache-Control', 'no-store'); res.json(rows.map(r => shapeReq(r, false)));
      } catch (e) { res.status(500).json({ error: 'Could not load your requests.' }); }
    });
  }

  app.get('/api/admin/websites/requests', anyAdminAuth, async (req, res) => {
    try {
      const rows = await WebsiteRequest.find({}).sort({ createdAt: -1 }).limit(300).lean();
      res.set('Cache-Control', 'no-store'); res.json(rows.map(r => shapeReq(r, true)));
    } catch (e) { res.status(500).json({ error: 'Failed to load requests' }); }
  });
  app.put('/api/admin/websites/requests/:id', anyAdminAuth, async (req, res) => {
    try {
      if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ error: 'Invalid id' });
      const set = {};
      if (req.body && req.body.status !== undefined) { if (!['new', 'seen', 'done'].includes(req.body.status)) return res.status(400).json({ error: 'Invalid status' }); set.status = req.body.status; }
      if (req.body && req.body.adminNote !== undefined) set.adminNote = String(req.body.adminNote).slice(0, 1000);
      const doc = await WebsiteRequest.findByIdAndUpdate(req.params.id, set, { new: true });
      if (!doc) return res.status(404).json({ error: 'Request not found' });
      res.json(shapeReq(doc, true));
    } catch (e) { res.status(500).json({ error: 'Failed to update request' }); }
  });
  app.delete('/api/admin/websites/requests/:id', anyAdminAuth, async (req, res) => {
    try {
      if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ error: 'Invalid id' });
      await WebsiteRequest.findByIdAndDelete(req.params.id);
      res.json({ message: 'Request deleted' });
    } catch (e) { res.status(500).json({ error: 'Failed to delete request' }); }
  });
};
