/* ============================================================
 * chart.js —— 纯 Canvas 绘图（K 线 + 副图 + 折线）
 *
 * 不引第三方图表库，一是零依赖直接双击就能跑，二是简历上
 * 「手写 Canvas K 线渲染」比「调了个 ECharts」更有内容。
 * ============================================================ */

window.QL = window.QL || {};

QL.chart = (function () {
  const U = QL.utils;
  const IND = QL.ind;

  const COLOR = {
    up:     '#26a69a',
    down:   '#ef5350',
    grid:   'rgba(35,42,58,.75)',
    axis:   '#5a6479',
    text:   '#8b95a8',
    cross:  'rgba(139,149,168,.6)',
    ma5:    '#f0a742',
    ma20:   '#4c8dff',
    ma60:   '#c77dff',
    boll:   'rgba(139,149,168,.55)',
    dif:    '#f0a742',
    dea:    '#4c8dff',
    rsi:    '#c77dff',
    accent: '#4c8dff',
    bench:  '#5a6479'
  };

  const PAD = { left: 8, right: 64, top: 10, bottom: 22 };

  /** 给定的数值范围向外扩一点，避免图形贴边 */
  function padRange(min, max, ratio) {
    if (!isFinite(min) || !isFinite(max)) return [0, 1];
    if (min === max) { const d = Math.abs(min) * 0.05 || 1; return [min - d, max + d]; }
    const pad = (max - min) * (ratio == null ? 0.06 : ratio);
    return [min - pad, max + pad];
  }

  /** 处理 HiDPI，返回 CSS 像素尺寸 */
  function setupCanvas(canvas) {
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    if (canvas.width !== w * dpr || canvas.height !== h * dpr) {
      canvas.width  = w * dpr;
      canvas.height = h * dpr;
    }
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    return { ctx, w, h };
  }

  function line(ctx, pts, color, width, dash) {
    ctx.save();
    ctx.strokeStyle = color;
    ctx.lineWidth = width || 1;
    if (dash) ctx.setLineDash(dash);
    ctx.beginPath();
    let started = false;
    for (const p of pts) {
      if (p == null) { started = false; continue; }
      if (!started) { ctx.moveTo(p[0], p[1]); started = true; }
      else ctx.lineTo(p[0], p[1]);
    }
    ctx.stroke();
    ctx.restore();
  }

  /* ============================================================
   * CandleChart —— 主图 K 线 + 可选副图
   * ========================================================== */
  class CandleChart {
    constructor(canvas, tipEl) {
      this.canvas = canvas;
      this.tip = tipEl;
      this.bars = [];
      this.mas = { 5: true, 20: true, 60: true, boll: false };
      this.sub = 'vol';
      this.hover = -1;

      this._onMove = this._onMove.bind(this);
      this._onLeave = this._onLeave.bind(this);
      canvas.addEventListener('mousemove', this._onMove);
      canvas.addEventListener('mouseleave', this._onLeave);

      this._ro = new ResizeObserver(() => this.draw());
      this._ro.observe(canvas);
    }

    setBars(bars) { this.bars = bars || []; this.hover = -1; this.draw(); }
    setMA(mas)    { this.mas = mas; this.draw(); }
    setSub(sub)   { this.sub = sub; this.draw(); }

    /* ---- 坐标换算 ---- */
    _geom() {
      const w = this.canvas.clientWidth;
      const h = this.canvas.clientHeight;
      const plotL = PAD.left;
      const plotR = w - PAD.right;
      const plotW = plotR - plotL;
      const innerH = h - PAD.top - PAD.bottom;
      const hasSub = !!this.sub;
      const mainH = hasSub ? innerH * 0.7 : innerH;
      const subT  = PAD.top + mainH + (hasSub ? innerH * 0.05 : 0);
      const subH  = hasSub ? innerH * 0.25 : 0;
      return { w, h, plotL, plotR, plotW, mainT: PAD.top, mainH, subT, subH, hasSub };
    }

    _xOf(i, g) {
      const n = this.bars.length;
      const step = g.plotW / Math.max(1, n);
      return g.plotL + step * (i + 0.5);
    }

    _indexAt(px, g) {
      const n = this.bars.length;
      if (!n) return -1;
      const step = g.plotW / n;
      const i = Math.floor((px - g.plotL) / step);
      return U.clamp(i, 0, n - 1);
    }

    draw() {
      const bars = this.bars;
      const { ctx, w, h } = setupCanvas(this.canvas);
      if (!bars.length) {
        ctx.fillStyle = COLOR.text;
        ctx.font = '13px system-ui';
        ctx.textAlign = 'center';
        ctx.fillText('加载中…', w / 2, h / 2);
        return;
      }

      const g = this._geom();
      const closes = bars.map(b => b.close);

      /* ---- 计算叠加指标 ---- */
      const overlays = [];
      if (this.mas[5])  overlays.push({ v: IND.sma(closes, 5),  c: COLOR.ma5,  label: 'MA5' });
      if (this.mas[20]) overlays.push({ v: IND.sma(closes, 20), c: COLOR.ma20, label: 'MA20' });
      if (this.mas[60]) overlays.push({ v: IND.sma(closes, 60), c: COLOR.ma60, label: 'MA60' });
      let bb = null;
      if (this.mas.boll) {
        bb = IND.boll(closes, 20, 2);
        overlays.push({ v: bb.upper, c: COLOR.boll, label: 'BOLL上', dash: [3, 3] });
        overlays.push({ v: bb.lower, c: COLOR.boll, label: 'BOLL下', dash: [3, 3] });
      }

      /* ---- 主图价格范围 ---- */
      let lo = Infinity, hi = -Infinity;
      for (const b of bars) { if (b.low < lo) lo = b.low; if (b.high > hi) hi = b.high; }
      overlays.forEach(o => o.v.forEach(v => {
        if (v == null) return;
        if (v < lo) lo = v; if (v > hi) hi = v;
      }));
      const [pMin, pMax] = padRange(lo, hi, 0.05);
      const yOf = p => g.mainT + g.mainH - ((p - pMin) / (pMax - pMin)) * g.mainH;

      /* ---- 网格 + 价格轴 ---- */
      ctx.font = '10px "SF Mono", Consolas, monospace';
      ctx.textBaseline = 'middle';
      const ticks = 5;
      for (let i = 0; i <= ticks; i++) {
        const p = pMin + (pMax - pMin) * (i / ticks);
        const y = yOf(p);
        line(ctx, [[g.plotL, y], [g.plotR, y]], COLOR.grid, 1);
        ctx.fillStyle = COLOR.text;
        ctx.textAlign = 'left';
        ctx.fillText(p.toFixed(2), g.plotR + 6, y);
      }

      /* ---- 日期轴 ---- */
      const dateTicks = Math.min(7, bars.length);
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      for (let i = 0; i < dateTicks; i++) {
        const idx = Math.round((bars.length - 1) * (i / Math.max(1, dateTicks - 1)));
        const x = this._xOf(idx, g);
        line(ctx, [[x, g.mainT], [x, g.subT + g.subH]], COLOR.grid, 1);
        ctx.fillStyle = COLOR.text;
        ctx.fillText(bars[idx].date.slice(2), x, h - PAD.bottom + 6);
      }

      /* ---- K 线 ---- */
      const step = g.plotW / bars.length;
      const cw = Math.max(1, Math.min(14, step * 0.68));
      for (let i = 0; i < bars.length; i++) {
        const b = bars[i];
        const x = this._xOf(i, g);
        const up = b.close >= b.open;
        const color = up ? COLOR.up : COLOR.down;
        ctx.strokeStyle = color;
        ctx.fillStyle = color;
        ctx.lineWidth = 1;

        // 影线
        ctx.beginPath();
        ctx.moveTo(Math.round(x) + .5, yOf(b.high));
        ctx.lineTo(Math.round(x) + .5, yOf(b.low));
        ctx.stroke();

        // 实体
        const yo = yOf(b.open), yc = yOf(b.close);
        const top = Math.min(yo, yc);
        const bh = Math.max(1, Math.abs(yc - yo));
        if (cw <= 1.5) {
          ctx.fillRect(Math.round(x), top, 1, bh);
        } else {
          ctx.fillRect(Math.round(x - cw / 2), top, Math.round(cw), bh);
        }
      }

      /* ---- 均线 ---- */
      overlays.forEach(o => {
        const pts = o.v.map((v, i) => v == null ? null : [this._xOf(i, g), yOf(v)]);
        line(ctx, pts, o.c, 1.3, o.dash);
      });

      /* ---- 图例 ---- */
      ctx.textAlign = 'left';
      ctx.textBaseline = 'top';
      let lx = g.plotL + 4;
      const last = bars[bars.length - 1];
      overlays.forEach(o => {
        const v = o.v[o.v.length - 1];
        const txt = o.label + ':' + (v == null ? '—' : v.toFixed(2));
        ctx.fillStyle = o.c;
        ctx.fillText(txt, lx, g.mainT + 2);
        lx += ctx.measureText(txt).width + 12;
      });

      /* ---- 模拟数据水印 ----
         这些价格是程序生成的，和真实行情无关。徽章太小容易被忽略，
         之前就有人对着 MOCK 模式的价格问"为什么和现实差这么多"，
         所以直接在图上标清楚。 */
      if (window.QL && QL.data && QL.data.mode === 'mock') {
        ctx.save();
        ctx.translate(g.plotL + g.plotW / 2, g.mainT + g.mainH / 2);
        ctx.rotate(-Math.PI / 12);
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillStyle = 'rgba(240,167,66,.13)';
        ctx.font = 'bold ' + Math.max(28, Math.min(72, g.plotW / 12)) + 'px system-ui';
        ctx.fillText('模拟数据 · 非真实行情', 0, 0);
        ctx.restore();
      }

      /* ---- 副图 ---- */
      if (g.hasSub) this._drawSub(ctx, g, bars, closes);

      /* ---- 十字光标 ---- */
      if (this.hover >= 0 && this.hover < bars.length) {
        const x = this._xOf(this.hover, g);
        line(ctx, [[x, g.mainT], [x, g.subT + g.subH]], COLOR.cross, 1, [3, 3]);
        const b = bars[this.hover];
        const y = yOf(b.close);
        line(ctx, [[g.plotL, y], [g.plotR, y]], COLOR.cross, 1, [3, 3]);

        ctx.fillStyle = '#1a2030';
        ctx.fillRect(g.plotR + 2, y - 8, PAD.right - 4, 16);
        ctx.fillStyle = '#d8dee9';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        ctx.fillText(b.close.toFixed(2), g.plotR + 6, y);
        this._showTip(b, last);
      } else {
        this._hideTip();
      }
    }

    _drawSub(ctx, g, bars, closes) {
      const xOf = i => this._xOf(i, g);
      const step = g.plotW / bars.length;
      const bw = Math.max(1, Math.min(14, step * 0.68));

      if (this.sub === 'vol') {
        let vmax = 0;
        bars.forEach(b => { if (b.volume > vmax) vmax = b.volume; });
        const vma = IND.sma(bars.map(b => b.volume), 20);
        for (let i = 0; i < bars.length; i++) {
          const b = bars[i];
          const hgt = (b.volume / vmax) * g.subH;
          ctx.fillStyle = b.close >= b.open ? 'rgba(38,166,154,.65)' : 'rgba(239,83,80,.65)';
          ctx.fillRect(Math.round(xOf(i) - bw / 2), g.subT + g.subH - hgt, Math.max(1, Math.round(bw)), hgt);
        }
        line(ctx, vma.map((v, i) => v == null ? null : [xOf(i), g.subT + g.subH - (v / vmax) * g.subH]),
             COLOR.ma20, 1);
        ctx.fillStyle = COLOR.text;
        ctx.textAlign = 'left'; ctx.textBaseline = 'top';
        ctx.fillText('VOL ' + U.fmtVol(bars[bars.length - 1].volume), g.plotL + 4, g.subT + 2);

      } else if (this.sub === 'macd') {
        const m = IND.macd(closes, 12, 26, 9);
        let mx = 0;
        for (let i = 0; i < bars.length; i++) {
          [m.dif[i], m.dea[i], m.hist[i]].forEach(v => { if (v != null) mx = Math.max(mx, Math.abs(v)); });
        }
        mx = mx || 1;
        const yOf = v => g.subT + g.subH / 2 - (v / mx) * (g.subH / 2) * 0.9;
        line(ctx, [[g.plotL, yOf(0)], [g.plotR, yOf(0)]], COLOR.grid, 1);
        for (let i = 0; i < bars.length; i++) {
          const v = m.hist[i];
          if (v == null) continue;
          ctx.fillStyle = v >= 0 ? 'rgba(38,166,154,.7)' : 'rgba(239,83,80,.7)';
          const y0 = yOf(0), y1 = yOf(v);
          ctx.fillRect(Math.round(xOf(i) - bw / 2), Math.min(y0, y1), Math.max(1, Math.round(bw)), Math.abs(y1 - y0));
        }
        line(ctx, m.dif.map((v, i) => v == null ? null : [xOf(i), yOf(v)]), COLOR.dif, 1.2);
        line(ctx, m.dea.map((v, i) => v == null ? null : [xOf(i), yOf(v)]), COLOR.dea, 1.2);
        ctx.fillStyle = COLOR.text;
        ctx.textAlign = 'left'; ctx.textBaseline = 'top';
        ctx.fillText('MACD(12,26,9)', g.plotL + 4, g.subT + 2);

      } else if (this.sub === 'rsi') {
        const r = IND.rsi(closes, 14);
        const yOf = v => g.subT + g.subH - (v / 100) * g.subH;
        [30, 50, 70].forEach(lv => {
          line(ctx, [[g.plotL, yOf(lv)], [g.plotR, yOf(lv)]], COLOR.grid, 1, lv === 50 ? null : [3, 3]);
          ctx.fillStyle = COLOR.text;
          ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
          ctx.fillText(String(lv), g.plotR + 6, yOf(lv));
        });
        line(ctx, r.map((v, i) => v == null ? null : [xOf(i), yOf(v)]), COLOR.rsi, 1.3);
        const lastR = r[r.length - 1];
        ctx.fillStyle = COLOR.text;
        ctx.textAlign = 'left'; ctx.textBaseline = 'top';
        ctx.fillText('RSI(14) ' + (lastR == null ? '—' : lastR.toFixed(1)), g.plotL + 4, g.subT + 2);
      }
    }

    _showTip(b, last) {
      if (!this.tip) return;
      const chg = b.close - b.open;
      const pct = b.open ? chg / b.open : 0;
      const cls = U.dirClass(chg);
      this.tip.innerHTML =
        '<div class="row"><span class="k">日期</span><span>' + b.date + '</span></div>' +
        '<div class="row"><span class="k">开</span><span>' + b.open.toFixed(2) + '</span></div>' +
        '<div class="row"><span class="k">高</span><span>' + b.high.toFixed(2) + '</span></div>' +
        '<div class="row"><span class="k">低</span><span>' + b.low.toFixed(2) + '</span></div>' +
        '<div class="row"><span class="k">收</span><span class="' + cls + '">' + b.close.toFixed(2) + '</span></div>' +
        '<div class="row"><span class="k">涨跌</span><span class="' + cls + '">' + U.fmtPct(pct) + '</span></div>' +
        '<div class="row"><span class="k">量</span><span>' + U.fmtVol(b.volume) + '</span></div>';
      this.tip.classList.remove('hidden');
    }

    _hideTip() { if (this.tip) this.tip.classList.add('hidden'); }

    _onMove(e) {
      const rect = this.canvas.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      const g = this._geom();
      const idx = this._indexAt(x, g);
      if (idx !== this.hover) { this.hover = idx; this.draw(); }
      if (this.tip && !this.tip.classList.contains('hidden')) {
        const tw = this.tip.offsetWidth, th = this.tip.offsetHeight;
        let tx = x + 16, ty = y + 12;
        if (tx + tw > rect.width - 8) tx = x - tw - 16;
        if (ty + th > rect.height - 8) ty = rect.height - th - 8;
        this.tip.style.left = Math.max(4, tx) + 'px';
        this.tip.style.top  = Math.max(4, ty) + 'px';
      }
    }

    _onLeave() { this.hover = -1; this.draw(); }
  }

  /* ============================================================
   * LineChart —— 资金曲线等多序列折线
   * series: [{ name, values:[number], color, fill:boolean }]
   * ========================================================== */
  class LineChart {
    constructor(canvas) {
      this.canvas = canvas;
      this.labels = [];
      this.series = [];
      this._ro = new ResizeObserver(() => this.draw());
      this._ro.observe(canvas);
    }

    setData(labels, series) {
      this.labels = labels || [];
      this.series = series || [];
      this.draw();
    }

    draw() {
      const { ctx, w, h } = setupCanvas(this.canvas);
      const labels = this.labels, series = this.series;
      if (!series.length || !labels.length) {
        ctx.fillStyle = COLOR.text;
        ctx.font = '13px system-ui';
        ctx.textAlign = 'center';
        ctx.fillText('运行回测后显示资金曲线', w / 2, h / 2);
        return;
      }

      const plotL = PAD.left + 4, plotR = w - PAD.right;
      const plotT = PAD.top, plotB = h - PAD.bottom;
      const plotW = plotR - plotL, plotH = plotB - plotT;

      let lo = Infinity, hi = -Infinity;
      series.forEach(s => s.values.forEach(v => {
        if (v == null || !isFinite(v)) return;
        if (v < lo) lo = v; if (v > hi) hi = v;
      }));
      const [vMin, vMax] = padRange(lo, hi, 0.08);
      const n = labels.length;
      const xOf = i => plotL + (n <= 1 ? 0 : (i / (n - 1)) * plotW);
      const yOf = v => plotB - ((v - vMin) / (vMax - vMin)) * plotH;

      ctx.font = '10px "SF Mono", Consolas, monospace';
      ctx.textBaseline = 'middle';
      for (let i = 0; i <= 5; i++) {
        const v = vMin + (vMax - vMin) * (i / 5);
        const y = yOf(v);
        line(ctx, [[plotL, y], [plotR, y]], COLOR.grid, 1);
        ctx.fillStyle = COLOR.text;
        ctx.textAlign = 'left';
        ctx.fillText(U.fmtVol(v), plotR + 6, y);
      }

      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      const dt = Math.min(6, n);
      for (let i = 0; i < dt; i++) {
        const idx = Math.round((n - 1) * (i / Math.max(1, dt - 1)));
        const x = xOf(idx);
        line(ctx, [[x, plotT], [x, plotB]], COLOR.grid, 1);
        ctx.fillStyle = COLOR.text;
        ctx.fillText(String(labels[idx]).slice(2), x, plotB + 6);
      }

      series.forEach(s => {
        const pts = s.values.map((v, i) => v == null ? null : [xOf(i), yOf(v)]);
        if (s.fill) {
          ctx.save();
          const grad = ctx.createLinearGradient(0, plotT, 0, plotB);
          grad.addColorStop(0, 'rgba(76,141,255,.22)');
          grad.addColorStop(1, 'rgba(76,141,255,0)');
          ctx.fillStyle = grad;
          ctx.beginPath();
          ctx.moveTo(xOf(0), plotB);
          pts.forEach(p => { if (p) ctx.lineTo(p[0], p[1]); });
          ctx.lineTo(xOf(n - 1), plotB);
          ctx.closePath();
          ctx.fill();
          ctx.restore();
        }
        line(ctx, pts, s.color, s.width || 1.6, s.dash);
      });
    }
  }

  /* ============================================================
   * RadarChart —— 六边形战士
   * axes: [{ label, value(0-100), sector(0-100|null), desc }]
   * ========================================================== */
  class RadarChart {
    constructor(canvas) {
      this.canvas = canvas;
      this.axes = [];
      this._ro = new ResizeObserver(() => this.draw());
      this._ro.observe(canvas);
    }

    setData(axes) { this.axes = axes || []; this.draw(); }

    draw() {
      const { ctx, w, h } = setupCanvas(this.canvas);
      const axes = this.axes;
      if (!axes.length) {
        ctx.fillStyle = COLOR.text;
        ctx.font = '13px system-ui';
        ctx.textAlign = 'center';
        ctx.fillText('运行分析后显示分位雷达', w / 2, h / 2);
        return;
      }

      const cx = w / 2;
      const cy = h / 2 + 4;
      // 留出边距给外圈文字标签
      const R = Math.max(40, Math.min(w / 2 - 74, h / 2 - 40));
      const n = axes.length;
      const angleOf = i => -Math.PI / 2 + (i / n) * Math.PI * 2;
      const pt = (i, frac) => [cx + Math.cos(angleOf(i)) * R * frac,
                               cy + Math.sin(angleOf(i)) * R * frac];

      /* 同心网格 */
      for (let ring = 1; ring <= 5; ring++) {
        const frac = ring / 5;
        ctx.beginPath();
        for (let i = 0; i < n; i++) {
          const p = pt(i, frac);
          if (i === 0) ctx.moveTo(p[0], p[1]); else ctx.lineTo(p[0], p[1]);
        }
        ctx.closePath();
        ctx.strokeStyle = ring === 5 ? 'rgba(139,149,168,.45)' : COLOR.grid;
        ctx.lineWidth = 1;
        ctx.stroke();
      }

      /* 轴线 */
      ctx.strokeStyle = COLOR.grid;
      for (let i = 0; i < n; i++) {
        const p = pt(i, 1);
        ctx.beginPath();
        ctx.moveTo(cx, cy);
        ctx.lineTo(p[0], p[1]);
        ctx.stroke();
      }

      /* 50 分位参考线（等于全市场中位数） */
      ctx.beginPath();
      for (let i = 0; i < n; i++) {
        const p = pt(i, 0.5);
        if (i === 0) ctx.moveTo(p[0], p[1]); else ctx.lineTo(p[0], p[1]);
      }
      ctx.closePath();
      ctx.setLineDash([3, 3]);
      ctx.strokeStyle = 'rgba(240,167,66,.5)';
      ctx.stroke();
      ctx.setLineDash([]);

      /* 行业分位（虚线轮廓，缺值按 50 处理以保持形状闭合） */
      const hasSector = axes.some(a => a.sector != null);
      if (hasSector) {
        ctx.beginPath();
        for (let i = 0; i < n; i++) {
          const v = axes[i].sector == null ? 50 : axes[i].sector;
          const p = pt(i, U.clamp(v, 0, 100) / 100);
          if (i === 0) ctx.moveTo(p[0], p[1]); else ctx.lineTo(p[0], p[1]);
        }
        ctx.closePath();
        ctx.setLineDash([4, 3]);
        ctx.strokeStyle = 'rgba(199,125,255,.85)';
        ctx.lineWidth = 1.4;
        ctx.stroke();
        ctx.setLineDash([]);
      }

      /* 全市场分位（实心多边形） */
      ctx.beginPath();
      for (let i = 0; i < n; i++) {
        const v = axes[i].value == null ? 0 : axes[i].value;
        const p = pt(i, U.clamp(v, 0, 100) / 100);
        if (i === 0) ctx.moveTo(p[0], p[1]); else ctx.lineTo(p[0], p[1]);
      }
      ctx.closePath();
      ctx.fillStyle = 'rgba(76,141,255,.28)';
      ctx.fill();
      ctx.strokeStyle = COLOR.accent;
      ctx.lineWidth = 2;
      ctx.stroke();

      /* 顶点 */
      for (let i = 0; i < n; i++) {
        const v = axes[i].value;
        if (v == null) continue;
        const p = pt(i, U.clamp(v, 0, 100) / 100);
        ctx.beginPath();
        ctx.arc(p[0], p[1], 3, 0, Math.PI * 2);
        ctx.fillStyle = COLOR.accent;
        ctx.fill();
      }

      /* 轴标签 + 数值 */
      ctx.font = '12px system-ui';
      for (let i = 0; i < n; i++) {
        const a = angleOf(i);
        const lx = cx + Math.cos(a) * (R + 26);
        const ly = cy + Math.sin(a) * (R + 20);
        const cosv = Math.cos(a);
        ctx.textAlign = Math.abs(cosv) < 0.3 ? 'center' : (cosv > 0 ? 'left' : 'right');
        ctx.textBaseline = 'middle';

        ctx.fillStyle = '#d8dee9';
        ctx.fillText(axes[i].label, lx, ly - 7);

        const v = axes[i].value;
        ctx.font = 'bold 12px "SF Mono", Consolas, monospace';
        ctx.fillStyle = v == null ? COLOR.text
                      : v >= 70 ? COLOR.up : v >= 40 ? COLOR.accent : COLOR.down;
        ctx.fillText(v == null ? '无数据' : v.toFixed(0), lx, ly + 8);
        ctx.font = '12px system-ui';
      }
    }
  }

  return { CandleChart, LineChart, RadarChart, COLOR };
})();
