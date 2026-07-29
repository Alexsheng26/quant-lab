/* ============================================================
 * utils.js —— 通用工具：DOM、格式化、存储、事件总线
 * ============================================================ */

window.QL = window.QL || {};

QL.utils = (function () {

  /* ---------- DOM ---------- */
  const $  = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => Array.from((root || document).querySelectorAll(sel));

  function el(tag, className, html) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (html != null) node.innerHTML = html;
    return node;
  }

  /* ---------- 数字格式化 ---------- */
  function fmtPrice(v, digits) {
    if (v == null || isNaN(v)) return '—';
    return Number(v).toFixed(digits == null ? 2 : digits);
  }

  function fmtMoney(v) {
    if (v == null || isNaN(v)) return '—';
    return '$' + Number(v).toLocaleString('en-US', {
      minimumFractionDigits: 2, maximumFractionDigits: 2
    });
  }

  function fmtPct(v, digits) {
    if (v == null || isNaN(v)) return '—';
    const d = digits == null ? 2 : digits;
    return (v >= 0 ? '+' : '') + (v * 100).toFixed(d) + '%';
  }

  /** 大数缩写：1.23M / 45.6K */
  function fmtVol(v) {
    if (v == null || isNaN(v)) return '—';
    const abs = Math.abs(v);
    if (abs >= 1e9) return (v / 1e9).toFixed(2) + 'B';
    if (abs >= 1e6) return (v / 1e6).toFixed(2) + 'M';
    if (abs >= 1e3) return (v / 1e3).toFixed(1) + 'K';
    return String(Math.round(v));
  }

  /** 根据正负返回 CSS 类名（美股：绿涨红跌） */
  function dirClass(v) {
    if (v > 0) return 'up';
    if (v < 0) return 'down';
    return 'flat';
  }

  function clamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }

  /** 把任意区间的值线性映射到 0-100 并截断 */
  function scale(v, lo, hi) {
    if (hi === lo) return 50;
    return clamp(((v - lo) / (hi - lo)) * 100, 0, 100);
  }

  /* ---------- 日期 ---------- */
  function fmtDate(d) {
    const dt = (d instanceof Date) ? d : new Date(d);
    const p = n => String(n).padStart(2, '0');
    return dt.getFullYear() + '-' + p(dt.getMonth() + 1) + '-' + p(dt.getDate());
  }

  function fmtTime(d) {
    const dt = (d instanceof Date) ? d : new Date(d);
    const p = n => String(n).padStart(2, '0');
    return p(dt.getHours()) + ':' + p(dt.getMinutes()) + ':' + p(dt.getSeconds());
  }

  /** 美东时间的当前小时+分钟（不依赖任何库，用 Intl 拿时区） */
  function nowET() {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York',
      hour: '2-digit', minute: '2-digit', weekday: 'short', hour12: false
    }).formatToParts(new Date());
    const get = t => (parts.find(p => p.type === t) || {}).value;
    return {
      hour: parseInt(get('hour'), 10) % 24,
      minute: parseInt(get('minute'), 10),
      weekday: get('weekday')
    };
  }

  /** 美股是否在常规交易时段（09:30–16:00 ET，周一至周五；未处理节假日） */
  function marketSession() {
    const t = nowET();
    if (t.weekday === 'Sat' || t.weekday === 'Sun') return 'closed';
    const mins = t.hour * 60 + t.minute;
    if (mins >= 4 * 60 && mins < 9 * 60 + 30)  return 'pre';
    if (mins >= 9 * 60 + 30 && mins < 16 * 60) return 'open';
    if (mins >= 16 * 60 && mins < 20 * 60)     return 'post';
    return 'closed';
  }

  /* ---------- 存储 ---------- */
  const store = {
    get(key, fallback) {
      try {
        const raw = localStorage.getItem(key);
        return raw == null ? fallback : JSON.parse(raw);
      } catch (e) { return fallback; }
    },
    set(key, value) {
      try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) { /* 隐私模式忽略 */ }
    },
    remove(key) {
      try { localStorage.removeItem(key); } catch (e) {}
    }
  };

  /* ---------- 事件总线 ---------- */
  const bus = (function () {
    const map = {};
    return {
      on(evt, fn)   { (map[evt] = map[evt] || []).push(fn); },
      off(evt, fn)  { map[evt] = (map[evt] || []).filter(f => f !== fn); },
      emit(evt, payload) { (map[evt] || []).forEach(fn => { try { fn(payload); } catch (e) { console.error(e); } }); }
    };
  })();

  function debounce(fn, wait) {
    let timer;
    return function () {
      const args = arguments, ctx = this;
      clearTimeout(timer);
      timer = setTimeout(() => fn.apply(ctx, args), wait);
    };
  }

  return {
    $, $$, el,
    fmtPrice, fmtMoney, fmtPct, fmtVol, dirClass,
    clamp, scale,
    fmtDate, fmtTime, nowET, marketSession,
    store, bus, debounce
  };
})();
