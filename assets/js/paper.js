/* ============================================================
 * paper.js —— 模拟交易（纸上交易）
 *
 * 账户完全存在 localStorage，刷新不丢。撮合按「当前价 + 滑点 + 手续费」
 * 立即成交，属于最简化模型；后续可以接后端做真正的挂单撮合。
 * ============================================================ */

window.QL = window.QL || {};

QL.paper = (function () {
  const U = QL.utils;
  const CFG = QL.CONFIG;
  const $ = U.$;

  const FEE_BPS = 5;        // 手续费 0.05%
  const SLIP_BPS = 3;       // 滑点 0.03%

  let acc = null;
  const priceMap = {};      // symbol -> 最新价

  /* ---------------- 账户读写 ---------------- */

  function emptyAccount() {
    return {
      initial: CFG.initialCapital,
      cash: CFG.initialCapital,
      positions: {},          // symbol -> { qty, avgCost }
      orders: []              // { time, symbol, side, price, qty, amount }
    };
  }

  function load() {
    acc = U.store.get(CFG.storeKeys.account, null) || emptyAccount();
    if (!acc.positions) acc.positions = {};
    if (!acc.orders) acc.orders = [];
  }

  function save() { U.store.set(CFG.storeKeys.account, acc); }

  /* ---------------- 估值 ---------------- */

  function marketValue() {
    let mv = 0;
    Object.keys(acc.positions).forEach(sym => {
      const p = acc.positions[sym];
      const px = priceMap[sym] != null ? priceMap[sym] : p.avgCost;
      mv += p.qty * px;
    });
    return mv;
  }

  /** 拉取持仓标的的最新价，保证市值不是用成本价凑数 */
  async function refreshPrices() {
    const syms = Object.keys(acc.positions);
    await Promise.all(syms.map(async sym => {
      if (priceMap[sym] != null) return;
      try {
        const q = await QL.data.getQuote(sym);
        priceMap[sym] = q.last;
      } catch (e) { /* 忽略单个失败 */ }
    }));
    render();
  }

  /* ---------------- 下单 ---------------- */

  function msg(text, cls) {
    const el = $('#ordMsg');
    el.textContent = text;
    el.className = 'order-msg ' + (cls || '');
  }

  function currentPrice() {
    const q = QL.state.quote;
    return q ? q.last : null;
  }

  function buy(qty) {
    const sym = QL.state.symbol;
    const px0 = currentPrice();
    if (!sym || !px0) return msg('暂无价格，稍后再试', 'err');
    qty = Math.floor(qty);
    if (!qty || qty <= 0) return msg('数量必须为正整数', 'err');

    const px = px0 * (1 + SLIP_BPS / 10000);
    const amount = px * qty;
    const fee = amount * FEE_BPS / 10000;
    if (amount + fee > acc.cash) {
      return msg('现金不足：需要 ' + U.fmtMoney(amount + fee) + '，可用 ' + U.fmtMoney(acc.cash), 'err');
    }

    acc.cash -= amount + fee;
    const p = acc.positions[sym] || { qty: 0, avgCost: 0 };
    p.avgCost = (p.avgCost * p.qty + amount + fee) / (p.qty + qty);
    p.qty += qty;
    acc.positions[sym] = p;
    priceMap[sym] = px0;

    acc.orders.unshift({
      time: U.fmtDate(new Date()) + ' ' + U.fmtTime(new Date()),
      symbol: sym, side: 'BUY', price: px, qty, amount: amount + fee
    });
    save(); render();
    msg('买入成交：' + qty + ' 股 @ ' + U.fmtPrice(px) + '（含费 ' + U.fmtMoney(fee) + '）', 'ok');
  }

  function sell(qty) {
    const sym = QL.state.symbol;
    const px0 = currentPrice();
    if (!sym || !px0) return msg('暂无价格，稍后再试', 'err');
    qty = Math.floor(qty);
    const p = acc.positions[sym];
    if (!p || p.qty <= 0) return msg('没有 ' + sym + ' 的持仓', 'err');
    if (qty > p.qty) return msg('持仓不足：最多可卖 ' + p.qty + ' 股', 'err');

    const px = px0 * (1 - SLIP_BPS / 10000);
    const amount = px * qty;
    const fee = amount * FEE_BPS / 10000;
    const realized = (px - p.avgCost) * qty - fee;

    acc.cash += amount - fee;
    p.qty -= qty;
    if (p.qty === 0) delete acc.positions[sym];
    priceMap[sym] = px0;

    acc.orders.unshift({
      time: U.fmtDate(new Date()) + ' ' + U.fmtTime(new Date()),
      symbol: sym, side: 'SELL', price: px, qty, amount: amount - fee
    });
    save(); render();
    msg('卖出成交：' + qty + ' 股 @ ' + U.fmtPrice(px) + '，本笔实现盈亏 ' +
        U.fmtMoney(realized), realized >= 0 ? 'ok' : 'err');
  }

  /* ---------------- 渲染 ---------------- */

  function render() {
    const mv = marketValue();
    const total = acc.cash + mv;
    const pnl = total - acc.initial;
    const pnlPct = acc.initial ? pnl / acc.initial : 0;

    $('#accTotal').textContent  = U.fmtMoney(total);
    $('#accCash').textContent   = U.fmtMoney(acc.cash);
    $('#accMarket').textContent = U.fmtMoney(mv);
    const pnlEl = $('#accPnl');
    pnlEl.textContent = U.fmtMoney(pnl) + '  ' + U.fmtPct(pnlPct);
    pnlEl.className = U.dirClass(pnl);

    // 持仓
    const syms = Object.keys(acc.positions);
    const tbody = $('#posTable tbody');
    if (!syms.length) {
      tbody.innerHTML = '<tr><td colspan="6" class="muted">暂无持仓</td></tr>';
    } else {
      tbody.innerHTML = syms.map(sym => {
        const p = acc.positions[sym];
        const px = priceMap[sym] != null ? priceMap[sym] : p.avgCost;
        const val = p.qty * px;
        const upl = (px - p.avgCost) * p.qty;
        const uplPct = p.avgCost ? (px / p.avgCost - 1) : 0;
        const cls = U.dirClass(upl);
        return '<tr data-sym="' + sym + '">' +
          '<td><b>' + sym + '</b></td>' +
          '<td class="num">' + p.qty + '</td>' +
          '<td class="num">' + U.fmtPrice(p.avgCost) + '</td>' +
          '<td class="num">' + U.fmtPrice(px) + '</td>' +
          '<td class="num">' + U.fmtMoney(val) + '</td>' +
          '<td class="num ' + cls + '">' + U.fmtMoney(upl) + ' (' + U.fmtPct(uplPct) + ')</td>' +
        '</tr>';
      }).join('');
      U.$$('#posTable tbody tr').forEach(tr => {
        tr.style.cursor = 'pointer';
        tr.addEventListener('click', () => QL.app.setSymbol(tr.dataset.sym));
      });
    }

    // 流水
    const ob = $('#orderTable tbody');
    if (!acc.orders.length) {
      ob.innerHTML = '<tr><td colspan="6" class="muted">暂无记录</td></tr>';
    } else {
      ob.innerHTML = acc.orders.slice(0, 100).map(o =>
        '<tr>' +
          '<td>' + o.time + '</td>' +
          '<td><b>' + o.symbol + '</b></td>' +
          '<td class="' + (o.side === 'BUY' ? 'up' : 'down') + '">' + (o.side === 'BUY' ? '买入' : '卖出') + '</td>' +
          '<td class="num">' + U.fmtPrice(o.price) + '</td>' +
          '<td class="num">' + o.qty + '</td>' +
          '<td class="num">' + U.fmtMoney(o.amount) + '</td>' +
        '</tr>'
      ).join('');
    }

    // 下单面板
    $('#ordSymbol').value = QL.state.symbol || '';
    const px = currentPrice();
    $('#ordPrice').value = px ? U.fmtPrice(px) : '—';
  }

  function reset() {
    if (!confirm('确定重置模拟账户？所有持仓和流水会被清空。')) return;
    acc = emptyAccount();
    save();
    render();
    msg('账户已重置为 ' + U.fmtMoney(CFG.initialCapital), 'ok');
  }

  /* ---------------- 初始化 ---------------- */

  function init() {
    load();

    $('#btnBuy').addEventListener('click', () => buy(parseFloat($('#ordQty').value)));
    $('#btnSell').addEventListener('click', () => sell(parseFloat($('#ordQty').value)));
    $('#btnResetAccount').addEventListener('click', reset);

    U.$$('.qty-quick .btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const pct = parseFloat(btn.dataset.pct);
        const px = currentPrice();
        if (!px) return;
        const qty = Math.floor((acc.cash * pct) / (px * 1.001));
        $('#ordQty').value = Math.max(1, qty);
      });
    });

    U.bus.on('symbol:loaded', () => { refreshPrices(); render(); });
    U.bus.on('quote:tick', q => {
      priceMap[q.symbol] = q.last;
      if (QL.app.currentView() === 'paper') render();
    });

    render();
    refreshPrices();
  }

  return { init, render, buy, sell, getAccount: () => acc };
})();
