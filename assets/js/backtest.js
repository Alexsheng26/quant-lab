/* ============================================================
 * backtest.js —— 事件驱动回测引擎 + 回测视图
 *
 * 防未来函数（look-ahead bias）的做法：
 *   signals[i] 表示「第 i 根 K 线收盘后想持有的仓位」，
 *   实际成交发生在第 i+1 根的开盘价，并扣手续费与滑点。
 *   任何策略都拿不到 i 之后的数据。
 * ============================================================ */

window.QL = window.QL || {};

QL.backtest = (function () {
  const U = QL.utils;
  const IND = QL.ind;
  const $ = U.$;

  /* ============================================================
   * 策略库：signal(bars, params) -> [0|1]，1 表示满仓多头
   * ========================================================== */
  const STRATEGIES = {
    ma_cross: {
      name: '双均线交叉',
      params: [
        { key: 'fast', label: '快线', def: 20, min: 2, win: true },
        { key: 'slow', label: '慢线', def: 60, min: 3, win: true }
      ],
      signal(bars, p) {
        const closes = bars.map(b => b.close);
        const f = IND.sma(closes, p.fast);
        const s = IND.sma(closes, p.slow);
        return bars.map((_, i) =>
          (f[i] == null || s[i] == null) ? 0 : (f[i] > s[i] ? 1 : 0));
      }
    },

    rsi_reversion: {
      name: 'RSI 均值回归',
      params: [
        { key: 'period', label: '周期', def: 14, min: 2, win: true },
        { key: 'buy',    label: '买入阈值', def: 30, min: 1 },
        { key: 'sell',   label: '卖出阈值', def: 60, min: 2 }
      ],
      signal(bars, p) {
        const r = IND.rsi(bars.map(b => b.close), p.period);
        const out = [];
        let pos = 0;
        for (let i = 0; i < bars.length; i++) {
          if (r[i] != null) {
            if (r[i] < p.buy) pos = 1;
            else if (r[i] > p.sell) pos = 0;
          }
          out.push(pos);
        }
        return out;
      }
    },

    macd: {
      name: 'MACD 金叉死叉',
      params: [
        { key: 'fast',   label: '快线', def: 12, min: 2, win: true },
        { key: 'slow',   label: '慢线', def: 26, min: 3, win: true },
        { key: 'signal', label: '信号', def: 9,  min: 2, win: true }
      ],
      signal(bars, p) {
        const m = IND.macd(bars.map(b => b.close), p.fast, p.slow, p.signal);
        return bars.map((_, i) => (m.hist[i] != null && m.hist[i] > 0) ? 1 : 0);
      }
    },

    boll_breakout: {
      name: '布林带突破',
      params: [
        { key: 'period', label: '周期',   def: 20, min: 5, win: true },
        { key: 'mult',   label: '倍数',   def: 2,  min: 0.5, step: 0.1 }
      ],
      signal(bars, p) {
        const closes = bars.map(b => b.close);
        const bb = IND.boll(closes, p.period, p.mult);
        const out = [];
        let pos = 0;
        for (let i = 0; i < bars.length; i++) {
          if (bb.upper[i] != null) {
            if (closes[i] > bb.upper[i]) pos = 1;
            else if (closes[i] < bb.mid[i]) pos = 0;
          }
          out.push(pos);
        }
        return out;
      }
    },

    donchian: {
      name: '唐奇安通道突破',
      params: [
        { key: 'entry', label: '入场窗口', def: 20, min: 3, win: true },
        { key: 'exit',  label: '出场窗口', def: 10, min: 2, win: true }
      ],
      signal(bars, p) {
        const inCh  = IND.donchian(bars, p.entry);
        const outCh = IND.donchian(bars, p.exit);
        const out = [];
        let pos = 0;
        for (let i = 0; i < bars.length; i++) {
          const c = bars[i].close;
          if (inCh.upper[i] != null && c > inCh.upper[i]) pos = 1;
          else if (outCh.lower[i] != null && c < outCh.lower[i]) pos = 0;
          out.push(pos);
        }
        return out;
      }
    },

    buy_hold: {
      name: '买入持有（基准）',
      params: [],
      signal(bars) { return bars.map(() => 1); }
    }
  };

  /** 两个 YYYY-MM-DD 之间的自然日数 */
  function dayDiff(from, to) {
    const a = new Date(from + 'T00:00:00');
    const b = new Date(to + 'T00:00:00');
    return Math.round((b - a) / 86400000);
  }

  /* ============================================================
   * 引擎
   * ========================================================== */
  function run(bars, signals, opts) {
    const capital = opts.capital;
    const fee  = (opts.feeBps  || 0) / 10000;
    const slip = (opts.slipBps || 0) / 10000;

    let cash = capital;
    let shares = 0;
    let pos = 0;
    let entry = null;
    let feesPaid = 0;
    let exposedDays = 0;

    const equity = [];
    const trades = [];

    for (let i = 0; i < bars.length; i++) {
      const bar = bars[i];

      // 用上一根收盘产生的信号，在本根开盘成交
      if (i > 0) {
        const want = signals[i - 1];
        if (want !== pos) {
          if (want === 1) {
            const px = bar.open * (1 + slip);
            const qty = Math.floor(cash / (px * (1 + fee)));
            if (qty > 0) {
              const cost = qty * px;
              const f = cost * fee;
              cash -= cost + f;
              feesPaid += f;
              shares = qty;
              pos = 1;
              entry = { date: bar.date, price: px, qty, index: i };
            }
          } else if (shares > 0) {
            const px = bar.open * (1 - slip);
            const gross = shares * px;
            const f = gross * fee;
            cash += gross - f;
            feesPaid += f;
            trades.push({
              inDate: entry.date, inPrice: entry.price,
              outDate: bar.date,  outPrice: px,
              qty: entry.qty,
              pnl: (px - entry.price) * entry.qty - f,
              ret: px / entry.price - 1,
              days: i - entry.index,
              calDays: dayDiff(entry.date, bar.date)
            });
            shares = 0; pos = 0; entry = null;
          }
        }
      }

      if (pos === 1) exposedDays++;
      equity.push(cash + shares * bar.close);
    }

    // 收尾：仍持仓则按最后收盘价标记（不强制平仓，但计入未平仓交易）
    if (pos === 1 && entry) {
      const lastBar = bars[bars.length - 1];
      trades.push({
        inDate: entry.date, inPrice: entry.price,
        outDate: '持仓中', outPrice: lastBar.close,
        qty: entry.qty,
        pnl: (lastBar.close - entry.price) * entry.qty,
        ret: lastBar.close / entry.price - 1,
        days: bars.length - 1 - entry.index,
        calDays: dayDiff(entry.date, lastBar.date),
        open: true
      });
    }

    return { equity, trades, feesPaid, exposure: exposedDays / bars.length };
  }

  /* ---------------- 绩效指标 ---------------- */

  const PERIODS_PER_YEAR = { day: 252, week: 52, month: 12 };
  const INTERVAL_LABEL = { day: '日线', week: '周线', month: '月线' };

  /**
   * @param perYear 一年多少根 K 线。夏普、年化波动、CAGR 都靠它换算，
   *                传错会让周线的年化波动被高估约 √5 倍。
   */
  function metrics(result, bars, capital, perYear) {
    const py = perYear || 252;
    const eq = result.equity;
    const last = eq[eq.length - 1];
    const rets = IND.returns(eq);
    const closed = result.trades.filter(t => !t.open);
    const wins = closed.filter(t => t.pnl > 0);
    const grossWin  = wins.reduce((a, t) => a + t.pnl, 0);
    const grossLoss = closed.filter(t => t.pnl <= 0).reduce((a, t) => a + Math.abs(t.pnl), 0);

    return {
      totalReturn: last / capital - 1,
      finalEquity: last,
      cagr: IND.cagr(capital, last, bars.length, py),
      maxDD: IND.maxDrawdown(eq),
      sharpe: IND.sharpe(rets, null, py),
      annualVol: IND.annualVol(rets, py),
      tradeCount: result.trades.length,
      winRate: closed.length ? wins.length / closed.length : 0,
      profitFactor: grossLoss > 0 ? grossWin / grossLoss : (grossWin > 0 ? Infinity : 0),
      // 持有时长用自然日，跨周期可比；用"根数"的话日线和月线没法对照
      avgHoldDays: closed.length ? closed.reduce((a, t) => a + t.calDays, 0) / closed.length : 0,
      avgHoldBars: closed.length ? closed.reduce((a, t) => a + t.days, 0) / closed.length : 0,
      exposure: result.exposure,
      fees: result.feesPaid
    };
  }

  /* ============================================================
   * 视图
   * ========================================================== */
  let equityChart = null;

  function renderParams() {
    const key = $('#btStrategy').value;
    const strat = STRATEGIES[key];
    $('#btParams').innerHTML = strat.params.map(p =>
      '<label>' + p.label +
        '<input type="number" data-key="' + p.key + '" value="' + p.def + '"' +
        (p.min != null ? ' min="' + p.min + '"' : '') +
        (p.step ? ' step="' + p.step + '"' : '') + '></label>'
    ).join('');
  }

  function readParams() {
    const p = {};
    U.$$('#btParams input').forEach(inp => { p[inp.dataset.key] = parseFloat(inp.value); });
    return p;
  }

  function execute() {
    const hist = QL.state.history;
    if (!hist || !hist.bars.length) {
      $('#btMetrics').innerHTML = '<span class="muted">还没有行情数据</span>';
      return;
    }

    const interval = $('#btInterval').value;
    const perYear = PERIODS_PER_YEAR[interval];
    const bars = IND.resample(hist.bars, interval);
    const key = $('#btStrategy').value;
    const strat = STRATEGIES[key];
    const params = readParams();

    // 样本太少的回测没有统计意义。月线三年只有 37 根，
    // 长周期均线连一个值都算不出来，跑出来的"绩效"纯属噪声。
    const need = Math.max(30, longestWindow(strat, params) + 10);
    if (bars.length < need) {
      $('#btMetrics').innerHTML =
        '<span class="muted">' + INTERVAL_LABEL[interval] + '只有 ' + bars.length +
        ' 根，当前参数至少需要 ' + need + ' 根。请换更短的参数、更细的周期，或拉更长的历史。</span>';
      $('#btTrades tbody').innerHTML = '<tr><td colspan="7" class="muted">—</td></tr>';
      equityChart.setData([], []);
      return;
    }

    const opts = {
      capital: parseFloat($('#btCapital').value) || 100000,
      feeBps:  parseFloat($('#btFee').value)  || 0,
      slipBps: parseFloat($('#btSlip').value) || 0
    };

    const sig = strat.signal(bars, params);
    const res = run(bars, sig, opts);
    const met = metrics(res, bars, opts.capital, perYear);

    const benchRes = run(bars, STRATEGIES.buy_hold.signal(bars), opts);
    const benchMet = metrics(benchRes, bars, opts.capital, perYear);

    renderEquity(bars, res.equity, benchRes.equity);
    renderMetrics(met, benchMet, bars, strat.name, interval);
    renderTrades(res.trades);

    QL.state.lastBacktest = {
      strategy: key, params, interval, metrics: met, result: res
    };
  }

  /**
   * 最长的回看窗口，用来判断样本够不够。
   * 只看策略声明了 win:true 的参数——RSI 的阈值 30/60 是分位不是窗口，
   * 一起算进去会误判成"至少需要 70 根"。
   */
  function longestWindow(strat, params) {
    let mx = 0;
    strat.params.forEach(def => {
      if (!def.win) return;
      const v = params[def.key];
      if (typeof v === 'number' && isFinite(v) && v > mx) mx = v;
    });
    return mx;
  }

  function renderEquity(bars, eq, bench) {
    if (!equityChart) equityChart = new QL.chart.LineChart($('#equityChart'));
    equityChart.setData(bars.map(b => b.date), [
      { name: '买入持有', values: bench, color: QL.chart.COLOR.bench, width: 1.2, dash: [4, 3] },
      { name: '策略',     values: eq,    color: QL.chart.COLOR.accent, width: 1.8, fill: true }
    ]);
  }

  function renderMetrics(m, b, bars, stratName, interval) {
    const pf = m.profitFactor === Infinity ? '∞' : m.profitFactor.toFixed(2);
    const unit = { day: '日', week: '周', month: '月' }[interval] || '日';
    const items = [
      ['策略',        stratName, ''],
      ['周期',        INTERVAL_LABEL[interval] || '日线', ''],
      ['回测区间',    bars[0].date + ' ~ ' + bars[bars.length - 1].date, ''],
      ['K线根数',     bars.length + ' 根' + unit + '线', ''],
      ['期末权益',    U.fmtMoney(m.finalEquity), U.dirClass(m.totalReturn)],
      ['总收益',      U.fmtPct(m.totalReturn), U.dirClass(m.totalReturn)],
      ['年化收益',    U.fmtPct(m.cagr), U.dirClass(m.cagr)],
      ['最大回撤',    '-' + (m.maxDD * 100).toFixed(2) + '%', 'down'],
      ['夏普比率',    m.sharpe.toFixed(2), U.dirClass(m.sharpe)],
      ['年化波动',    (m.annualVol * 100).toFixed(1) + '%', ''],
      ['卡玛比率',    m.maxDD > 0 ? (m.cagr / m.maxDD).toFixed(2) : '—', ''],
      ['交易次数',    m.tradeCount, ''],
      ['胜率',        (m.winRate * 100).toFixed(1) + '%', m.winRate >= 0.5 ? 'up' : 'down'],
      ['盈亏比',      pf, ''],
      ['平均持有',    m.avgHoldDays.toFixed(0) + ' 自然日（' + m.avgHoldBars.toFixed(1) + ' 根）', ''],
      ['仓位暴露',    (m.exposure * 100).toFixed(1) + '%', ''],
      ['手续费合计',  U.fmtMoney(m.fees), ''],
      ['基准总收益',  U.fmtPct(b.totalReturn), U.dirClass(b.totalReturn)],
      ['超额收益',    U.fmtPct(m.totalReturn - b.totalReturn), U.dirClass(m.totalReturn - b.totalReturn)]
    ];
    $('#btMetrics').innerHTML = items.map(it =>
      '<div><label>' + it[0] + '</label><span class="' + it[2] + '">' + it[1] + '</span></div>'
    ).join('');
  }

  function renderTrades(trades) {
    const tbody = $('#btTrades tbody');
    if (!trades.length) {
      tbody.innerHTML = '<tr><td colspan="7" class="muted">该参数下没有产生任何交易</td></tr>';
      return;
    }
    tbody.innerHTML = trades.slice().reverse().map((t, idx) => {
      const cls = U.dirClass(t.pnl);
      return '<tr>' +
        '<td>' + (trades.length - idx) + '</td>' +
        '<td>' + t.inDate + '</td>' +
        '<td class="num">' + t.inPrice.toFixed(2) + '</td>' +
        '<td>' + t.outDate + '</td>' +
        '<td class="num">' + t.outPrice.toFixed(2) + '</td>' +
        '<td class="num ' + cls + '">' + U.fmtPct(t.ret) + '</td>' +
        '<td class="num">' + t.calDays + 'd</td>' +
      '</tr>';
    }).join('');
  }

  function init() {
    renderParams();
    $('#btStrategy').addEventListener('change', renderParams);
    $('#btInterval').addEventListener('change', () => {
      if (QL.state.lastBacktest) execute();     // 已经跑过就按新周期重算
    });
    $('#btnRunBacktest').addEventListener('click', execute);
    equityChart = new QL.chart.LineChart($('#equityChart'));

    U.bus.on('symbol:loaded', () => {
      $('#btMetrics').innerHTML = '<span class="muted">已切换到 ' + QL.state.symbol + '，点击「开始回测」</span>';
      $('#btTrades tbody').innerHTML = '<tr><td colspan="7" class="muted">—</td></tr>';
      equityChart.setData([], []);
    });
  }

  return { init, run, metrics, STRATEGIES, execute };
})();
