/* ============================================================
 * market.js —— 行情视图：报价头、K 线、指标快照、成交明细、自选列表
 * ============================================================ */

window.QL = window.QL || {};

QL.market = (function () {
  const U = QL.utils;
  const IND = QL.ind;
  const CFG = QL.CONFIG;
  const $ = U.$;

  let chart = null;
  let range = 120;                 // 以交易日计，跟 K 线周期无关
  let interval = 'day';            // day | week | month
  const mas = { 5: true, 20: true, 60: true, boll: false };
  let sub = 'vol';

  // 一根 K 线约等于多少个交易日，用来把 3M/6M/1Y 换算成 K 线根数
  const DAYS_PER_BAR = { day: 1, week: 5, month: 21 };
  const INTERVAL_LABEL = { day: '日线', week: '周线', month: '月线' };
  const PERIODS_PER_YEAR = { day: 252, week: 52, month: 12 };
  let watch = [];
  const wlQuotes = {};          // symbol -> {last, changePct}

  /* ---------------- 自选列表 ---------------- */

  function loadWatchlist() {
    watch = U.store.get(CFG.storeKeys.watchlist, null) || CFG.defaultWatchlist.slice();
    renderWatchlist();
    // 后台把每个自选的最新价拉出来，侧栏才不是一排横杠
    watch.forEach(sym => refreshWatchQuote(sym));
  }

  function saveWatchlist() { U.store.set(CFG.storeKeys.watchlist, watch); }

  async function refreshWatchQuote(sym) {
    try {
      const q = await QL.data.getQuote(sym);
      wlQuotes[sym] = { last: q.last, changePct: q.changePct, name: q.name };
      renderWatchlist();
    } catch (e) { /* 单个失败不影响整体 */ }
  }

  function renderWatchlist() {
    const ul = $('#watchlist');
    ul.innerHTML = '';

    if (!watch.length) {
      ul.innerHTML = '<li class="wl-empty muted">自选列表是空的<br>搜索标的后点 + 加入</li>';
      $('#watchCount').textContent = 0;
      syncStar();
      return;
    }

    watch.forEach(sym => {
      const q = wlQuotes[sym];
      const li = U.el('li');
      if (sym === QL.state.symbol) li.className = 'active';
      const chgCls = q ? U.dirClass(q.changePct) : 'flat';
      li.innerHTML =
        '<div class="wl-left">' +
          '<span class="wl-sym">' + sym + '</span>' +
          '<span class="wl-name">' + (q && q.name ? q.name : '') + '</span>' +
        '</div>' +
        '<div class="wl-right">' +
          '<div class="' + chgCls + '">' + (q ? U.fmtPrice(q.last) : '—') + '</div>' +
          '<div class="wl-chg ' + chgCls + '">' + (q ? U.fmtPct(q.changePct) : '') + '</div>' +
        '</div>' +
        '<button class="wl-del" title="移出自选">×</button>';

      li.addEventListener('click', () => QL.app.setSymbol(sym));
      li.querySelector('.wl-del').addEventListener('click', e => {
        e.stopPropagation();                 // 别让点删除顺带切了标的
        removeFromWatchlist(sym);
      });
      ul.appendChild(li);
    });

    $('#watchCount').textContent = watch.length;
    syncStar();
  }

  /* ---------------- 自选增删 ---------------- */

  function isWatched(sym) { return watch.indexOf(sym) >= 0; }

  /** @returns {boolean} true 表示这次调用真的加进去了 */
  function addToWatchlist(sym) {
    if (!sym || isWatched(sym)) return false;
    watch.unshift(sym);
    saveWatchlist();
    renderWatchlist();
    refreshWatchQuote(sym);
    return true;
  }

  function removeFromWatchlist(sym) {
    const i = watch.indexOf(sym);
    if (i < 0) return false;
    watch.splice(i, 1);
    saveWatchlist();
    renderWatchlist();
    return true;
  }

  /** 加入则移出、未加入则加入，返回加入后的状态 */
  function toggleWatch(sym) {
    if (!sym) return false;
    if (isWatched(sym)) { removeFromWatchlist(sym); return false; }
    addToWatchlist(sym);
    return true;
  }

  function resetWatchlist() {
    watch = CFG.defaultWatchlist.slice();
    saveWatchlist();
    renderWatchlist();
    watch.forEach(sym => refreshWatchQuote(sym));
  }

  /** 报价头的星标 + 侧栏按钮跟随当前标的的自选状态 */
  function syncStar() {
    const sym = QL.state.symbol;
    const on = !!sym && isWatched(sym);

    const star = $('#btnStar');
    if (star) {
      star.textContent = on ? '★' : '☆';
      star.classList.toggle('on', on);
      star.title = on ? '移出自选' : '加入自选';
    }
    const btn = $('#btnAddWatch');
    if (btn) btn.textContent = on ? '✓ 已在自选' : '+ 加入自选';
  }

  /* ---------------- 报价头 ---------------- */

  function renderQuoteHead(q) {
    $('#qSymbol').textContent   = q.symbol;
    $('#qName').textContent     = q.name || '';
    $('#qExchange').textContent = q.exchange || 'US';

    const lastEl = $('#qLast');
    const chgEl  = $('#qChange');
    const cls = U.dirClass(q.change);
    lastEl.textContent = U.fmtPrice(q.last);
    lastEl.className = 'last ' + cls;
    chgEl.textContent = (q.change >= 0 ? '+' : '') + U.fmtPrice(q.change) + '  ' + U.fmtPct(q.changePct);
    chgEl.className = 'change ' + cls;

    $('#qOpen').textContent = U.fmtPrice(q.open);
    $('#qHigh').textContent = U.fmtPrice(q.high);
    $('#qLow').textContent  = U.fmtPrice(q.low);
    $('#qPrev').textContent = U.fmtPrice(q.prevClose);
    $('#qVol').textContent  = U.fmtVol(q.volume);
    $('#qAmp').textContent  = q.prevClose ? ((q.high - q.low) / q.prevClose * 100).toFixed(2) + '%' : '—';

    // 明确标出数据源和最后一根 K 线的日期。
    // 之前有人对着模拟价格问"为什么和现实对不上"，
    // 光靠右上角那个小徽章不够，这里再标一次。
    const asOf = $('#qAsOf');
    if (asOf) {
      const hist = QL.state.history;
      const lastDate = (hist && hist.bars.length) ? hist.bars[hist.bars.length - 1].date : '—';
      const live = QL.data.mode === 'live';
      asOf.textContent = lastDate + (live ? '' : ' 模拟');
      asOf.className = live ? '' : 'warn-text';
      asOf.title = live ? '来自后端真实行情' : '模拟数据，与真实价格无关';
    }
  }

  /* ---------------- 指标快照 ---------------- */

  /**
   * 指标快照跟随所选周期：切到周K，MA20 就是 20 周均线。
   * 用完整重采样序列（不受 3M/6M 显示区间裁剪影响），否则窗口不够 MA60 算不出来。
   */
  function renderSnapshot() {
    const daily = QL.state.history ? QL.state.history.bars : [];
    if (!daily.length) return;
    const bars = IND.resample(daily, interval);

    const titleEl = $('#snapshotTitle');
    if (titleEl) titleEl.textContent = '技术指标快照（' + INTERVAL_LABEL[interval] + '）';

    const closes = bars.map(b => b.close);
    const i = bars.length - 1;
    const last = closes[i];

    const ma5  = IND.sma(closes, 5)[i];
    const ma20 = IND.sma(closes, 20)[i];
    const ma60 = IND.sma(closes, 60)[i];
    const r    = IND.rsi(closes, 14)[i];
    const m    = IND.macd(closes);
    const bb   = IND.boll(closes, 20, 2);
    const a    = IND.atr(bars, 14)[i];

    // 一年 = 252 根日线 / 52 根周线 / 12 根月线；
    // 年化波动率的换算因子也要跟着周期变，否则周线会被高估约 √5 倍
    const perYear = PERIODS_PER_YEAR[interval];
    const rets = IND.returns(closes.slice(-perYear));
    const vol  = IND.annualVol(rets, perYear);

    const win = bars.slice(-perYear);
    const hi52 = Math.max.apply(null, win.map(b => b.high));
    const lo52 = Math.min.apply(null, win.map(b => b.low));

    const items = [
      ['MA5',  U.fmtPrice(ma5),  ma5  ? U.dirClass(last - ma5)  : ''],
      ['MA20', U.fmtPrice(ma20), ma20 ? U.dirClass(last - ma20) : ''],
      ['MA60', U.fmtPrice(ma60), ma60 ? U.dirClass(last - ma60) : ''],
      ['RSI(14)', r == null ? '—' : r.toFixed(1), r == null ? '' : (r > 70 ? 'down' : r < 30 ? 'up' : '')],
      ['MACD 柱', m.hist[i] == null ? '—' : m.hist[i].toFixed(3), m.hist[i] == null ? '' : U.dirClass(m.hist[i])],
      ['布林 %B', bb.pctB[i] == null ? '—' : (bb.pctB[i] * 100).toFixed(1) + '%', ''],
      ['ATR(14)', a == null ? '—' : a.toFixed(2), ''],
      ['ATR 占比', a == null ? '—' : (a / last * 100).toFixed(2) + '%', ''],
      ['年化波动', (vol * 100).toFixed(1) + '%', ''],
      ['52周最高', U.fmtPrice(hi52), ''],
      ['52周最低', U.fmtPrice(lo52), ''],
      ['距52周高', ((last / hi52 - 1) * 100).toFixed(1) + '%', U.dirClass(last / hi52 - 1)]
    ];

    $('#indicatorSnapshot').innerHTML = items.map(it =>
      '<div><label>' + it[0] + '</label><span class="' + it[2] + '">' + it[1] + '</span></div>'
    ).join('');
  }

  /* ---------------- 逐笔成交（模拟） ---------------- */

  const tape = [];

  function pushTape(q) {
    const side = Math.random() < 0.5 ? 'B' : 'S';
    const jitter = (Math.random() - 0.5) * Math.max(0.01, q.last * 0.0004);
    tape.unshift({
      time: U.fmtTime(new Date()),
      price: q.last + jitter,
      qty: Math.round((Math.random() * 900 + 100) / 10) * 10,
      side
    });
    if (tape.length > 40) tape.pop();

    const tbody = $('#tapeTable tbody');
    tbody.innerHTML = tape.map(t =>
      '<tr>' +
        '<td>' + t.time + '</td>' +
        '<td class="num ' + (t.side === 'B' ? 'up' : 'down') + '">' + U.fmtPrice(t.price) + '</td>' +
        '<td class="num">' + t.qty + '</td>' +
        '<td class="' + (t.side === 'B' ? 'up' : 'down') + '">' + (t.side === 'B' ? '买' : '卖') + '</td>' +
      '</tr>'
    ).join('');
  }

  function clearTape() {
    tape.length = 0;
    const tbody = $('#tapeTable tbody');
    if (tbody) tbody.innerHTML = '';
  }

  /* ---------------- K 线渲染 ---------------- */

  /** 当前周期下用于绘图与指标的 K 线序列 */
  function activeBars() {
    const daily = QL.state.history ? QL.state.history.bars : [];
    if (!daily.length) return [];
    const bars = IND.resample(daily, interval);
    if (range <= 0) return bars;
    // 3M 的周线只有 13 根，是对的；但别少到画不出东西
    const n = Math.max(6, Math.ceil(range / DAYS_PER_BAR[interval]));
    return bars.slice(-n);
  }

  function renderChart() {
    chart.setBars(activeBars());
  }

  /* ---------------- 事件绑定 ---------------- */

  function bindToolbar() {
    U.$$('#intervalGroup .btn').forEach(btn => {
      btn.addEventListener('click', () => {
        U.$$('#intervalGroup .btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        interval = btn.dataset.interval;
        renderChart();
        renderSnapshot();          // 指标要跟着周期重算
      });
    });

    U.$$('#rangeGroup .btn').forEach(btn => {
      btn.addEventListener('click', () => {
        U.$$('#rangeGroup .btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        range = parseInt(btn.dataset.range, 10);
        renderChart();
      });
    });

    U.$$('#maGroup .btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const key = btn.dataset.ma;
        const k = key === 'boll' ? 'boll' : parseInt(key, 10);
        mas[k] = !mas[k];
        btn.classList.toggle('active', !!mas[k]);
        chart.setMA(mas);
      });
    });

    U.$$('#subGroup .btn').forEach(btn => {
      btn.addEventListener('click', () => {
        U.$$('#subGroup .btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        sub = btn.dataset.sub;
        chart.setSub(sub);
      });
    });

    $('#btnAddWatch').addEventListener('click', () => {
      const sym = QL.state.symbol;
      const on = toggleWatch(sym);
      QL.app.toast(on ? sym + ' 已加入自选' : sym + ' 已移出自选');
    });

    $('#btnStar').addEventListener('click', () => {
      const sym = QL.state.symbol;
      const on = toggleWatch(sym);
      QL.app.toast(on ? sym + ' 已加入自选' : sym + ' 已移出自选');
    });

    $('#btnResetWatch').addEventListener('click', () => {
      if (!confirm('恢复默认自选列表？当前的自选会被覆盖。')) return;
      resetWatchlist();
      QL.app.toast('自选列表已重置');
    });
  }

  /* ---------------- 生命周期 ---------------- */

  function init() {
    chart = new QL.chart.CandleChart($('#mainChart'), $('#chartTip'));
    bindToolbar();
    loadWatchlist();

    U.bus.on('symbol:loaded', () => {
      clearTape();
      renderChart();
      renderSnapshot();
      renderQuoteHead(QL.state.quote);
      renderWatchlist();
      if (!wlQuotes[QL.state.symbol]) refreshWatchQuote(QL.state.symbol);
    });

    U.bus.on('quote:tick', q => {
      renderQuoteHead(q);
      pushTape(q);
      wlQuotes[q.symbol] = { last: q.last, changePct: q.changePct, name: q.name };
      renderWatchlist();
      if (QL.app.currentView() === 'market') renderChart();
    });

    U.bus.on('data:mode', () => {
      Object.keys(wlQuotes).forEach(k => delete wlQuotes[k]);
      watch.forEach(sym => refreshWatchQuote(sym));
    });
  }

  return {
    init, renderChart,
    addToWatchlist, removeFromWatchlist, toggleWatch, isWatched, resetWatchlist
  };
})();
