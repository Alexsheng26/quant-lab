/* ============================================================
 * app.js —— 应用编排：全局状态、标的切换、路由、行情轮询
 * ============================================================ */

window.QL = window.QL || {};

QL.state = {
  symbol: null,
  history: null,
  quote: null,
  lastAnalysis: null,
  lastBacktest: null
};

QL.app = (function () {
  const U = QL.utils;
  const CFG = QL.CONFIG;
  const $ = U.$;

  let view = 'market';
  let tickTimer = null;

  /* 请求序号：LIVE 模式下一次取数要 0.5~2 秒，用户连点两个标的时，
     先发的请求可能后到并覆盖后发的结果。每次切换自增，
     回来的响应序号不是最新的就直接丢弃。
     （早先这里用的是 loading 布尔守卫，副作用是加载中的点击被静默忽略。） */
  let loadSeq = 0;

  /* ---------------- 标的切换 ---------------- */

  async function setSymbol(symbol) {
    if (!symbol) return;
    const seq = ++loadSeq;
    try {
      const hist = await QL.data.getHistory(symbol);
      const quote = await QL.data.getQuote(symbol);
      if (seq !== loadSeq) return;                   // 期间又切走了，这次作废
      QL.state.symbol = hist.symbol;
      QL.state.history = hist;
      QL.state.quote = quote;
      document.title = hist.symbol + ' ' + U.fmtPrice(quote.last) + ' · QuantLab';
      U.bus.emit('symbol:loaded', QL.state);
      U.bus.emit('quote:tick', quote);
    } catch (e) {
      if (seq !== loadSeq) return;
      console.error('加载标的失败', e);
      toast('加载 ' + symbol + ' 失败：' + e.message, 'warn', 5000);
    }
  }

  /* ---------------- 行情轮询 ---------------- */

  function startTicker() {
    if (tickTimer) clearInterval(tickTimer);
    tickTimer = setInterval(async () => {
      const sym = QL.state.symbol;
      if (!sym) return;
      try {
        let q;
        if (QL.data.mode === 'mock') {
          q = QL.data.tick(sym);
        } else {
          q = await QL.data.getQuote(sym);
          // 这一笔飞在路上时用户可能已经切了标的，
          // 不检查就会把旧标的的价格写到新标的头上
          if (QL.state.symbol !== sym) return;
          // live 模式同步更新最后一根 K 线，图表才跟着动
          const hist = QL.state.history;
          if (hist && q) {
            const cur = hist.bars[hist.bars.length - 1];
            cur.close = q.last;
            cur.high = Math.max(cur.high, q.last);
            cur.low  = Math.min(cur.low, q.last);
          }
        }
        if (q && QL.state.symbol === sym) {
          QL.state.quote = q;
          document.title = q.symbol + ' ' + U.fmtPrice(q.last) + ' · QuantLab';
          U.bus.emit('quote:tick', q);
        }
      } catch (e) { /* 轮询失败静默，下个周期重试 */ }
    }, CFG.tickInterval);
  }

  /* ---------------- 顶栏：时钟与市场状态 ---------------- */

  const SESSION_TEXT = {
    pre:    ['盘前交易', 'pill-open'],
    open:   ['交易中',   'pill-open'],
    post:   ['盘后交易', 'pill-open'],
    closed: ['已休市',   'pill-muted']
  };

  function startClock() {
    const tick = () => {
      const et = U.nowET();
      const p = n => String(n).padStart(2, '0');
      $('#clock').textContent = p(et.hour) + ':' + p(et.minute) + ' ET';
      const s = U.marketSession();
      const el = $('#marketStatus');
      el.textContent = SESSION_TEXT[s][0];
      el.className = 'pill ' + SESSION_TEXT[s][1];
    };
    tick();
    setInterval(tick, 15000);
  }

  /* ---------------- 顶栏：数据源切换 ---------------- */

  function renderDataMode() {
    const el = $('#dataMode');
    if (QL.data.mode === 'live') {
      el.textContent = 'LIVE 实时数据';
      el.className = 'pill pill-live';
    } else {
      el.textContent = 'MOCK 模拟数据';
      el.className = 'pill pill-mock';
    }
  }

  function bindDataMode() {
    renderDataMode();
    // 徽章的显示由事件驱动，任何地方改数据源都能同步（包括启动时的自动回落）
    U.bus.on('data:mode', renderDataMode);

    $('#dataMode').addEventListener('click', async () => {
      const next = QL.data.mode === 'live' ? 'mock' : 'live';
      try {
        await QL.data.setMode(next, true);       // 点徽章 = 主动选择，记盘
        await setSymbol(QL.state.symbol || CFG.defaultSymbol);
        toast(next === 'live' ? '已接入后端实时数据' : '已切回模拟数据');
      } catch (e) {
        // 部署到静态托管时后端不在本机，让用户填地址而不是干说"没启动"
        if (next === 'live' && !CFG.isLocalHost) {
          promptForBackend();
        } else {
          toast(e.message + '（先运行 backend/app.py）', 'warn', 6000);
        }
      }
    });
  }

  /**
   * 启动时决定用哪个数据源。
   *
   * 1) 用户从没手动选过：探一下后端，起着就直接用真实数据。
   *    默认停在 MOCK 会让人对着模拟价格发懵——毕竟没人会预期
   *    打开一个行情网站看到的是假价格。
   * 2) 用户选过 LIVE：探活，后端没起就回落到 MOCK 并说明原因，
   *    否则整页拿不到数据还不知道为什么。
   */
  async function ensureDataMode() {
    if (!QL.data.hasUserChoice) {
      try {
        await QL.data.setMode('live');            // 内部会先打 /api/health
        toast('检测到本地后端，已接入真实行情', null, 4000);
      } catch (e) {
        // 后端没起是常态，静默留在 MOCK，图上有水印提示
      }
      return;
    }

    if (QL.data.mode !== 'live') return;
    try {
      await QL.data.ping();
    } catch (e) {
      await QL.data.setMode('mock');
      toast('后端未响应，已自动切回模拟数据', 'warn', 6000);
    }
  }

  /**
   * 让用户填后端地址。
   *
   * 静态托管（GitHub Pages 等）上前端和后端不在一起，默认的
   * 127.0.0.1:8000 只有在访问者自己本机也跑了后端时才通。
   * 与其反复提示"后端未启动"，不如直接问地址并记下来。
   */
  async function promptForBackend() {
    const cur = CFG.apiBase;
    const input = window.prompt(
      '这个页面是静态托管的，后端不在同一台机器上。\n\n' +
      '请填后端地址：\n' +
      '· 本机跑了 backend/app.py  →  http://127.0.0.1:8000\n' +
      '· 部署到了云端            →  https://你的域名\n\n' +
      '（留空则继续用模拟数据）',
      cur
    );
    if (input == null) return;
    const url = input.trim().replace(/\/+$/, '');
    if (!url) return;

    U.store.set('ql.apiBase', url);
    try {
      await QL.data.setMode('live', true);
      await setSymbol(QL.state.symbol || CFG.defaultSymbol);
      toast('已连接后端 ' + url);
    } catch (e) {
      // 保留地址，用户可能只是还没启动后端
      toast('连不上 ' + url + '：' + e.message, 'warn', 7000);
    }
  }

  /* ---------------- 轻量提示 ---------------- */

  let toastTimer = null;
  function toast(text, kind, ms) {
    let box = $('#toast');
    if (!box) {
      box = U.el('div');
      box.id = 'toast';
      document.body.appendChild(box);
    }
    box.textContent = text;
    box.className = 'toast show' + (kind ? ' toast-' + kind : '');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { box.className = 'toast'; }, ms || 3000);
  }

  /* ---------------- 搜索 ---------------- */

  /* 交易所筛选：记在 localStorage，下次打开还是上次选的 */
  let searchEx = U.store.get(CFG.storeKeys.searchFilter, 'ALL');

  const EX_LABEL = {
    NASDAQ: 'NASDAQ', NYSE: 'NYSE', NYSEAMERICAN: 'NYSE MKT',
    NYSEARCA: 'ARCA', BATS: 'BATS', IEX: 'IEX'
  };

  function bindSearch() {
    const input = $('#symbolSearch');
    const box = $('#searchResults');
    const list = $('#srList');

    function renderRows(items) {
      if (!items.length) {
        list.innerHTML = '<div class="sr-empty muted">没有匹配的标的' +
          (searchEx === 'ALL' ? '' : '（当前筛选：' + $('#srFilter .chip.active').textContent + '）') +
          '</div>';
        return;
      }
      list.innerHTML = items.map(s => {
        const watched = QL.market.isWatched(s.symbol);
        return '<div class="sr-row" data-sym="' + s.symbol + '">' +
            '<b>' + s.symbol + '</b>' +
            '<span class="sr-name">' + (s.name || '') + '</span>' +
            '<span class="sr-ex">' + (EX_LABEL[s.exchange] || s.exchange) +
              (s.etf ? ' · ETF' : '') + '</span>' +
            '<button class="sr-add' + (watched ? ' on' : '') + '" data-add="' + s.symbol + '" ' +
              'title="' + (watched ? '已在自选，点击移出' : '加入自选') + '">' +
              (watched ? '✓' : '+') + '</button>' +
          '</div>';
      }).join('');

      // 点行 = 打开标的；点 + = 只加自选，不切标的也不关面板
      U.$$('#srList .sr-row').forEach(row => {
        row.addEventListener('click', () => {
          input.value = '';
          box.classList.add('hidden');
          setSymbol(row.dataset.sym);
        });
      });
      U.$$('#srList .sr-add').forEach(btn => {
        btn.addEventListener('click', e => {
          e.stopPropagation();
          const sym = btn.dataset.add;
          const on = QL.market.toggleWatch(sym);
          btn.classList.toggle('on', on);
          btn.textContent = on ? '✓' : '+';
          btn.title = on ? '已在自选，点击移出' : '加入自选';
          toast(on ? sym + ' 已加入自选' : sym + ' 已移出自选', null, 1600);
        });
      });
    }

    const doSearch = U.debounce(async () => {
      const q = input.value.trim();
      if (!q) { box.classList.add('hidden'); return; }
      try {
        renderRows(await QL.data.search(q, 12, searchEx));
      } catch (e) {
        list.innerHTML = '<div class="sr-empty muted">搜索失败：' + e.message + '</div>';
      }
      box.classList.remove('hidden');
    }, 160);

    // 筛选按钮
    U.$$('#srFilter .chip').forEach(chip => {
      chip.addEventListener('click', e => {
        e.stopPropagation();
        U.$$('#srFilter .chip').forEach(c => c.classList.remove('active'));
        chip.classList.add('active');
        searchEx = chip.dataset.ex;
        U.store.set(CFG.storeKeys.searchFilter, searchEx);
        doSearch();
        input.focus();
      });
    });
    // 恢复上次选的筛选
    const saved = $('#srFilter .chip[data-ex="' + searchEx + '"]');
    if (saved) {
      U.$$('#srFilter .chip').forEach(c => c.classList.remove('active'));
      saved.classList.add('active');
    }

    input.addEventListener('input', doSearch);
    input.addEventListener('focus', () => { if (input.value.trim()) doSearch(); });
    input.addEventListener('keydown', e => {
      if (e.key === 'Enter') {
        const first = list.querySelector('.sr-row');
        if (first) first.click();
        else setSymbol(input.value.trim().toUpperCase());
        input.value = '';
        box.classList.add('hidden');
      }
      if (e.key === 'Escape') { box.classList.add('hidden'); input.blur(); }
    });
    document.addEventListener('click', e => {
      if (!e.target.closest('.search-wrap')) box.classList.add('hidden');
    });
  }

  /* ---------------- 标签页 ---------------- */

  function bindTabs() {
    U.$$('.tab').forEach(tab => {
      tab.addEventListener('click', () => {
        U.$$('.tab').forEach(t => t.classList.remove('active'));
        U.$$('.view').forEach(v => v.classList.remove('active'));
        tab.classList.add('active');
        view = tab.dataset.view;
        $('#view-' + view).classList.add('active');
        // Canvas 在隐藏容器里宽高为 0，切回来必须重绘
        if (view === 'market') QL.market.renderChart();
        U.bus.emit('view:change', view);
      });
    });
  }

  /* ---------------- 启动 ---------------- */

  async function init() {
    bindTabs();
    bindSearch();
    bindDataMode();
    startClock();

    QL.market.init();
    QL.agent.init();
    QL.agents.init();
    QL.backtest.init();
    QL.paper.init();

    await ensureDataMode();
    await setSymbol(CFG.defaultSymbol);
    startTicker();
  }

  document.addEventListener('DOMContentLoaded', init);

  return {
    setSymbol,
    toast,
    currentView: () => view,
    reload: () => setSymbol(QL.state.symbol)
  };
})();
