"""
QuantLab 行情后端（骨架）
========================

前端 assets/js/dataSource.js 里的 LiveProvider 就是按这套接口写的，
后端跑起来后，网页右上角把 MOCK 切成 LIVE 即可接真实数据。

接口：
    GET /api/health                      健康检查
    GET /api/search?q=AAPL               标的搜索
    GET /api/history?symbol=AAPL&days=760  日线历史
    GET /api/quote?symbol=AAPL           最新报价

数据源说明（重要）
------------------
* akshare  —— 中文社区最常用，A 股覆盖最好；美股走的是东财接口
               （stock_us_daily / stock_us_spot_em），字段偶尔会变，
               而且不保证实时（通常延迟 15 分钟以上）。
* baostock —— **只有 A 股**，没有美股数据，所以这里没有接入。
               如果之后要做 A 股，再加一个 BaostockProvider 即可。
* yfinance —— 美股覆盖最全、最稳，作为默认兜底。

运行：
    pip install -r requirements.txt
    python app.py
"""

from __future__ import annotations

import json
import os
import re
import time
import threading
from typing import Any, Dict, List, Optional

from fastapi import FastAPI, HTTPException, Query, Request
from fastapi.middleware.cors import CORSMiddleware

app = FastAPI(title="QuantLab Market API", version="0.1.0")

# CORS：本地开发放开，公网部署必须收紧。
#
# 默认 "*" 是为了本地能直接双击 index.html（file:// 的 Origin 是 "null"）。
# 一旦部署到公网，任何网页都能调你的后端——包括花你钱的 /api/news/ask。
# 部署时设 ALLOWED_ORIGINS 环境变量，逗号分隔，例如：
#   ALLOWED_ORIGINS=https://alexsheng26.github.io
_origins_env = os.environ.get("ALLOWED_ORIGINS", "").strip()
ALLOWED_ORIGINS = [o.strip() for o in _origins_env.split(",") if o.strip()] or ["*"]
if ALLOWED_ORIGINS == ["*"]:
    print("[cors] 允许所有来源（本地开发默认）。公网部署请设置 ALLOWED_ORIGINS。")
else:
    print(f"[cors] 仅允许：{', '.join(ALLOWED_ORIGINS)}")

app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_credentials=False,
    allow_methods=["GET"],
    allow_headers=["*"],
)


# ----------------------------------------------------------------------
# 生成式问答的调用限额
#
# /api/news/ask 会真金白银地调 Claude API。部署到公网后，任何知道 URL 的人
# 都能刷你的额度。这里做一个进程内的滑动窗口限流，按客户端 IP 计。
# 不是严密的防护（IP 可以换），但足以挡住无意的循环和顺手的滥用。
# ----------------------------------------------------------------------
LLM_CALLS_PER_HOUR = int(os.environ.get("LLM_CALLS_PER_HOUR", "30"))
_llm_calls: Dict[str, List[float]] = {}
_llm_lock = threading.Lock()


def _llm_rate_ok(client_ip: str) -> bool:
    now = time.time()
    with _llm_lock:
        hits = [t for t in _llm_calls.get(client_ip, []) if now - t < 3600]
        if len(hits) >= LLM_CALLS_PER_HOUR:
            _llm_calls[client_ip] = hits
            return False
        hits.append(now)
        _llm_calls[client_ip] = hits
        # 顺手清理不活跃的 IP，避免长期运行内存无限增长
        if len(_llm_calls) > 5000:
            for k in [k for k, v in _llm_calls.items() if not v or now - v[-1] > 3600]:
                _llm_calls.pop(k, None)
        return True


# ----------------------------------------------------------------------
# 简易 TTL 缓存：免得刷新页面就把上游接口打爆
# ----------------------------------------------------------------------
class TTLCache:
    def __init__(self) -> None:
        self._data: Dict[str, tuple[float, Any]] = {}
        self._lock = threading.Lock()

    def get(self, key: str, ttl: float) -> Optional[Any]:
        with self._lock:
            hit = self._data.get(key)
            if hit and time.time() - hit[0] < ttl:
                return hit[1]
        return None

    def set(self, key: str, value: Any) -> None:
        with self._lock:
            self._data[key] = (time.time(), value)


cache = TTLCache()

HISTORY_TTL = 60 * 30   # 日线缓存 30 分钟
QUOTE_TTL = 10          # 报价缓存 10 秒


# ----------------------------------------------------------------------
# 标的池：读 data/symbols.json（由 build_symbols.py 从 NASDAQ Trader 官方清单生成）
# 文件不存在时退回一份最小清单，服务照常可用。
# ----------------------------------------------------------------------
_HERE = os.path.dirname(os.path.abspath(__file__))
_SYMBOLS_PATH = os.path.join(_HERE, "data", "symbols.json")

FALLBACK_SYMBOLS: List[Dict[str, str]] = [
    {"symbol": "AAPL", "name": "苹果 Apple",     "exchange": "NASDAQ"},
    {"symbol": "MSFT", "name": "微软 Microsoft", "exchange": "NASDAQ"},
    {"symbol": "NVDA", "name": "英伟达 NVIDIA",  "exchange": "NASDAQ"},
    {"symbol": "TSLA", "name": "特斯拉 Tesla",   "exchange": "NASDAQ"},
    {"symbol": "SPY",  "name": "标普500 ETF",    "exchange": "NYSEARCA"},
]


def _load_symbols() -> List[Dict[str, str]]:
    try:
        with open(_SYMBOLS_PATH, encoding="utf-8") as f:
            data = json.load(f)
        if data:
            print(f"[symbols] 已加载 {len(data)} 个代码")
            return data
    except FileNotFoundError:
        print(f"[symbols] 没找到 {_SYMBOLS_PATH}，"
              f"运行 python backend/build_symbols.py 生成全量代码表")
    except Exception as exc:                          # noqa: BLE001
        print(f"[symbols] 读取失败：{type(exc).__name__}: {exc}")
    return FALLBACK_SYMBOLS


SYMBOLS = _load_symbols()
SYMBOL_MAP = {s["symbol"]: s for s in SYMBOLS}


DERIVATIVE_RE = re.compile(
    r"\b(2x|3x|-1x|bull|bear|inverse|leverage|leveraged|daily|"
    r"option income|covered call|acquisition corp|yieldmax)\b"
)

ALIASES = {
    "tsmc": "TSM", "台积电": "TSM",
    "google": "GOOGL", "alphabet": "GOOGL",
    "facebook": "META", "fb": "META",
    "berkshire": "BRK-B", "伯克希尔": "BRK-B",
    "amazon": "AMZN", "apple": "AAPL", "microsoft": "MSFT",
    "nvidia": "NVDA", "tesla": "TSLA", "netflix": "NFLX",
    "alibaba": "BABA", "sp500": "SPY", "s&p500": "SPY", "nasdaq100": "QQQ",
}


def _score_match(item: Dict[str, Any], key: str) -> int:
    """和前端 dataSource.js 里的 scoreMatch 保持一致的排序逻辑。"""
    sym = item["symbol"].lower()
    name = (item.get("name") or "").lower()

    if sym == key:
        base = 1000
    elif sym.startswith(key):
        base = 800 - len(sym)
    elif name.startswith(key):
        base = 600 - len(sym)
    elif (" " + key) in name:
        base = 500 - len(sym)
    elif key in sym:
        base = 300 - len(sym)
    elif key in name:
        base = 200 - len(sym)
    else:
        return -1

    if item.get("pop"):
        base += 150
    if DERIVATIVE_RE.search(name):
        base -= 260
    return base


# ----------------------------------------------------------------------
# Provider
# ----------------------------------------------------------------------
class ProviderError(RuntimeError):
    pass


def fetch_history_yfinance(symbol: str, days: int) -> List[Dict[str, Any]]:
    """yfinance：美股首选，字段稳定。"""
    try:
        import yfinance as yf
    except ImportError as exc:  # pragma: no cover
        raise ProviderError("yfinance 未安装") from exc

    if days > 1200:
        period = "10y"
    elif days > 500:
        period = "5y"
    else:
        period = "2y"
    df = yf.Ticker(symbol).history(period=period, interval="1d", auto_adjust=False)
    if df is None or df.empty:
        raise ProviderError(f"yfinance 未返回 {symbol} 的数据")

    df = df.tail(days)
    bars = []
    for idx, row in df.iterrows():
        bars.append({
            "date": idx.strftime("%Y-%m-%d"),
            "open": round(float(row["Open"]), 4),
            "high": round(float(row["High"]), 4),
            "low": round(float(row["Low"]), 4),
            "close": round(float(row["Close"]), 4),
            "volume": int(row["Volume"]) if row["Volume"] == row["Volume"] else 0,
        })
    return bars


def fetch_history_akshare(symbol: str, days: int) -> List[Dict[str, Any]]:
    """akshare：走东财美股日线接口，列名可能随版本变动，做了容错映射。"""
    try:
        import akshare as ak
    except ImportError as exc:
        raise ProviderError("akshare 未安装") from exc

    try:
        df = ak.stock_us_daily(symbol=symbol, adjust="")
    except TypeError:
        # 不同版本的签名不一样，去掉 adjust 再试一次
        df = ak.stock_us_daily(symbol=symbol)
    if df is None or df.empty:
        raise ProviderError(f"akshare 未返回 {symbol} 的数据")

    # 新版本直接给英文列名，老版本给中文，两种都兼容
    rename = {
        "日期": "date", "开盘": "open", "最高": "high",
        "最低": "low", "收盘": "close", "成交量": "volume",
    }
    df = df.rename(columns=rename)
    required = {"date", "open", "high", "low", "close", "volume"}
    if not required.issubset(df.columns):
        raise ProviderError(f"akshare 返回的列不符合预期：{list(df.columns)}")

    df = df.tail(days)
    bars = []
    for _, row in df.iterrows():
        bars.append({
            "date": str(row["date"])[:10],
            "open": round(float(row["open"]), 4),
            "high": round(float(row["high"]), 4),
            "low": round(float(row["low"]), 4),
            "close": round(float(row["close"]), 4),
            "volume": int(row["volume"]),
        })
    return bars


# 想优先用 akshare 就把顺序调过来
HISTORY_PROVIDERS = [fetch_history_yfinance, fetch_history_akshare]


def get_history(symbol: str, days: int) -> List[Dict[str, Any]]:
    key = f"hist:{symbol}:{days}"
    hit = cache.get(key, HISTORY_TTL)
    if hit is not None:
        return hit

    errors = []
    for provider in HISTORY_PROVIDERS:
        try:
            bars = provider(symbol, days)
            if bars:
                cache.set(key, bars)
                return bars
        except Exception as exc:                      # noqa: BLE001
            errors.append(f"{provider.__name__}: {exc}")

    raise HTTPException(status_code=502, detail="所有数据源都失败了 -> " + " | ".join(errors))


# ----------------------------------------------------------------------
# 路由
# ----------------------------------------------------------------------
@app.get("/api/health")
def health() -> Dict[str, Any]:
    return {"ok": True, "service": "quantlab", "time": int(time.time())}


def _public(s: Dict[str, Any]) -> Dict[str, str]:
    """
    只暴露前端要用的三个字段。

    内部记录还带 etf / pop 这类布尔标记，直接返回会撞上
    List[Dict[str, str]] 的响应校验（FastAPI 会把它变成 500）。
    """
    return {
        "symbol": s["symbol"],
        "name": s.get("name") or s["symbol"],
        "exchange": s.get("exchange") or "US",
    }


@app.get("/api/search")
def search(q: str = Query("", description="代码或名称关键字"),
           limit: int = 12) -> List[Dict[str, str]]:
    key = q.strip().lower()
    alias = ALIASES.get(key)
    if alias and alias in SYMBOL_MAP:
        key = alias.lower()
    if not key:
        return [_public(s) for s in SYMBOLS[:limit]]

    scored = []
    for s in SYMBOLS:
        sc = _score_match(s, key)
        if sc > 0:
            scored.append((sc, s["symbol"], s))
    scored.sort(key=lambda t: (-t[0], t[1]))
    hits = [_public(t[2]) for t in scored[:limit]]

    # 清单外的代码也放行，交给上游数据源去验证
    if not hits and key.replace("-", "").isalnum():
        up = q.strip().upper()
        hits = [{"symbol": up, "name": up, "exchange": "US"}]
    return hits


@app.get("/api/history")
def history(symbol: str, days: int = 1800) -> Dict[str, Any]:
    symbol = symbol.strip().upper()
    bars = get_history(symbol, days)
    meta = SYMBOL_MAP.get(symbol, {"name": symbol, "exchange": "US"})
    return {
        "symbol": symbol,
        "name": meta["name"],
        "exchange": meta["exchange"],
        "bars": bars,
    }


@app.get("/api/quote")
def quote(symbol: str) -> Dict[str, Any]:
    """
    先尝试拿盘中实时价；失败就退回日线最后一根，
    保证前端永远拿得到一个可用报价，不会白屏。
    """
    symbol = symbol.strip().upper()
    key = f"quote:{symbol}"
    hit = cache.get(key, QUOTE_TTL)
    if hit is not None:
        return hit

    meta = SYMBOL_MAP.get(symbol, {"name": symbol, "exchange": "US"})
    result: Optional[Dict[str, Any]] = None

    try:
        import yfinance as yf
        fast = yf.Ticker(symbol).fast_info

        # yfinance 1.x 把 fast_info 的键从 snake_case 换成了 camelCase，
        # 两种都试一遍，省得升级一次就静默退回日线数据。
        def pick(*names, default=None):
            for n in names:
                try:
                    v = fast[n]
                except (KeyError, TypeError):
                    v = None
                if v is not None:
                    return v
            return default

        last = pick("lastPrice", "last_price")
        if last is None:
            raise ProviderError("fast_info 没有返回最新价")
        last = float(last)
        prev = float(pick("previousClose", "regularMarketPreviousClose",
                          "previous_close", default=last))
        result = {
            "symbol": symbol,
            "name": meta["name"],
            "exchange": meta["exchange"],
            "last": last,
            "prev_close": prev,
            "open": float(pick("open", default=last)),
            "high": float(pick("dayHigh", "day_high", default=last)),
            "low": float(pick("dayLow", "day_low", default=last)),
            "volume": int(pick("lastVolume", "last_volume", default=0)),
        }
    except Exception:                                 # noqa: BLE001
        pass

    if result is None:
        bars = get_history(symbol, 5)
        cur, prev_bar = bars[-1], (bars[-2] if len(bars) > 1 else bars[-1])
        result = {
            "symbol": symbol,
            "name": meta["name"],
            "exchange": meta["exchange"],
            "last": cur["close"],
            "prev_close": prev_bar["close"],
            "open": cur["open"],
            "high": cur["high"],
            "low": cur["low"],
            "volume": cur["volume"],
        }

    cache.set(key, result)
    return result


# ----------------------------------------------------------------------
# 三个 Agent 的接口
#
# 这三块都可能打外部服务（SEC / Yahoo），慢且会失败，所以统一做两件事：
#   1) 结果进 TTL 缓存，避免用户切个标签页就重新拉一遍
#   2) 失败返回结构化的 ok=false + reason，而不是抛 500 让前端整块空白
# ----------------------------------------------------------------------
import news as news_agent            # noqa: E402
import research as research_agent    # noqa: E402
import fundamentals as quant_agent   # noqa: E402

NEWS_TTL = 60 * 10          # 新闻 10 分钟
FILINGS_TTL = 60 * 60 * 6   # 申报列表 6 小时（一天更新不了几次）
FACTS_TTL = 60 * 60 * 24    # XBRL 财务一天一次足够
QUANT_TTL = 60 * 30         # 基本面分位 30 分钟


def _cached(key: str, ttl: float, producer):
    """统一的"取缓存 / 算 / 失败也别炸"包装。"""
    hit = cache.get(key, ttl)
    if hit is not None:
        return hit
    try:
        val = producer()
        val["ok"] = True
    except Exception as exc:                          # noqa: BLE001
        val = {"ok": False, "reason": f"{type(exc).__name__}: {exc}"}
    cache.set(key, val)
    return val


@app.get("/api/news")
def api_news(symbol: str, limit: int = 20) -> Dict[str, Any]:
    sym = symbol.strip().upper()
    return _cached(f"news:{sym}:{limit}", NEWS_TTL,
                   lambda: news_agent.fetch(sym, limit))


@app.get("/api/news/ask")
def api_news_ask(request: Request, symbol: str, q: str, limit: int = 20) -> Dict[str, Any]:
    sym = symbol.strip().upper()
    key = f"newsask:{sym}:{q}:{limit}"

    # 命中缓存不算调用——重复问同一个问题不该扣额度
    hit = cache.get(key, NEWS_TTL)
    if hit is not None:
        return hit

    client_ip = request.client.host if request.client else "unknown"
    if not _llm_rate_ok(client_ip):
        # 超额不报错，降级成检索式：功能变弱但仍可用
        res = news_agent.answer(sym, q, limit, use_llm=False)
        res["ok"] = True
        res["llmError"] = (f"已达每小时 {LLM_CALLS_PER_HOUR} 次生成式问答上限，"
                           f"本次返回检索结果")
        return res

    return _cached(key, NEWS_TTL, lambda: news_agent.answer(sym, q, limit))


@app.get("/api/filings")
def api_filings(symbol: str, limit: int = 25) -> Dict[str, Any]:
    sym = symbol.strip().upper()
    return _cached(f"filings:{sym}:{limit}", FILINGS_TTL,
                   lambda: research_agent.filings(sym, limit))


@app.get("/api/financials")
def api_financials(symbol: str) -> Dict[str, Any]:
    sym = symbol.strip().upper()
    return _cached(f"facts:{sym}", FACTS_TTL,
                   lambda: research_agent.financials(sym))


@app.get("/api/quant")
def api_quant(symbol: str) -> Dict[str, Any]:
    sym = symbol.strip().upper()
    return _cached(f"quant:{sym}", QUANT_TTL,
                   lambda: quant_agent.evaluate(sym))


@app.get("/api/llm/status")
def api_llm_status() -> Dict[str, Any]:
    """新闻问答是生成式还是检索式，前端据此显示徽章。绝不回传 API Key。"""
    try:
        import llm
        st = llm.status()
        st["ok"] = True
        return st
    except Exception as exc:                          # noqa: BLE001
        return {"ok": True, "enabled": False,
                "reason": f"{type(exc).__name__}: {exc}"}


@app.get("/api/quant/universe")
def api_quant_universe() -> Dict[str, Any]:
    """快照元信息，前端用来提示参照池有多大、什么时候建的。"""
    meta = quant_agent.snapshot_meta()
    meta["ok"] = meta.get("count", 0) > 0
    if not meta["ok"]:
        meta["reason"] = "尚未生成基本面快照，请运行 python backend/build_universe_snapshot.py"
    return meta


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="127.0.0.1", port=8000)
