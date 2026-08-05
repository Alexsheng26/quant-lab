/* ============================================================
 * agents.js —— 个股全景：三个 Agent 的前端编排
 *
 *   ① 量化分析 Agent  /api/quant      全市场分位 + 六边形雷达 + 结构判断
 *   ② 新闻 Agent      /api/news       资讯扫描 + 情绪 + 来源分布 + 检索问答
 *   ③ 研究 Agent      /api/filings    SEC 申报列表
 *                     /api/financials XBRL 结构化财务
 *
 * 三个都依赖后端（要访问 Yahoo / SEC），MOCK 模式下没法工作，
 * 这时直接把话说清楚，而不是转个圈然后空白。
 * ============================================================ */

window.QL = window.QL || {};

QL.agents = (function () {
  const U = QL.utils;
  const CFG = QL.CONFIG;
  const $ = U.$;

  let radar = null;
  let loadedFor = null;          // 已经加载过的标的，避免重复请求

  /* ---------------- 通用请求 ---------------- */

  async function api(path, params) {
    const url = new URL(CFG.apiBase + path);
    Object.keys(params || {}).forEach(k => url.searchParams.set(k, params[k]));
    const resp = await fetch(url.toString(), { headers: { Accept: 'application/json' } });
    if (!resp.ok) throw new Error('HTTP ' + resp.status);
    return resp.json();
  }

  function needBackend() {
    if (QL.data.mode === 'live') return false;
    const msg = '<div class="pad muted">三个 Agent 都需要后端支持（要访问 Yahoo Finance 和 SEC EDGAR）。<br>' +
                '请双击 <code>quantlab.bat</code> 启动后端，或点右上角徽章切到 LIVE。</div>';
    $('#quantVerdict').innerHTML = '<span class="muted">需要后端</span>';
    $('#newsList').innerHTML = msg;
    $('#filingList').innerHTML = msg;
    $('#quantAxes').innerHTML = '';
    if (radar) radar.setData([]);
    return true;
  }

  const fmtPct = v => v == null ? '—' : v.toFixed(0);

  /**
   * 六边形图是纯 Canvas 画的，屏幕阅读器读不到形状。
   * 这里把每根轴的分位数写成一句话挂到 aria-label 上，
   * 读屏用户听到的信息量和看图的人一致。
   */
  function describeRadar(symbol, res) {
    const cv = $('#radarChart');
    if (!cv) return;
    const known = (res.axes || []).filter(a => a.marketPct != null);
    if (!known.length) {
      cv.setAttribute('aria-label', '六边形分位雷达图，暂无数据');
      return;
    }
    const parts = known.map(a =>
      a.label + ' 全市场分位 ' + fmtPct(a.marketPct) +
      (a.sectorPct == null ? '' : '、同行业分位 ' + fmtPct(a.sectorPct)));
    const v = res.verdict || {};
    cv.setAttribute('aria-label',
      symbol + ' 六边形分位雷达图，' + known.length + ' 个维度：' + parts.join('；') +
      '。分位越高越好，100 为全市场最优。' +
      (v.tag ? '结论：' + v.tag + '。' : '') +
      '同样的数字也列在下方「各维度分位」里。');
  }

  /** 指标英文名 -> 中文 */
  const METRIC_CN = {
    trailingPE: '市盈率 TTM', forwardPE: '预期市盈率', priceToBook: '市净率',
    enterpriseToEbitda: 'EV/EBITDA', returnOnEquity: 'ROE 净资产收益率',
    returnOnAssets: 'ROA 总资产收益率', profitMargins: '净利率',
    grossMargins: '毛利率', operatingMargins: '营业利润率',
    revenueGrowth: '营收增速', earningsGrowth: '盈利增速',
    debtToEquity: '负债权益比', currentRatio: '流动比率',
    fiftyTwoWeekChange: '52周涨幅', pctOf52WeekHigh: '距52周高点',
    logMarketCap: '市值(对数)'
  };

  function fmtMetric(name, v) {
    if (v == null) return '—';
    if (['returnOnEquity', 'returnOnAssets', 'profitMargins', 'grossMargins',
         'operatingMargins', 'revenueGrowth', 'earningsGrowth',
         'fiftyTwoWeekChange'].indexOf(name) >= 0) {
      return (v * 100).toFixed(1) + '%';
    }
    if (name === 'pctOf52WeekHigh') return (v * 100).toFixed(1) + '%';
    if (name === 'logMarketCap') return '$' + U.fmtVol(Math.pow(10, v));
    return v.toFixed(2);
  }

  /* ---------------- ① 量化 Agent ---------------- */

  async function loadQuant(symbol) {
    $('#quantVerdict').innerHTML = '<span class="muted">正在计算全市场分位…</span>';
    let res;
    try {
      res = await api('/api/quant', { symbol });
    } catch (e) {
      $('#quantVerdict').innerHTML = '<span class="muted">请求失败：' + e.message + '</span>';
      return;
    }
    if (!res.ok) {
      $('#quantVerdict').innerHTML = '<span class="muted">无法计算：' + (res.reason || '未知原因') + '</span>';
      radar.setData([]);
      $('#radarChart').setAttribute('aria-label', '六边形分位雷达图，暂无数据');
      return;
    }

    const meta = res.snapshot || {};
    $('#quantUniverse').textContent =
      '参照池 ' + (meta.count || res.universeSize) + ' 只 · 同行业 ' + res.peerCount +
      ' 只' + (meta.builtAt ? ' · 快照 ' + meta.builtAt.slice(0, 10) : '');

    radar.setData(res.axes.map(a => ({
      label: a.label, value: a.marketPct, sector: a.sectorPct
    })));
    describeRadar(symbol, res);

    const v = res.verdict || {};
    $('#quantVerdict').innerHTML =
      '<div class="verdict-tag ' + (v.cls || 'flat') + '">' + (v.tag || '—') + '</div>' +
      '<div class="verdict-text">' + (v.text || '') + '</div>' +
      renderTotal(res);

    $('#quantAxes').innerHTML = res.axes.map(a => {
      const val = a.marketPct;
      const color = val == null ? '#5a6479' : val >= 70 ? '#26a69a' : val >= 40 ? '#4c8dff' : '#ef5350';
      return '<div class="axis-row">' +
          '<span class="ax-name">' + a.label + '</span>' +
          '<span class="ax-bar"><i style="width:' + (val == null ? 0 : val) + '%;background:' + color + '"></i></span>' +
          '<span class="ax-val">' + fmtPct(val) + '</span>' +
          '<span class="ax-sec">行业 ' + fmtPct(a.sectorPct) + '</span>' +
        '</div>';
    }).join('');

    const rows = [];
    res.axes.forEach(a => {
      a.detail.forEach(d => {
        rows.push('<tr>' +
          '<td>' + (METRIC_CN[d.metric] || d.metric) +
            ' <span class="muted">(' + a.label + ')</span></td>' +
          '<td class="num">' + fmtMetric(d.metric, d.value) + (d.note ? ' <span class="muted">' + d.note + '</span>' : '') + '</td>' +
          '<td class="num ' + pctCls(d.marketPct) + '">' + fmtPct(d.marketPct) + '</td>' +
          '<td class="num ' + pctCls(d.sectorPct) + '">' + fmtPct(d.sectorPct) + '</td>' +
        '</tr>');
      });
    });
    $('#quantDetail tbody').innerHTML = rows.join('') ||
      '<tr><td colspan="4" class="muted">没有可用指标</td></tr>';
  }

  /**
   * 总分只在有足够维度时才显示。
   * ETF 这类标的只有动量和规模有数据，拿两个维度平均出"76 分"
   * 会让人以为是完整评分，反而比不给分更误导。
   */
  function renderTotal(res) {
    const cov = res.coverage;
    if (res.total != null) {
      return '<div class="verdict-total">六维平均分位 <b>' + res.total.toFixed(0) + '</b> / 100' +
             (cov && cov.withData < cov.total
               ? ' <span class="muted">（' + cov.withData + '/' + cov.total + ' 个维度有数据）</span>'
               : '') + '</div>';
    }
    if (!cov) return '';
    return '<div class="verdict-total muted">仅 ' + cov.withData + '/' + cov.total +
           ' 个维度有数据' + (cov.missing && cov.missing.length
             ? '（缺：' + cov.missing.join('、') + '）' : '') +
           '，不足以给出综合分位。</div>';
  }

  function pctCls(v) {
    if (v == null) return '';
    return v >= 70 ? 'up' : v <= 30 ? 'down' : '';
  }

  /* ---------------- ② 新闻 Agent ---------------- */

  async function loadNews(symbol) {
    $('#newsList').innerHTML = '<div class="pad muted">正在扫描资讯…</div>';
    let res;
    try {
      res = await api('/api/news', { symbol, limit: 20 });
    } catch (e) {
      $('#newsList').innerHTML = '<div class="pad muted">请求失败：' + e.message + '</div>';
      return;
    }
    if (!res.ok || !res.items || !res.items.length) {
      $('#newsList').innerHTML = '<div class="pad muted">没有抓到这只标的的新闻' +
        (res.error ? '（' + res.error + '）' : '') + '</div>';
      $('#newsSources').innerHTML = '';
      $('#newsSentiment').textContent = '';
      return;
    }

    const o = res.overall;
    const cls = o.label === '偏多' ? 'up' : o.label === '偏空' ? 'down' : 'flat';
    $('#newsSentiment').innerHTML =
      '<span class="' + cls + '">整体' + o.label + '</span> · ' +
      o.positive + ' 正 / ' + o.neutral + ' 中 / ' + o.negative + ' 负';

    // 来源分布：单一媒体占比过高就是信息茧房，直接标出来
    const top = res.sources[0];
    const share = top ? top.count / res.count : 0;
    $('#newsSources').innerHTML =
      '<div class="src-line">来源 ' + res.sources.length + ' 家：' +
        res.sources.map(s => '<span class="src-chip">' + s.name + ' ' + s.count + '</span>').join('') +
      '</div>' +
      (share >= 0.6
        ? '<div class="src-warn">⚠ ' + top.name + ' 一家占了 ' + (share * 100).toFixed(0) +
          '%，口径单一，建议再找其他来源交叉验证。</div>'
        : '');

    $('#newsList').innerHTML = res.items.map(n => {
      const sc = n.sentimentLabel === '偏多' ? 'up' : n.sentimentLabel === '偏空' ? 'down' : 'flat';
      return '<div class="news-item">' +
          '<div class="news-title">' +
            (n.url ? '<a href="' + n.url + '" target="_blank" rel="noopener">' + esc(n.title) + '</a>'
                   : esc(n.title)) +
          '</div>' +
          '<div class="news-meta">' +
            '<span class="' + sc + '">' + n.sentimentLabel + '</span>' +
            '<span>' + esc(n.publisher) + '</span>' +
            '<span>' + fmtTime(n.published) + '</span>' +
          '</div>' +
          (n.summary ? '<div class="news-sum">' + esc(n.summary.slice(0, 160)) + '</div>' : '') +
        '</div>';
    }).join('');
  }

  async function askNews() {
    const q = $('#newsQuestion').value.trim();
    const symbol = QL.state.symbol;
    if (!q || !symbol) return;
    const box = $('#newsAnswer');
    box.classList.remove('hidden');
    box.innerHTML = '<div class="muted">检索中…</div>';
    try {
      const res = await api('/api/news/ask', { symbol, q });
      if (!res.ok) { box.innerHTML = '<div class="muted">失败：' + res.reason + '</div>'; return; }

      const gen = res.mode === 'generative';
      const cited = res.cited || [];
      const CONF = { high: ['把握较高', 'up'], medium: ['把握一般', 'flat'], low: ['把握较低', 'down'] };
      const conf = CONF[res.confidence] || null;

      // 明确区分「模型综合的」和「原文摘录」。没接 LLM 时绝不假装有 AI。
      let html = '<div class="ans-head">' +
        '<span class="ans-mode ' + (gen ? 'gen' : '') + '">' +
          (gen ? '生成式 · ' + esc(res.model || 'Claude') : '检索式 · 非生成式') +
        '</span>' +
        (conf ? '<span class="ans-conf ' + conf[1] + '">' + conf[0] + '</span>' : '') +
        '<div class="ans-text">' + esc(res.answer) + '</div>' +
        (res.caveat ? '<div class="ans-caveat">⚠ ' + esc(res.caveat) + '</div>' : '') +
        (res.llmError ? '<div class="ans-caveat">生成式回答不可用（' + esc(res.llmError) +
                        '），以下为检索结果</div>' : '') +
      '</div>';

      html += (res.hits || []).map((h, i) => {
        const n = i + 1;
        const used = cited.indexOf(n) >= 0;
        return '<div class="ans-hit' + (used ? ' cited' : '') + '">' +
            '<b>[' + n + '] ' +
              (h.url ? '<a href="' + h.url + '" target="_blank" rel="noopener">' + esc(h.title) + '</a>'
                     : esc(h.title)) + '</b>' +
            '<div class="muted">' + esc(h.publisher) + ' · ' + fmtTime(h.published) +
              (used ? ' · <span class="up">已引用</span>' : '') + '</div>' +
            (h.summary ? '<div class="hit-sum">' + esc(h.summary.slice(0, 200)) + '</div>' : '') +
          '</div>';
      }).join('');

      box.innerHTML = html;
    } catch (e) {
      box.innerHTML = '<div class="muted">请求失败：' + e.message + '</div>';
    }
  }

  /* ---------------- ③ 研究 Agent ---------------- */

  async function loadResearch(symbol) {
    $('#filingList').innerHTML = '<div class="pad muted">正在读取 SEC 申报…</div>';
    $('#financialSummary').innerHTML = '';

    let fil, fin;
    try {
      [fil, fin] = await Promise.all([
        api('/api/filings', { symbol, limit: 20 }),
        api('/api/financials', { symbol })
      ]);
    } catch (e) {
      $('#filingList').innerHTML = '<div class="pad muted">请求失败：' + e.message + '</div>';
      return;
    }

    if (!fil.ok || !fil.found) {
      $('#filingCompany').textContent = '';
      $('#filingList').innerHTML = '<div class="pad muted">' +
        (fil.reason || 'SEC 没有这只标的的申报记录') + '</div>';
    } else {
      $('#filingCompany').textContent = fil.companyName + (fil.sic ? ' · ' + fil.sic : '');
      const items = (fil.keyFilings || []).concat();
      $('#filingList').innerHTML = items.length
        ? items.map(f =>
            '<div class="filing-item">' +
              '<span class="form-tag">' + esc(f.form) + '</span>' +
              '<div class="filing-main">' +
                '<div>' + (f.url
                  ? '<a href="' + f.url + '" target="_blank" rel="noopener">' + esc(f.meaning) + '</a>'
                  : esc(f.meaning)) + '</div>' +
                '<div class="muted">申报 ' + f.filingDate +
                  (f.reportDate ? ' · 报告期 ' + f.reportDate : '') + '</div>' +
              '</div>' +
            '</div>').join('')
        : '<div class="pad muted">没有 10-K / 10-Q / 8-K 等主要申报</div>';
    }

    // XBRL 财务：直接给结构化数字，不用翻 PDF
    if (fin.ok && fin.found && fin.series && Object.keys(fin.series).length) {
      const s = fin.series, d = fin.derived || {};
      const order = ['revenue', 'netIncome', 'grossProfit', 'operatingIncome',
                     'cashFromOps', 'equity', 'assets'];

      // 列头用后端给的 year 字段。别在这里自己 slice(0,4)——
      // 财年跨年的公司（NVDA 财年一月底结束）会算出重复年份。
      // 再去一次重，防止后端换实现后又冒出来。
      const rev = s.revenue ? s.revenue.rows : [];
      const years = [];
      rev.slice(-5).forEach(r => {
        const y = r.year || r.end.slice(0, 4);
        if (years.indexOf(y) < 0) years.push(y);
      });

      let html = '<div class="fin-head">SEC XBRL 结构化财务（年报口径，无需翻阅 PDF）</div>';
      html += '<div class="table-wrap"><table class="table"><thead><tr><th>科目</th>';
      years.forEach(y => { html += '<th class="num">' + y + '</th>'; });
      html += '</tr></thead><tbody>';

      order.forEach(k => {
        if (!s[k]) return;
        const byYear = {};
        s[k].rows.forEach(r => { byYear[r.year || r.end.slice(0, 4)] = r.val; });
        html += '<tr><td>' + s[k].label + '</td>';
        years.forEach(y => {
          const v = byYear[y];
          html += '<td class="num">' + (v == null ? '—' : '$' + U.fmtVol(v)) + '</td>';
        });
        html += '</tr>';
      });
      html += '</tbody></table></div>';

      const chips = [];
      if (d.revenueYoY != null) chips.push(['营收同比', U.fmtPct(d.revenueYoY), U.dirClass(d.revenueYoY)]);
      if (d.netIncomeYoY != null) chips.push(['净利同比', U.fmtPct(d.netIncomeYoY), U.dirClass(d.netIncomeYoY)]);
      if (d.netMargin != null) chips.push(['净利率', (d.netMargin * 100).toFixed(1) + '%', '']);
      if (d.roe != null) chips.push(['ROE', (d.roe * 100).toFixed(1) + '%', U.dirClass(d.roe)]);
      if (chips.length) {
        html += '<div class="fin-chips">' + chips.map(c =>
          '<div><label>' + c[0] + '</label><span class="' + c[2] + '">' + c[1] + '</span></div>'
        ).join('') + '</div>';
      }
      $('#financialSummary').innerHTML = html;
    } else if (fin.ok && !fin.found) {
      $('#financialSummary').innerHTML = '<div class="pad muted">' + (fin.reason || '无 XBRL 财务数据') + '</div>';
    }
  }

  /* ---------------- 工具 ---------------- */

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function fmtTime(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    if (isNaN(d.getTime())) return String(iso).slice(0, 16);
    const diff = (Date.now() - d.getTime()) / 3600000;
    if (diff < 1) return Math.max(1, Math.round(diff * 60)) + ' 分钟前';
    if (diff < 24) return Math.round(diff) + ' 小时前';
    if (diff < 24 * 7) return Math.round(diff / 24) + ' 天前';
    return U.fmtDate(d);
  }

  /* ---------------- 编排 ---------------- */

  async function run() {
    const symbol = QL.state.symbol;
    if (!symbol) return;
    if (needBackend()) return;

    loadedFor = symbol;
    $('#newsAnswer').classList.add('hidden');
    // 三个 Agent 并行跑，互不阻塞；任何一个失败不影响其他两个
    await Promise.allSettled([
      loadQuant(symbol),
      loadNews(symbol),
      loadResearch(symbol)
    ]);
  }

  function reset() {
    loadedFor = null;
    if (radar) radar.setData([]);
    $('#quantVerdict').innerHTML = '<span class="muted">点击「运行全景分析」</span>';
    $('#quantAxes').innerHTML = '';
    $('#quantUniverse').textContent = '';
    $('#quantDetail tbody').innerHTML = '<tr><td colspan="4" class="muted">—</td></tr>';
    $('#newsList').innerHTML = '<div class="pad muted">未加载</div>';
    $('#newsSources').innerHTML = '';
    $('#newsSentiment').textContent = '';
    $('#newsAnswer').classList.add('hidden');
    $('#filingList').innerHTML = '<div class="pad muted">未加载</div>';
    $('#financialSummary').innerHTML = '';
    $('#filingCompany').textContent = '';
  }

  function init() {
    radar = new QL.chart.RadarChart($('#radarChart'));
    $('#btnRunPanorama').addEventListener('click', run);
    $('#btnAskNews').addEventListener('click', askNews);
    $('#newsQuestion').addEventListener('keydown', e => {
      if (e.key === 'Enter') askNews();
    });

    U.bus.on('symbol:loaded', reset);
    // 切到这个标签页时，如果还没为当前标的加载过就自动跑一次
    U.bus.on('view:change', view => {
      if (view !== 'panorama') return;
      if (radar) radar.draw();
      if (loadedFor !== QL.state.symbol) run();
    });
  }

  return { init, run };
})();
