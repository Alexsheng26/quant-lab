/* ============================================================
 * indicators.js —— 技术指标与绩效统计
 *
 * 约定：所有函数输入是等长数组，输出等长数组，前面数据不足的位置填 null。
 * 这样索引可以直接和 bars 对齐，画图和回测都不用做偏移换算。
 * ============================================================ */

window.QL = window.QL || {};

QL.ind = (function () {

  /* ---------------- 均线族 ---------------- */

  function sma(values, period) {
    const out = new Array(values.length).fill(null);
    let sum = 0;
    for (let i = 0; i < values.length; i++) {
      sum += values[i];
      if (i >= period) sum -= values[i - period];
      if (i >= period - 1) out[i] = sum / period;
    }
    return out;
  }

  function ema(values, period) {
    const out = new Array(values.length).fill(null);
    if (values.length < period) return out;
    const k = 2 / (period + 1);
    // 用前 period 个值的简单均值做种子，避免开头剧烈失真
    let seed = 0;
    for (let i = 0; i < period; i++) seed += values[i];
    let prev = seed / period;
    out[period - 1] = prev;
    for (let i = period; i < values.length; i++) {
      prev = values[i] * k + prev * (1 - k);
      out[i] = prev;
    }
    return out;
  }

  /** 标准差（总体），窗口不足返回 null */
  function stdev(values, period) {
    const out = new Array(values.length).fill(null);
    const means = sma(values, period);
    for (let i = period - 1; i < values.length; i++) {
      let acc = 0;
      for (let j = i - period + 1; j <= i; j++) {
        const d = values[j] - means[i];
        acc += d * d;
      }
      out[i] = Math.sqrt(acc / period);
    }
    return out;
  }

  /* ---------------- 震荡指标 ---------------- */

  /** RSI（Wilder 平滑） */
  function rsi(closes, period) {
    period = period || 14;
    const out = new Array(closes.length).fill(null);
    if (closes.length <= period) return out;

    let gain = 0, loss = 0;
    for (let i = 1; i <= period; i++) {
      const d = closes[i] - closes[i - 1];
      if (d >= 0) gain += d; else loss -= d;
    }
    let avgGain = gain / period, avgLoss = loss / period;
    out[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);

    for (let i = period + 1; i < closes.length; i++) {
      const d = closes[i] - closes[i - 1];
      const g = d > 0 ? d : 0;
      const l = d < 0 ? -d : 0;
      avgGain = (avgGain * (period - 1) + g) / period;
      avgLoss = (avgLoss * (period - 1) + l) / period;
      out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
    }
    return out;
  }

  /** MACD：返回 { dif, dea, hist } */
  function macd(closes, fast, slow, signal) {
    fast = fast || 12; slow = slow || 26; signal = signal || 9;
    const ef = ema(closes, fast);
    const es = ema(closes, slow);
    const dif = closes.map((_, i) =>
      (ef[i] == null || es[i] == null) ? null : ef[i] - es[i]);

    // DEA 是 DIF 的 EMA，需要跳过前面的 null
    const start = dif.findIndex(v => v != null);
    const dea = new Array(closes.length).fill(null);
    if (start >= 0) {
      const valid = dif.slice(start);
      const deaValid = ema(valid, signal);
      for (let i = 0; i < deaValid.length; i++) dea[start + i] = deaValid[i];
    }
    const hist = closes.map((_, i) =>
      (dif[i] == null || dea[i] == null) ? null : (dif[i] - dea[i]) * 2);

    return { dif, dea, hist };
  }

  /** 布林带：返回 { mid, upper, lower, pctB, width } */
  function boll(closes, period, mult) {
    period = period || 20; mult = mult || 2;
    const mid = sma(closes, period);
    const sd  = stdev(closes, period);
    const upper = [], lower = [], pctB = [], width = [];
    for (let i = 0; i < closes.length; i++) {
      if (mid[i] == null) { upper.push(null); lower.push(null); pctB.push(null); width.push(null); continue; }
      const u = mid[i] + mult * sd[i];
      const l = mid[i] - mult * sd[i];
      upper.push(u); lower.push(l);
      pctB.push(u === l ? 0.5 : (closes[i] - l) / (u - l));
      width.push(mid[i] === 0 ? null : (u - l) / mid[i]);
    }
    return { mid, upper, lower, pctB, width };
  }

  /** ATR（Wilder 平滑），输入 bars */
  function atr(bars, period) {
    period = period || 14;
    const out = new Array(bars.length).fill(null);
    if (bars.length <= period) return out;

    const tr = bars.map((b, i) => {
      if (i === 0) return b.high - b.low;
      const pc = bars[i - 1].close;
      return Math.max(b.high - b.low, Math.abs(b.high - pc), Math.abs(b.low - pc));
    });

    let sum = 0;
    for (let i = 1; i <= period; i++) sum += tr[i];
    let prev = sum / period;
    out[period] = prev;
    for (let i = period + 1; i < bars.length; i++) {
      prev = (prev * (period - 1) + tr[i]) / period;
      out[i] = prev;
    }
    return out;
  }

  /** ROC 变化率（%） */
  function roc(values, period) {
    period = period || 20;
    return values.map((v, i) =>
      (i < period || values[i - period] === 0) ? null : (v / values[i - period] - 1) * 100);
  }

  /** 唐奇安通道：过去 period 根（不含当根）的最高/最低 */
  function donchian(bars, period) {
    const upper = new Array(bars.length).fill(null);
    const lower = new Array(bars.length).fill(null);
    for (let i = period; i < bars.length; i++) {
      let hi = -Infinity, lo = Infinity;
      for (let j = i - period; j < i; j++) {
        if (bars[j].high > hi) hi = bars[j].high;
        if (bars[j].low  < lo) lo = bars[j].low;
      }
      upper[i] = hi; lower[i] = lo;
    }
    return { upper, lower };
  }

  /* ---------------- 周期重采样 ---------------- */

  /** 取某天所在那一周的周一，返回 YYYY-MM-DD */
  function weekKey(dateStr) {
    const d = new Date(dateStr + 'T00:00:00');
    const wd = d.getDay();                       // 0=周日
    const back = wd === 0 ? 6 : wd - 1;          // 回退到周一
    d.setDate(d.getDate() - back);
    const p = n => String(n).padStart(2, '0');
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
  }

  /**
   * 把日线聚合成周线 / 月线。
   *   开 = 区间第一根的开盘   高 = 区间最高
   *   低 = 区间最低           收 = 区间最后一根的收盘
   *   量 = 区间累加
   * 用每段的**起始日期**当标签，未收完的当期照样输出（就是"本周至今"）。
   */
  function resample(bars, interval) {
    if (!bars || !bars.length || interval === 'day') return bars || [];

    const keyOf = interval === 'week'
      ? b => weekKey(b.date)
      : b => b.date.slice(0, 7);                 // 月线用 YYYY-MM

    const out = [];
    let cur = null;
    let curKey = null;

    for (const b of bars) {
      const k = keyOf(b);
      if (k !== curKey) {
        if (cur) out.push(cur);
        curKey = k;
        cur = {
          date: b.date,                          // 段内第一个交易日
          open: b.open, high: b.high, low: b.low, close: b.close,
          volume: b.volume
        };
      } else {
        if (b.high > cur.high) cur.high = b.high;
        if (b.low  < cur.low)  cur.low  = b.low;
        cur.close = b.close;
        cur.volume += b.volume;
      }
    }
    if (cur) out.push(cur);
    return out;
  }

  /* ---------------- 绩效统计 ---------------- */

  /** 日收益率序列 */
  function returns(series) {
    const out = [];
    for (let i = 1; i < series.length; i++) {
      out.push(series[i - 1] === 0 ? 0 : series[i] / series[i - 1] - 1);
    }
    return out;
  }

  /** 最大回撤（正数，0.25 表示 -25%） */
  function maxDrawdown(series) {
    let peak = -Infinity, mdd = 0;
    for (const v of series) {
      if (v > peak) peak = v;
      if (peak > 0) mdd = Math.max(mdd, (peak - v) / peak);
    }
    return mdd;
  }

  /** 年化波动率（默认 252 个交易日） */
  function annualVol(rets, periods) {
    periods = periods || 252;
    if (rets.length < 2) return 0;
    const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
    const varr = rets.reduce((a, b) => a + (b - mean) * (b - mean), 0) / (rets.length - 1);
    return Math.sqrt(varr) * Math.sqrt(periods);
  }

  /** 夏普比率（默认无风险利率 4%，贴近当前美债水平） */
  function sharpe(rets, rf, periods) {
    rf = rf == null ? 0.04 : rf;
    periods = periods || 252;
    if (rets.length < 2) return 0;
    const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
    const vol = annualVol(rets, periods);
    if (vol === 0) return 0;
    return (mean * periods - rf) / vol;
  }

  /**
   * 年化收益（CAGR）
   * @param periods       区间内的 K 线根数
   * @param periodsPerYear 一年多少根（日线 252 / 周线 52 / 月线 12）
   */
  function cagr(first, last, periods, periodsPerYear) {
    if (first <= 0 || periods <= 0) return 0;
    const py = periodsPerYear || 252;
    return Math.pow(last / first, py / periods) - 1;
  }

  return {
    sma, ema, stdev, rsi, macd, boll, atr, roc, donchian,
    resample,
    returns, maxDrawdown, annualVol, sharpe, cagr
  };
})();
