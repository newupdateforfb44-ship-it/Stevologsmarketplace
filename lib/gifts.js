// ── Gift Delivery ───────────────────────────────────────────────────────────
// Admin lists gifts with prices. A customer picks gifts, enters the recipient's
// delivery address and PAYS FROM THEIR WALLET (they can fund the wallet from the
// normal Deposit page first). The moment the payment succeeds the order appears
// in Admin → Gift Delivery as "Pending" and the admin is emailed. The admin
// marks it "Gifted" once delivered, or "Cancelled" to refund the customer.
//
// SAFETY MODEL
//  • Prices always come from the database; the browser sends only product ids
//    and quantities.
//  • The order record is written BEFORE the wallet is charged and carries a
//    client reference, so a double-tap / retry returns the SAME order and can
//    never charge twice.
//  • The wallet is debited atomically (balance >= total), and the debit is
//    recorded as a Transaction with a unique txRef.
//  • A background reconciler finishes any order that was charged but not marked
//    paid (server crash mid-request) and discards orders that never charged.
//  • Cancelling refunds exactly once (atomic claim + unique refund txRef).

const crypto = require('crypto');

const STATUSES = ['pending', 'gifted', 'cancelled'];            // 'awaiting_payment' is internal only
const STATUS_LABEL = { awaiting_payment: 'Awaiting payment', pending: 'Pending', gifted: 'Gifted', cancelled: 'Cancelled & refunded' };
const MAX_LINES = 15;
const MAX_QTY = 20;

const clean = (v, max = 200) => String(v == null ? '' : v).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
const cleanMultiline = (v, max = 500) => String(v == null ? '' : v).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim().slice(0, max);
const money = (n) => Math.max(0, Math.round(Number(n) || 0));
const naira = (n) => '₦' + money(n).toLocaleString('en-NG');
const digits = (v) => String(v || '').replace(/[^\d]/g, '');

function register(app, deps) {
  const { mongoose, User, Transaction, auth, anyAdminAuth, upload, fileUrl, getSiteLinks, sendAdminEmail } = deps;

  // ── Models ────────────────────────────────────────────────────────────────
  const productSchema = new mongoose.Schema({
    name: { type: String, required: true, trim: true, maxlength: 140 },
    description: { type: String, default: '', maxlength: 1500 },
    category: { type: String, default: 'Other', trim: true, maxlength: 60, index: true },
    images: { type: [String], default: [] },
    price: { type: Number, required: true, min: 0 },
    freeShipping: { type: Boolean, default: true },
    inStock: { type: Boolean, default: true },
    active: { type: Boolean, default: true, index: true },
    bestSelling: { type: Boolean, default: false },
    sortOrder: { type: Number, default: 0 }
  }, { timestamps: true });
  const GiftProduct = mongoose.models.GiftProduct || mongoose.model('GiftProduct', productSchema);

  const orderSchema = new mongoose.Schema({
    ref: { type: String, unique: true, index: true },
    clientRef: { type: String, index: true },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true, required: true },
    username: String,
    userEmail: String,
    items: [{ productId: mongoose.Schema.Types.ObjectId, name: String, image: String, price: Number, qty: Number, freeShipping: Boolean }],
    subtotal: { type: Number, default: 0 },
    deliveryFee: { type: Number, default: 0 },
    total: { type: Number, default: 0 },                      // what the customer paid
    payTxRef: String,
    chargeStarted: { type: Boolean, default: false },
    paidAt: Date,
    recipientName: String,
    recipientPhone: String,
    contactPhone: String,
    address: String,
    city: String,
    state: String,
    landmark: String,
    deliveryDate: String,
    giftMessage: String,
    status: { type: String, enum: ['awaiting_payment', 'pending', 'gifted', 'cancelled'], default: 'awaiting_payment', index: true },
    giftedAt: Date,
    refundedAt: Date,
    adminNote: { type: String, default: '' },
    history: [{ status: String, at: { type: Date, default: Date.now }, note: String }]
  }, { timestamps: true });
  const GiftOrder = mongoose.models.GiftOrder || mongoose.model('GiftOrder', orderSchema);

  const settingsSchema = new mongoose.Schema({
    _id: { type: String, default: 'main' },
    enabled: { type: Boolean, default: true },
    whatsappNumber: { type: String, default: '' },
    notice: { type: String, default: '' },
    deliveryFee: { type: Number, default: 0 },                // flat fee per order, skipped when every item is "free shipping"
    deliveryNote: { type: String, default: 'Free shipping on most gifts. Delivery is made to the address you provide.' },
    checkoutNote: { type: String, default: 'Prices shown are our listed prices. For the final price confirmation, delivery timing or any change to your order, please contact our admin on WhatsApp.' }
  });
  const GiftSettings = mongoose.models.GiftSettings || mongoose.model('GiftSettings', settingsSchema);

  // Customer asks for something that is not in the catalogue; admin quotes a price on WhatsApp.
  const requestSchema = new mongoose.Schema({
    ref: { type: String, unique: true, index: true },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true, required: true },
    username: String,
    userEmail: String,
    itemName: { type: String, required: true, maxlength: 140 },
    details: { type: String, default: '', maxlength: 1500 },
    budget: { type: String, default: '', maxlength: 40 },
    quantity: { type: Number, default: 1 },
    contactPhone: { type: String, default: '' },
    recipientCity: { type: String, default: '' },
    status: { type: String, enum: ['new', 'contacted', 'closed'], default: 'new', index: true },
    adminNote: { type: String, default: '' }
  }, { timestamps: true });
  const GiftRequest = mongoose.models.GiftRequest || mongoose.model('GiftRequest', requestSchema);
  const REQ_STATUSES = ['new', 'contacted', 'closed'];
  const REQ_LABEL = { new: 'New', contacted: 'Contacted', closed: 'Closed' };
  const newReqRef = () => 'REQ-' + crypto.randomBytes(3).toString('hex').toUpperCase();

  async function getSettings() {
    let s = await GiftSettings.findById('main');
    if (!s) s = await GiftSettings.create({ _id: 'main' });
    return s;
  }
  async function adminWhatsapp(settings) {
    const own = digits(settings && settings.whatsappNumber);
    if (own.length >= 10) return own;
    try {
      const l = await getSiteLinks();
      const n = digits(l && (l.whatsappNumber || l.adminPhone));
      if (n.length >= 10) return n;
    } catch (e) { /* fall through */ }
    return digits(process.env.ADMIN_WHATSAPP);
  }
  const newRef = () => 'GFT-' + crypto.randomBytes(4).toString('hex').toUpperCase();

  function totalsFor(items, settings) {
    const subtotal = items.reduce((s, it) => s + it.price * it.qty, 0);
    const fee = money(settings.deliveryFee);
    const deliveryFee = fee > 0 && items.some((it) => !it.freeShipping) ? fee : 0;
    return { subtotal, deliveryFee, total: subtotal + deliveryFee };
  }

  function helpMessage(o) {
    return 'Hello, I have a question about my gift delivery order ' + o.ref + ' (' + naira(o.total) + ').';
  }
  function publicProduct(p) {
    return { id: String(p._id), name: p.name, description: p.description, category: p.category, images: p.images || [], image: (p.images && p.images[0]) || '',
      price: p.price, freeShipping: !!p.freeShipping, inStock: p.inStock !== false, bestSelling: !!p.bestSelling };
  }
  function publicOrder(o, wa) {
    const x = o.toObject ? o.toObject() : o;
    return { id: String(x._id), ref: x.ref, status: x.status, statusLabel: STATUS_LABEL[x.status] || x.status, items: x.items,
      subtotal: x.subtotal, deliveryFee: x.deliveryFee, total: x.total, paidAt: x.paidAt, giftedAt: x.giftedAt,
      recipientName: x.recipientName, recipientPhone: x.recipientPhone, address: x.address, city: x.city, state: x.state, landmark: x.landmark,
      deliveryDate: x.deliveryDate, giftMessage: x.giftMessage, adminNote: x.adminNote, createdAt: x.createdAt,
      helpUrl: wa ? 'https://wa.me/' + wa + '?text=' + encodeURIComponent(helpMessage(x)) : '' };
  }

  // ── Payment finalisation ──────────────────────────────────────────────────
  async function notifyAdminPaid(o) {
    if (typeof sendAdminEmail !== 'function') return;
    const lines = [
      'A customer has PAID for a gift delivery. Please arrange the gift.',
      '',
      'Order: ' + o.ref,
      'Customer: ' + (o.username || '') + (o.userEmail ? ' <' + o.userEmail + '>' : ''),
      'Amount paid: ' + naira(o.total) + (o.deliveryFee ? ' (includes ' + naira(o.deliveryFee) + ' delivery)' : ''),
      '',
      'Items:',
      ...o.items.map((i) => '  • ' + i.qty + ' x ' + i.name + ' (' + naira(i.price) + ' each)'),
      '',
      'Deliver to: ' + o.recipientName + ' — ' + o.recipientPhone,
      [o.address, o.landmark ? '(' + o.landmark + ')' : '', o.city, o.state].filter(Boolean).join(', '),
      o.deliveryDate ? 'Preferred date: ' + o.deliveryDate : '',
      o.giftMessage ? 'Card message: ' + o.giftMessage : '',
      '',
      'Open Admin → Gift Delivery and mark the order as Gifted when it is delivered.'
    ].filter((l) => l !== undefined);
    try { await sendAdminEmail(null, 'Gift delivery paid — ' + o.ref + ' (' + naira(o.total) + ')', lines.join('\n')); }
    catch (e) { console.error('[gifts] admin email failed:', e.message); }
  }
  async function markPaid(orderId) {
    const o = await GiftOrder.findOneAndUpdate(
      { _id: orderId, status: 'awaiting_payment' },
      { $set: { status: 'pending', paidAt: new Date() }, $push: { history: { status: 'pending', note: 'Paid from wallet' } } },
      { new: true });
    if (o) notifyAdminPaid(o);        // fire and forget: never blocks the customer
    return o;
  }

  // Finish orders that were charged but not marked paid; drop ones that never charged.
  async function reconcile() {
    try {
      const stale = await GiftOrder.find({ status: 'awaiting_payment', createdAt: { $lt: new Date(Date.now() - 2 * 60 * 1000) } }).limit(50);
      for (const o of stale) {
        const tx = await Transaction.findOne({ txRef: 'gift_' + o.ref, status: 'success' });
        if (tx) await markPaid(o._id);
        else if (o.chargeStarted) console.error('[gifts] ORDER ' + o.ref + ' began charging but has no transaction — check the customer wallet manually.');
        else await GiftOrder.deleteOne({ _id: o._id, status: 'awaiting_payment' });
      }
    } catch (e) { console.error('[gifts] reconcile:', e.message); }
  }
  const timer = setInterval(reconcile, 5 * 60 * 1000); if (timer.unref) timer.unref();

  // ── Public API ────────────────────────────────────────────────────────────
  app.get('/api/gifts/catalog', auth, async (req, res) => {
    res.set('Cache-Control', 'no-store');
    try {
      const settings = await getSettings();
      const wa = await adminWhatsapp(settings);
      if (!settings.enabled) return res.json({ enabled: false, products: [], categories: [] });
      const products = await GiftProduct.find({ active: true }).sort({ sortOrder: 1, createdAt: -1 }).lean();
      res.json({
        enabled: true, notice: settings.notice || '', deliveryNote: settings.deliveryNote || '', checkoutNote: settings.checkoutNote || '', deliveryFee: money(settings.deliveryFee),
        balance: money(req.user.balance), helpUrl: wa ? 'https://wa.me/' + wa : '',
        categories: [...new Set(products.map((p) => p.category).filter(Boolean))].sort(),
        products: products.map((p) => ({ ...publicProduct(p), createdAt: p.createdAt }))
      });
    } catch (e) { console.error('[gifts] catalog', e.message); res.status(500).json({ error: 'Could not load gifts right now. Please try again.' }); }
  });

  app.post('/api/gifts/orders', auth, async (req, res) => {
    try {
      const settings = await getSettings();
      if (!settings.enabled) return res.status(503).json({ error: 'Gift Delivery is currently unavailable.' });
      const wa = await adminWhatsapp(settings);
      const b = req.body || {};
      const clientRef = clean(b.clientRef, 64);

      // Retry / double-tap: return the existing order instead of charging again.
      let order = null;
      if (clientRef) {
        order = await GiftOrder.findOne({ userId: req.user._id, clientRef });
        if (order && order.status !== 'awaiting_payment') {
          const u = await User.findById(req.user._id).select('balance');
          return res.json({ ok: true, duplicate: true, balance: money(u && u.balance), order: publicOrder(order, wa) });
        }
      }

      let items, totals;
      if (order) {                              // resume an order that was created but not yet charged
        items = order.items.map((i) => i.toObject ? i.toObject() : i);
        totals = { subtotal: order.subtotal, deliveryFee: order.deliveryFee, total: order.total };
      } else {
        const recipientName = clean(b.recipientName, 80);
        const recipientPhone = digits(b.recipientPhone);
        const address = clean(b.address, 250), city = clean(b.city, 80), state = clean(b.state, 60);
        if (recipientName.length < 2) return res.status(400).json({ error: 'Please enter the recipient’s full name.' });
        if (recipientPhone.length < 10 || recipientPhone.length > 15) return res.status(400).json({ error: 'Please enter a valid recipient phone number.' });
        if (address.length < 8) return res.status(400).json({ error: 'Please enter the full delivery address.' });
        if (city.length < 2) return res.status(400).json({ error: 'Please enter the city or town.' });
        if (state.length < 2) return res.status(400).json({ error: 'Please select the state.' });

        const raw = Array.isArray(b.items) ? b.items : [];
        if (!raw.length) return res.status(400).json({ error: 'Your cart is empty.' });
        if (raw.length > MAX_LINES) return res.status(400).json({ error: 'You can order at most ' + MAX_LINES + ' different gifts at once.' });
        const wanted = new Map();
        for (const r of raw) {
          const id = String((r && r.productId) || '');
          if (!mongoose.Types.ObjectId.isValid(id)) return res.status(400).json({ error: 'One of the gifts in your cart is invalid.' });
          const qty = Math.floor(Number(r.qty));
          if (!(qty >= 1 && qty <= MAX_QTY)) return res.status(400).json({ error: 'Quantity must be between 1 and ' + MAX_QTY + '.' });
          wanted.set(id, Math.min(MAX_QTY, (wanted.get(id) || 0) + qty));
        }
        const products = await GiftProduct.find({ _id: { $in: [...wanted.keys()] }, active: true });
        const byId = new Map(products.map((p) => [String(p._id), p]));
        items = [];
        for (const [id, qty] of wanted) {
          const p = byId.get(id);
          if (!p) return res.status(400).json({ error: 'A gift in your cart is no longer available. Please refresh and try again.', refresh: true });
          if (p.inStock === false) return res.status(400).json({ error: '“' + p.name + '” is currently out of stock.', refresh: true });
          items.push({ productId: p._id, name: p.name, image: (p.images && p.images[0]) || '', price: money(p.price), qty, freeShipping: !!p.freeShipping });
        }
        totals = totalsFor(items, settings);
        if (!(totals.total > 0)) return res.status(400).json({ error: 'This order has no payable amount.' });

        // Check the wallet BEFORE writing anything.
        const fresh = await User.findById(req.user._id).select('balance');
        const bal = money(fresh && fresh.balance);
        if (bal < totals.total) {
          return res.status(402).json({ error: 'Your wallet balance is too low for this order.', insufficient: true, balance: bal, total: totals.total, shortfall: totals.total - bal });
        }

        for (let attempt = 0; attempt < 4 && !order; attempt++) {
          try {
            order = await GiftOrder.create({
              ref: newRef(), clientRef: clientRef || undefined, userId: req.user._id, username: req.user.name || req.user.email || '', userEmail: req.user.email || '',
              items, subtotal: totals.subtotal, deliveryFee: totals.deliveryFee, total: totals.total,
              recipientName, recipientPhone, contactPhone: digits(b.contactPhone) || recipientPhone, address, city, state,
              landmark: clean(b.landmark, 120), deliveryDate: clean(b.deliveryDate, 40), giftMessage: cleanMultiline(b.giftMessage, 300),
              status: 'awaiting_payment', history: [{ status: 'awaiting_payment', note: 'Order created' }]
            });
          } catch (e) { if (!(e && e.code === 11000)) throw e; }
        }
        if (!order) return res.status(500).json({ error: 'Could not create your order. Please try again.' });
      }

      // Charge the wallet atomically. A Transaction with a unique txRef proves it happened exactly once.
      const txRef = 'gift_' + order.ref;
      const already = await Transaction.findOne({ txRef, status: 'success' });
      let balanceAfter;
      if (already) {
        const u = await User.findById(req.user._id).select('balance'); balanceAfter = money(u && u.balance);
      } else {
        await GiftOrder.updateOne({ _id: order._id }, { $set: { chargeStarted: true } });
        const debited = await User.findOneAndUpdate({ _id: req.user._id, balance: { $gte: totals.total } }, { $inc: { balance: -totals.total } }, { new: true });
        if (!debited) {
          await GiftOrder.deleteOne({ _id: order._id, status: 'awaiting_payment' });   // debit did not happen
          const u = await User.findById(req.user._id).select('balance'); const bal = money(u && u.balance);
          return res.status(402).json({ error: 'Your wallet balance is too low for this order.', insufficient: true, balance: bal, total: totals.total, shortfall: Math.max(0, totals.total - bal) });
        }
        balanceAfter = money(debited.balance);
        try {
          await Transaction.create({ userId: req.user._id, type: 'purchase', amount: totals.total, description: 'Gift delivery ' + order.ref, status: 'success', txRef });
        } catch (e) { console.error('[gifts] transaction record failed (wallet WAS charged):', e.message); }
      }
      const paid = await markPaid(order._id);
      const final = paid || (await GiftOrder.findById(order._id));
      res.json({ ok: true, balance: balanceAfter, order: publicOrder(final, wa) });
    } catch (e) {
      console.error('[gifts] create order', e.message);
      res.status(500).json({ error: 'Something went wrong. If your wallet was charged, your order is saved — check My orders before trying again.' });
    }
  });

  app.get('/api/gifts/orders', auth, async (req, res) => {
    res.set('Cache-Control', 'no-store');
    try {
      const wa = await adminWhatsapp(await getSettings());
      const orders = await GiftOrder.find({ userId: req.user._id, status: { $ne: 'awaiting_payment' } }).sort({ createdAt: -1 }).limit(50);
      res.json({ orders: orders.map((o) => publicOrder(o, wa)) });
    } catch (e) { res.status(500).json({ error: 'Could not load your orders.' }); }
  });

  // ── Item requests (not in the catalogue) ──────────────────────────────────
  async function notifyAdminRequest(r) {
    if (typeof sendAdminEmail !== 'function') return;
    const lines = [
      'A customer is asking for a gift that is not in the catalogue. Please quote a price (they are being sent to your WhatsApp).',
      '',
      'Request: ' + r.ref,
      'Customer: ' + (r.username || '') + (r.userEmail ? ' <' + r.userEmail + '>' : ''),
      'Item wanted: ' + r.itemName + (r.quantity > 1 ? ' (x' + r.quantity + ')' : ''),
      r.budget ? 'Budget: ' + r.budget : '',
      r.recipientCity ? 'Deliver to (city): ' + r.recipientCity : '',
      r.contactPhone ? 'Phone: ' + r.contactPhone : '',
      '',
      'Details:',
      r.details || '(none)',
      '',
      'Open Admin → Gift Delivery → Requests to follow up.'
    ].filter((l) => l !== undefined);
    try { await sendAdminEmail(null, 'Gift request — ' + r.itemName + ' (' + r.ref + ')', lines.join('\n')); }
    catch (e) { console.error('[gifts] request email failed:', e.message); }
  }

  app.post('/api/gifts/requests', auth, async (req, res) => {
    try {
      const settings = await getSettings();
      if (!settings.enabled) return res.status(503).json({ error: 'Gift Delivery is currently unavailable.' });
      const b = req.body || {};
      const itemName = clean(b.itemName, 140);
      const details = cleanMultiline(b.details, 1500);
      if (itemName.length < 2) return res.status(400).json({ error: 'Please enter the name of the gift you want.' });
      if (details.length < 10) return res.status(400).json({ error: 'Please describe the gift in full (colour, size, brand, anything that helps us find it).' });
      // Simple abuse guard: at most 8 requests per customer per hour.
      const recent = await GiftRequest.countDocuments({ userId: req.user._id, createdAt: { $gt: new Date(Date.now() - 3600 * 1000) } });
      if (recent >= 8) return res.status(429).json({ error: 'You have sent several requests already. Please wait a little before sending another.' });
      let doc = null;
      for (let attempt = 0; attempt < 4 && !doc; attempt++) {
        try {
          doc = await GiftRequest.create({
            ref: newReqRef(), userId: req.user._id, username: req.user.name || req.user.email || '', userEmail: req.user.email || '',
            itemName, details, budget: clean(b.budget, 40), quantity: Math.min(MAX_QTY, Math.max(1, Math.floor(Number(b.quantity)) || 1)),
            contactPhone: digits(b.contactPhone).slice(0, 15), recipientCity: clean(b.recipientCity, 80)
          });
        } catch (e) { if (!(e && e.code === 11000)) throw e; }
      }
      if (!doc) return res.status(500).json({ error: 'Could not send your request. Please try again.' });
      notifyAdminRequest(doc);
      const wa = await adminWhatsapp(settings);
      const text = ['Hello, I could not find a gift on the site and I would like a price quote.', '', 'Request: ' + doc.ref,
        'Item: ' + doc.itemName + (doc.quantity > 1 ? ' (x' + doc.quantity + ')' : ''),
        doc.budget ? 'Budget: ' + doc.budget : '', doc.recipientCity ? 'Delivery city: ' + doc.recipientCity : '', '', 'Details: ' + doc.details,
        '', 'Name: ' + (doc.username || '')].join('\n');
      res.json({ ok: true, request: { id: String(doc._id), ref: doc.ref }, whatsappUrl: wa ? 'https://wa.me/' + wa + '?text=' + encodeURIComponent(text) : '' });
    } catch (e) { console.error('[gifts] request', e.message); res.status(500).json({ error: 'Could not send your request. Please try again.' }); }
  });

  app.get('/api/gifts/requests', auth, async (req, res) => {
    res.set('Cache-Control', 'no-store');
    try {
      const rows = await GiftRequest.find({ userId: req.user._id }).sort({ createdAt: -1 }).limit(30).lean();
      res.json({ requests: rows.map((r) => ({ id: String(r._id), ref: r.ref, itemName: r.itemName, details: r.details, status: r.status, statusLabel: REQ_LABEL[r.status] || r.status, adminNote: r.adminNote || '', createdAt: r.createdAt })) });
    } catch (e) { res.status(500).json({ error: 'Could not load your requests.' }); }
  });

  // ── Admin API ─────────────────────────────────────────────────────────────
  app.get('/api/admin/gifts/settings', anyAdminAuth, async (req, res) => {
    try { const s = await getSettings(); res.json({ enabled: s.enabled, whatsappNumber: s.whatsappNumber, notice: s.notice, deliveryNote: s.deliveryNote, checkoutNote: s.checkoutNote, deliveryFee: money(s.deliveryFee), effectiveWhatsapp: await adminWhatsapp(s), emailConfigured: !!(process.env.ADMIN_ALERT_EMAIL && process.env.RESEND_API_KEY) }); }
    catch (e) { res.status(500).json({ error: 'Failed to load settings' }); }
  });
  app.post('/api/admin/gifts/settings', anyAdminAuth, async (req, res) => {
    try {
      const b = req.body || {}; const set = {};
      if (b.enabled !== undefined) set.enabled = !!b.enabled;
      if (b.notice !== undefined) set.notice = clean(b.notice, 300);
      if (b.deliveryNote !== undefined) set.deliveryNote = clean(b.deliveryNote, 300);
      if (b.checkoutNote !== undefined) set.checkoutNote = clean(b.checkoutNote, 400);
      if (b.deliveryFee !== undefined) { const f = Number(b.deliveryFee); if (!(f >= 0 && f <= 1000000)) return res.status(400).json({ error: 'Delivery fee must be 0 or more.' }); set.deliveryFee = money(f); }
      if (b.whatsappNumber !== undefined) {
        const n = digits(b.whatsappNumber);
        if (n && n.length < 10) return res.status(400).json({ error: 'WhatsApp number must be at least 10 digits (include the country code, e.g. 234…).' });
        set.whatsappNumber = n;
      }
      await GiftSettings.findByIdAndUpdate('main', { $set: set }, { upsert: true, setDefaultsOnInsert: true });
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: 'Failed to save settings' }); }
  });

  app.get('/api/admin/gifts/products', anyAdminAuth, async (req, res) => {
    try { res.json({ products: await GiftProduct.find({}).sort({ sortOrder: 1, createdAt: -1 }).lean() }); }
    catch (e) { res.status(500).json({ error: 'Failed to load products' }); }
  });

  function readProductBody(req) {
    const b = req.body || {}; const out = {};
    if (b.name !== undefined) out.name = clean(b.name, 140);
    if (b.description !== undefined) out.description = cleanMultiline(b.description, 1500);
    if (b.category !== undefined) out.category = clean(b.category, 60) || 'Other';
    if (b.price !== undefined) out.price = money(b.price);
    ['freeShipping', 'inStock', 'active', 'bestSelling'].forEach((k) => { if (b[k] !== undefined) out[k] = (b[k] === true || b[k] === 'true' || b[k] === '1' || b[k] === 'on'); });
    if (b.sortOrder !== undefined) out.sortOrder = Math.floor(Number(b.sortOrder)) || 0;
    return out;
  }
  const uploadImages = (req, res, next) => upload.array('images', 5)(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message || 'Image upload failed' });
    next();
  });
  const collectImages = (req) => {
    const imgs = (req.files || []).map((f) => fileUrl(f)).filter(Boolean);
    const extra = clean(req.body && req.body.imageUrl, 500);
    if (extra && /^https?:\/\//i.test(extra)) imgs.push(extra);
    return imgs;
  };

  app.post('/api/admin/gifts/products', anyAdminAuth, uploadImages, async (req, res) => {
    try {
      const data = readProductBody(req);
      if (!data.name || data.name.length < 2) return res.status(400).json({ error: 'Product name is required.' });
      if (!(data.price > 0)) return res.status(400).json({ error: 'Enter a price greater than 0.' });
      data.images = collectImages(req);
      res.json({ ok: true, product: await GiftProduct.create(data) });
    } catch (e) { console.error('[gifts] add product', e.message); res.status(500).json({ error: 'Could not save the product.' }); }
  });

  app.put('/api/admin/gifts/products/:id', anyAdminAuth, uploadImages, async (req, res) => {
    try {
      if (!mongoose.Types.ObjectId.isValid(req.params.id)) return res.status(400).json({ error: 'Invalid product id' });
      const p = await GiftProduct.findById(req.params.id);
      if (!p) return res.status(404).json({ error: 'Product not found' });
      const data = readProductBody(req);
      if (data.name !== undefined && data.name.length < 2) return res.status(400).json({ error: 'Product name is too short.' });
      if (data.price !== undefined && !(data.price > 0)) return res.status(400).json({ error: 'Enter a price greater than 0.' });
      Object.assign(p, data);
      const added = collectImages(req);
      if (added.length) p.images = [...(p.images || []), ...added].slice(0, 8);
      const b = req.body || {};
      if (b.removeImage) p.images = (p.images || []).filter((u) => u !== b.removeImage);
      if (b.makePrimary && (p.images || []).includes(b.makePrimary)) p.images = [b.makePrimary, ...p.images.filter((u) => u !== b.makePrimary)];
      await p.save();
      res.json({ ok: true, product: p });
    } catch (e) { console.error('[gifts] edit product', e.message); res.status(500).json({ error: 'Could not update the product.' }); }
  });

  app.delete('/api/admin/gifts/products/:id', anyAdminAuth, async (req, res) => {
    try {
      if (!mongoose.Types.ObjectId.isValid(req.params.id)) return res.status(400).json({ error: 'Invalid product id' });
      await GiftProduct.findByIdAndDelete(req.params.id);    // past orders keep their own copy of name/price
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: 'Could not delete the product.' }); }
  });

  app.get('/api/admin/gifts/orders', anyAdminAuth, async (req, res) => {
    try {
      const q = { status: { $ne: 'awaiting_payment' } };
      if (STATUSES.includes(req.query.status)) q.status = req.query.status;
      const [orders, agg] = await Promise.all([
        GiftOrder.find(q).sort({ createdAt: -1 }).limit(200).lean(),
        GiftOrder.aggregate([{ $match: { status: { $ne: 'awaiting_payment' } } }, { $group: { _id: '$status', n: { $sum: 1 }, amt: { $sum: '$total' } } }])
      ]);
      const stats = { pending: 0, gifted: 0, cancelled: 0, revenue: 0 };
      agg.forEach((a) => { stats[a._id] = a.n; if (a._id !== 'cancelled') stats.revenue += a.amt; });
      const ids = [...new Set(orders.map((o) => String(o.userId)))];
      const users = await User.find({ _id: { $in: ids } }).select('name email').lean();
      const umap = new Map(users.map((u) => [String(u._id), u]));
      res.json({
        stats, statuses: STATUSES.map((s) => ({ value: s, label: STATUS_LABEL[s] })),
        orders: orders.map((o) => { const u = umap.get(String(o.userId)) || {}; return { ...o, customer: { name: u.name || o.username || '', email: u.email || o.userEmail || '' }, statusLabel: STATUS_LABEL[o.status] }; })
      });
    } catch (e) { res.status(500).json({ error: 'Failed to load orders' }); }
  });

  app.patch('/api/admin/gifts/orders/:id', anyAdminAuth, async (req, res) => {
    try {
      if (!mongoose.Types.ObjectId.isValid(req.params.id)) return res.status(400).json({ error: 'Invalid order id' });
      const b = req.body || {};
      const o = await GiftOrder.findById(req.params.id);
      if (!o || o.status === 'awaiting_payment') return res.status(404).json({ error: 'Order not found' });
      if (b.adminNote !== undefined) o.adminNote = cleanMultiline(b.adminNote, 500);

      if (b.status !== undefined && b.status !== o.status) {
        if (!STATUSES.includes(b.status)) return res.status(400).json({ error: 'Invalid status' });
        if (o.status === 'cancelled') return res.status(400).json({ error: 'A cancelled order was already refunded and cannot be reopened. Ask the customer to place a new order.' });

        if (b.status === 'cancelled') {
          // Atomic claim so a double click can never refund twice.
          const claimed = await GiftOrder.findOneAndUpdate({ _id: o._id, status: { $in: ['pending', 'gifted'] } },
            { $set: { status: 'cancelled', refundedAt: new Date(), adminNote: o.adminNote }, $push: { history: { status: 'cancelled', note: 'Cancelled by admin — wallet refunded' } } }, { new: true });
          if (!claimed) return res.status(409).json({ error: 'This order was just changed. Refresh and try again.' });
          await User.updateOne({ _id: o.userId }, { $inc: { balance: o.total } });
          try { await Transaction.create({ userId: o.userId, type: 'refund', amount: o.total, description: 'Refund — gift delivery ' + o.ref, status: 'success', txRef: 'gift_r_' + o._id }); } catch (e) { /* already recorded */ }
          return res.json({ ok: true, order: claimed, refunded: o.total });
        }
        o.status = b.status;
        if (b.status === 'gifted') o.giftedAt = new Date(); else o.giftedAt = undefined;
        o.history.push({ status: b.status, note: b.status === 'gifted' ? 'Marked as gifted' : 'Marked as pending' });
      }
      await o.save();
      res.json({ ok: true, order: o });
    } catch (e) { console.error('[gifts] update order', e.message); res.status(500).json({ error: 'Could not update the order.' }); }
  });

  app.get('/api/admin/gifts/requests', anyAdminAuth, async (req, res) => {
    try {
      const q = REQ_STATUSES.includes(req.query.status) ? { status: req.query.status } : {};
      const [rows, counts] = await Promise.all([
        GiftRequest.find(q).sort({ createdAt: -1 }).limit(200).lean(),
        GiftRequest.aggregate([{ $group: { _id: '$status', n: { $sum: 1 } } }])
      ]);
      const stats = { new: 0, contacted: 0, closed: 0 }; counts.forEach((c) => { stats[c._id] = c.n; });
      res.json({ stats, requests: rows.map((r) => ({ ...r, statusLabel: REQ_LABEL[r.status] || r.status })) });
    } catch (e) { res.status(500).json({ error: 'Failed to load requests' }); }
  });
  app.patch('/api/admin/gifts/requests/:id', anyAdminAuth, async (req, res) => {
    try {
      if (!mongoose.Types.ObjectId.isValid(req.params.id)) return res.status(400).json({ error: 'Invalid request id' });
      const b = req.body || {}; const set = {};
      if (b.status !== undefined) { if (!REQ_STATUSES.includes(b.status)) return res.status(400).json({ error: 'Invalid status' }); set.status = b.status; }
      if (b.adminNote !== undefined) set.adminNote = cleanMultiline(b.adminNote, 500);
      const r = await GiftRequest.findByIdAndUpdate(req.params.id, { $set: set }, { new: true });
      if (!r) return res.status(404).json({ error: 'Request not found' });
      res.json({ ok: true, request: r });
    } catch (e) { res.status(500).json({ error: 'Could not update the request.' }); }
  });
  app.delete('/api/admin/gifts/requests/:id', anyAdminAuth, async (req, res) => {
    try {
      if (!mongoose.Types.ObjectId.isValid(req.params.id)) return res.status(400).json({ error: 'Invalid request id' });
      await GiftRequest.findByIdAndDelete(req.params.id); res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: 'Could not delete the request.' }); }
  });

  console.log('[gifts] Gift Delivery module ready');
  return { GiftProduct, GiftOrder, GiftSettings, GiftRequest };
}

module.exports = { register };
