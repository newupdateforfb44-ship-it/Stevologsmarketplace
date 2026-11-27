'use strict';
// Updates — a SEPARATE product section (not the Tools). Own admin tab, own customer page,
// own purchase history. Nothing here touches the existing Tools, Logs or My Orders records.
//
// Routes:
//   GET    /api/updates                 public — live updates (no delivery data)
//   GET    /api/updates/:id             public — one update (no delivery data)
//   POST   /api/updates/buy/:id         user   — buy one; returns what was delivered
//   GET    /api/updates/purchases       user   — this user's Update purchase history
//   GET    /api/admin/updates           admin or support staff
//   POST   /api/admin/updates           admin or support staff (multipart)
//   PUT    /api/admin/updates/:id       admin or support staff (multipart; staff cannot change price, quantity or visibility)
//   DELETE /api/admin/updates/:id       owner only

const path = require('path');

module.exports.register = function register(app, deps) {
  const {
    mongoose, User, Transaction, auth, adminAuth, anyAdminAuth, fileUrl, multer,
    cloudinary, cloudinaryConfigured, CloudinaryStorage, uploadDir, fileDir
  } = deps;
  const { sendMail } = require('./mailer');

  const esc = (s) => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const TUT = ['none', 'images', 'video', 'link'];
  const DEL = ['link', 'file', 'email', 'video', 'image'];
  const normDel = (v) => (DEL.includes(String(v || '')) ? String(v) : 'link');

  const tutSchema = new mongoose.Schema({
    tutorialType: { type: String, enum: TUT, default: 'none' },
    images: [{ type: String }],
    videoUrl: { type: String, default: '' },
    linkUrl: { type: String, default: '' },
    note: { type: String, default: '', maxlength: 2000 }
  }, { _id: false });

  const updateSchema = new mongoose.Schema({
    title: { type: String, required: true, trim: true, maxlength: 160 },
    description: { type: String, default: '', maxlength: 4000 },
    price: { type: Number, required: true, min: 0 },
    picture: { type: String, default: '' },
    workingPictures: [{ type: String }],
    productMode: { type: String, enum: ['product', 'tutorial_only'], default: 'product' },
    deliveryType: { type: String, enum: ['link', 'file', 'email', 'video', 'image', 'none'], default: 'link' },
    toolLink: { type: String, default: '' },
    deliverableFile: { type: String, default: '' },
    deliverableFileName: { type: String, default: '' },
    details: { type: String, default: '' },          // email text, or private text given to the buyer
    audioManual: { type: String, default: '' },      // buyer-only, after purchase
    postPurchaseMessage: { type: String, default: '', maxlength: 4000 },
    purchaseTutorial: { type: tutSchema, default: () => ({ tutorialType: 'none' }) }, // hidden until purchase
    qty: { type: Number, default: 0, min: 0 },       // 0 = unlimited; 1, 500 or a custom number
    soldCount: { type: Number, default: 0 },
    available: { type: Boolean, default: true },
    createdAt: { type: Date, default: Date.now },
    updatedAt: { type: Date, default: Date.now }
  });
  const UpdateItem = mongoose.models.UpdateItem || mongoose.model('UpdateItem', updateSchema);

  const purchaseSchema = new mongoose.Schema({
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    updateId: mongoose.Schema.Types.ObjectId,
    title: String,
    pricePaid: Number,
    productMode: String,
    deliveryType: String,
    toolLink: String,
    details: String,
    deliverableFile: String,
    deliverableFileName: String,
    audioManual: String,
    postPurchaseMessage: String,
    purchaseTutorial: { type: tutSchema, default: () => ({ tutorialType: 'none' }) },
    purchasedAt: { type: Date, default: Date.now }
  });
  const UpdatePurchase = mongoose.models.UpdatePurchase || mongoose.model('UpdatePurchase', purchaseSchema);

  // ── Uploads (Cloudinary when configured, otherwise local folders, like the rest of the site)
  const upload = multer({
    storage: cloudinaryConfigured
      ? new CloudinaryStorage({
          cloudinary,
          params: async (req, file) => ({
            folder: 'ksl/updates',
            resource_type: ['audioManual', 'deliverableFile', 'purchaseTutorialVideo'].includes(file.fieldname) ? 'auto' : 'image',
            public_id: `${Date.now()}_${Math.random().toString(36).slice(2)}`,
            use_filename: false
          })
        })
      : multer.diskStorage({
          destination: (req, file, cb) => cb(null, file.fieldname === 'deliverableFile' ? fileDir : uploadDir),
          filename: (req, file, cb) => cb(null, `upd_${Date.now()}_${Math.random().toString(36).slice(2)}${path.extname(file.originalname)}`)
        }),
    limits: { fileSize: 100 * 1024 * 1024 },
    fileFilter: (req, file, cb) => {
      const f = file.fieldname, m = file.mimetype || '';
      if ((f === 'picture' || f === 'workingPictures' || f === 'purchaseTutorialImages') && !/^image\//.test(m)) return cb(new Error('Pictures must be image files'));
      if (f === 'audioManual' && !/^audio\//.test(m)) return cb(new Error('Audio manual must be an audio file'));
      if (f === 'purchaseTutorialVideo' && !/^video\//.test(m)) return cb(new Error('Tutorial video must be a video file'));
      cb(null, true);
    }
  }).fields([
    { name: 'picture', maxCount: 1 }, { name: 'workingPictures', maxCount: 10 },
    { name: 'audioManual', maxCount: 1 }, { name: 'deliverableFile', maxCount: 1 },
    { name: 'purchaseTutorialImages', maxCount: 20 }, { name: 'purchaseTutorialVideo', maxCount: 1 }
  ]);

  // ── Helpers
  // Reads the hidden tutorial from the form. Keeps the previous one when no new file is sent (edit).
  function tutFrom(b, files, prev) {
    const type = TUT.includes(b.tutType) ? b.tutType : 'none';
    const note = String(b.tutNote || '').trim().slice(0, 2000);
    if (type === 'none') return { tutorialType: 'none', images: [], videoUrl: '', linkUrl: '', note: '' };
    if (type === 'images') {
      const imgs = (files.purchaseTutorialImages || []).map(fileUrl);
      if (imgs.length) return { tutorialType: 'images', images: imgs, videoUrl: '', linkUrl: '', note };
      if (prev && prev.tutorialType === 'images' && prev.images && prev.images.length) return { tutorialType: 'images', images: Array.from(prev.images), videoUrl: '', linkUrl: '', note };
      return { error: 'Upload at least one tutorial picture' };
    }
    if (type === 'video') {
      const f = files.purchaseTutorialVideo && files.purchaseTutorialVideo[0];
      if (f) return { tutorialType: 'video', images: [], videoUrl: fileUrl(f), linkUrl: '', note };
      if (prev && prev.tutorialType === 'video' && prev.videoUrl) return { tutorialType: 'video', images: [], videoUrl: prev.videoUrl, linkUrl: '', note };
      return { error: 'Upload a tutorial video' };
    }
    const link = String(b.tutLink || '').trim();
    if (!/^https?:\/\//i.test(link)) return { error: 'The tutorial link must start with http:// or https://' };
    return { tutorialType: 'link', images: [], videoUrl: '', linkUrl: link, note };
  }

  // What a customer sees before buying: no delivery, no tutorial, no message, no audio.
  const publicShape = (u) => ({
    id: String(u._id), title: u.title, description: u.description, price: u.price,
    picture: u.picture || '', workingPictures: u.workingPictures || [],
    productMode: u.productMode, qty: u.qty || 0, soldCount: u.soldCount || 0,
    remaining: u.qty > 0 ? Math.max(0, u.qty - (u.soldCount || 0)) : null,
    soldOut: u.qty > 0 && (u.soldCount || 0) >= u.qty
  });

  // What the buyer receives, saved in their purchase record.
  const deliveredShape = (r) => ({
    id: String(r._id), title: r.title, pricePaid: r.pricePaid, purchasedAt: r.purchasedAt,
    productMode: r.productMode, deliveryType: r.deliveryType, toolLink: r.toolLink || '',
    logDetails: r.details || '', deliverableFile: r.deliverableFile || '', deliverableFileName: r.deliverableFileName || '',
    audioManual: r.audioManual || '', postPurchaseMessage: r.postPurchaseMessage || '',
    purchaseTutorial: (r.purchaseTutorial && r.purchaseTutorial.tutorialType !== 'none') ? r.purchaseTutorial : null
  });

  async function emailDelivery(user, title, text) {
    try {
      await sendMail({
        to: user.email, category: 'delivery', userId: user._id,
        subject: `Your ${title} delivery | Stevelogsmarketplace`,
        content: {
          title: 'Your purchase has been delivered',
          preheader: `Your ${title} details are inside.`,
          lines: [`<b>Item:</b> ${esc(title)}`, `<b>Delivery:</b><br>${esc(text).replace(/\n/g, '<br>')}`]
        }
      });
    } catch (err) { console.error('[update-delivery-email]', err.message); }
  }

  // Validates the admin form. `existing` is the saved update when editing, otherwise null.
  function readForm(req, existing) {
    const b = req.body || {};
    const files = req.files || {};
    const mode = b.productMode === 'tutorial_only' ? 'tutorial_only' : 'product';
    const dt = mode === 'tutorial_only' ? 'none' : normDel(b.deliveryType);
    const tut = tutFrom(b, files, existing ? existing.purchaseTutorial : null);
    if (tut.error) return { error: tut.error };
    const title = String(b.title || '').trim().slice(0, 160);
    if (!title) return { error: 'Name is required' };
    const out = {
      title, description: String(b.description || '').slice(0, 4000), productMode: mode, deliveryType: dt,
      purchaseTutorial: tut, postPurchaseMessage: String(b.postPurchaseMessage || '').trim().slice(0, 4000),
      details: String(b.details || ''), toolLink: String(b.toolLink || '').trim(),
      newDeliverableFile: files.deliverableFile && files.deliverableFile[0]
    };
    if (mode === 'tutorial_only') {
      const hasTut = tut.tutorialType !== 'none';
      if (!hasTut && !out.postPurchaseMessage && !(existing && existing.audioManual) && !files.audioManual) {
        return { error: 'A tutorial-only update needs a tutorial, a message or an audio manual' };
      }
      return { out };
    }
    const hasFile = !!(out.newDeliverableFile || (existing && existing.deliverableFile));
    if (dt === 'link' && !/^https?:\/\//i.test(out.toolLink)) return { error: 'Enter the link to deliver (starting with http:// or https://)' };
    if (['file', 'video', 'image'].includes(dt) && !hasFile) return { error: 'Upload the file to deliver' };
    if (dt === 'video' && out.newDeliverableFile && !/^video\//.test(out.newDeliverableFile.mimetype)) return { error: 'The delivered video must be a video file' };
    if (dt === 'image' && out.newDeliverableFile && !/^image\//.test(out.newDeliverableFile.mimetype)) return { error: 'The delivered picture must be an image file' };
    if (dt === 'email' && !out.details.trim()) return { error: 'Write the email content in the Details box' };
    return { out };
  }

  // ── Public
  app.get('/api/updates', async (req, res) => {
    try {
      const items = await UpdateItem.find({ available: true }).sort({ createdAt: -1 }).lean();
      res.set('Cache-Control', 'no-store');
      res.json(items.map(publicShape));
    } catch (e) { res.status(500).json({ error: 'Failed to load updates' }); }
  });
  app.get('/api/updates/purchases', auth, async (req, res) => {
    try {
      const rows = await UpdatePurchase.find({ userId: req.user._id }).sort({ purchasedAt: -1 }).limit(200).lean();
      res.set('Cache-Control', 'no-store');
      res.json(rows.map(deliveredShape));
    } catch (e) { res.status(500).json({ error: 'Failed to load purchases' }); }
  });
  app.get('/api/updates/:id', async (req, res) => {
    try {
      const u = await UpdateItem.findById(req.params.id).lean();
      if (!u || !u.available) return res.status(404).json({ error: 'Not found' });
      res.json(publicShape(u));
    } catch (e) { res.status(404).json({ error: 'Not found' }); }
  });

  // ── Buy: stock is claimed atomically, the wallet is debited atomically, and the delivery is saved
  app.post('/api/updates/buy/:id', auth, async (req, res) => {
    let claimed = null;
    try {
      const u = await UpdateItem.findById(req.params.id);
      if (!u || !u.available) return res.status(404).json({ error: 'Not found' });
      claimed = await UpdateItem.findOneAndUpdate(
        {
          _id: u._id, available: true,
          $expr: { $or: [ { $lte: [{ $ifNull: ['$qty', 0] }, 0] }, { $lt: [{ $ifNull: ['$soldCount', 0] }, '$qty'] } ] }
        },
        { $inc: { soldCount: 1 } }, { new: true }
      );
      if (!claimed) return res.status(400).json({ error: 'This update is sold out.' });
      const user = await User.findOneAndUpdate(
        { _id: req.user._id, balance: { $gte: u.price } },
        { $inc: { balance: -u.price } }, { new: true }
      );
      if (!user) {
        await UpdateItem.updateOne({ _id: u._id }, { $inc: { soldCount: -1 } });
        return res.status(400).json({ error: 'Insufficient balance. Please deposit funds.' });
      }
      const rec = await UpdatePurchase.create({
        userId: user._id, updateId: u._id, title: u.title, pricePaid: u.price,
        productMode: u.productMode, deliveryType: u.deliveryType, toolLink: u.toolLink,
        details: u.details, deliverableFile: u.deliverableFile, deliverableFileName: u.deliverableFileName,
        audioManual: u.audioManual, postPurchaseMessage: u.postPurchaseMessage,
        purchaseTutorial: u.purchaseTutorial && u.purchaseTutorial.tutorialType !== 'none' ? u.purchaseTutorial.toObject() : { tutorialType: 'none' }
      });
      await Transaction.create({ userId: user._id, type: 'purchase', amount: u.price, description: `Update purchased: ${u.title}`, status: 'success' });
      if (u.productMode !== 'tutorial_only' && u.deliveryType === 'email' && user.email) emailDelivery(user, u.title, u.details || '');
      res.json({ message: 'Purchase successful!', newBalance: user.balance, purchase: deliveredShape(rec.toObject()) });
    } catch (e) {
      if (claimed) await UpdateItem.updateOne({ _id: claimed._id }, { $inc: { soldCount: -1 } }).catch(() => {});
      res.status(500).json({ error: 'Purchase failed: ' + e.message });
    }
  });

  // ── Admin and support staff
  app.get('/api/admin/updates', anyAdminAuth, async (req, res) => {
    try {
      const items = await UpdateItem.find({}).sort({ createdAt: -1 }).lean();
      res.set('Cache-Control', 'no-store');
      res.json(items.map((u) => ({ ...u, id: String(u._id) })));
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  app.post('/api/admin/updates', anyAdminAuth, upload, async (req, res) => {
    try {
      const r = readForm(req, null);
      if (r.error) return res.status(400).json({ error: r.error });
      const o = r.out, files = req.files || {};
      const price = parseFloat(req.body.price);
      if (!(price >= 0) || req.body.price === '' || req.body.price === undefined) return res.status(400).json({ error: 'Price is required' });
      const item = await UpdateItem.create({
        ...o, price,
        qty: parseInt(req.body.qty, 10) || 0,
        available: req.body.available !== 'false',
        picture: files.picture && files.picture[0] ? fileUrl(files.picture[0]) : '',
        workingPictures: (files.workingPictures || []).map(fileUrl),
        audioManual: files.audioManual && files.audioManual[0] ? fileUrl(files.audioManual[0]) : '',
        deliverableFile: o.newDeliverableFile && o.productMode === 'product' ? fileUrl(o.newDeliverableFile) : '',
        deliverableFileName: o.newDeliverableFile && o.productMode === 'product' ? o.newDeliverableFile.originalname : '',
        newDeliverableFile: undefined
      });
      res.json({ ...item.toObject(), id: String(item._id) });
    } catch (e) { res.status(500).json({ error: 'Failed: ' + e.message }); }
  });

  app.put('/api/admin/updates/:id', anyAdminAuth, upload, async (req, res) => {
    try {
      const existing = await UpdateItem.findById(req.params.id);
      if (!existing) return res.status(404).json({ error: 'Not found' });
      const r = readForm(req, existing);
      if (r.error) return res.status(400).json({ error: r.error });
      const o = r.out, files = req.files || {}, b = req.body || {};
      const update = {
        title: o.title, description: o.description, productMode: o.productMode, deliveryType: o.deliveryType,
        toolLink: o.toolLink, details: o.details, postPurchaseMessage: o.postPurchaseMessage,
        purchaseTutorial: o.purchaseTutorial, updatedAt: new Date()
      };
      if (files.picture && files.picture[0]) update.picture = fileUrl(files.picture[0]);
      if (files.workingPictures && files.workingPictures.length) update.workingPictures = [...(existing.workingPictures || []), ...files.workingPictures.map(fileUrl)];
      if (String(b.clearWorkingPictures) === 'true') update.workingPictures = [];
      if (files.audioManual && files.audioManual[0]) update.audioManual = fileUrl(files.audioManual[0]);
      if (String(b.clearAudioManual) === 'true') update.audioManual = '';
      if (o.newDeliverableFile && o.productMode === 'product') {
        update.deliverableFile = fileUrl(o.newDeliverableFile);
        update.deliverableFileName = o.newDeliverableFile.originalname;
      }
      // Owner only: price, quantity, visibility. Support staff cannot change these.
      if (req.adminRole === 'super') {
        const price = parseFloat(b.price);
        if (b.price !== undefined && b.price !== '' && price >= 0) update.price = price;
        if (b.qty !== undefined && b.qty !== '') update.qty = parseInt(b.qty, 10) || 0;
        if (b.available !== undefined) update.available = b.available !== 'false';
      }
      const item = await UpdateItem.findByIdAndUpdate(req.params.id, update, { new: true });
      res.json({ ...item.toObject(), id: String(item._id) });
    } catch (e) { res.status(500).json({ error: 'Failed: ' + e.message }); }
  });

  app.delete('/api/admin/updates/:id', adminAuth, async (req, res) => {
    try {
      await UpdateItem.findByIdAndDelete(req.params.id);
      res.json({ message: 'Deleted' });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });
};
