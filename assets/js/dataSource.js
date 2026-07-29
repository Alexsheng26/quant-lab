/* ============================================================
 * dataSource.js —— 数据适配层
 *
 * 这一层是整个项目的关键抽象：上层（行情/回测/Agent）只认下面这套接口，
 * 不关心数据是模拟生成的还是后端 akshare / yfinance 推过来的。
 *
 *   QL.data.search(q)              -> Promise<[{symbol, name, exchange}]>
 *   QL.data.getHistory(symbol)     -> Promise<{symbol, name, exchange, bars:[Bar]}>
 *   QL.data.getQuote(symbol)       -> Promise<Quote>
 *
 *   Bar   = {date:'YYYY-MM-DD', open, high, low, close, volume}
 *   Quote = {symbol, name, exchange, last, prevClose, open, high, low, volume,
 *            change, changePct, time}
 *
 * 接真实数据时只需要在 LiveProvider 里把 fetch 的 URL / 字段映射对上即可，
 * 其余代码一行都不用动。
 * ============================================================ */

window.QL = window.QL || {};

QL.data = (function () {
  const U = QL.utils;
  const CFG = QL.CONFIG;

  /* ------------------------------------------------------------
   * 精调标的（mock 模式下让常见股票的模拟行情更贴近真实特征）
   *   basePrice —— 只影响模拟价格量级，跟真实价格无关
   *   vol       —— 年化总波动率
   *   drift     —— 年化漂移
   *   beta      —— 对共同市场因子的暴露，决定个股之间的联动
   *
   * 全量代码表在 assets/data/symbols.js（11000+ 个，由
   * backend/build_symbols.py 从 NASDAQ Trader 官方清单生成）。
   * 不在这份精调表里的代码，参数由代码名哈希确定性推导。
   * ---------------------------------------------------------- */
  const CURATED = [
    { symbol: 'AAPL',  name: '苹果 Apple',              exchange: 'NASDAQ',   basePrice: 225,  vol: 0.24, drift: 0.14,  beta: 1.15 },
    { symbol: 'NVDA',  name: '英伟达 NVIDIA',            exchange: 'NASDAQ',   basePrice: 178,  vol: 0.48, drift: 0.42,  beta: 1.85 },
    { symbol: 'MSFT',  name: '微软 Microsoft',          exchange: 'NASDAQ',   basePrice: 430,  vol: 0.22, drift: 0.16,  beta: 1.05 },
    { symbol: 'TSLA',  name: '特斯拉 Tesla',            exchange: 'NASDAQ',   basePrice: 340,  vol: 0.55, drift: 0.10,  beta: 1.90 },
    { symbol: 'AMZN',  name: '亚马逊 Amazon',           exchange: 'NASDAQ',   basePrice: 205,  vol: 0.28, drift: 0.18,  beta: 1.25 },
    { symbol: 'GOOGL', name: '谷歌 Alphabet',           exchange: 'NASDAQ',   basePrice: 190,  vol: 0.26, drift: 0.15,  beta: 1.10 },
    { symbol: 'META',  name: 'Meta 平台',               exchange: 'NASDAQ',   basePrice: 590,  vol: 0.33, drift: 0.22,  beta: 1.30 },
    { symbol: 'AMD',   name: '超威半导体 AMD',           exchange: 'NASDAQ',   basePrice: 165,  vol: 0.46, drift: 0.12,  beta: 1.80 },
    { symbol: 'AVGO',  name: '博通 Broadcom',           exchange: 'NASDAQ',   basePrice: 240,  vol: 0.34, drift: 0.30,  beta: 1.40 },
    { symbol: 'NFLX',  name: '奈飞 Netflix',            exchange: 'NASDAQ',   basePrice: 760,  vol: 0.31, drift: 0.20,  beta: 1.20 },
    { symbol: 'INTC',  name: '英特尔 Intel',            exchange: 'NASDAQ',   basePrice: 24,   vol: 0.42, drift: -0.08, beta: 1.10 },
    { symbol: 'MU',    name: '美光科技 Micron',          exchange: 'NASDAQ',   basePrice: 105,  vol: 0.45, drift: 0.18,  beta: 1.60 },
    { symbol: 'QCOM',  name: '高通 Qualcomm',           exchange: 'NASDAQ',   basePrice: 165,  vol: 0.30, drift: 0.09,  beta: 1.25 },
    { symbol: 'PLTR',  name: 'Palantir',                exchange: 'NASDAQ',   basePrice: 62,   vol: 0.58, drift: 0.50,  beta: 1.75 },
    { symbol: 'COIN',  name: 'Coinbase',                exchange: 'NASDAQ',   basePrice: 245,  vol: 0.68, drift: 0.25,  beta: 2.10 },
    { symbol: 'JPM',   name: '摩根大通 JPMorgan',        exchange: 'NYSE',     basePrice: 240,  vol: 0.20, drift: 0.12,  beta: 1.00 },
    { symbol: 'BAC',   name: '美国银行 Bank of America', exchange: 'NYSE',     basePrice: 44,   vol: 0.24, drift: 0.08,  beta: 1.15 },
    { symbol: 'V',     name: 'Visa',                    exchange: 'NYSE',     basePrice: 300,  vol: 0.18, drift: 0.13,  beta: 0.90 },
    { symbol: 'JNJ',   name: '强生 Johnson & Johnson',   exchange: 'NYSE',     basePrice: 158,  vol: 0.15, drift: 0.05,  beta: 0.55 },
    { symbol: 'UNH',   name: '联合健康 UnitedHealth',    exchange: 'NYSE',     basePrice: 560,  vol: 0.22, drift: 0.07,  beta: 0.70 },
    { symbol: 'XOM',   name: '埃克森美孚 Exxon Mobil',   exchange: 'NYSE',     basePrice: 118,  vol: 0.23, drift: 0.06,  beta: 0.75 },
    { symbol: 'WMT',   name: '沃尔玛 Walmart',          exchange: 'NYSE',     basePrice: 92,   vol: 0.19, drift: 0.20,  beta: 0.60 },
    { symbol: 'KO',    name: '可口可乐 Coca-Cola',       exchange: 'NYSE',     basePrice: 68,   vol: 0.14, drift: 0.04,  beta: 0.50 },
    { symbol: 'DIS',   name: '迪士尼 Disney',           exchange: 'NYSE',     basePrice: 96,   vol: 0.28, drift: 0.02,  beta: 1.20 },
    { symbol: 'BA',    name: '波音 Boeing',             exchange: 'NYSE',     basePrice: 155,  vol: 0.38, drift: -0.05, beta: 1.45 },
    { symbol: 'PFE',   name: '辉瑞 Pfizer',             exchange: 'NYSE',     basePrice: 26,   vol: 0.25, drift: -0.06, beta: 0.65 },
    { symbol: 'NIO',   name: '蔚来汽车 NIO',            exchange: 'NYSE',     basePrice: 5.2,  vol: 0.70, drift: -0.15, beta: 1.70 },
    { symbol: 'BABA',  name: '阿里巴巴 Alibaba',         exchange: 'NYSE',     basePrice: 105,  vol: 0.40, drift: 0.10,  beta: 0.85 },
    { symbol: 'PDD',   name: '拼多多 PDD Holdings',      exchange: 'NASDAQ',   basePrice: 115,  vol: 0.52, drift: 0.05,  beta: 0.80 },
    { symbol: 'JD',    name: '京东 JD.com',             exchange: 'NASDAQ',   basePrice: 36,   vol: 0.44, drift: 0.03,  beta: 0.75 },
    { symbol: 'SPY',   name: '标普500 ETF',             exchange: 'NYSEARCA', basePrice: 590,  vol: 0.14, drift: 0.11,  beta: 1.00 },
    { symbol: 'QQQ',   name: '纳指100 ETF',             exchange: 'NASDAQ',   basePrice: 510,  vol: 0.18, drift: 0.15,  beta: 1.20 },
    { symbol: 'IWM',   name: '罗素2000 ETF',            exchange: 'NYSEARCA', basePrice: 228,  vol: 0.21, drift: 0.07,  beta: 1.10 },
    { symbol: 'TQQQ',  name: '纳指三倍做多 ETF',         exchange: 'NASDAQ',   basePrice: 78,   vol: 0.55, drift: 0.30,  beta: 3.00 },
    { symbol: 'GLD',   name: '黄金 ETF',                exchange: 'NYSEARCA', basePrice: 250,  vol: 0.13, drift: 0.14,  beta: 0.10 }
  ];

  const CURATED_MAP = {};
  CURATED.forEach(s => { CURATED_MAP[s.symbol] = s; });

  /* ------------------------------------------------------------
   * 全量代码表
   *
   * symbols.js 打包成 "SYM|名称|交易所|是否ETF" 的字符串数组，
   * 比展开成对象数组小一半。这里按需解析一次。
   * 文件缺失时退回精调表，页面依然能跑。
   * ---------------------------------------------------------- */
  const UNIVERSE = (function () {
    const packed = window.QL && QL.SYMBOLS_PACKED;
    if (!packed || !packed.length) {
      console.warn('[QuantLab] 未加载 assets/data/symbols.js，搜索范围仅限内置标的。' +
                   '重新生成：python backend/build_symbols.py');
      return CURATED.map(s => ({
        symbol: s.symbol, name: s.name, exchange: s.exchange, etf: false
      }));
    }
    return packed.map(row => {
      const p = row.split('|');
      return {
        symbol: p[0], name: p[1] || p[0], exchange: p[2] || 'US',
        etf: p[3] === '1', pop: p[4] === '1'
      };
    });
  })();

  const UNIVERSE_MAP = {};
  UNIVERSE.forEach(s => { UNIVERSE_MAP[s.symbol] = s; });

  /* ------------------------------------------------------------
   * 伪随机：同一个代码永远生成同一条历史，刷新页面不会变。
   * mulberry32 + 字符串哈希做种子。
   * ---------------------------------------------------------- */
  function hashSeed(str) {
    let h = 2166136261 >>> 0;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 16777619) >>> 0;
    }
    return h >>> 0;
  }

  function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  /** Box-Muller 生成标准正态 */
  function gaussian(rand) {
    let u = 0, v = 0;
    while (u === 0) u = rand();
    while (v === 0) v = rand();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }

  /** 从今天往回取 n 个交易日（跳过周末，未处理美股节假日） */
  function tradingDays(n) {
    const days = [];
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    while (days.length < n) {
      const wd = d.getDay();
      if (wd !== 0 && wd !== 6) days.unshift(U.fmtDate(d));
      d.setDate(d.getDate() - 1);
    }
    return days;
  }

  /* ------------------------------------------------------------
   * 本地搜索
   *
   * 11000+ 个代码里做子串匹配，不排序的话「搜 V 出来一堆 XXVX」。
   * 按匹配质量给分：代码完全相同 > 代码前缀 > 名称词首 > 代码包含 > 名称包含，
   * 同分时短代码优先（短代码通常是知名标的）。
   * ---------------------------------------------------------- */
  // 杠杆/反向 ETF、期权收益 ETF、SPAC 壳公司：名字里常带标的代码，
  // 会把真正的标的挤下去（搜 brk 出来一堆 BRKC/BRKL），降权处理
  const DERIVATIVE_RE = /\b(2x|3x|-1x|bull|bear|inverse|leverage|leveraged|daily|option income|covered call|acquisition corp|yieldmax)\b/;

  // 常见的别名/俗称，用户按习惯输入也能命中
  const ALIASES = {
    'tsmc': 'TSM', '台积电': 'TSM',
    'google': 'GOOGL', 'alphabet': 'GOOGL',
    'facebook': 'META', 'fb': 'META',
    'berkshire': 'BRK-B', '伯克希尔': 'BRK-B',
    'amazon': 'AMZN', 'apple': 'AAPL', 'microsoft': 'MSFT',
    'nvidia': 'NVDA', 'tesla': 'TSLA', 'netflix': 'NFLX',
    'alibaba': 'BABA', 'sp500': 'SPY', 's&p500': 'SPY', 'nasdaq100': 'QQQ'
  };

  function scoreMatch(item, key) {
    const sym = item.symbol.toLowerCase();
    const name = (item.name || '').toLowerCase();

    let base;
    if (sym === key) base = 1000;
    else if (sym.startsWith(key)) base = 800 - sym.length;
    // 名称以关键字开头，比如 "voo" 匹配 "Vanguard..."、"英伟" 匹配 "英伟达"
    else if (name.startsWith(key)) base = 600 - sym.length;
    else if (name.indexOf(' ' + key) >= 0) base = 500 - sym.length;
    else if (sym.indexOf(key) >= 0) base = 300 - sym.length;
    else if (name.indexOf(key) >= 0) base = 200 - sym.length;
    else return -1;

    if (item.pop) base += 150;                       // 手工标注的常搜标的
    if (DERIVATIVE_RE.test(name)) base -= 260;       // 杠杆/反向/SPAC 降权
    return base;
  }

  /* 交易所分组。NYSE 组含 NYSE American 与 NYSE Arca——
     Arca 是绝大多数 ETF 的挂牌地，归到纽交所体系符合实际。 */
  const NYSE_GROUP = { NYSE: 1, NYSEAMERICAN: 1, NYSEARCA: 1 };

  function passFilter(item, ex) {
    if (!ex || ex === 'ALL') return true;
    if (ex === 'ETF') return !!item.etf;
    if (ex === 'NASDAQ') return item.exchange === 'NASDAQ';
    if (ex === 'NYSE') return !!NYSE_GROUP[item.exchange];
    return true;
  }

  function pack(item) {
    return {
      symbol: item.symbol, name: item.name,
      exchange: item.exchange, etf: !!item.etf
    };
  }

  /**
   * @param q      关键字
   * @param limit  返回条数
   * @param ex     交易所筛选：'ALL' | 'NASDAQ' | 'NYSE' | 'ETF'
   */
  function searchLocal(q, limit, ex) {
    let key = (q || '').trim().toLowerCase();
    const alias = ALIASES[key];
    if (alias && UNIVERSE_MAP[alias]) key = alias.toLowerCase();

    if (!key) {
      // 空关键字给一份常见标的，而不是按字母序的前十个冷门股
      const seed = CURATED
        .map(s => UNIVERSE_MAP[s.symbol] || { symbol: s.symbol, name: s.name, exchange: s.exchange, etf: false })
        .filter(s => passFilter(s, ex));
      return seed.slice(0, limit || 10).map(pack);
    }

    const hits = [];
    for (let i = 0; i < UNIVERSE.length; i++) {
      const item = UNIVERSE[i];
      if (!passFilter(item, ex)) continue;
      const sc = scoreMatch(item, key);
      if (sc > 0) hits.push({ sc: sc, item: item });
    }
    hits.sort((a, b) => b.sc - a.sc || (a.item.symbol < b.item.symbol ? -1 : 1));
    return hits.slice(0, limit || 12).map(h => pack(h.item));
  }

  /* ------------------------------------------------------------
   * 取标的的模拟参数
   *
   * 精调表里有就直接用；没有就用代码名哈希推导一组确定性参数
   * ——同一个代码永远得到同一组，刷新页面不会变。
   * ETF 给更低的波动和更集中的 beta，个股给更宽的分布。
   * ---------------------------------------------------------- */
  function metaFor(symbol) {
    const curated = CURATED_MAP[symbol];
    if (curated) return curated;

    const listed = UNIVERSE_MAP[symbol];
    const isEtf = listed ? listed.etf : false;
    const rand = mulberry32(hashSeed(symbol + '::meta'));

    // 价格量级取对数均匀分布，避免清一色都是两位数
    const basePrice = Math.exp(Math.log(6) + rand() * (Math.log(450) - Math.log(6)));

    return {
      symbol: symbol,
      name: listed ? listed.name : symbol,
      exchange: listed ? listed.exchange : 'US',
      basePrice: +basePrice.toFixed(2),
      vol:   isEtf ? 0.11 + rand() * 0.20 : 0.18 + rand() * 0.55,
      drift: isEtf ? -0.04 + rand() * 0.22 : -0.18 + rand() * 0.50,
      beta:  isEtf ? 0.55 + rand() * 0.85 : 0.45 + rand() * 1.55
    };
  }

  /* ------------------------------------------------------------
   * 共同市场因子
   *
   * 所有标的的收益 = beta × 市场冲击 + 个股特质冲击。
   * 这样自选列表里各标的会一起涨一起跌（有联动），
   * 而不是 35 条互不相干的随机游走，回测和 Beta 才有意义。
   * ---------------------------------------------------------- */
  const MKT_VOL = 0.13;                     // 市场因子年化波动
  const MKT_SIGMA = MKT_VOL / Math.sqrt(252);
  let marketCache = null;

  function marketShocks(n) {
    if (marketCache && marketCache.length >= n) return marketCache.slice(-n);
    const rand = mulberry32(hashSeed('QL::MARKET::FACTOR'));
    const out = [];
    let sigma = MKT_SIGMA;
    for (let i = 0; i < n; i++) {
      // 波动率聚集：平静期与恐慌期交替
      sigma += (MKT_SIGMA - sigma) * 0.04 + gaussian(rand) * MKT_SIGMA * 0.12;
      sigma = Math.max(MKT_SIGMA * 0.35, Math.min(MKT_SIGMA * 3.2, sigma));
      let shock = sigma * gaussian(rand);
      if (rand() < 0.006) shock -= sigma * (3 + rand() * 5);   // 偶发系统性回调
      out.push(shock);
    }

    // 暴跌是单向注入的，会让因子自带负漂移，把个股的 drift 吃掉。
    // 去均值后只保留「左尾更厚」的形状，趋势交给各标的自己的 drift 决定。
    const mean = out.reduce((a, b) => a + b, 0) / out.length;
    for (let i = 0; i < out.length; i++) out[i] -= mean;

    marketCache = out;
    return out;
  }

  /* ------------------------------------------------------------
   * MockProvider：单因子模型 + 波动率聚集 + 偶发跳空
   * ---------------------------------------------------------- */
  const MockProvider = {
    name: 'mock',

    async search(q, limit, ex) { return searchLocal(q, limit, ex); },

    async getHistory(symbol, days) {
      const n = days || CFG.historyDays;
      const meta = metaFor(symbol);
      const rand = mulberry32(hashSeed(symbol));
      const dates = tradingDays(n);
      const mkt = marketShocks(n);

      const beta = meta.beta == null ? 1.0 : meta.beta;
      const dailyDrift = meta.drift / 252;
      const totalSigma = meta.vol / Math.sqrt(252);

      // 总方差拆成「系统性 + 特质」，特质部分至少保留 35%，
      // 否则高 beta 标的会变成市场因子的复制品
      const sysVar = beta * beta * MKT_SIGMA * MKT_SIGMA;
      const idioSigma = Math.sqrt(Math.max(
        totalSigma * totalSigma - sysVar,
        Math.pow(totalSigma * 0.35, 2)
      ));

      // 1) 生成对数收益路径：市场冲击 + 特质冲击（特质部分带波动率聚集）
      const logRet = [];
      let sigma = idioSigma;
      for (let i = 0; i < n; i++) {
        sigma += (idioSigma - sigma) * 0.05 + gaussian(rand) * idioSigma * 0.08;
        sigma = Math.max(idioSigma * 0.4, Math.min(idioSigma * 2.6, sigma));

        let r = dailyDrift - 0.5 * totalSigma * totalSigma
              + beta * mkt[i]
              + sigma * gaussian(rand);
        if (rand() < 0.012) r += (rand() < 0.5 ? -1 : 1) * sigma * (3 + rand() * 4); // 财报跳空
        logRet.push(r);
      }

      // 2) 累乘出收盘价，再整体缩放，使最后一根收在 basePrice 附近
      const closes = [];
      let cum = 0;
      for (let i = 0; i < n; i++) { cum += logRet[i]; closes.push(Math.exp(cum)); }
      const scaleTo = meta.basePrice / closes[n - 1];
      for (let i = 0; i < n; i++) closes[i] = Math.max(0.05, closes[i] * scaleTo);

      // 3) 由收盘价反推 OHLC 和成交量
      const bars = [];
      const baseVol = Math.max(3e5, 4e9 / meta.basePrice) * (0.6 + rand() * 0.8);
      for (let i = 0; i < n; i++) {
        const close = closes[i];
        const prev  = i > 0 ? closes[i - 1] : close;
        const open  = i === 0 ? close : prev * (1 + gaussian(rand) * totalSigma * 0.35);
        const body  = Math.abs(close - open);
        const wick  = (body + close * totalSigma * 0.5) * (0.3 + rand() * 0.9);
        const high  = Math.max(open, close) + wick * rand();
        const low   = Math.min(open, close) - wick * rand();
        const move  = Math.abs(close / prev - 1);
        const volume = Math.round(baseVol * (0.55 + rand() * 0.9) * (1 + move * 22));

        bars.push({
          date: dates[i],
          open:  +open.toFixed(2),
          high:  +Math.max(high, open, close).toFixed(2),
          low:   +Math.max(0.01, Math.min(low, open, close)).toFixed(2),
          close: +close.toFixed(2),
          volume
        });
      }

      return { symbol: meta.symbol, name: meta.name, exchange: meta.exchange, bars };
    },

    async getQuote(symbol) {
      const hist = await cachedHistory(symbol);
      const bars = hist.bars;
      const cur  = bars[bars.length - 1];
      const prev = bars[bars.length - 2] || cur;
      return {
        symbol: hist.symbol, name: hist.name, exchange: hist.exchange,
        last: cur.close, prevClose: prev.close,
        open: cur.open, high: cur.high, low: cur.low, volume: cur.volume,
        change: cur.close - prev.close,
        changePct: prev.close ? (cur.close - prev.close) / prev.close : 0,
        time: Date.now()
      };
    },

    /** 模拟盘中跳动：只在开盘时段抖动最后一根 K 线 */
    tick(symbol) {
      const hist = cache[symbol];
      if (!hist) return null;
      const bars = hist.bars;
      const cur  = bars[bars.length - 1];
      const prev = bars[bars.length - 2] || cur;

      const sigma = metaFor(symbol).vol / Math.sqrt(252 * 390);
      const next  = Math.max(0.01, cur.close * (1 + gaussian(Math.random) * sigma * 6));

      cur.close = +next.toFixed(2);
      cur.high  = +Math.max(cur.high, cur.close).toFixed(2);
      cur.low   = +Math.min(cur.low,  cur.close).toFixed(2);
      cur.volume += Math.round(cur.volume * 0.0008 * Math.random());

      return {
        symbol: hist.symbol, name: hist.name, exchange: hist.exchange,
        last: cur.close, prevClose: prev.close,
        open: cur.open, high: cur.high, low: cur.low, volume: cur.volume,
        change: cur.close - prev.close,
        changePct: prev.close ? (cur.close - prev.close) / prev.close : 0,
        time: Date.now()
      };
    }
  };

  /* ------------------------------------------------------------
   * LiveProvider：对接 backend/app.py（akshare / yfinance）
   * 后端没起来时自动回落到 mock，页面不会白屏。
   * ---------------------------------------------------------- */
  const LiveProvider = {
    name: 'live',

    async _get(path, params, timeoutMs) {
      const url = new URL(CFG.apiBase + path);
      Object.keys(params || {}).forEach(k => url.searchParams.set(k, params[k]));

      // 探活必须带超时，否则后端卡住会把整个启动流程一起拖住
      const ctrl = typeof AbortController === 'function' ? new AbortController() : null;
      const timer = (ctrl && timeoutMs) ? setTimeout(() => ctrl.abort(), timeoutMs) : null;
      try {
        const resp = await fetch(url.toString(), {
          headers: { 'Accept': 'application/json' },
          signal: ctrl ? ctrl.signal : undefined
        });
        if (!resp.ok) throw new Error('HTTP ' + resp.status);
        return await resp.json();
      } finally {
        if (timer) clearTimeout(timer);
      }
    },

    /* 代码表前端已经有全量的了，本地搜索无网络往返、输入即出结果，
       没必要为每次按键打一次后端。后端的 /api/search 仍然保留，
       方便别的客户端调用。 */
    async search(q, limit, ex) { return searchLocal(q, limit, ex); },

    async getHistory(symbol, days) {
      const raw = await this._get('/api/history', { symbol, days: days || CFG.historyDays });
      return {
        symbol: raw.symbol,
        name: raw.name || symbol,
        exchange: raw.exchange || 'US',
        bars: (raw.bars || []).map(b => ({
          date: b.date,
          open: +b.open, high: +b.high, low: +b.low, close: +b.close,
          volume: +b.volume
        }))
      };
    },

    async getQuote(symbol) {
      const q = await this._get('/api/quote', { symbol });
      const prevClose = +q.prev_close;
      return {
        symbol: q.symbol, name: q.name || symbol, exchange: q.exchange || 'US',
        last: +q.last, prevClose,
        open: +q.open, high: +q.high, low: +q.low, volume: +q.volume,
        change: +q.last - prevClose,
        changePct: prevClose ? (+q.last - prevClose) / prevClose : 0,
        time: Date.now()
      };
    },

    tick() { return null; }   // live 模式靠 getQuote 轮询，不做本地抖动
  };

  /* ------------------------------------------------------------
   * 门面：模式切换 + 历史缓存
   * ---------------------------------------------------------- */
  /* 数据源的持久化状态。
   *
   * 只有「用户点了徽章」才算显式选择并写盘；自动探测和自动回落都不写。
   * 早先版本不区分这两者：后端没起时的自动回落会把 "mock" 存进去，
   * 之后即使后端起来了也认为"用户选了模拟数据"，永久卡在假价格上。
   *
   * 存储格式 { mode, explicit }。旧版本存的是裸字符串，
   * 无法分辨来源，一律当作"没选过"，让自动探测重新接管。 */
  const rawStored = U.store.get(CFG.storeKeys.dataMode, null);
  let explicitChoice = false;
  let mode = 'mock';
  if (rawStored && typeof rawStored === 'object' && rawStored.mode) {
    mode = rawStored.mode === 'live' ? 'live' : 'mock';
    explicitChoice = rawStored.explicit === true;
  } else if (typeof rawStored === 'string') {
    mode = rawStored === 'live' ? 'live' : 'mock';
    explicitChoice = false;                        // 旧格式，不认作显式选择
  }
  let provider = mode === 'live' ? LiveProvider : MockProvider;
  const cache = {};                                  // symbol -> history

  async function cachedHistory(symbol) {
    const key = mode + ':' + symbol;
    if (!cache[symbol] || cache[symbol]._key !== key) {
      const h = await provider.getHistory(symbol);
      h._key = key;
      cache[symbol] = h;
    }
    return cache[symbol];
  }

  return {
    get mode() { return mode; },

    /** 用户是否**主动**选过数据源；没选过就交给启动流程自动探测 */
    get hasUserChoice() { return explicitChoice; },

    /**
     * 切换数据源；切 live 失败会退回原模式并抛错。
     * @param explicit true 表示这是用户主动选择，才写入 localStorage。
     *                 自动探测/自动回落必须传 false（或不传），
     *                 否则一次临时回落会被当成永久偏好。
     */
    async setMode(next, explicit) {
      const prevMode = mode;
      mode = next;
      provider = next === 'live' ? LiveProvider : MockProvider;
      Object.keys(cache).forEach(k => delete cache[k]);

      if (next === 'live') {
        try {
          await LiveProvider._get('/api/health', {}, 2500);
        } catch (e) {
          mode = prevMode;
          provider = prevMode === 'live' ? LiveProvider : MockProvider;
          throw new Error('后端未启动（' + CFG.apiBase + '），已保持模拟数据');
        }
      }
      if (explicit) {
        explicitChoice = true;
        U.store.set(CFG.storeKeys.dataMode, { mode: mode, explicit: true });
      }
      U.bus.emit('data:mode', mode);
      return mode;
    },

    /** 探活后端；mock 模式恒为 true */
    async ping() {
      if (mode !== 'live') return true;
      await LiveProvider._get('/api/health', {}, 2500);
      return true;
    },

    search(q, limit, ex) { return provider.search(q, limit, ex); },
    getHistory(symbol) { return cachedHistory(symbol); },
    getQuote(symbol)   { return provider.getQuote(symbol); },
    tick(symbol)       { return provider.tick ? provider.tick(symbol) : null; },

    /** 强制重新拉取（换数据源、手动刷新时用） */
    invalidate(symbol) {
      if (symbol) delete cache[symbol];
      else Object.keys(cache).forEach(k => delete cache[k]);
    },

    universe: UNIVERSE,
    searchLocal: searchLocal
  };
})();
