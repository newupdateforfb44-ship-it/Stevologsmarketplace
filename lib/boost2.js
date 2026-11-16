// Boost 2 — second SMM provider: Vinasmm (standard SMM panel API v2). Credentials stay server-side.
//   VINASMM_API_KEY   (required)  your Vinasmm API key
//   VINASMM_BASE_URL  (optional)  default https://vinasmm.com/api/v2
//   VINASMM_USD_RATE  (optional)  fixed NGN per 1 USD; if empty the live USD→NGN rate is used
//   VINASMM_RATE_CURRENCY (optional) currency of the provider's "rate" column, default USD (use NGN if Vinasmm lists NGN)
const axios = require('axios');
const crypto = require('crypto');
const fx = require('./fx');
const PA = require('./price-adjust');
const { sealRef, openRef } = require('./opaque-ref');
module.exports = function registerNovaBoost2({ app, mongoose, User, Transaction, auth, anyAdminAuth, novaGate }) {
  const base = () => String(process.env.VINASMM_BASE_URL || 'https://vinasmm.com/api/v2').replace(/\/+$/, '');
  const cleanKey = v => String(v || '').replace(/[\r\n\t]/g, '').trim().replace(/^["'`]+|["'`]+$/g, '').trim();
  const key = () => cleanKey(process.env.VINASMM_API_KEY);
  const rateCurrency = () => String(process.env.VINASMM_RATE_CURRENCY || 'USD').trim().toUpperCase();
  let fxMemo = { at: 0, rate: 0 };
  async function ngnPerUnit() {
    if (rateCurrency() === 'NGN') return 1;
    const fixed = Number(process.env.VINASMM_USD_RATE);
    if (Number.isFinite(fixed) && fixed > 0) return fixed;
    if (fxMemo.rate && Date.now() - fxMemo.at < 30 * 60 * 1000) return fxMemo.rate;
    try { const r = Number(await fx.convert(1, rateCurrency(), 'NGN')) * (1 + (fx.SPREAD || 0)); if (Number.isFinite(r) && r > 0) { fxMemo = { at: Date.now(), rate: r }; return r; } } catch (e) {}
    if (fxMemo.rate) return fxMemo.rate;
    const fallback = Number(process.env.BOOST_FALLBACK_USD_RATE || 1600); return fallback > 0 ? fallback : 1600;
  }
  const serviceRef = itemId => sealRef('boost2-service', { itemId }, process.env.JWT_SECRET);
  function serviceIdFromRef(token) {
    const value = openRef('boost2-service', token, process.env.JWT_SECRET);
    const id = Number(value.itemId);
    if (!Number.isSafeInteger(id) || id <= 0) throw new Error('Invalid service reference.');
    return id;
  }
  const schema = new mongoose.Schema({ itemId: {type:Number,unique:true,index:true}, sellPrice:{type:Number,default:0}, markup:{type:Number,default:0}, mode:{type:String,enum:['specific','markup'],default:'markup'}, enabled:{type:Boolean,default:true}, visible:{type:Boolean,default:true}, updatedAt:{type:Date,default:Date.now} });
  const Price = mongoose.models.VinaBoost2Price || mongoose.model('VinaBoost2Price', schema);
  const ordersSchema = new mongoose.Schema({ userId:mongoose.Schema.Types.ObjectId, itemId:Number, itemName:String, quantity:Number, rateUnit:Number, link:String, clientRef:{type:String,unique:true,sparse:true}, providerOrder:String, idempotencyKey:{type:String,index:true},provider:{type:String,default:''}, status:String, reviewNote:String, txRecorded:{type:Boolean,default:false}, cost:Number, sellTotal:Number, createdAt:{type:Date,default:Date.now} });
  // Default markup (NGN per rateUnit) used when a service has no markup of its own.
  const cfgSchema = new mongoose.Schema({ key:{type:String,unique:true,default:'main'}, defaultMarkup:{type:Number,default:0} });
  const Cfg = mongoose.models.VinaBoost2Config || mongoose.model('VinaBoost2Config', cfgSchema);
  const getDefaultMarkup = async () => { try { const c = await Cfg.findOne({key:'main'}).lean(); const n = Number(c && c.defaultMarkup); return Number.isFinite(n) && n > 0 ? n : 0; } catch { return 0; } };
  const Order = mongoose.models.NovaBoost2Order || mongoose.model('NovaBoost2Order', ordersSchema);
  // Standard SMM v2: POST form (key, action, ...). Errors come back as 200 + { error: "..." }.
  async function api(action, fields={}) {
    if (!key()) { const e=new Error('Boost 2 is not set up yet. Please contact the administrator.'); e.status=503; throw e; }
    const body=new URLSearchParams({ key:key(), action, ...Object.fromEntries(Object.entries(fields).map(([k,v])=>[k,String(v)])) });
    const r=await axios.post(base(), body.toString(), { timeout:45000, headers:{ 'Content-Type':'application/x-www-form-urlencoded', Accept:'application/json' }, validateStatus:()=>true });
    let d=r.data;
    if (typeof d==='string') { try { d=JSON.parse(d); } catch (e) { const er=new Error('Provider returned an unreadable response.'); er.response={status:r.status||502,data:String(d).slice(0,200)}; throw er; } }
    if (r.status>=400) { const er=new Error(String(d&&d.error||('HTTP '+r.status))); er.response={status:r.status,data:d}; throw er; }
    if (d && !Array.isArray(d) && typeof d==='object' && d.error) { const er=new Error(String(d.error)); er.providerError=true; er.response={status:400,data:d}; throw er; }
    return d;
  }
  const unwrap = d => (d && d.data && typeof d.data === 'object' && !Array.isArray(d.data)) ? d.data : (d || {});
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  async function fetchAllProducts() {
    const d = await api('services');
    const rows = Array.isArray(d) ? d : (Array.isArray(d?.services) ? d.services : null);
    if (!rows) throw new Error('The provider returned an invalid Boost 2 catalogue.');
    const out = new Map();
    for (const x of rows) {
      const id = Number(x?.service ?? x?.id);
      if (!Number.isInteger(id) || id <= 0 || out.has(id)) continue;
      const st = String(x.status ?? '').toLowerCase();
      if (x.enabled === false || x.active === false || ['inactive','disabled','unavailable','hidden','deleted','removed','paused'].includes(st)) continue;
      const desc = String(x.desc || x.description || '').slice(0, 600);
      out.set(id, { id, name: String(x.name || ('Service ' + id)).slice(0, 300), category: String(x.category || x.type || 'Social boosting').slice(0, 120), description: desc, min: Number(x.min) || 1, max: Number(x.max) || 100000, rate: Number(x.rate) || 0, rate_unit: 1000 });
    }
    return [...out.values()];
  }
  // The provider list is stored in our database. Customers never trigger a provider call just by
  // opening the page; it is re-pulled on admin sync, on a customer Refresh (30s cooldown), or when
  // nothing is stored yet. If a re-pull fails, the previously stored list stays available.
  const cacheSchema = new mongoose.Schema({ key:{type:String,unique:true}, products:{type:mongoose.Schema.Types.Mixed,default:[]}, syncedAt:Date, error:{type:String,default:''} },{minimize:false});
  const Cache = mongoose.models.VinaBoost2Cache || mongoose.model('VinaBoost2Cache', cacheSchema);
  let inflight = null;
  // In-memory copy so a customer request never waits on the database or the provider.
  let mem = null; const MEM_MS = 35 * 60 * 1000; // background refresh runs every 30 min and admin sync updates it, so this stays fresh
  async function loadProducts(refresh=false, force=false) {
    if (!refresh && mem && Date.now() - mem.at < MEM_MS) return mem.val;
    const val = await loadProductsDb(refresh, force);
    if (val && Array.isArray(val.products) && val.products.length) mem = { at: Date.now(), val };
    return val;
  }
  async function loadProductsDb(refresh=false, force=false) {
    const doc = await Cache.findOne({key:'smm'}).lean();
    const age = doc?.syncedAt ? Date.now()-new Date(doc.syncedAt).getTime() : Infinity;
    if (doc && Array.isArray(doc.products) && doc.products.length && !(refresh && (force || age>30000))) return {products:doc.products, syncedAt:doc.syncedAt, stale:false};
    if (!inflight) inflight = fetchAllProducts().then(async products=>{
      if (!products.length && Array.isArray(doc?.products) && doc.products.length) return {products:doc.products,syncedAt:doc.syncedAt,stale:true};
      const syncedAt=new Date(); await Cache.updateOne({key:'smm'},{$set:{products,syncedAt,error:''}},{upsert:true}); return {products,syncedAt,stale:false};
    }).finally(()=>{inflight=null;});
    try { return await inflight; }
    catch(e) {
      const st=e.response?.status, pm=e.response?.data?.message||e.response?.data?.error||e.message;
      console.error('[boost2] catalogue pull failed:',st || 'no response');
      Cache.updateOne({key:'smm'},{$set:{error:String(pm||'').slice(0,300)}},{upsert:true}).catch(()=>{});
      if (doc && Array.isArray(doc.products) && doc.products.length) { return {products:doc.products, syncedAt:doc.syncedAt, stale:true, error:pm}; }
      throw e;
    }
  }
  // Warm the list shortly after the server starts and keep it fresh in the background,
  // so the first customer to open Boost 2 sees services immediately.
  setTimeout(() => { loadProducts(false).catch(() => {}); }, 4000);
  setInterval(() => { loadProducts(true).catch(() => {}); }, 30 * 60 * 1000);
  const friendly = e => e.response?.status===429 ? 'The provider is limiting requests right now. Please wait a minute and try again.' : 'The provider service is temporarily unavailable.';
  // Reads only what is already stored. If nothing is stored yet it starts a background pull and says so,
  // instead of making the customer wait minutes for the provider.
  let kickAt = 0;
  async function cachedOnly() {
    if (mem && Date.now() - mem.at < MEM_MS) return mem.val;
    const doc = await Cache.findOne({key:'smm'}).lean();
    if (doc && Array.isArray(doc.products) && doc.products.length) {
      const val = {products:doc.products, syncedAt:doc.syncedAt, stale:false};
      mem = { at: Date.now(), val };
      return val;
    }
    if (!inflight && Date.now() - kickAt > 60000) { kickAt = Date.now(); loadProducts(true, true).catch(() => {}); }
    cachedOnly.lastError = (doc && doc.error) || '';
    return null;
  }
  async function catalogue(refresh=false, force=false, noPull=false) {
    let loaded;
    if (noPull) { loaded = await cachedOnly(); if (!loaded) { const w = new Error('Boost 2 services are still being prepared.'); w.warming = true; w.detail = cachedOnly.lastError || ''; throw w; } }
    else loaded = await loadProducts(refresh, force);
    const {products, syncedAt, stale} = loaded;
    const defMarkup=await getDefaultMarkup();
    const prices=await Price.find({}).lean(); const pm=new Map(prices.map(p=>[Number(p.itemId),p]));
    const fxRate = await ngnPerUnit();
    const costOf = p => { const x=Number(p.rate ?? p.price ?? p.cost); return Number.isFinite(x)&&x>=0?Math.round(x*fxRate*100)/100:0; };
    const rateUnitOf = p => { const n=Number(p.rate_unit ?? p.rateUnit); return Number.isSafeInteger(n) && n>0 ? n : 1000; };
    const list = products.map(p=>{const cfg=pm.get(Number(p.id))||{};const cost=costOf(p);const effMarkup=(Number(cfg.markup)||0)>0?Number(cfg.markup):(cost>0?defMarkup:0);const sell0=cfg.mode==='specific'?Number(cfg.sellPrice)||0:cost+effMarkup;const sell=PA.apply('boost2',sell0,{floor:cost,decimals:true});return {id:Number(p.id),name:p.name||`Service ${p.id}`,category:p.category||'Social boosting',description:String(p.description||p.service_description||p.desc||''),min:Number(p.min_qty ?? p.min)||1,max:Number(p.max_qty ?? p.max)||100000,rateUnit:rateUnitOf(p),cost,price:sell,mode:cfg.mode||'markup',sellPrice:Number(cfg.sellPrice)||0,markup:Number(cfg.markup)||0,effectiveMarkup:effMarkup,enabled:cfg.enabled!==false,visible:cfg.visible!==false,priced:sell>0};});
    list.syncedAt = syncedAt; list.stale = stale;
    return list;
  }
  function safeOrderStatus(value) {
    const status=String(value||'').trim().toLowerCase();
    if(['success','complete','completed','delivered'].includes(status)) return 'completed';
    if(['failed','error','rejected','cancelled','canceled'].includes(status)) return 'failed';
    if(['pending','processing','in progress','in_progress','partial','queued','review','refunding','refunded'].includes(status)) return status.replace('in progress','processing').replace('in_progress','processing');
    return 'processing';
  }
  function statusBucket(value) {
    const status=String(value||'').toLowerCase();
    if(['success','complete','completed','delivered'].includes(status)) return 'delivered';
    if(['failed','error','rejected','cancelled','canceled','refunded'].includes(status)) return 'failed';
    return 'pending';
  }
  let custCache=null; // built customer list, reused for 60s so the page opens fast
  app.get('/api/boost2/services',auth,async(req,res)=>{
    res.set('Cache-Control','no-store');
    if(!key()) return res.json({enabled:false,services:[],message:'Boost 2 is not available yet. Please contact the administrator.'});
    try {
      const wantFresh=String(req.query.refresh||'')==='1';
      if(!wantFresh && custCache && Date.now()-custCache.at<60000) return res.json(custCache.body);
      const list=await catalogue(wantFresh,false,!wantFresh);
      const services=list.filter(x=>x.enabled&&x.visible&&x.priced)
        .map(({id,name,category,description,min,max,rateUnit,price})=>({serviceKey:serviceRef(id),name,category,description,min,max,rateUnit,price}));
      const body={enabled:true,syncedAt:list.syncedAt,stale:!!list.stale,services};
      custCache={at:Date.now(),body};
      res.json(body);
    } catch(e) {
      if(e.warming) return res.json({enabled:true,loading:true,services:[],message:'Loading services from the provider. This can take a minute, please wait…'});
      console.error('[boost2] catalogue request failed:',e.response?.status||'no response');
      res.status(502).json({error:'Could not load Boost 2 services right now. Please try again shortly.'});
    }
  });
  function customerOrder(order) {
    return {orderId:String(order._id),status:safeOrderStatus(order.status),itemName:order.itemName,quantity:order.quantity,rateUnit:order.rateUnit,link:order.link,amountPaid:order.sellTotal,createdAt:order.createdAt};
  }
  function respondExistingOrder(res, order) {
    if(['pending','review','refunding'].includes(String(order.status).toLowerCase())) {
      return res.status(202).json({ok:true,pending:true,orderId:String(order._id),message:'This order is still being checked. Please do not submit it again.'});
    }
    if(['failed','refunded'].includes(String(order.status).toLowerCase())) {
      return res.status(409).json({error:'This order attempt has already finished. Review your order history before placing another order.'});
    }
    return res.json({...customerOrder(order),ok:true,repeated:true});
  }
  // Pulls live order status from Vinasmm (action=status, up to 100 ids at once) for orders still in progress.
  // Completed orders are marked completed. Cancelled/partial orders are moved to "review" so an admin
  // can check and refund them; the wallet is never refunded automatically from a status poll.
  let lastStatusSync = 0;
  async function syncStatuses() {
    if (!key() || Date.now() - lastStatusSync < 20000) return;
    lastStatusSync = Date.now();
    try {
      const open = await Order.find({ provider: 'vinasmm', status: { $in: ['processing','pending'] }, providerOrder: { $nin: ['', null] } }).sort({ createdAt: -1 }).limit(100).lean();
      if (!open.length) return;
      const d = await api('status', { orders: open.map(o => o.providerOrder).join(',') });
      for (const o of open) {
        const r = d && d[o.providerOrder]; if (!r || r.error) continue;
        const st = String(r.status || '').toLowerCase();
        if (st === 'completed') await Order.updateOne({ _id: o._id, status: { $in: ['processing','pending'] } }, { $set: { status: 'completed' } });
        else if (['canceled','cancelled','partial','fail','failed','refunded'].includes(st)) await Order.updateOne({ _id: o._id, status: { $in: ['processing','pending'] } }, { $set: { status: 'review', reviewNote: 'Provider reports this order as "' + st + '". Check it, then refund the customer from the review list if nothing was delivered.' } });
      }
    } catch (e) { console.error('[boost2] status sync failed:', e.message); }
  }
  setInterval(() => { syncStatuses().catch(() => {}); }, 60 * 1000);
  app.get('/api/boost2/orders',auth,async(req,res)=>{
    try {
      await syncStatuses();
      const rows=await Order.find({userId:req.user._id}).sort({createdAt:-1}).limit(50).lean();
      const statuses=await Order.find({userId:req.user._id}).select('status').lean();
      const counts={all:statuses.length,pending:0,delivered:0,failed:0};
      for(const row of statuses) counts[statusBucket(row.status)]++;
      res.set('Cache-Control','no-store');
      res.json({orders:rows.map(customerOrder),counts});
    } catch(e) {
      console.error('[boost2] customer history query failed:',e.name);
      res.status(500).json({error:'Could not load your Boost 2 order history.'});
    }
  });
  app.get('/api/boost2/orders/:id',auth,async(req,res)=>{
    if(!mongoose.Types.ObjectId.isValid(req.params.id)) return res.status(404).json({error:'Order not found.'});
    try {
      const order=await Order.findOne({_id:req.params.id,userId:req.user._id}).lean();
      if(!order) return res.status(404).json({error:'Order not found.'});
      res.set('Cache-Control','no-store');
      res.json(customerOrder(order));
    } catch(e) {
      console.error('[boost2] customer order detail query failed:',e.name);
      res.status(500).json({error:'Could not load this Boost 2 order.'});
    }
  });
  app.get('/api/boost2/orders',auth,async(req,res)=>{try{const rows=await Order.find({userId:req.user._id}).sort({createdAt:-1}).limit(15).lean();const label=s=>({review:'processing',refunding:'processing',pending:'processing',refunded:'refunded',failed:'failed'}[String(s||'').toLowerCase()]||String(s||'processing'));res.json(rows.map(o=>({service:o.itemName,quantity:o.quantity,total:o.sellTotal,status:label(o.status),createdAt:o.createdAt})));}catch(e){res.status(500).json({error:'Could not load your orders.'});}}); // STEVO-UPGRADE
  app.post('/api/boost2/orders',auth,async(req,res)=>{
    let order=null, user=null, charged=0, providerCallStarted=false, clientRef='', purchaseTxRef='', refundTxRef='';
    try {
      let id;
      try { id=req.body?.serviceKey ? serviceIdFromRef(String(req.body.serviceKey)) : Number(req.body?.serviceId); }
      catch { return res.status(400).json({error:'Refresh the service list and choose a service again.'}); }
      const qty=Number(req.body?.quantity),link=String(req.body?.link||'').trim();
      clientRef=String(req.body?.clientRef||'').trim();
      if(clientRef&&!/^[A-Za-z0-9_-]{16,80}$/.test(clientRef)) return res.status(400).json({error:'Invalid order reference. Please review the order and try again.'});
      if(!clientRef) clientRef=crypto.randomUUID();
      if(!Number.isInteger(id)||id<=0||!Number.isInteger(qty)||qty<1||link.length>2048) return res.status(400).json({error:'Choose a service, valid quantity, and public http(s) link.'});
      let target;
      try { target=new URL(link); } catch { return res.status(400).json({error:'Enter a valid public http(s) link.'}); }
      if(!['http:','https:'].includes(target.protocol)||!target.hostname||target.username||target.password) return res.status(400).json({error:'Enter a valid public http(s) link.'});
      if(!key()) return res.status(503).json({error:'Boost 2 is not available right now. Nothing was charged.'});
      const previous=await Order.findOne({clientRef}).lean();
      if(previous) {
        if(String(previous.userId)!==String(req.user._id)) return res.status(409).json({error:'Invalid order reference.'});
        return respondExistingOrder(res,previous);
      }
      const s=(await catalogue(false,false,true)).find(x=>x.id===id&&x.enabled&&x.visible&&x.priced);
      if(!s) return res.status(404).json({error:'Service unavailable.'});
      if(qty<s.min||qty>s.max) return res.status(400).json({error:`Quantity must be between ${s.min} and ${s.max}.`});
      const rateUnit=Number.isSafeInteger(s.rateUnit)&&s.rateUnit>0?s.rateUnit:1000;
      const total=Math.round((s.price*qty/rateUnit)*100)/100;
      if(!Number.isFinite(total)||total<=0||!Number.isFinite(s.cost)||s.cost<0) return res.status(400).json({error:'Invalid service price. No charge was made.'});
      const recent=await Order.findOne({
        userId:req.user._id,itemId:id,quantity:qty,link,
        status:{$in:['pending','review','refunding','processing']},
        createdAt:{$gte:new Date(Date.now()-10*60*1000)}
      }).sort({createdAt:-1}).lean();
      if(recent) return res.status(202).json({ok:true,pending:true,orderId:String(recent._id),message:'A matching Boost 2 order is still being checked. Please review your order history before trying again.'});
      const idempotencyKey=clientRef;
      order=await Order.create({userId:req.user._id,itemId:id,itemName:s.name,quantity:qty,rateUnit,link,clientRef,providerOrder:'',idempotencyKey,provider:'vinasmm',status:'pending',cost:Math.round((s.cost*qty/rateUnit)*100)/100,sellTotal:total});
      purchaseTxRef=`boost2:${order._id}:purchase`;
      refundTxRef=`boost2:${order._id}:refund`;
      user=await User.findOneAndUpdate({_id:req.user._id,balance:{$gte:total}},{$inc:{balance:-total}},{new:true});
      if(!user){await Order.updateOne({_id:order._id},{$set:{status:'failed',reviewNote:'Insufficient balance; provider was not called.'}});return res.status(400).json({error:'Insufficient wallet balance.'});}
      charged=total;
      await Transaction.create({userId:user._id,type:'purchase',amount:total,description:`Boost 2 — ${s.name}`,status:'pending',txRef:purchaseTxRef});
      let d;
      providerCallStarted=true;
      try {
        d=await api('add',{service:id,link,quantity:qty});
      } catch(e) {
        const status=Number(e.response?.status||e.status||0);
        // A timeout/network drop/5xx means Vinasmm may already have created and charged the order.
        // Never refund automatically in this case; hold the debit and flag it for reconciliation.
        const ambiguous=!e.response || status===408 || status>=500;
        if(ambiguous){
          const note=`Provider outcome unclear (HTTP ${status||'no response'}). Reconcile using the saved request key before refunding.`;
          await Order.updateOne({_id:order._id},{$set:{status:'review',reviewNote:note}}).catch(()=>{});
          console.error('[BOOST2-REVIEW] provider result is ambiguous; manual reconciliation is required.');
          return res.status(202).json({ok:true,pending:true,orderId:String(order._id),message:'Your order is being verified because the provider did not confirm the result. Your balance is on hold; please do not order again yet.'});
        }
        // Definite provider rejection: refund exactly once using an atomic order-state claim.
        // Capture the provider's real reason (no secrets) so the cause is visible instead of a generic "rejected".
        const pBody=e.response?.data;
        let pReason='';
        try { pReason=String((pBody&&(pBody.message||pBody.error?.message||(typeof pBody.error==='string'?pBody.error:'')||pBody.detail))||(typeof pBody==='string'?pBody:JSON.stringify(pBody))||e.message||'').replace(/\s+/g,' ').slice(0,300); } catch { pReason=String(e.message||'').slice(0,300); }
        console.error('[boost2] provider rejected order: HTTP',status,'|',pReason,'| sent: service',id,'qty',qty);
        const claim=await Order.findOneAndUpdate({_id:order._id,status:'pending'},{$set:{status:'refunding',reviewNote:`Provider rejected order (HTTP ${status}): ${pReason}` }},{new:true});
        if(claim){
          try {
            await User.updateOne({_id:user._id},{$inc:{balance:total}});
            await Transaction.updateOne({txRef:purchaseTxRef},{$set:{status:'failed'}});
            await Transaction.create({userId:user._id,type:'refund',amount:total,description:`Boost 2 refund — ${s.name}`,status:'success',txRef:refundTxRef});
          } catch(refundErr) {
            // Keep the refund claim in place: the wallet update may have succeeded before a
            // later ledger write failed, so reopening this order could credit it twice.
            await Order.updateOne({_id:order._id,status:'refunding'},{$set:{reviewNote:'Provider rejection was verified, but wallet/ledger refund requires manual reconciliation.'}}).catch(()=>{});
            console.error('[BOOST2-REFUND-REVIEW] wallet/ledger refund needs reconciliation:',refundErr.name);
            return res.status(202).json({ok:true,pending:true,orderId:String(order._id),message:'The provider rejected the order. Your refund is being processed; contact support if your balance is not restored shortly.'});
          }
          await Order.updateOne({_id:order._id,status:'refunding'},{$set:{status:'refunded',reviewNote:`Provider rejection confirmed (HTTP ${status}): ${pReason}; wallet refunded.`}});
          charged=0;
        }
        return res.status(400).json({error:'The provider rejected this order'+(pReason?' ('+pReason.slice(0,160)+')':'')+'. Your wallet was refunded.'});
      }
      const providerOrder=String((d&&(d.order??d.order_id??d.id))||'');
      const reportedStatus='processing';
      if(!d||typeof d!=='object'||Array.isArray(d)||!providerOrder||!/^[A-Za-z0-9_-]{1,64}$/.test(providerOrder)){
        await Order.updateOne({_id:order._id},{$set:{status:'review',reviewNote:'Provider response did not confirm a usable order reference.'}}).catch(()=>{});
        console.error('[BOOST2-REVIEW] provider response requires manual reconciliation.');
        return res.status(202).json({ok:true,pending:true,orderId:String(order._id),message:'The provider has not confirmed the order details yet. Your balance is on hold; please do not submit it again.'});
      }
      const status=safeOrderStatus(reportedStatus);
      await Order.updateOne({_id:order._id},{$set:{providerOrder,status,reviewNote:''}});
      try {
        const txResult=await Transaction.updateOne({txRef:purchaseTxRef},{$set:{status:'success'}});
        if(!txResult.matchedCount) throw new Error('Pending Boost 2 ledger transaction was not found.');
        await Order.updateOne({_id:order._id},{$set:{txRecorded:true}});
      } catch(logErr){ console.error('[BOOST2-LEDGER-REVIEW] confirmed order transaction record needs reconciliation.'); }
      res.json({ok:true,orderId:String(order._id),status,amountPaid:total,balance:user.balance});
    } catch(e) {
      if(e.code===11000&&clientRef) {
        const existing=await Order.findOne({clientRef}).lean().catch(()=>null);
        if(existing&&String(existing.userId)===String(req.user._id)) return respondExistingOrder(res,existing);
      }
      if(charged && user?._id && !providerCallStarted){
        const claim=await Order.findOneAndUpdate({_id:order._id,status:'pending'},{$set:{status:'refunding',reviewNote:'Local failure before provider submission; refund claimed.'}},{new:true}).catch(()=>null);
        if(claim) {
          try {
            await User.updateOne({_id:user._id},{$inc:{balance:charged}});
            if(purchaseTxRef) await Transaction.updateOne({txRef:purchaseTxRef},{$set:{status:'failed'}});
            if(refundTxRef) await Transaction.create({userId:user._id,type:'refund',amount:charged,description:`Boost 2 refund — ${order.itemName}`,status:'success',txRef:refundTxRef});
            await Order.updateOne({_id:order._id,status:'refunding'},{$set:{status:'refunded',reviewNote:'Local failure before provider submission; wallet refunded.'}});
            charged=0;
          } catch(refundErr) {
            // Never move an uncertain refund back to a retryable state after a wallet
            // increment may have happened. The admin handler intentionally won't credit a
            // refunding order a second time.
            await Order.updateOne({_id:order._id,status:'refunding'},{$set:{reviewNote:'Pre-provider refund needs reconciliation.'}}).catch(()=>{});
            console.error('[BOOST2-REFUND-REVIEW] pre-provider refund requires reconciliation:',refundErr.name);
          }
        }
      } else if(charged && order?._id && providerCallStarted) {
        await Order.updateOne({_id:order._id,status:'pending'},{$set:{status:'review',reviewNote:'Provider may have accepted the order; do not refund until reconciled.'}}).catch(()=>{});
      } else if(order?._id&&!charged&&!providerCallStarted) {
        await Order.updateOne({_id:order._id,status:'pending'},{$set:{status:'failed',reviewNote:'Local failure before wallet debit and provider submission.'}}).catch(()=>{});
      }
      console.error('[boost2] order handler failed:',e.name,e.response?.status||e.status||'');
      if(!res.headersSent) {
        if(providerCallStarted) return res.status(202).json({ok:true,pending:true,orderId:order?._id?String(order._id):undefined,message:'Your order result is still being checked. Please do not submit it again yet.'});
        const status=Number(e.status);
        res.status(status>=400&&status<500?status:502).json({error:providerCallStarted?'Order status is being checked. Please do not retry yet.':'The Boost 2 order could not be placed. Please try again.'});
      }
    }
  });
  app.get('/api/admin/boost2/config',anyAdminAuth,async(req,res)=>{res.json({defaultMarkup:await getDefaultMarkup()});});
  app.put('/api/admin/boost2/config',anyAdminAuth,async(req,res)=>{const n=Number(req.body&&req.body.defaultMarkup);if(!Number.isFinite(n)||n<0||n>1000000)return res.status(400).json({error:'Default markup must be 0 or more.'});await Cfg.updateOne({key:'main'},{$set:{key:'main',defaultMarkup:Math.round(n*100)/100}},{upsert:true});custCache=null;res.json({ok:true,defaultMarkup:n});});
  app.get('/api/admin/boost2/services',anyAdminAuth,async(req,res)=>{try{const wf=String(req.query.refresh||'')==='1';res.json(await catalogue(wf,false,!wf));}catch(e){if(e.warming)return res.json({loading:true,services:[],message:'Loading the provider catalogue. This can take a minute or two, please wait…',detail:e.detail||''});res.status(502).json({error:'Could not load the service list: '+friendly(e)});}});
  app.post('/api/admin/boost2/sync',anyAdminAuth,async(req,res)=>{try{const sp=catalogue(true,true);sp.catch(()=>{});const list=await Promise.race([sp,sleep(25000).then(()=>null)]);custCache=null;if(!list)return res.json({ok:true,started:true,message:'Sync is running in the background and can take a few minutes. The list will appear here when it is ready.'});res.json({ok:true,count:list.length,stale:!!list.stale,syncedAt:list.syncedAt,message:list.stale?'Provider could not be reached; the previously stored list was kept.':`Synced ${list.length} services.`});}catch(e){res.status(502).json({error:'Sync failed: '+friendly(e)});}});
  app.put('/api/admin/boost2/services/:id',anyAdminAuth,async(req,res)=>{const id=Number(req.params.id);if(!Number.isInteger(id)||id<1)return res.status(400).json({error:'Invalid service ID'});const b=req.body||{},set={updatedAt:new Date()};if(b.mode!==undefined){if(!['specific','markup'].includes(b.mode))return res.status(400).json({error:'Mode must be specific or markup'});set.mode=b.mode;}for(const k of ['sellPrice','markup'])if(b[k]!==undefined){const n=Number(b[k]);if(!Number.isFinite(n)||n<0)return res.status(400).json({error:`${k} must be zero or greater`});set[k]=n;}if(typeof b.enabled==='boolean')set.enabled=b.enabled;if(typeof b.visible==='boolean')set.visible=b.visible;await Price.updateOne({itemId:id},{$set:{itemId:id,...set}},{upsert:true});custCache=null;res.json({ok:true});});
  app.get('/api/admin/boost2/orders',anyAdminAuth,async(req,res)=>{
    try {
      const rows=await Order.find({status:{$in:['pending','review','refunding']}})
        .sort({createdAt:-1}).limit(100).populate('userId','name email').lean();
      res.set('Cache-Control','no-store');
      res.json(rows.map(order=>({
        id:String(order._id),userName:order.userId?.name||'',userEmail:order.userId?.email||'',
        itemId:order.itemId,itemName:order.itemName,quantity:order.quantity,rateUnit:order.rateUnit,
        link:order.link,amount:order.sellTotal,status:order.status,reviewNote:order.reviewNote||'',
        providerOrder:order.providerOrder||'',clientRef:order.clientRef,createdAt:order.createdAt,
        txRecorded:!!order.txRecorded
      })));
    } catch(e) {
      console.error('[boost2] admin order review list failed:',e.name);
      res.status(500).json({error:'Could not load Boost 2 orders requiring review.'});
    }
  });
  app.post('/api/admin/boost2/orders/:id/resolve',anyAdminAuth,async(req,res)=>{
    if(!mongoose.Types.ObjectId.isValid(req.params.id)) return res.status(404).json({error:'Order not found.'});
    const action=String(req.body?.action||'');
    try {
      let order=await Order.findById(req.params.id);
      if(!order) return res.status(404).json({error:'Order not found.'});
      const purchaseTxRef=`boost2:${order._id}:purchase`, refundTxRef=`boost2:${order._id}:refund`;
      if(action==='review') {
        const result=await Order.updateOne({_id:order._id,status:'pending'},{$set:{status:'review',reviewNote:'Admin flagged this order for provider reconciliation; do not refund until checked.'}});
        if(!result.matchedCount) return res.status(409).json({error:'Only a pending order can be flagged for review.'});
        return res.json({ok:true,status:'review'});
      }
      if(action==='confirm') {
        const providerOrder=String(req.body?.providerOrder||'').trim().slice(0,128);
        const status=String(req.body?.status||'processing');
        if(!providerOrder||!['processing','completed'].includes(status)) return res.status(400).json({error:'Enter the confirmed provider order reference and a processing or completed status.'});
        if(order.status!=='review') return res.status(409).json({error:'Only an order awaiting review can be confirmed.'});
        const tx=await Transaction.findOne({txRef:purchaseTxRef}).lean();
        if(tx) await Transaction.updateOne({txRef:purchaseTxRef},{$set:{status:'success'}});
        const result=await Order.updateOne({_id:order._id,status:'review'},{$set:{providerOrder,status,reviewNote:'',txRecorded:!!tx}});
        if(!result.matchedCount) return res.status(409).json({error:'The order changed while it was being resolved. Refresh and try again.'});
        return res.json({ok:true,status,ledgerRecorded:!!tx});
      }
      if(action==='refund') {
        if(order.status==='refunded') return res.json({ok:true,status:'refunded',repeated:true});
        if(order.status==='refunding') {
          const priorRefund=await Transaction.findOne({txRef:refundTxRef,status:'success'}).lean();
          if(priorRefund) {
            await Transaction.updateOne({txRef:purchaseTxRef},{$set:{status:'failed'}});
            await Order.updateOne({_id:order._id,status:'refunding'},{$set:{status:'refunded',reviewNote:'Manual provider check confirmed no order; wallet refund reconciled.'}});
            return res.json({ok:true,status:'refunded',repeated:true});
          }
          return res.status(409).json({error:'This refund is already in progress and needs manual balance reconciliation; it will not be credited again automatically.'});
        }
        const claim=await Order.findOneAndUpdate({_id:order._id,status:'review'},{$set:{status:'refunding',reviewNote:'Admin confirmed the provider did not create this order; refund in progress.'}},{new:true});
        if(!claim) return res.status(409).json({error:'Only an order awaiting review can be refunded.'});
        try {
          const wallet=await User.updateOne({_id:claim.userId},{$inc:{balance:claim.sellTotal}});
          if(!wallet.matchedCount) throw new Error('The customer wallet was not found.');
          await Transaction.create({userId:claim.userId,type:'refund',amount:claim.sellTotal,description:`Boost 2 refund — ${claim.itemName}`,status:'success',txRef:refundTxRef});
          await Transaction.updateOne({txRef:purchaseTxRef},{$set:{status:'failed'}});
          await Order.updateOne({_id:claim._id,status:'refunding'},{$set:{status:'refunded',reviewNote:'Manual provider check confirmed no order; wallet refunded.'}});
          return res.json({ok:true,status:'refunded',refunded:claim.sellTotal});
        } catch(refundError) {
          console.error('[BOOST2-ADMIN-REFUND] reconciliation required:',refundError.name);
          return res.status(202).json({ok:true,pending:true,status:'refunding',message:'Refund processing requires balance reconciliation. Do not retry the credit.'});
        }
      }
      return res.status(400).json({error:'Action must be confirm or refund.'});
    } catch(e) {
      console.error('[boost2] admin order resolution failed:',e.name);
      res.status(500).json({error:'Could not resolve this Boost 2 order.'});
    }
  });
};
