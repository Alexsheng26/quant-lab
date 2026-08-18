/* ============================================================
 * 前端纯函数单元测试
 *
 * 直接加载 assets/js 下的真实文件（不是副本），在 Chromium 里跑，
 * 由 tests/test_js.py 通过 Playwright 驱动。
 *
 * 之所以在浏览器里跑而不是 Node：项目是零依赖的经典 <script> 结构，
 * 没有 package.json 也没有模块系统，浏览器就是它的真实运行环境。
 * ========================================================== */

(function () {
  const results = [];
  let group = '';

  function describe(name, fn) { group = name; fn(); }

  function it(name, fn) {
    try {
      fn();
      results.push({ group, name, ok: true });
    } catch (e) {
      results.push({ group, name, ok: false, message: e.message });
    }
  }

  function eq(actual, expected, msg) {
    if (actual !== expected) {
      throw new Error((msg ? msg + ': ' : '') + `期望 ${expected}，实际 ${actual}`);
    }
  }

  function close(actual, expected, tol, msg) {
    tol = tol == null ? 1e-9 : tol;
    if (actual == null || Math.abs(actual - expected) > tol) {
      throw new Error((msg ? msg + ': ' : '') +
        `期望 ≈${expected}（容差 ${tol}），实际 ${actual}`);
    }
  }

  function ok(cond, msg) {
    if (!cond) throw new Error(msg || '断言失败');
  }

  const IND = QL.ind;
  const BT = QL.backtest;

  /* --------------------------------------------------------
   * 造数据
   * ------------------------------------------------------ */

  /** 从收盘价数组造 bars，开盘=前收，高低各留 1%，方便推算 */
  function barsFromCloses(closes, startDate) {
    let d = new Date((startDate || '2020-01-01') + 'T00:00:00');
    return closes.map((c, i) => {
      const o = i === 0 ? c : closes[i - 1];
      const bar = {
        date: d.toISOString().slice(0, 10),
        open: o,
        high: Math.max(o, c) * 1.01,
        low: Math.min(o, c) * 0.99,
        close: c,
        volume: 1000,
      };
      d.setDate(d.getDate() + 1);
      return bar;
    });
  }

  /* ============================================================
   * 指标
   * ========================================================== */

  describe('indicators.sma', function () {
    it('窗口不足的位置填 null，长度和输入一致', function () {
      const out = IND.sma([1, 2, 3, 4, 5], 3);
      eq(out.length, 5);
      eq(out[0], null); eq(out[1], null);
      eq(out[2], 2);    // (1+2+3)/3
      eq(out[4], 4);    // (3+4+5)/3
    });

    it('滚动窗口正确移除旧值', function () {
      const out = IND.sma([10, 20, 30, 100], 2);
      eq(out[1], 15); eq(out[2], 25); eq(out[3], 65);
    });

    it('period 等于长度时只有最后一个有值', function () {
      const out = IND.sma([1, 2, 3], 3);
      eq(out[0], null); eq(out[1], null); eq(out[2], 2);
    });
  });

  describe('indicators.ema', function () {
    it('用前 period 个值的均值做种子', function () {
      const out = IND.ema([1, 2, 3, 4, 5], 3);
      eq(out[1], null);
      eq(out[2], 2);                       // (1+2+3)/3
      close(out[3], 4 * 0.5 + 2 * 0.5);    // k = 2/(3+1) = 0.5
      close(out[4], 5 * 0.5 + 3 * 0.5);
    });

    it('数据短于周期时全是 null', function () {
      ok(IND.ema([1, 2], 5).every(v => v === null));
    });

    it('恒定序列的 EMA 等于该常数', function () {
      const out = IND.ema(new Array(20).fill(7), 5);
      close(out[19], 7, 1e-9);
    });
  });

  describe('indicators.rsi', function () {
    it('单调上涨时 RSI = 100', function () {
      const out = IND.rsi([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16], 14);
      eq(out[14], 100);
    });

    it('单调下跌时 RSI 接近 0', function () {
      const closes = [];
      for (let i = 30; i > 10; i--) closes.push(i);
      const out = IND.rsi(closes, 14);
      close(out[14], 0, 1e-9);
    });

    it('结果始终落在 0~100', function () {
      const closes = [];
      let p = 100;
      for (let i = 0; i < 200; i++) { p *= 1 + Math.sin(i) * 0.03; closes.push(p); }
      IND.rsi(closes, 14).forEach(v => {
        if (v != null) ok(v >= 0 && v <= 100, 'RSI 越界: ' + v);
      });
    });

    it('数据不够时不报错', function () {
      ok(IND.rsi([1, 2, 3], 14).every(v => v === null));
    });
  });

  describe('indicators.boll', function () {
    it('恒定序列时上下轨与中轨重合，%B 定义为 0.5', function () {
      const b = IND.boll(new Array(30).fill(50), 20, 2);
      close(b.mid[25], 50);
      close(b.upper[25], 50);
      eq(b.pctB[25], 0.5, '上下轨相等时不能除零');
    });

    it('上轨恒大于等于中轨恒大于等于下轨', function () {
      const closes = [];
      for (let i = 0; i < 100; i++) closes.push(100 + Math.sin(i / 3) * 10);
      const b = IND.boll(closes, 20, 2);
      for (let i = 19; i < closes.length; i++) {
        ok(b.upper[i] >= b.mid[i] && b.mid[i] >= b.lower[i], '轨道顺序错乱 @' + i);
      }
    });
  });

  describe('indicators.donchian', function () {
    it('不含当根 K 线，否则就是未来函数', function () {
      const bars = barsFromCloses([1, 2, 3, 4, 100]);
      const ch = IND.donchian(bars, 3);
      // i=4 的通道只看 i=1,2,3，不能被 i=4 自己的高点污染
      const expectHigh = Math.max(bars[1].high, bars[2].high, bars[3].high);
      close(ch.upper[4], expectHigh, 1e-9, '通道上沿吃到了当根的高点');
      ok(ch.upper[4] < bars[4].high, '当根新高不该已经在通道里');
    });
  });

  describe('indicators.resample', function () {
    it('日线聚合成周线：开取首、收取尾、高低取极值、量累加', function () {
      // 2020-01-06 是周一
      const bars = [
        { date: '2020-01-06', open: 10, high: 12, low: 9,  close: 11, volume: 100 },
        { date: '2020-01-07', open: 11, high: 15, low: 10, close: 14, volume: 200 },
        { date: '2020-01-08', open: 14, high: 14, low: 8,  close: 9,  volume: 300 },
        { date: '2020-01-13', open: 9,  high: 10, low: 8,  close: 10, volume: 400 },
      ];
      const wk = IND.resample(bars, 'week');
      eq(wk.length, 2);
      eq(wk[0].open, 10); eq(wk[0].close, 9);
      eq(wk[0].high, 15); eq(wk[0].low, 8);
      eq(wk[0].volume, 600);
      eq(wk[1].date, '2020-01-13');
    });

    it('周日归到上一周（ISO 周一起算）', function () {
      const bars = [
        { date: '2020-01-11', open: 1, high: 1, low: 1, close: 1, volume: 1 }, // 周六
        { date: '2020-01-12', open: 2, high: 2, low: 2, close: 2, volume: 1 }, // 周日
        { date: '2020-01-13', open: 3, high: 3, low: 3, close: 3, volume: 1 }, // 周一
      ];
      const wk = IND.resample(bars, 'week');
      eq(wk.length, 2, '周日应该和周六同一周');
      eq(wk[0].close, 2);
    });

    it('day 原样返回', function () {
      const bars = barsFromCloses([1, 2, 3]);
      eq(IND.resample(bars, 'day'), bars);
    });

    it('空输入不炸', function () {
      eq(IND.resample([], 'week').length, 0);
      eq(IND.resample(null, 'week').length, 0);
    });
  });

  describe('indicators 绩效统计', function () {
    it('最大回撤', function () {
      close(IND.maxDrawdown([100, 120, 60, 80]), 0.5);   // 120 -> 60
      eq(IND.maxDrawdown([1, 2, 3, 4]), 0, '单调上涨没有回撤');
    });

    it('CAGR：两年翻倍约等于 41.4%', function () {
      close(IND.cagr(100, 200, 504, 252), Math.pow(2, 0.5) - 1, 1e-9);
    });

    it('CAGR 对非法输入返回 0 而不是 NaN', function () {
      eq(IND.cagr(0, 100, 252, 252), 0);
      eq(IND.cagr(100, 200, 0, 252), 0);
    });

    it('恒定收益率的年化波动为 0，夏普不除零', function () {
      const rets = new Array(50).fill(0.001);
      close(IND.annualVol(rets), 0, 1e-12);
      eq(IND.sharpe(rets), 0, '波动为 0 时夏普应返回 0 而不是 Infinity');
    });

    it('日收益率序列比价格序列短 1', function () {
      eq(IND.returns([100, 110, 121]).length, 2);
      close(IND.returns([100, 110])[0], 0.1);
    });
  });

  /* ============================================================
   * 回测引擎 —— 最重要的部分
   * ========================================================== */

  describe('backtest 防未来函数', function () {
    it('第 i 根的信号在第 i+1 根开盘成交', function () {
      const bars = [
        { date: '2020-01-01', open: 10, high: 10, low: 10, close: 10, volume: 1 },
        { date: '2020-01-02', open: 20, high: 20, low: 20, close: 20, volume: 1 },
        { date: '2020-01-03', open: 30, high: 30, low: 30, close: 30, volume: 1 },
      ];
      // 第 0 根收盘后决定买入
      const r = BT.run(bars, [1, 1, 1], { capital: 1000, feeBps: 0, slipBps: 0 });
      eq(r.trades.length, 1);
      eq(r.trades[0].inPrice, 20, '应该按第 1 根的开盘价 20 成交，而不是第 0 根的 10');
      eq(r.trades[0].inDate, '2020-01-02');
    });

    it('最后一根的信号不会成交（没有下一根可执行）', function () {
      const bars = barsFromCloses([10, 10, 10]);
      const r = BT.run(bars, [0, 0, 1], { capital: 1000, feeBps: 0, slipBps: 0 });
      eq(r.trades.length, 0, '末根信号没有执行机会，不该产生成交');
    });

    it('用一个只有末根暴涨的序列验证拿不到未来信息', function () {
      // 如果引擎偷看了未来，"最后一天暴涨"这个信息会让它提前买入
      const bars = barsFromCloses([10, 10, 10, 10, 1000]);
      const flat = BT.run(bars, [0, 0, 0, 0, 0], { capital: 1000, feeBps: 0, slipBps: 0 });
      eq(flat.trades.length, 0);
      eq(flat.equity[flat.equity.length - 1], 1000, '没交易过，资金不该变化');
    });
  });

  describe('backtest 成本模型', function () {
    it('手续费和滑点都记到成本里', function () {
      const bars = [
        { date: '2020-01-01', open: 100, high: 100, low: 100, close: 100, volume: 1 },
        { date: '2020-01-02', open: 100, high: 100, low: 100, close: 100, volume: 1 },
        { date: '2020-01-03', open: 100, high: 100, low: 100, close: 100, volume: 1 },
      ];
      const free = BT.run(bars, [1, 0, 0], { capital: 10000, feeBps: 0, slipBps: 0 });
      const paid = BT.run(bars, [1, 0, 0], { capital: 10000, feeBps: 50, slipBps: 50 });

      eq(free.feesPaid, 0);
      ok(paid.feesPaid > 0, '应该产生手续费');
      ok(paid.equity[2] < free.equity[2], '有成本的最终资金必须更少');
    });

    it('买入价含滑点上浮，卖出价含滑点下压', function () {
      const bars = [
        { date: '2020-01-01', open: 100, high: 100, low: 100, close: 100, volume: 1 },
        { date: '2020-01-02', open: 100, high: 100, low: 100, close: 100, volume: 1 },
        { date: '2020-01-03', open: 100, high: 100, low: 100, close: 100, volume: 1 },
      ];
      const r = BT.run(bars, [1, 0, 0], { capital: 10000, feeBps: 0, slipBps: 100 });
      close(r.trades[0].inPrice, 101, 1e-9, '买入应上浮 1%');
      close(r.trades[0].outPrice, 99, 1e-9, '卖出应下压 1%');
    });

    it('只买得起整数股，且现金不会变成负数', function () {
      const bars = [
        { date: '2020-01-01', open: 300, high: 300, low: 300, close: 300, volume: 1 },
        { date: '2020-01-02', open: 300, high: 300, low: 300, close: 300, volume: 1 },
      ];
      const r = BT.run(bars, [1, 1], { capital: 1000, feeBps: 10, slipBps: 10 });
      // 1000 元买 300 元的股票，含成本只买得起 3 股，不能是 3.33 股
      eq(r.trades.length, 1);
      eq(r.trades[0].open, true, '收尾时仍持仓，应记为未平仓交易');
      eq(r.trades[0].qty, 3, '只能买整数股');
      ok(r.equity[1] <= 1000, '资金不该凭空增加');
      ok(r.equity[1] > 0, '资金不该变成负数');
    });

    it('资金不足以买 1 股时不开仓', function () {
      const bars = [
        { date: '2020-01-01', open: 500, high: 500, low: 500, close: 500, volume: 1 },
        { date: '2020-01-02', open: 500, high: 500, low: 500, close: 500, volume: 1 },
      ];
      const r = BT.run(bars, [1, 1], { capital: 100, feeBps: 0, slipBps: 0 });
      eq(r.equity[1], 100, '买不起就该原地不动');
    });
  });

  describe('backtest 资金曲线与交易记录', function () {
    it('资金曲线长度等于 K 线根数', function () {
      const bars = barsFromCloses([10, 11, 12, 13, 14]);
      const r = BT.run(bars, [1, 1, 0, 1, 1], { capital: 1000, feeBps: 5, slipBps: 5 });
      eq(r.equity.length, bars.length);
    });

    it('全程空仓时资金恒等于本金', function () {
      const bars = barsFromCloses([10, 50, 2, 80]);
      const r = BT.run(bars, [0, 0, 0, 0], { capital: 5000, feeBps: 10, slipBps: 10 });
      r.equity.forEach(v => eq(v, 5000));
      eq(r.exposure, 0);
    });

    it('未平仓的持仓会作为 open 交易收尾', function () {
      const bars = barsFromCloses([10, 12, 15]);
      const r = BT.run(bars, [1, 1, 1], { capital: 1000, feeBps: 0, slipBps: 0 });
      const last = r.trades[r.trades.length - 1];
      eq(last.open, true);
      eq(last.outDate, '持仓中');
    });

    it('盈亏方向和价格方向一致', function () {
      const up = [
        { date: '2020-01-01', open: 10, high: 10, low: 10, close: 10, volume: 1 },
        { date: '2020-01-02', open: 10, high: 10, low: 10, close: 10, volume: 1 },
        { date: '2020-01-03', open: 20, high: 20, low: 20, close: 20, volume: 1 },
      ];
      const r = BT.run(up, [1, 0, 0], { capital: 1000, feeBps: 0, slipBps: 0 });
      ok(r.trades[0].pnl > 0, '10 买 20 卖应该盈利');
      close(r.trades[0].ret, 1.0, 1e-9);
    });

    it('exposure 落在 0~1', function () {
      const bars = barsFromCloses([10, 11, 12, 13, 14, 15]);
      const r = BT.run(bars, [1, 1, 0, 0, 1, 1], { capital: 1000, feeBps: 0, slipBps: 0 });
      ok(r.exposure >= 0 && r.exposure <= 1, 'exposure 越界: ' + r.exposure);
    });
  });

  describe('backtest 策略信号', function () {
    it('买入持有全程满仓', function () {
      const bars = barsFromCloses([1, 2, 3]);
      const sig = BT.STRATEGIES.buy_hold.signal(bars, {});
      ok(sig.every(s => s === 1));
    });

    it('信号数组长度始终等于 K 线根数', function () {
      const closes = [];
      for (let i = 0; i < 120; i++) closes.push(100 + Math.sin(i / 5) * 20);
      const bars = barsFromCloses(closes);
      Object.keys(BT.STRATEGIES).forEach(function (k) {
        const s = BT.STRATEGIES[k];
        const p = {};
        s.params.forEach(function (prm) { p[prm.key] = prm.def; });
        const sig = s.signal(bars, p);
        eq(sig.length, bars.length, k + ' 的信号长度不对');
        ok(sig.every(v => v === 0 || v === 1), k + ' 产生了 0/1 以外的信号');
      });
    });

    it('数据不足时所有策略都输出空仓而不是崩', function () {
      const bars = barsFromCloses([10, 11, 12]);
      Object.keys(BT.STRATEGIES).forEach(function (k) {
        const s = BT.STRATEGIES[k];
        const p = {};
        s.params.forEach(function (prm) { p[prm.key] = prm.def; });
        const sig = s.signal(bars, p);
        eq(sig.length, 3, k);
      });
    });

    it('双均线：快线在上才持仓', function () {
      // 先跌后涨，快线应当在后半段上穿
      const closes = [];
      for (let i = 0; i < 40; i++) closes.push(100 - i);
      for (let i = 0; i < 40; i++) closes.push(60 + i * 2);
      const bars = barsFromCloses(closes);
      const sig = BT.STRATEGIES.ma_cross.signal(bars, { fast: 5, slow: 20 });
      eq(sig[30], 0, '下跌段应空仓');
      eq(sig[79], 1, '上涨段应持仓');
    });
  });

  describe('backtest 绩效指标', function () {
    it('买入持有的总收益等于价格涨幅', function () {
      const bars = [];
      for (let i = 0; i < 30; i++) {
        const px = 100 + i * 10;
        bars.push({ date: '2020-01-' + String(i + 1).padStart(2, '0'),
                    open: px, high: px, low: px, close: px, volume: 1 });
      }
      const r = BT.run(bars, bars.map(() => 1), { capital: 100000, feeBps: 0, slipBps: 0 });
      const m = BT.metrics(r, bars, 100000, 252);
      ok(m.totalReturn > 0, '上涨行情满仓应该盈利');
      ok(m.maxDD >= 0 && m.maxDD <= 1, 'maxDD 越界: ' + m.maxDD);
      close(m.finalEquity / 100000 - 1, m.totalReturn, 1e-12);
    });

    it('恒定收益率不会算出天文数字的夏普', function () {
      // 浮点误差让方差 ≈1e-38 而不是 0，除下去会得到 2e16 这种数字
      const rets = new Array(60).fill(0.001);
      const s = IND.sharpe(rets, 0.04, 252);
      ok(Math.abs(s) < 100, '夏普失控: ' + s);
    });

    it('指标里没有 NaN 或 Infinity', function () {
      const bars = barsFromCloses(new Array(60).fill(100));   // 完全不动的行情
      const r = BT.run(bars, bars.map(() => 1), { capital: 10000, feeBps: 5, slipBps: 5 });
      const m = BT.metrics(r, bars, 10000, 252);
      Object.keys(m).forEach(function (k) {
        const v = m[k];
        if (typeof v === 'number') {
          ok(isFinite(v), k + ' 是 ' + v);
        }
      });
    });
  });

  /* ============================================================
   * utils
   * ========================================================== */

  describe('utils 格式化', function () {
    it('涨跌百分比带符号', function () {
      ok(QL.utils.fmtPct(0.0123).indexOf('+') === 0, '正数应带 + 号');
      ok(QL.utils.fmtPct(-0.0123).indexOf('-') === 0);
    });

    it('空值不会显示成 NaN', function () {
      [null, undefined, NaN].forEach(function (v) {
        const s = String(QL.utils.fmtPct(v));
        ok(s.indexOf('NaN') === -1, 'fmtPct(' + v + ') = ' + s);
      });
    });

    it('价格格式化对空值同样安全', function () {
      [null, undefined, NaN].forEach(function (v) {
        const s = String(QL.utils.fmtPrice(v));
        ok(s.indexOf('NaN') === -1, 'fmtPrice(' + v + ') = ' + s);
      });
    });

    it('clamp 夹在区间内', function () {
      eq(QL.utils.clamp(5, 0, 10), 5);
      eq(QL.utils.clamp(-1, 0, 10), 0);
      eq(QL.utils.clamp(99, 0, 10), 10);
    });
  });

  window.__QL_TEST_RESULTS__ = results;
})();
