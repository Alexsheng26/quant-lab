/* ============================================================
 * agent.js —— 量化分析 Agent（0-100 打分）
 *
 * 设计思路：不做黑箱。每个因子单独算成 0-100 的子分，
 * 再按 CONFIG.agentWeights 加权得到总分，并把每一条判断的
 * 依据（具体数值）打印出来，做到结论可复查、权重可调。
 *
 * 因子：
 *   trend      趋势   —— 价格相对均线位置 + 均线多头排列 + 均线斜率
 *   momentum   动量   —— RSI + ROC20/60 + MACD 柱
 *   volatility 风险   —— ATR% + 年化波动 + 近期回撤（越低分越高）
 *   volume     量能   —— 量比 + OBV 斜率，且需与价格方向一致
 *   position   位置   —— 布林 %B + 52 周区间位置
 * ============================================================ */

window.QL = window.QL || {};

QL.agent = (function () {
  const U = QL.utils;
  const IND = QL.ind;
  const CFG = QL.CONFIG;
  const $ = U.$;

  const FACTOR_META = {
    trend:      { label: '趋势',   desc: '均线排列 / 价格位置' },
    momentum:   { label: '动量',   desc: 'RSI / ROC / MACD' },
    volatility: { label: '风险',   desc: '波动率 / 回撤（低者高分）' },
    volume:     { label: '量能',   desc: '量比 / OBV 与价格配合' },
    position:   { label: '位置',   desc: '布林 %B / 52 周区间' }
  };

  /* ---------------- 因子计算 ---------------- */

  const PERIODS_PER_YEAR = { day: 252, week: 52, month: 12 };
  const UNIT = { day: '日', week: '周', month: '月' };
  const INTERVAL_LABEL = { day: '日线', week: '周线', month: '月线' };

  /**
   * @param perYear 一年多少根 K 线。决定"一年"窗口取多少根，
   *                以及年化波动率、夏普的换算因子。
   */
  function calcFactors(bars, perYear) {
    const py = perYear || 252;
    const closes = bars.map(b => b.close);
    const vols   = bars.map(b => b.volume);
    const i = bars.length - 1;
    const last = closes[i];

    const ma20 = IND.sma(closes, 20);
    const ma60 = IND.sma(closes, 60);
    const rsi14 = IND.rsi(closes, 14)[i];
    const roc20 = IND.roc(closes, 20)[i];
    const roc60 = IND.roc(closes, 60)[i];
    const m = IND.macd(closes);
    const bb = IND.boll(closes, 20, 2);
    const atr14 = IND.atr(bars, 14)[i];

    // "一年"和"近一季"都按周期折算根数，不能写死 252 / 60
    const yearWin = bars.slice(-py);
    const hi52 = Math.max.apply(null, yearWin.map(b => b.high));
    const lo52 = Math.min.apply(null, yearWin.map(b => b.low));

    const retsYear = IND.returns(closes.slice(-py));
    const annVol   = IND.annualVol(retsYear, py);
    const ddWin    = Math.max(6, Math.round(py / 4.2));      // 约一个季度
    const dd60     = IND.maxDrawdown(closes.slice(-ddWin));
    const sharpe1y = IND.sharpe(retsYear, null, py);

    /* --- 趋势 --- */
    const vsMa20 = ma20[i] ? last / ma20[i] - 1 : 0;
    const vsMa60 = ma60[i] ? last / ma60[i] - 1 : 0;
    const maSpread = (ma20[i] && ma60[i]) ? ma20[i] / ma60[i] - 1 : 0;
    const slope20 = (ma20[i] && ma20[i - 10]) ? ma20[i] / ma20[i - 10] - 1 : 0;
    const trendScore =
      0.30 * U.scale(vsMa20,   -0.08, 0.08) +
      0.25 * U.scale(vsMa60,   -0.15, 0.15) +
      0.25 * U.scale(maSpread, -0.08, 0.08) +
      0.20 * U.scale(slope20,  -0.06, 0.06);

    /* --- 动量 --- */
    const macdNorm = (m.hist[i] != null && last) ? m.hist[i] / last * 100 : 0;
    const momentumScore =
      0.30 * U.scale(rsi14 == null ? 50 : rsi14, 25, 75) +
      0.30 * U.scale(roc20 == null ? 0 : roc20, -15, 15) +
      0.20 * U.scale(roc60 == null ? 0 : roc60, -25, 25) +
      0.20 * U.scale(macdNorm, -1.5, 1.5);

    /* --- 风险（反向：波动越小分越高） --- */
    const atrPct = atr14 ? atr14 / last * 100 : 3;
    const volScore =
      0.35 * U.scale(atrPct, 6.0, 1.0) +
      0.30 * U.scale(annVol, 0.70, 0.15) +
      0.35 * U.scale(dd60,   0.35, 0.03);

    /* --- 量能：放量必须和价格方向一致才算加分 --- */
    const vma5  = IND.sma(vols, 5)[i];
    const vma20 = IND.sma(vols, 20)[i];
    const volRatio = (vma5 && vma20) ? vma5 / vma20 : 1;
    const priceUp = (roc20 == null ? 0 : roc20) >= 0;
    const ratioScore = U.scale(volRatio, 0.6, 1.6);

    // OBV：涨日加量、跌日减量，再看近 20 日斜率
    let obv = 0;
    const obvSeries = [0];
    for (let k = 1; k < closes.length; k++) {
      obv += closes[k] > closes[k - 1] ? vols[k] : (closes[k] < closes[k - 1] ? -vols[k] : 0);
      obvSeries.push(obv);
    }
    const avgVol20 = vma20 || 1;
    const obvSlope = (obvSeries[i] - obvSeries[i - 20]) / (avgVol20 * 20);
    const volumeScore =
      0.45 * (priceUp ? ratioScore : 100 - ratioScore) +
      0.55 * U.scale(obvSlope, -0.6, 0.6);

    /* --- 位置：偏强但不过热最好 --- */
    const pctB = bb.pctB[i] == null ? 0.5 : bb.pctB[i];
    const pctBScore = pctB <= 0.9
      ? U.scale(pctB, -0.10, 0.90)
      : U.clamp(100 - (pctB - 0.9) * 180, 0, 100);
    const pos52 = (hi52 > lo52) ? (last - lo52) / (hi52 - lo52) : 0.5;
    const pos52Score = pos52 <= 0.92
      ? U.scale(pos52, 0, 0.92)
      : U.clamp(100 - (pos52 - 0.92) * 300, 55, 100);
    const positionScore = 0.5 * pctBScore + 0.5 * pos52Score;

    return {
      scores: {
        trend:      U.clamp(trendScore, 0, 100),
        momentum:   U.clamp(momentumScore, 0, 100),
        volatility: U.clamp(volScore, 0, 100),
        volume:     U.clamp(volumeScore, 0, 100),
        position:   U.clamp(positionScore, 0, 100)
      },
      raw: {
        last, ma20: ma20[i], ma60: ma60[i], vsMa20, vsMa60, maSpread, slope20,
        rsi14, roc20, roc60, macdHist: m.hist[i], macdDif: m.dif[i], macdDea: m.dea[i],
        atr14, atrPct, annVol, dd60, sharpe1y, ddWin,
        volRatio, obvSlope, pctB, pos52, hi52, lo52,
        bollMid: bb.mid[i], bollUpper: bb.upper[i], bollLower: bb.lower[i]
      }
    };
  }

  /* ---------------- 参考价位 ----------------
   *
   * 找现价下方最近的几档技术支撑，作为"试探位 / 低吸位 / 止损位"。
   * 全部来自均线、布林轨道、区间低点这些确定性计算，
   * 每一档都带上依据，用户能自己判断该不该信。
   * 这是对历史价格的算术描述，不含任何未来预测成分。
   */
  function calcLevels(bars, r) {
    const last = r.last;
    const atr = (r.atr14 && r.atr14 > 0) ? r.atr14 : last * 0.02;
    const lows = bars.map(b => b.low);
    const lowOf = n => Math.min.apply(null, lows.slice(-n));

    // 候选支撑，按从高到低排序，只保留低于现价的
    const cands = [
      { v: r.ma20,       name: 'MA20' },
      { v: r.ma60,       name: 'MA60' },
      { v: r.bollLower,  name: '布林下轨' },
      { v: lowOf(20),    name: '近20根低点' },
      { v: lowOf(60),    name: '近60根低点' }
    ].filter(c => c.v != null && isFinite(c.v) && c.v > 0 && c.v < last * 0.995)
     .sort((a, b) => b.v - a.v);

    let probe, deep;
    if (cands.length) {
      probe = { price: cands[0].v, basis: '最近支撑：' + cands[0].name };
    } else {
      // 价格已经跌破所有支撑，只能用波动率给一个观察位
      probe = { price: last - 0.5 * atr, basis: '现价 − 0.5×ATR（下方已无有效支撑）' };
    }

    // 低吸位要比试探位明显更低才有意义，否则往下推 1.2 个 ATR
    const lower = cands.filter(c => c.v < probe.price * 0.985);
    if (lower.length) {
      deep = { price: lower[0].v, basis: '次级支撑：' + lower[0].name };
    } else {
      deep = { price: probe.price - 1.2 * atr, basis: '试探位 − 1.2×ATR' };
    }

    const stop = {
      price: Math.max(0.01, deep.price - atr),
      basis: '低吸位 − 1×ATR（跌破则支撑判断失效）'
    };

    // 创新低 / 下方几乎没有支撑时，这些"买入位"是靠波动率外推出来的，
    // 不是真实存在的技术支撑。这种情况必须说清楚，否则等于诱导接飞刀。
    const atFreshLow = last <= lowOf(60) * 1.005;
    const warn = (cands.length <= 1) || atFreshLow;
    let warnText = '';
    if (atFreshLow) {
      warnText = '价格正处于近 60 根新低，下方没有历史成交密集区可依托，' +
                 '所谓"支撑"只是波动率外推的结果。';
    } else if (cands.length <= 1) {
      warnText = '现价下方仅剩 ' + cands.length + ' 档技术支撑，位置参考价值有限。';
    }

    const pctFrom = p => (p / last - 1) * 100;
    return {
      probe: { price: probe.price, basis: probe.basis, pct: pctFrom(probe.price) },
      deep:  { price: deep.price,  basis: deep.basis,  pct: pctFrom(deep.price) },
      stop:  { price: stop.price,  basis: stop.basis,  pct: pctFrom(stop.price) },
      atr: atr,
      supportCount: cands.length,
      warn: warn,
      warnText: warnText
    };
  }

  /* ---------------- 评级 ---------------- */

  function rate(score) {
    if (score >= 80) return { text: '强烈看多',   cls: 'up',   color: '#26a69a' };
    if (score >= 65) return { text: '看多',       cls: 'up',   color: '#4caf7d' };
    if (score >= 45) return { text: '中性观望',   cls: 'flat', color: '#4c8dff' };
    if (score >= 30) return { text: '偏空',       cls: 'down', color: '#f0a742' };
    return               { text: '强烈看空',   cls: 'down', color: '#ef5350' };
  }

  /* ---------------- 方向判断 ----------------
   *
   * 刻意写成"当前结构是什么 + 什么条件下会转向"，而不是"接下来会涨/会跌"。
   * 技术指标是历史价格的函数，没有预测能力；给一个可证伪的条件，
   * 用户至少能拿它去验证，而不是当预言接受。
   */
  function buildDirection(total, f, r, levels) {
    const s = f.scores;
    let head, cls;
    if (total >= 80)      { head = '技术面强势看涨'; cls = 'up'; }
    else if (total >= 65) { head = '技术面偏多';     cls = 'up'; }
    else if (total >= 45) { head = '技术面中性';     cls = 'flat'; }
    else if (total >= 30) { head = '技术面偏空';     cls = 'down'; }
    else                  { head = '技术面弱势看跌'; cls = 'down'; }

    // 趋势结构
    let trend;
    if (r.maSpread > 0.01 && r.vsMa20 > 0) trend = '均线多头排列';
    else if (r.maSpread < -0.01 && r.vsMa20 < 0) trend = '均线空头排列';
    else trend = '均线纠缠方向未明';

    // 动量
    const mom = s.momentum >= 65 ? '动量偏强'
              : s.momentum <= 35 ? '动量偏弱' : '动量中性';

    // 区间位置
    const pos = r.pos52 >= 0.9 ? '逼近 52 周高位'
              : r.pos52 <= 0.15 ? '接近 52 周低位'
              : '处于区间中段';

    // 过热/超卖提示
    let extra = '';
    if (r.rsi14 != null && r.rsi14 > 75) extra = ' RSI 已超买，短线追高的风险回报比不佳。';
    else if (r.rsi14 != null && r.rsi14 < 25) extra = ' RSI 已超卖，可能出现技术性反弹。';

    const key = levels.probe;
    const cond = cls === 'down'
      ? '若能站回 ' + key.price.toFixed(2) + ' 上方，偏空结构才有修复迹象。'
      : '跌破 ' + key.price.toFixed(2) + '（' + key.pct.toFixed(1) + '%）则当前结构转弱。';

    return {
      text: head,
      cls: cls,
      sentence: trend + '、' + mom + '、' + pos + '。' + cond + extra
    };
  }

  /* ---------------- 生成分析要点 ---------------- */

  function buildReasons(f, symbol, interval) {
    const r = f.raw, s = f.scores;
    const out = [];
    const pct = v => (v * 100).toFixed(2) + '%';
    const u = UNIT[interval] || '日';       // 周期单位：日 / 周 / 月

    // 趋势
    if (r.ma20 && r.ma60) {
      if (r.maSpread > 0 && r.vsMa20 > 0) {
        out.push('均线多头排列：价格 ' + r.last.toFixed(2) + ' 位于 MA20(' + r.ma20.toFixed(2) +
                 ') 与 MA60(' + r.ma60.toFixed(2) + ') 上方，MA20 高出 MA60 ' + pct(r.maSpread) + '。');
      } else if (r.maSpread < 0 && r.vsMa20 < 0) {
        out.push('均线空头排列：价格跌破 MA20(' + r.ma20.toFixed(2) + ')，MA20 低于 MA60 ' +
                 pct(Math.abs(r.maSpread)) + '，中期趋势承压。');
      } else {
        out.push('均线纠缠：价格与 MA20 偏离 ' + pct(r.vsMa20) + '，趋势方向不明确，观望为主。');
      }
      out.push('MA20 近 10 ' + u + '斜率 ' + pct(r.slope20) + (r.slope20 > 0 ? '，中枢仍在抬升。' : '，中枢走平或下移。'));
    }

    // 动量
    if (r.rsi14 != null) {
      const tag = r.rsi14 > 70 ? '进入超买区，短线追高风险上升'
                : r.rsi14 < 30 ? '进入超卖区，存在技术性反弹需求'
                : '处于中性区间';
      out.push('RSI(14) = ' + r.rsi14.toFixed(1) + '，' + tag + '。');
    }
    if (r.roc20 != null) {
      out.push('近 20 ' + u + '涨跌 ' + r.roc20.toFixed(2) + '%，近 60 ' + u + ' ' +
               (r.roc60 == null ? '—' : r.roc60.toFixed(2) + '%') + '。');
    }
    if (r.macdHist != null) {
      out.push('MACD 柱 ' + r.macdHist.toFixed(3) + '（DIF ' + (r.macdDif || 0).toFixed(3) +
               ' / DEA ' + (r.macdDea || 0).toFixed(3) + '），' +
               (r.macdHist > 0 ? '多头动能占优。' : '空头动能占优。'));
    }

    // 风险
    out.push('年化波动率 ' + pct(r.annVol) + '，ATR 占价格 ' + r.atrPct.toFixed(2) +
             '%，近 ' + r.ddWin + ' ' + u + '最大回撤 ' + pct(r.dd60) + '。' +
             (s.volatility < 40 ? ' 风险偏高，建议压缩单笔仓位。' : ''));

    // 量能
    out.push('5 ' + u + '均量 / 20 ' + u + '均量 = ' + r.volRatio.toFixed(2) +
             '，OBV 20 ' + u + '斜率 ' + r.obvSlope.toFixed(2) +
             (r.obvSlope > 0.1 ? '，资金呈净流入特征。' : r.obvSlope < -0.1 ? '，资金呈净流出特征。' : '，量能中性。'));

    // 位置
    out.push('布林 %B = ' + (r.pctB * 100).toFixed(1) + '%，处于 52 周区间的 ' +
             (r.pos52 * 100).toFixed(1) + '% 分位（高 ' + r.hi52.toFixed(2) + ' / 低 ' + r.lo52.toFixed(2) + '）。');

    // 夏普
    out.push('过去一年夏普比率约 ' + r.sharpe1y.toFixed(2) +
             (r.sharpe1y > 1 ? '，风险调整后收益良好。' : r.sharpe1y < 0 ? '，风险调整后收益为负。' : '，中规中矩。'));

    return out;
  }

  function buildSummary(symbol, total, f, interval) {
    const s = f.scores;
    const entries = Object.keys(s).map(k => [k, s[k]]).sort((a, b) => b[1] - a[1]);
    const best = FACTOR_META[entries[0][0]].label;
    const worst = FACTOR_META[entries[entries.length - 1][0]].label;
    return symbol + ' 基于' + (INTERVAL_LABEL[interval] || '日线') + '综合得分 ' + total +
           '，最强项是「' + best + '」（' + entries[0][1].toFixed(0) +
           '），最弱项是「' + worst + '」（' + entries[entries.length - 1][1].toFixed(0) + '）。';
  }

  /* ---------------- 分析入口 ---------------- */

  function analyze(bars, symbol, interval) {
    const iv = interval || 'day';
    const f = calcFactors(bars, PERIODS_PER_YEAR[iv]);
    const w = CFG.agentWeights;
    let total = 0;
    Object.keys(w).forEach(k => { total += f.scores[k] * w[k]; });
    total = Math.round(U.clamp(total, 0, 100));

    const levels = calcLevels(bars, f.raw);

    return {
      symbol,
      interval: iv,
      total,
      rating: rate(total),
      factors: f.scores,
      raw: f.raw,
      levels: levels,
      direction: buildDirection(total, f, f.raw, levels),
      reasons: buildReasons(f, symbol, iv),
      summary: buildSummary(symbol, total, f, iv)
    };
  }

  /* ---------------- 渲染 ---------------- */

  function barColor(v) {
    if (v >= 70) return '#26a69a';
    if (v >= 50) return '#4c8dff';
    if (v >= 35) return '#f0a742';
    return '#ef5350';
  }

  function render(res) {
    // 环形分数
    const circumference = 2 * Math.PI * 52;
    const ring = $('#ringFg');
    ring.style.strokeDasharray = circumference;
    ring.style.strokeDashoffset = circumference * (1 - res.total / 100);
    ring.style.stroke = res.rating.color;

    $('#scoreValue').textContent = res.total;
    const ratingEl = $('#scoreRating');
    ratingEl.textContent = res.rating.text;
    ratingEl.className = 'rating ' + res.rating.cls;
    $('#scoreSummary').textContent = res.summary;

    // 因子条
    const w = CFG.agentWeights;
    $('#factorList').innerHTML = Object.keys(FACTOR_META).map(k => {
      const v = res.factors[k];
      const meta = FACTOR_META[k];
      return '<div class="factor">' +
          '<div class="f-name">' + meta.label +
            '<small>' + meta.desc + ' · 权重' + (w[k] * 100).toFixed(0) + '%</small></div>' +
          '<div class="f-bar"><i style="width:' + v.toFixed(1) + '%;background:' + barColor(v) + '"></i></div>' +
          '<div class="f-val">' + v.toFixed(0) + '</div>' +
        '</div>';
    }).join('');

    // 方向判断
    const d = res.direction;
    $('#directionBox').innerHTML =
      '<div class="dir-head ' + d.cls + '">' +
        '<span class="dir-arrow">' + (d.cls === 'up' ? '▲' : d.cls === 'down' ? '▼' : '▬') + '</span>' +
        d.text +
      '</div>' +
      '<div class="dir-text">' + d.sentence + '</div>';

    // 参考价位
    const L = res.levels;
    const cards = [
      ['试探买入位', L.probe, 'lv-probe'],
      ['低吸参考位', L.deep,  'lv-deep'],
      ['止损参考位', L.stop,  'lv-stop']
    ];
    const warnEl = $('#levelWarn');
    if (L.warn) {
      warnEl.textContent = '⚠ ' + L.warnText;
      warnEl.classList.remove('hidden');
    } else {
      warnEl.classList.add('hidden');
    }

    $('#levelCards').innerHTML = cards.map(c => {
      const lv = c[1];
      return '<div class="level-card ' + c[2] + '">' +
          '<label>' + c[0] + '</label>' +
          '<span class="lv-price">' + lv.price.toFixed(2) + '</span>' +
          '<span class="lv-pct ' + U.dirClass(lv.pct) + '">距现价 ' + lv.pct.toFixed(1) + '%</span>' +
          '<small>' + lv.basis + '</small>' +
        '</div>';
    }).join('');

    // 要点
    $('#agentReasons').innerHTML = res.reasons.map(t => '<li>' + t + '</li>').join('');

    // 统计
    const r = res.raw;
    const u = UNIT[res.interval] || '日';
    const stats = [
      ['周期',        INTERVAL_LABEL[res.interval] || '日线', ''],
      ['现价',        r.last.toFixed(2), ''],
      ['年化波动率',  (r.annVol * 100).toFixed(1) + '%', ''],
      ['ATR 占比',    r.atrPct.toFixed(2) + '%', ''],
      ['近' + r.ddWin + u + '最大回撤', (r.dd60 * 100).toFixed(1) + '%', 'down'],
      ['夏普(1年)',   r.sharpe1y.toFixed(2), U.dirClass(r.sharpe1y)],
      ['RSI(14)',     r.rsi14 == null ? '—' : r.rsi14.toFixed(1), ''],
      ['52周位置',    (r.pos52 * 100).toFixed(1) + '%', ''],
      ['量比(5/20)',  r.volRatio.toFixed(2), U.dirClass(r.volRatio - 1)]
    ];
    $('#agentStats').innerHTML = stats.map(s =>
      '<div><label>' + s[0] + '</label><span class="' + s[2] + '">' + s[1] + '</span></div>'
    ).join('');
  }

  function run() {
    const hist = QL.state.history;
    if (!hist || !hist.bars.length) {
      $('#scoreSummary').textContent = '还没有行情数据。';
      return null;
    }
    const interval = ($('#agInterval') || { value: 'day' }).value;
    const bars = IND.resample(hist.bars, interval);

    // MA60 + 60 周期 ROC 是打分的基础，样本不够只能算出一堆 null
    if (bars.length < 70) {
      $('#scoreSummary').textContent =
        (INTERVAL_LABEL[interval] || '日线') + '只有 ' + bars.length +
        ' 根，不足 70 根，趋势与动量因子算不出来。请改用更细的周期。';
      return null;
    }

    const res = analyze(bars, hist.symbol, interval);
    render(res);
    QL.state.lastAnalysis = res;
    return res;
  }

  function init() {
    $('#btnRunAgent').addEventListener('click', run);
    $('#agInterval').addEventListener('change', () => {
      if (QL.state.lastAnalysis) run();       // 已经分析过就按新周期重算
    });
    // 切换标的后清空旧结果，避免看错标的
    U.bus.on('symbol:loaded', () => {
      $('#scoreValue').textContent = '--';
      $('#scoreRating').textContent = '等待分析';
      $('#scoreRating').className = 'rating';
      $('#ringFg').style.strokeDashoffset = 2 * Math.PI * 52;
      $('#scoreSummary').textContent = '点击「运行分析」，对 ' + QL.state.symbol + ' 进行五维度打分。';
      $('#factorList').innerHTML = '';
      $('#agentReasons').innerHTML = '<li class="muted">暂无</li>';
      $('#agentStats').innerHTML = '';
      $('#directionBox').innerHTML = '<span class="muted">运行分析后显示</span>';
      $('#levelCards').innerHTML = '';
    });
  }

  return { init, run, analyze, calcFactors };
})();
