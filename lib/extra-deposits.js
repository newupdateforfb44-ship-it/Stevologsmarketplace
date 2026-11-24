// ── Extra deposit methods: Manual Payment + Paymonetra ───────────────────────────────
// Both are switched ON/OFF by the admin (Admin → Payment Methods) and both default to OFF.
//
//  MANUAL PAYMENT  customer transfers to the bank account the admin configured, uploads the
//                  payment receipt, and it lands in Admin → Deposit receipts where an admin
//                  views the receipt and approves (wallet credited) or declines.
//  PAYMONETRA      hosted bank-transfer checkout (POST /payments). Credited only after the payment
//                  is confirmed with Paymonetra's API (webhook, 2-minute sweep, or customer check).
//
//   GET  /api/deposit/extra-methods                user    what is ON + manual bank details
//   POST /api/deposit/manual                       user    multipart: amount, senderName, note, receipt
//   GET  /api/deposit/manual/mine                  user    own submissions + status
//   POST /api/deposit/paymonetra/create            user    start a Paymonetra checkout
//   GET  /api/deposit/paymonetra/status/:reference user    confirm one payment
//   GET  /api/deposit/paymonetra/latest            user    confirm the customer's latest pending payment
//   POST /api/webhooks/paymonetra                  public  Paymonetra callback (signature verified)
//   GET  /api/admin/extra-methods                  admin   settings + readiness
//   POST /api/admin/extra-methods/:method          owner   toggle / message / manual bank details
//   GET  /api/admin/manual-deposits                admin   list (?status=pending|approved|rejected|all)
//   POST /api/admin/manual-deposits/:id/action     admin   { action:'approved'|'rejected', note, amount? }

const crypto = require('crypto');
const multer = require('multer');
const fs = require('fs');
const path = require('path');

const METHODS = ['manual', 'paymonetra'];
const MIN_AMOUNT = 100;
const MAX_AMOUNT = 5000000;
const MAX_PENDING_PER_USER = 3;

function clean(v, max) {
  return String(v == null ? '' : v).replace(/<[^>]*>/g, '').replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').trim().slice(0, max);
}

// ── PAYMONETRA ADAPTER ───────────────────────────────────────────────────────────────
// API: https://api.paymonetra.com/v1  ·  auth: Authorization: Bearer sk_live_…
// Env vars: PAYMONETRA_SECRET_KEY (required) and PAYMONETRA_WEBHOOK_SECRET (whsec_…, recommended:
// when set, every webhook must carry a valid X-Paymonetra-Signature = HMAC-SHA512 hex of the raw body).
// Wallet credit NEVER trusts the webhook body: it is only a nudge, the payment is always confirmed
// with GET /payments/{reference} first.
const axios = require('axios');
const PM_BASE = (process.env.PAYMONETRA_API_BASE || 'https://api.paymonetra.com/v1').replace(/\/$/, '');
const PM_PAID = ['paid', 'success', 'successful', 'completed', 'credited', 'settled'];

function paymonetraConfigured() { return !!process.env.PAYMONETRA_SECRET_KEY; }
function pmHeaders() { return { Authorization: 'Bearer ' + process.env.PAYMONETRA_SECRET_KEY, Accept: 'application/json' }; }
function pmErr(e) { const d = e.response && e.response.data; return (d && d.error && d.error.message) || (e.response ? `HTTP ${e.response.status}` : e.message); }

// Create a hosted checkout (bank transfer). Returns { link, gatewayRef, payAmount }.
async function paymonetraCreateCheckout(dep, redirectUrl) {
  const post = body => axios.post(PM_BASE + '/payments', new URLSearchParams(body).toString(), {
    headers: { ...pmHeaders(), 'Content-Type': 'application/x-www-form-urlencoded' }, timeout: 20000
  });
  const minimal = { amount: String(dep.amount), reference: dep.reference, description: 'Wallet deposit' };
  let r;
  try {
    r = await post({ ...minimal, customer_name: dep.userName || '', customer_email: dep.userEmail || '', redirect_url: redirectUrl });
  } catch (e) {
    // If Paymonetra rejects one of the optional fields, retry with only the documented basics.
    if (e.response && e.response.status >= 400 && e.response.status < 500 && e.response.status !== 401 && e.response.status !== 403) r = await post(minimal);
    else throw e;
  }
  const d = r.data || {};
  if (!d.checkout_url || !d.reference) throw new Error('Paymonetra returned no checkout link');
  return { link: d.checkout_url, gatewayRef: String(d.reference), payAmount: Number(d.amount) || dep.amount };
}
// Look a payment up. Returns { paid, status, amountRequested }.
async function paymonetraLookup(gatewayRef) {
  const r = await axios.get(`${PM_BASE}/payments/${encodeURIComponent(gatewayRef)}`, { headers: pmHeaders(), timeout: 20000 });
  const d = r.data || {};
  const status = String(d.status || '').toLowerCase();
  return { paid: PM_PAID.includes(status), status, amountRequested: Number(d.amount_requested), amount: Number(d.amount), raw: d };
}
// X-Paymonetra-Signature: HMAC-SHA512 (hex) over the raw request body.
function paymonetraSignatureOk(req) {
  const secret = process.env.PAYMONETRA_WEBHOOK_SECRET || '';
  if (!secret) return true; // not enforced until the secret is set; crediting is still verified via the API
  const got = String(req.headers['x-paymonetra-signature'] || '').trim().toLowerCase();
  if (!got || !req.rawBody) return false;
  const want = crypto.createHmac('sha512', secret).update(req.rawBody).digest('hex');
  const a = Buffer.from(want), b = Buffer.from(got);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
// Pull every string that could be one of our/their references out of an unknown webhook payload.
function paymonetraRefCandidates(body) {
  const out = new Set();
  const keys = ['reference', 'merchant_reference', 'checkout_reference', 'payment_reference'];
  (function walk(o, depth) {
    if (!o || typeof o !== 'object' || depth > 3) return;
    for (const k of Object.keys(o)) {
      const v = o[k];
      if (keys.includes(k) && typeof v === 'string' && v.length < 80) out.add(v);
      else if (v && typeof v === 'object') walk(v, depth + 1);
    }
  })(body, 0);
  return [...out];
}
// ─────────────────────────────────────────────────────────────────────────────────────

function register(app, deps) {
  const { mongoose, User, Transaction, auth, adminAuth, anyAdminAuth, cloudinary, cloudinaryConfigured, receiptDir, pushBalanceToUser, sendAdminEmail } = deps;

  const settingSchema = new mongoose.Schema({
    method: { type: String, enum: METHODS, required: true, unique: true },
    enabled: { type: Boolean, default: false },
    disabledMessage: { type: String, default: '' },
    // manual-payment bank details shown to customers
    bankName: { type: String, default: '' },
    accountName: { type: String, default: '' },
    accountNumber: { type: String, default: '' },
    instructions: { type: String, default: '' },
    updatedAt: { type: Date, default: Date.now }
  });
  const Setting = mongoose.models.ExtraPaySetting || mongoose.model('ExtraPaySetting', settingSchema);

  const manualSchema = new mongoose.Schema({
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    reference: { type: String, unique: true, required: true },
    amount: { type: Number, required: true },        // what the customer says they sent (₦)
    creditedAmount: { type: Number, default: 0 },    // what the admin actually credited
    senderName: { type: String, default: '' },
    note: { type: String, default: '' },
    proofUrl: { type: String, required: true },
    proofIsPdf: { type: Boolean, default: false },
    fingerprint: { type: String, unique: true, sparse: true }, // sha256 of the file: same receipt can't be used twice
    status: { type: String, enum: ['pending', 'approved', 'rejected'], default: 'pending', index: true },
    adminNote: { type: String, default: '' },
    reviewedBy: { type: String, default: '' },
    reviewedAt: { type: Date, default: null },
    createdAt: { type: Date, default: Date.now }
  });
  const ManualDeposit = mongoose.models.ManualDeposit || mongoose.model('ManualDeposit', manualSchema);

  const pmSchema = new mongoose.Schema({
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    reference: { type: String, unique: true, required: true },
    amount: { type: Number, required: true },
    status: { type: String, enum: ['pending', 'success', 'failed'], default: 'pending' },
    gatewayRef: { type: String, default: '' },
    creditedAt: { type: Date, default: null },
    createdAt: { type: Date, default: Date.now }
  });
  const PaymonetraDeposit = mongoose.models.PaymonetraDeposit || mongoose.model('PaymonetraDeposit', pmSchema);

  async function getSettings() {
    let docs = [];
    try { docs = await Setting.find({}); } catch (e) { console.error('[extra-deposits] settings load failed:', e.message); }
    const by = {};
    METHODS.forEach(m => { by[m] = docs.find(d => d.method === m) || { method: m, enabled: false, disabledMessage: '' }; });
    return by;
  }
  const manualReady = s => !!(s.bankName && s.accountName && s.accountNumber);

  // Receipt upload: kept in memory so it can be hashed (duplicate-receipt check) before it is stored.
  const proofUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 8 * 1024 * 1024, files: 1 },
    fileFilter: (req, file, cb) => /^(image\/(jpeg|png|webp|gif)|application\/pdf)$/.test(file.mimetype) ? cb(null, true) : cb(new Error('Receipt must be an image (JPG, PNG, WEBP) or a PDF'))
  });
  async function storeProof(file) {
    const isPdf = file.mimetype === 'application/pdf';
    if (cloudinaryConfigured) {
      const result = await new Promise((resolve, reject) => {
        const stream = cloudinary.uploader.upload_stream(
          { folder: 'ksl/manual-receipts', resource_type: isPdf ? 'raw' : 'image', public_id: `${Date.now()}_${crypto.randomBytes(6).toString('hex')}${isPdf ? '.pdf' : ''}` },
          (err, r) => err ? reject(err) : resolve(r)
        );
        stream.end(file.buffer);
      });
      return { url: result.secure_url, isPdf };
    }
    const ext = isPdf ? '.pdf' : ({ 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/gif': '.gif' }[file.mimetype] || '.jpg');
    const name = `manual_${Date.now()}_${crypto.randomBytes(6).toString('hex')}${ext}`;
    await fs.promises.writeFile(path.join(receiptDir, name), file.buffer);
    return { url: `/receipts/${name}`, isPdf };
  }
  const newRef = prefix => `${prefix}-${Date.now().toString(36)}-${crypto.randomBytes(4).toString('hex')}`.toUpperCase();

  // ── Customer: what's available ────────────────────────────────────────────────────
  app.get('/api/deposit/extra-methods', auth, async (req, res) => {
    try {
      const s = await getSettings();
      const manualOn = s.manual.enabled && manualReady(s.manual);
      res.json({
        manual: {
          enabled: s.manual.enabled === true,
          available: manualOn,
          disabledMessage: s.manual.disabledMessage || '',
          // bank details only go out while the method is ON
          bank: manualOn ? { bankName: s.manual.bankName, accountName: s.manual.accountName, accountNumber: s.manual.accountNumber, instructions: s.manual.instructions || '' } : null,
          min: MIN_AMOUNT
        },
        paymonetra: {
          enabled: s.paymonetra.enabled === true,
          available: s.paymonetra.enabled === true && paymonetraConfigured(),
          disabledMessage: s.paymonetra.disabledMessage || ''
        }
      });
    } catch (e) { res.status(500).json({ error: 'Failed to load payment methods' }); }
  });

  // ── Customer: manual payment ──────────────────────────────────────────────────────
  app.post('/api/deposit/manual', auth, (req, res, next) => {
    proofUpload.single('receipt')(req, res, err => err ? res.status(400).json({ error: err.message || 'Upload failed' }) : next());
  }, async (req, res) => {
    try {
      const s = (await getSettings()).manual;
      if (!s.enabled || !manualReady(s)) return res.status(503).json({ error: s.disabledMessage || 'Manual payment is currently unavailable.' });
      if (!req.file) return res.status(400).json({ error: 'Please upload your payment receipt.' });
      const amount = Math.round(Number(req.body.amount) * 100) / 100;
      if (!Number.isFinite(amount) || amount < MIN_AMOUNT) return res.status(400).json({ error: `Minimum manual deposit is ₦${MIN_AMOUNT}.` });
      if (amount > MAX_AMOUNT) return res.status(400).json({ error: 'Amount is too large — contact support for large deposits.' });
      const pending = await ManualDeposit.countDocuments({ userId: req.user._id, status: 'pending' });
      if (pending >= MAX_PENDING_PER_USER) return res.status(429).json({ error: `You already have ${pending} receipts waiting for review. Please wait for them to be processed.` });

      const fingerprint = crypto.createHash('sha256').update(req.file.buffer).digest('hex');
      if (await ManualDeposit.findOne({ fingerprint })) return res.status(409).json({ error: 'This receipt has already been submitted.' });

      const stored = await storeProof(req.file);
      let doc;
      try {
        doc = await ManualDeposit.create({
          userId: req.user._id, reference: newRef('MAN'), amount,
          senderName: clean(req.body.senderName, 80), note: clean(req.body.note, 300),
          proofUrl: stored.url, proofIsPdf: stored.isPdf, fingerprint
        });
      } catch (e) {
        if (e && e.code === 11000) return res.status(409).json({ error: 'This receipt has already been submitted.' });
        throw e;
      }
      try { if (sendAdminEmail && process.env.ADMIN_EMAIL) await sendAdminEmail(process.env.ADMIN_EMAIL, 'New manual deposit receipt', `${req.user.name || req.user.email} submitted a ₦${amount.toLocaleString('en-NG')} manual deposit receipt (${doc.reference}). Review it in Admin → Deposit receipts.`); } catch { /* email never blocks a submission */ }
      res.json({ ok: true, reference: doc.reference, message: 'Receipt submitted. Your wallet is credited as soon as an admin approves it.' });
    } catch (e) {
      console.error('[manual-deposit] submit failed:', e.message);
      res.status(500).json({ error: 'Could not submit your receipt — please try again.' });
    }
  });

  app.get('/api/deposit/manual/mine', auth, async (req, res) => {
    try {
      const rows = await ManualDeposit.find({ userId: req.user._id }).sort({ createdAt: -1 }).limit(15)
        .select('reference amount creditedAmount status adminNote createdAt reviewedAt').lean();
      res.json(rows);
    } catch (e) { res.status(500).json({ error: 'Failed to load your submissions' }); }
  });

  // ── Customer: Paymonetra ──────────────────────────────────────────────────────────
  // Confirm one deposit with Paymonetra and credit the wallet exactly once.
  async function pmVerifyAndCredit(dep) {
    if (!dep || dep.status === 'success' || !dep.gatewayRef) return { status: dep ? dep.status : 'missing' };
    let look;
    try { look = await paymonetraLookup(dep.gatewayRef); }
    catch (e) { console.error(`[paymonetra] lookup ${dep.reference} failed:`, pmErr(e)); return { status: 'pending', error: true }; }
    if (!look.paid) { return { status: 'pending', gatewayStatus: look.status }; }
    // Claim first (atomic) so a webhook, the poller and the customer's own check can never double-credit.
    const fresh = await PaymonetraDeposit.findOneAndUpdate({ _id: dep._id, status: { $in: ['pending', 'failed'] } }, { status: 'success', creditedAt: new Date() }, { new: true });
    if (!fresh) return { status: 'success' };
    const user = await User.findByIdAndUpdate(fresh.userId, { $inc: { balance: fresh.amount } }, { new: true }).select('balance');
    if (!user) { console.error('[paymonetra] user missing for paid deposit', fresh.reference); return { status: 'success' }; }
    try {
      await Transaction.create({ userId: fresh.userId, type: 'deposit', amount: fresh.amount, txRef: `paymonetra:${fresh.reference}`, description: 'Deposit via Paymonetra (bank transfer)', status: 'success' });
    } catch (e) { console.error('[paymonetra] transaction log failed:', e.message); }
    if (pushBalanceToUser) pushBalanceToUser(fresh.userId, user.balance, fresh.amount);
    console.log(`✅ Paymonetra deposit credited: ₦${fresh.amount} (${fresh.reference})`);
    return { status: 'success', credited: fresh.amount };
  }

  app.post('/api/deposit/paymonetra/create', auth, async (req, res) => {
    try {
      const s = (await getSettings()).paymonetra;
      if (!s.enabled) return res.status(503).json({ error: s.disabledMessage || 'Paymonetra is currently unavailable.' });
      if (!paymonetraConfigured()) return res.status(503).json({ error: 'Paymonetra is not set up yet — please use another payment method.' });
      const amount = Math.round(Number(req.body.amount) * 100) / 100;
      if (!Number.isFinite(amount) || amount < MIN_AMOUNT) return res.status(400).json({ error: `Minimum deposit is ₦${MIN_AMOUNT}.` });
      if (amount > MAX_AMOUNT) return res.status(400).json({ error: 'Amount is too large.' });
      const reference = newRef('PMN');
      const site = (process.env.SITE_URL || '').replace(/\/$/, '');
      const dep = await PaymonetraDeposit.create({ userId: req.user._id, reference, amount });
      try {
        const out = await paymonetraCreateCheckout({ reference, amount, userEmail: req.user.email, userName: req.user.name }, `${site}/deposit`);
        await PaymonetraDeposit.updateOne({ _id: dep._id }, { gatewayRef: out.gatewayRef });
        res.json({ link: out.link, reference, payAmount: out.payAmount });
      } catch (e) {
        await PaymonetraDeposit.updateOne({ _id: dep._id }, { status: 'failed' });
        console.error('[paymonetra] checkout failed:', pmErr(e));
        res.status(502).json({ error: 'Could not start the Paymonetra checkout — please try again or use another method.' });
      }
    } catch (e) { res.status(500).json({ error: 'Failed to start payment' }); }
  });

  // Customer taps "I've paid — check now" (or the page checks on return): confirm with Paymonetra.
  app.get('/api/deposit/paymonetra/status/:reference', auth, async (req, res) => {
    try {
      const dep = await PaymonetraDeposit.findOne({ reference: String(req.params.reference), userId: req.user._id });
      if (!dep) return res.status(404).json({ error: 'Payment not found' });
      const out = await pmVerifyAndCredit(dep);
      res.json({ status: out.status, credited: out.credited || 0, amount: dep.amount });
    } catch (e) { res.status(500).json({ error: 'Could not check the payment' }); }
  });
  app.get('/api/deposit/paymonetra/latest', auth, async (req, res) => {
    try {
      const dep = await PaymonetraDeposit.findOne({ userId: req.user._id, status: 'pending', gatewayRef: { $ne: '' }, createdAt: { $gte: new Date(Date.now() - 3 * 3600 * 1000) } }).sort({ createdAt: -1 });
      if (!dep) return res.json({ status: 'none' });
      const out = await pmVerifyAndCredit(dep);
      res.json({ status: out.status, credited: out.credited || 0, amount: dep.amount, reference: dep.reference });
    } catch (e) { res.status(500).json({ error: 'Could not check the payment' }); }
  });

  // Webhook: always processed, even when the switch is OFF — a customer who already paid must be credited.
  // The body is only used to find the deposit; the payment itself is confirmed with Paymonetra.
  app.post('/api/webhooks/paymonetra', async (req, res) => {
    try {
      if (!paymonetraSignatureOk(req)) { console.error('[paymonetra] webhook rejected: bad signature'); return res.status(401).json({ error: 'Invalid signature' }); }
      const cands = paymonetraRefCandidates(req.body || {});
      const dep = cands.length ? await PaymonetraDeposit.findOne({ $or: [{ reference: { $in: cands } }, { gatewayRef: { $in: cands } }] }) : null;
      if (!dep) { console.log('[paymonetra] webhook matched no deposit:', JSON.stringify(cands)); return res.json({ received: true }); }
      await pmVerifyAndCredit(dep);
      res.json({ received: true });
    } catch (e) {
      console.error('[paymonetra] webhook error:', e.message);
      res.status(500).json({ error: 'Processing error' }); // non-2xx so Paymonetra retries
    }
  });

  // Safety net: every 2 minutes confirm recent pending deposits, so a missed/odd webhook never strands a payment.
  setInterval(async () => {
    if (!paymonetraConfigured()) return;
    try {
      const rows = await PaymonetraDeposit.find({ status: 'pending', gatewayRef: { $ne: '' }, createdAt: { $gte: new Date(Date.now() - 3 * 3600 * 1000) } }).sort({ createdAt: 1 }).limit(40);
      for (const dep of rows) await pmVerifyAndCredit(dep);
    } catch (e) { console.error('[paymonetra] sweep failed:', e.message); }
  }, 120000).unref();

  // ── Admin: settings ───────────────────────────────────────────────────────────────
  app.get('/api/admin/extra-methods', anyAdminAuth, async (req, res) => {
    try {
      const s = await getSettings();
      const site = (process.env.SITE_URL || '').replace(/\/$/, '');
      res.json({
        manual: { enabled: s.manual.enabled === true, disabledMessage: s.manual.disabledMessage || '', bankName: s.manual.bankName || '', accountName: s.manual.accountName || '', accountNumber: s.manual.accountNumber || '', instructions: s.manual.instructions || '', ready: manualReady(s.manual) },
        paymonetra: { enabled: s.paymonetra.enabled === true, disabledMessage: s.paymonetra.disabledMessage || '', configured: paymonetraConfigured(), apiImplemented: true, keySet: !!process.env.PAYMONETRA_SECRET_KEY, webhookSecretSet: !!process.env.PAYMONETRA_WEBHOOK_SECRET, webhookUrl: `${site}/api/webhooks/paymonetra` },
        pendingManual: await ManualDeposit.countDocuments({ status: 'pending' })
      });
    } catch (e) { res.status(500).json({ error: 'Failed to load settings' }); }
  });

  app.post('/api/admin/extra-methods/:method', adminAuth, async (req, res) => {
    try {
      const { method } = req.params;
      if (!METHODS.includes(method)) return res.status(400).json({ error: 'Invalid method' });
      const b = req.body || {};
      const current = (await getSettings())[method];
      const update = { method, updatedAt: new Date() };
      if (b.disabledMessage !== undefined) update.disabledMessage = clean(b.disabledMessage, 300);
      if (method === 'manual') {
        if (b.bankName !== undefined) update.bankName = clean(b.bankName, 80);
        if (b.accountName !== undefined) update.accountName = clean(b.accountName, 80);
        if (b.accountNumber !== undefined) update.accountNumber = clean(b.accountNumber, 30);
        if (b.instructions !== undefined) update.instructions = clean(b.instructions, 600);
      }
      if (b.enabled !== undefined) {
        const on = !!b.enabled;
        if (on && method === 'manual') {
          const merged = { ...(current.toObject ? current.toObject() : current), ...update };
          if (!manualReady(merged)) return res.status(400).json({ error: 'Add the bank name, account name and account number before switching Manual Payment on.' });
        }
        if (on && method === 'paymonetra' && !paymonetraConfigured()) {
          return res.status(400).json({ error: 'Paymonetra cannot be switched on yet — PAYMONETRA_SECRET_KEY is not set on the server.' });
        }
        update.enabled = on;
      }
      await Setting.findOneAndUpdate({ method }, update, { upsert: true, new: true });
      console.log(`[admin] extra deposit method ${method} updated:`, JSON.stringify({ ...update, accountNumber: update.accountNumber ? '***' : undefined }));
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: 'Failed to save: ' + e.message }); }
  });

  // ── Admin: review manual receipts ─────────────────────────────────────────────────
  app.get('/api/admin/manual-deposits', anyAdminAuth, async (req, res) => {
    try {
      const st = String(req.query.status || 'pending');
      const q = ['pending', 'approved', 'rejected'].includes(st) ? { status: st } : {};
      const rows = await ManualDeposit.find(q).populate('userId', 'name email').sort({ createdAt: -1 }).limit(200).lean();
      res.json(rows);
    } catch (e) { res.status(500).json({ error: 'Failed to load deposits' }); }
  });

  app.post('/api/admin/manual-deposits/:id/action', anyAdminAuth, async (req, res) => {
    try {
      const { action, note } = req.body || {};
      if (!['approved', 'rejected'].includes(action)) return res.status(400).json({ error: 'Invalid action' });
      if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ error: 'Invalid id' });
      let credit = 0;
      if (action === 'approved') {
        const existing = await ManualDeposit.findById(req.params.id).select('amount');
        if (!existing) return res.status(404).json({ error: 'Deposit not found' });
        credit = req.body.amount !== undefined && req.body.amount !== '' ? Math.round(Number(req.body.amount) * 100) / 100 : existing.amount;
        if (!Number.isFinite(credit) || credit <= 0 || credit > MAX_AMOUNT) return res.status(400).json({ error: 'Enter a valid amount to credit.' });
      }
      const reviewer = req.adminRole === 'super' ? 'owner' : (req.subAdmin && (req.subAdmin.email || req.subAdmin.name)) || 'sub-admin';
      // Atomic claim: only ONE request can move a receipt out of "pending" (no double credit on double-click/replay).
      const dep = await ManualDeposit.findOneAndUpdate(
        { _id: req.params.id, status: 'pending' },
        { $set: { status: action, adminNote: clean(note, 300), reviewedBy: reviewer, reviewedAt: new Date(), creditedAmount: action === 'approved' ? credit : 0 } },
        { new: true }
      );
      if (!dep) return res.status(400).json({ error: 'Deposit not found or already processed' });
      if (action === 'approved') {
        const user = await User.findByIdAndUpdate(dep.userId, { $inc: { balance: credit } }, { new: true }).select('balance');
        if (!user) return res.status(404).json({ error: 'User not found — credit the wallet manually.' });
        await Transaction.create({ userId: dep.userId, type: 'deposit', amount: credit, txRef: `manual:${dep._id}`, description: `Manual deposit approved (${dep.reference})`, status: 'success' });
        if (pushBalanceToUser) pushBalanceToUser(dep.userId, user.balance, credit);
      }
      res.json({ message: `Deposit ${action}` });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
}

module.exports = { register };
