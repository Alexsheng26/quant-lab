/* ============================================================
 * config.js —— 全局配置
 * 所有可调参数集中在这里，方便后续接真实数据源时只改一处。
 * ============================================================ */

window.QL = window.QL || {};

QL.CONFIG = {
  /* 数据源模式：
   *   'mock' —— 前端内置行情引擎（离线可用，用于开发/演示）
   *   'live' —— 请求本地后端 backend/app.py（akshare / yfinance 等）
   * 顶栏那个徽章可以点击切换，选择会记在 localStorage。 */
  dataMode: 'mock',

  /* 后端地址。
   *
   * 本地打开（file:// 或 localhost）时默认指向本机的 8000 端口。
   * 部署到 GitHub Pages 这类静态托管后，后端不在同一台机器上，
   * 地址由用户在界面里填，存 localStorage —— 所以这里是个 getter 而不是常量。
   *
   * 注意浏览器的混合内容策略：HTTPS 页面请求 http:// 接口会被拦截。
   * 例外是 localhost / 127.0.0.1，Chrome 和 Firefox 把它当作可信来源放行，
   * Safari 不放行。要在 Safari 上用远程后端，后端必须上 HTTPS。 */
  get apiBase() {
    try {
      const saved = localStorage.getItem('ql.apiBase');
      if (saved) return JSON.parse(saved);
    } catch (e) { /* 隐私模式忽略 */ }
    return 'http://127.0.0.1:8000';
  },

  /** 页面是否跑在本机（决定要不要提示用户填后端地址） */
  isLocalHost: (function () {
    const h = location.hostname;
    return location.protocol === 'file:' ||
           h === 'localhost' || h === '127.0.0.1' || h === '' || h === '[::1]';
  })(),

  /* 一次取多少根日线（约 7 年）。
   * 别调太小：月线是日线聚合出来的，1800 根日线才有 ~86 根月线，
   * 刚够算 MA60。取 760（3 年）的话月线只有 37 根，月线分析直接没法做。 */
  historyDays: 1800,

  /* 行情轮询间隔（毫秒）。mock 模式下用于生成跳动的最新价 */
  tickInterval: 2000,

  /* 模拟盘初始资金 */
  initialCapital: 100000,

  /* 默认打开的标的 */
  defaultSymbol: 'AAPL',

  /* 默认自选列表 */
  defaultWatchlist: ['AAPL', 'NVDA', 'MSFT', 'TSLA', 'AMZN', 'GOOGL', 'META', 'SPY'],

  /* Agent 打分权重（合计 1.0）。调权重就是调策略偏好。 */
  agentWeights: {
    trend:      0.30,   // 趋势：均线多头排列、价格相对均线位置
    momentum:   0.22,   // 动量：RSI、ROC、MACD 柱
    volatility: 0.16,   // 波动/风险：ATR%、回撤（越低越好）
    volume:     0.14,   // 量能：放量配合方向
    position:   0.18    // 位置：布林 %B、距 52 周高低点
  },

  /* localStorage 键名 */
  storeKeys: {
    watchlist:    'ql.watchlist',
    account:      'ql.account',
    dataMode:     'ql.dataMode',
    searchFilter: 'ql.searchFilter'
  }
};
