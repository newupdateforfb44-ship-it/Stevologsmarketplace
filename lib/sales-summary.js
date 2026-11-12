/**
 * Admin "Sales & Profit" summary.
 *
 *   GET /api/admin/sales-summary?range=today|7d|30d|90d|all|custom&from=YYYY-MM-DD&to=YYYY-MM-DD
 *
 * Super-admin only (adminAuth) because it exposes provider cost and profit.
 * Read-only: it never writes to the database.
 *
 * Everything is in NGN. Days are bucketed in Nigerian time (WAT, UTC+1).
 *
 * Sources covered
 *   - Logs & Tools (own stock)        → Transaction (type purchase, description "Purchased…")
 *                                       NOTE: no cost price is stored for own stock, so cost = 0.
 *   - Buy Numbers — Server 1 / 2      → NumberListing (sellPrice vs cost)
 *   - Buy Number 2 (OTP Suite)        → OtpSuiteOrder (price vs providerCost)
 *   - Boost                           → BoostOrder (price vs cost)
 *   - Boost 2                         → NovaBoost2Order (sellTotal vs cost)
 *   - Marketplace 2 / 3 / 4           → Market2/3/4Order (sellTotal vs costTotal)
 *
 * Each order lands in exactly one outcome:
 *   sold      → counted in revenue / provider cost / profit
 *   refunded  → money went back to the customer (shown separately, not profit)
 *   pending   → still processing / needs review (shown separately, not profit)
 * "Loss" = fulfilled orders that were sold for less than their provider cost.
 */
module.exports.register = function register(app, { mongoose, adminAuth }) {
  const WAT_MS = 60 * 60 * 1000; // Nigeria = UTC+1, no DST
  const r2 = n => Math.round((Number(n) || 0) * 100) / 100;
  const num = n => (Number.isFinite(Number(n)) ? Number(n) : 0);
  const model = name => mongoose.models[name] || null;

  // ── date range ─────────────────────────────────────────────────────────
  function startOfWatDay(ts) {
    return new Date(Math.floor((ts + WAT_MS) / 86400000) * 86400000 - WAT_MS);
  }
  function parseRange(q) {
    const range = String(q.range || '30d');
    const now = Date.now();
    const tomorrow = new Date(startOfWatDay(now).getTime() + 86400000);
    if (range === 'all') return { range, from: null, to: null, label: 'All time' };
    if (range === 'month' || range === 'lastmonth') {
      const w = new Date(now + WAT_MS);
      const y = w.getUTCFullYear(), mo = w.getUTCMonth() + (range === 'lastmonth' ? -1 : 0);
      const from = new Date(Date.UTC(y, mo, 1) - WAT_MS);
      const to = new Date(Date.UTC(y, mo + 1, 1) - WAT_MS);
      const name = new Date(Date.UTC(y, mo, 1)).toLocaleString('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' });
      return { range, from, to, label: (range === 'month' ? 'This month' : 'Last month') + ' (' + name + ')' };
    }
    if (range === 'today') return { range, from: startOfWatDay(now), to: tomorrow, label: 'Today' };
    const m = /^(\d{1,3})d$/.exec(range);
    if (m) {
      const days = Math.min(365, Math.max(1, Number(m[1])));
      return { range, from: new Date(tomorrow.getTime() - days * 86400000), to: tomorrow, label: `Last ${days} days` };
    }
    if (range === 'custom') {
      const ok = s => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));
      if (!ok(q.from) || !ok(q.to)) return { error: 'Pick a valid start and end date.' };
      const from = new Date(Date.parse(q.from + 'T00:00:00Z') - WAT_MS);
      const to = new Date(Date.parse(q.to + 'T00:00:00Z') + 86400000 - WAT_MS); // end date inclusive
      if (!(from < to)) return { error: 'The end date must be on or after the start date.' };
      if (to - from > 366 * 86400000) return { error: 'Please choose a range of one year or less.' };
      return { range, from, to, label: `${q.from} to ${q.to}` };
    }
    return { error: 'Unknown range.' };
  }
  const dateQuery = (field, r) => {
    if (!r.from) return {};
    return { [field]: { $gte: r.from, $lt: r.to } };
  };

  // ── accumulator ────────────────────────────────────────────────────────
  function makeCollector() {
    const sources = new Map();
    const daily = new Map();
    const top = new Map();
    const errors = [];

    function src(key, label, costTracked) {
      if (!sources.has(key)) {
        sources.set(key, {
          key, label, costTracked,
          orders: 0, revenue: 0, cost: 0, profit: 0,
          refundedCount: 0, refundedAmount: 0,
          pendingCount: 0, pendingAmount: 0,
          lossOrders: 0, lossAmount: 0,
        });
      }
      return sources.get(key);
    }

    /** outcome: 'sold' | 'refunded' | 'pending' */
    function add(key, label, costTracked, { outcome, date, item, revenue = 0, cost = 0 }) {
      const s = src(key, label, costTracked);
      revenue = num(revenue); cost = num(cost);
      if (outcome === 'refunded') { s.refundedCount++; s.refundedAmount += revenue; return; }
      if (outcome === 'pending') { s.pendingCount++; s.pendingAmount += revenue; return; }
      const profit = revenue - cost;
      s.orders++; s.revenue += revenue; s.cost += cost; s.profit += profit;
      if (profit < 0) { s.lossOrders++; s.lossAmount += -profit; }

      if (date) {
        const day = new Date(new Date(date).getTime() + WAT_MS).toISOString().slice(0, 10);
        const d = daily.get(day) || { date: day, orders: 0, revenue: 0, cost: 0, profit: 0 };
        d.orders++; d.revenue += revenue; d.cost += cost; d.profit += profit;
        daily.set(day, d);
      }
      const name = String(item || 'Unknown').slice(0, 80);
      const tk = key + '|' + name;
      const t = top.get(tk) || { source: label, item: name, orders: 0, revenue: 0, profit: 0 };
      t.orders++; t.revenue += revenue; t.profit += profit;
      top.set(tk, t);
    }

    function finish() {
      const srcList = [...sources.values()].map(s => ({
        ...s,
        revenue: r2(s.revenue), cost: r2(s.cost), profit: r2(s.profit),
        refundedAmount: r2(s.refundedAmount), pendingAmount: r2(s.pendingAmount), lossAmount: r2(s.lossAmount),
        marginPct: s.revenue > 0 ? r2((s.profit / s.revenue) * 100) : 0,
      })).sort((a, b) => b.revenue - a.revenue);

      const sum = (list, k) => list.reduce((a, s) => a + s[k], 0);
      const tracked = srcList.filter(s => s.costTracked);
      const own = srcList.filter(s => !s.costTracked);
      const revenue = sum(srcList, 'revenue');
      const orders = sum(srcList, 'orders');
      const profit = sum(srcList, 'profit');
      const trackedRevenue = sum(tracked, 'revenue');
      const trackedProfit = sum(tracked, 'profit');

      const totals = {
        orders,
        revenue: r2(revenue),
        providerCost: r2(sum(srcList, 'cost')),
        profit: r2(profit),
        marginPct: revenue > 0 ? r2((profit / revenue) * 100) : 0,
        avgOrderValue: orders > 0 ? r2(revenue / orders) : 0,
        refundedCount: sum(srcList, 'refundedCount'),
        refundedAmount: r2(sum(srcList, 'refundedAmount')),
        pendingCount: sum(srcList, 'pendingCount'),
        pendingAmount: r2(sum(srcList, 'pendingAmount')),
        lossOrders: sum(srcList, 'lossOrders'),
        lossAmount: r2(sum(srcList, 'lossAmount')),
        // Provider-backed products only (cost is real, so the margin is meaningful)
        provider: {
          orders: sum(tracked, 'orders'),
          revenue: r2(trackedRevenue),
          cost: r2(sum(tracked, 'cost')),
          profit: r2(trackedProfit),
          marginPct: trackedRevenue > 0 ? r2((trackedProfit / trackedRevenue) * 100) : 0,
        },
        // Own stock (logs & tools): no cost stored, revenue is counted as full profit above
        ownStock: { orders: sum(own, 'orders'), revenue: r2(sum(own, 'revenue')) },
      };

      const dailyList = [...daily.values()]
        .map(d => ({ ...d, revenue: r2(d.revenue), cost: r2(d.cost), profit: r2(d.profit) }))
        .sort((a, b) => (a.date < b.date ? -1 : 1));
      const topList = [...top.values()]
        .map(t => ({ ...t, revenue: r2(t.revenue), profit: r2(t.profit) }))
        .sort((a, b) => b.revenue - a.revenue)
        .slice(0, 10);
      return { totals, sources: srcList, daily: dailyList, top: topList, errors };
    }

    return { add, finish, errors };
  }

  // Run one source; a failure in one never breaks the whole report.
  async function guard(c, label, fn) {
    try { await fn(); } catch (e) { c.errors.push(`${label}: ${e.message || 'failed'}`); }
  }
  async function each(Model, query, select, fn) {
    const cursor = Model.find(query).select(select).lean().cursor();
    for await (const doc of cursor) fn(doc);
  }

  // ── sources ────────────────────────────────────────────────────────────
  async function ownLogs(c, r) {
    const Transaction = model('Transaction');
    if (!Transaction) return;
    const q = { type: 'purchase', status: 'success', description: /^Purchased/, ...dateQuery('createdAt', r) };
    await each(Transaction, q, 'amount description createdAt', t => {
      const item = String(t.description || '')
        .replace(/^Purchased(?: \d+ accounts)?(?: via API)?(?: from)?:?\s*/, '')
        .split(' — ')[0] || 'Log / tool';
      c.add('logs', 'Logs & Tools (own stock)', false, { outcome: 'sold', date: t.createdAt, item, revenue: t.amount, cost: 0 });
    });
  }

  async function numbers(c, r) {
    const NumberListing = model('NumberListing');
    if (!NumberListing) return;
    const q = { soldTo: { $ne: null }, ...dateQuery('soldAt', r) };
    await each(NumberListing, q, 'provider country sellPrice cost status server soldAt', l => {
      const s2 = l.server === 'server2';
      const key = s2 ? 'numbers2' : 'numbers1';
      const label = s2 ? 'Buy Numbers — Server 2' : 'Buy Numbers — Server 1';
      const item = `${l.provider || 'Number'} · ${l.country || ''}`.trim();
      if (l.status === 'sold' || l.status === 'delivered') {
        c.add(key, label, true, { outcome: 'sold', date: l.soldAt, item, revenue: l.sellPrice, cost: l.cost });
      } else if (l.status === 'expired' || l.status === 'cancelled') {
        c.add(key, label, true, { outcome: 'refunded', revenue: l.sellPrice });
      } else if (l.status === 'needs_review') {
        c.add(key, label, true, { outcome: 'pending', revenue: l.sellPrice });
      }
    });
  }

  async function otpSuite(c, r) {
    const Order = model('OtpSuiteOrder');
    if (!Order) return;
    const key = 'otp2', label = 'Buy Number 2 (OTP Suite)';
    await each(Order, dateQuery('createdAt', r), 'serviceName countryName price providerCost status refunded debited createdAt', o => {
      if (o.debited === false) return; // never charged
      const st = String(o.status || '').toLowerCase();
      const item = `${o.serviceName || 'Number'} · ${o.countryName || ''}`.trim();
      if (o.refunded || ['failed', 'refunded', 'cancelled', 'canceled', 'expired'].includes(st)) {
        c.add(key, label, true, { outcome: 'refunded', revenue: o.price });
      } else if (['pending', 'review'].includes(st)) {
        c.add(key, label, true, { outcome: 'pending', revenue: o.price });
      } else {
        c.add(key, label, true, { outcome: 'sold', date: o.createdAt, item, revenue: o.price, cost: o.providerCost });
      }
    });
  }

  async function boost1(c, r) {
    const BoostOrder = model('BoostOrder');
    if (!BoostOrder) return;
    const key = 'boost1', label = 'Boost';
    await each(BoostOrder, dateQuery('createdAt', r), 'serviceName price cost bucket refunded refundAmount createdAt', o => {
      const price = num(o.price);
      const refAmt = num(o.refundAmount) > 0 ? num(o.refundAmount) : (o.refunded ? price : 0);
      const item = o.serviceName || 'Boost order';
      if (o.bucket === 'failed' || (price > 0 && refAmt >= price - 0.01)) {
        c.add(key, label, true, { outcome: 'refunded', revenue: refAmt || price });
      } else if (o.bucket === 'pending') {
        c.add(key, label, true, { outcome: 'pending', revenue: price });
      } else {
        // delivered (a partial refund keeps only the delivered share of price and cost)
        const keep = price > 0 ? (price - refAmt) / price : 1;
        c.add(key, label, true, { outcome: 'sold', date: o.createdAt, item, revenue: price - refAmt, cost: num(o.cost) * keep });
      }
    });
  }

  async function boost2(c, r) {
    const Order = model('NovaBoost2Order');
    if (!Order) return;
    const key = 'boost2', label = 'Boost 2';
    await each(Order, dateQuery('createdAt', r), 'itemName sellTotal cost status createdAt', o => {
      const st = String(o.status || '').toLowerCase();
      const item = o.itemName || 'Boost 2 order';
      if (['completed', 'complete', 'delivered', 'success'].includes(st)) {
        c.add(key, label, true, { outcome: 'sold', date: o.createdAt, item, revenue: o.sellTotal, cost: o.cost });
      } else if (['failed', 'refunded', 'cancelled', 'canceled', 'error', 'rejected'].includes(st)) {
        c.add(key, label, true, { outcome: 'refunded', revenue: o.sellTotal });
      } else {
        c.add(key, label, true, { outcome: 'pending', revenue: o.sellTotal });
      }
    });
  }

  async function market(c, r, modelName, key, label) {
    const Order = model(modelName);
    if (!Order) return;
    await each(Order, dateQuery('createdAt', r), 'title productName sellTotal costTotal status createdAt', o => {
      const st = String(o.status || '').toLowerCase();
      const item = o.title || o.productName || 'Product';
      if (st === 'delivered' || st === 'partial') {
        c.add(key, label, true, { outcome: 'sold', date: o.createdAt, item, revenue: o.sellTotal, cost: o.costTotal });
      } else if (st === 'refunded') {
        c.add(key, label, true, { outcome: 'refunded', revenue: o.sellTotal });
      } else if (st === 'pending' || st === 'review') {
        c.add(key, label, true, { outcome: 'pending', revenue: o.sellTotal });
      }
      // 'failed' = never charged / auto-refunded before delivery, so it is ignored.
    });
  }

  // ── route ──────────────────────────────────────────────────────────────
  app.get('/api/admin/sales-summary', adminAuth, async (req, res) => {
    try {
      const r = parseRange(req.query || {});
      if (r.error) return res.status(400).json({ error: r.error });
      const c = makeCollector();
      await Promise.all([
        guard(c, 'Logs & Tools', () => ownLogs(c, r)),
        guard(c, 'Buy Numbers', () => numbers(c, r)),
        guard(c, 'Buy Number 2', () => otpSuite(c, r)),
        guard(c, 'Boost', () => boost1(c, r)),
        guard(c, 'Boost 2', () => boost2(c, r)),
        guard(c, 'Marketplace 2', () => market(c, r, 'Market2Order', 'market2', 'Marketplace 2')),
        guard(c, 'Marketplace 3', () => market(c, r, 'Market3Order', 'market3', 'Marketplace 3')),
        guard(c, 'Marketplace 4', () => market(c, r, 'Market4Order', 'market4', 'Marketplace 4')),
      ]);
      res.json({
        range: { key: r.range, label: r.label, from: r.from, to: r.to },
        generatedAt: new Date(),
        ...c.finish(),
      });
    } catch (e) {
      res.status(500).json({ error: e.message || 'Could not build the sales summary' });
    }
  });
};
