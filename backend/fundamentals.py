"""
量化分析 Agent —— 全市场分位数评分
==================================

回答的是这类问题：
    这只票的 PE 在全市场排第几？ROE 打败了多少同行？
    它到底是"价值陷阱"还是"沧海遗珠"？

做法是**横截面分位**：先离线跑 `build_universe_snapshot.py` 把一批股票的
基本面存成快照，然后把目标股的每个指标放回这个池子里排名。

六个维度（对应前端那张六边形图）：
    估值  valuation    PE / PB / EV-EBITDA        —— 越低越好，分位要反转
    盈利  profitability ROE / ROA / 净利率
    成长  growth       营收增速 / 盈利增速
    质量  quality      毛利率 / 流动比率 / 负债权益比（反转）
    动量  momentum     52 周涨幅 / 距 52 周高点
    规模  size         市值（取对数）

**关于 A 股工具的移植**：截图里那套是 AkShare + BaoStock 的 A 股方案。
BaoStock 只有 A 股，美股拿不到任何数据；AkShare 的美股基本面也很单薄。
所以这里美股走 yfinance，口径不同但方法论一致。
"""

from __future__ import annotations

import json
import math
import os
import threading
import time
from typing import Any, Dict, List, Optional

HERE = os.path.dirname(os.path.abspath(__file__))
SNAPSHOT_PATH = os.path.join(HERE, "data", "universe_snapshot.json")

# 每个维度用哪些指标，以及方向（True = 数值越大越好）
AXES: List[Dict[str, Any]] = [
    {"key": "valuation", "label": "估值", "desc": "PE / PB / EV-EBITDA，越低分越高",
     "metrics": [("trailingPE", False), ("priceToBook", False), ("enterpriseToEbitda", False)]},
    {"key": "profitability", "label": "盈利", "desc": "ROE / ROA / 净利率",
     "metrics": [("returnOnEquity", True), ("returnOnAssets", True), ("profitMargins", True)]},
    {"key": "growth", "label": "成长", "desc": "营收增速 / 盈利增速",
     "metrics": [("revenueGrowth", True), ("earningsGrowth", True)]},
    {"key": "quality", "label": "质量", "desc": "毛利率 / 流动比率 / 负债率(反)",
     "metrics": [("grossMargins", True), ("currentRatio", True), ("debtToEquity", False)]},
    {"key": "momentum", "label": "动量", "desc": "52周涨幅 / 距52周高点",
     "metrics": [("fiftyTwoWeekChange", True), ("pctOf52WeekHigh", True)]},
    {"key": "size", "label": "规模", "desc": "市值（对数）",
     "metrics": [("logMarketCap", True)]},
]

# yfinance info 里要留存的原始字段
RAW_FIELDS = [
    "trailingPE", "forwardPE", "priceToBook", "enterpriseToEbitda", "pegRatio",
    "returnOnEquity", "returnOnAssets", "profitMargins", "grossMargins",
    "operatingMargins", "revenueGrowth", "earningsGrowth", "debtToEquity",
    "currentRatio", "quickRatio", "marketCap", "dividendYield", "beta",
    "freeCashflow", "totalRevenue", "sector", "industry", "shortName",
    "fiftyTwoWeekHigh", "fiftyTwoWeekLow", "currentPrice", "52WeekChange",
]


def derive(info: Dict[str, Any]) -> Dict[str, Any]:
    """从原始字段派生出排名要用的几个量。"""
    out = {k: info.get(k) for k in RAW_FIELDS}

    mc = info.get("marketCap")
    out["logMarketCap"] = math.log10(mc) if isinstance(mc, (int, float)) and mc > 0 else None

    chg = info.get("52WeekChange")
    out["fiftyTwoWeekChange"] = chg if isinstance(chg, (int, float)) else None

    hi = info.get("fiftyTwoWeekHigh")
    px = info.get("currentPrice") or info.get("regularMarketPrice")
    out["pctOf52WeekHigh"] = (px / hi) if (isinstance(hi, (int, float)) and hi > 0
                                          and isinstance(px, (int, float))) else None
    return out


def fetch_metrics(symbol: str) -> Dict[str, Any]:
    """拉单只股票的基本面。"""
    import yfinance as yf
    info = yf.Ticker(symbol).info or {}
    d = derive(info)
    d["symbol"] = symbol.upper()
    return d


# ----------------------------------------------------------------------
# 快照
# ----------------------------------------------------------------------
_snapshot: Optional[List[Dict[str, Any]]] = None
_snap_lock = threading.Lock()


def snapshot() -> List[Dict[str, Any]]:
    global _snapshot
    with _snap_lock:
        if _snapshot is None:
            try:
                with open(SNAPSHOT_PATH, encoding="utf-8") as f:
                    payload = json.load(f)
                _snapshot = payload.get("rows", payload)
                print(f"[fundamentals] 快照已加载 {len(_snapshot)} 只")
            except FileNotFoundError:
                print(f"[fundamentals] 没找到 {SNAPSHOT_PATH}，"
                      f"请先运行 python backend/build_universe_snapshot.py")
                _snapshot = []
            except Exception as exc:                  # noqa: BLE001
                print(f"[fundamentals] 快照读取失败: {type(exc).__name__}: {exc}")
                _snapshot = []
    return _snapshot


def snapshot_meta() -> Dict[str, Any]:
    try:
        with open(SNAPSHOT_PATH, encoding="utf-8") as f:
            payload = json.load(f)
        return {"builtAt": payload.get("builtAt"), "count": len(payload.get("rows", [])),
                "source": payload.get("source")}
    except Exception:                                 # noqa: BLE001
        return {"builtAt": None, "count": 0, "source": None}


# ----------------------------------------------------------------------
# 分位数
# ----------------------------------------------------------------------
def _pct_rank(value: float, pool: List[float], higher_is_better: bool) -> Optional[float]:
    """value 在 pool 中的百分位（0-100）。higher_is_better=False 时反转。"""
    if value is None or not pool:
        return None
    below = sum(1 for v in pool if v < value)
    equal = sum(1 for v in pool if v == value)
    pct = (below + 0.5 * equal) / len(pool) * 100
    return pct if higher_is_better else 100 - pct


def _pool(rows: List[Dict[str, Any]], field: str) -> List[float]:
    vals = []
    for r in rows:
        v = r.get(field)
        if isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v):
            # PE 为负（亏损）在估值排名里没有意义，剔除
            if field in ("trailingPE", "priceToBook", "enterpriseToEbitda") and v <= 0:
                continue
            vals.append(float(v))
    return vals


def evaluate(symbol: str, metrics: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
    rows = snapshot()
    if metrics is None:
        metrics = fetch_metrics(symbol)

    sector = metrics.get("sector")
    peers = [r for r in rows if r.get("sector") == sector and r.get("symbol") != metrics["symbol"]]

    axes_out = []
    for axis in AXES:
        parts_all, parts_sector, detail = [], [], []
        for field, hib in axis["metrics"]:
            val = metrics.get(field)
            if not isinstance(val, (int, float)) or isinstance(val, bool) or not math.isfinite(val):
                detail.append({"metric": field, "value": None, "marketPct": None, "sectorPct": None})
                continue
            if field in ("trailingPE", "priceToBook", "enterpriseToEbitda") and val <= 0:
                detail.append({"metric": field, "value": val, "marketPct": None,
                               "sectorPct": None, "note": "为负，不参与估值排名"})
                continue

            m = _pct_rank(val, _pool(rows, field), hib)
            s = _pct_rank(val, _pool(peers, field), hib) if peers else None
            if m is not None:
                parts_all.append(m)
            if s is not None:
                parts_sector.append(s)
            detail.append({"metric": field, "value": val, "marketPct": m, "sectorPct": s})

        axes_out.append({
            "key": axis["key"], "label": axis["label"], "desc": axis["desc"],
            "marketPct": round(sum(parts_all) / len(parts_all), 1) if parts_all else None,
            "sectorPct": round(sum(parts_sector) / len(parts_sector), 1) if parts_sector else None,
            "coverage": f"{len(parts_all)}/{len(axis['metrics'])}",
            "detail": detail,
        })

    valid = [a["marketPct"] for a in axes_out if a["marketPct"] is not None]
    # 六个维度里只有两三个有数（ETF、次新股常见）时，平均分没有意义，
    # 直接不给总分，免得用"76 分"这种数字掩盖掉数据缺失
    enough = len(valid) >= 4
    total = round(sum(valid) / len(valid), 1) if enough else None
    missing = [a["label"] for a in axes_out if a["marketPct"] is None]

    return {
        "symbol": metrics["symbol"],
        "name": metrics.get("shortName"),
        "sector": sector,
        "industry": metrics.get("industry"),
        "universeSize": len(rows),
        "peerCount": len(peers),
        "axes": axes_out,
        "total": total,
        "coverage": {"withData": len(valid), "total": len(axes_out), "missing": missing},
        "verdict": verdict(axes_out, total),
        "raw": {k: metrics.get(k) for k in RAW_FIELDS if metrics.get(k) is not None},
        "snapshot": snapshot_meta(),
    }


def verdict(axes: List[Dict[str, Any]], total: Optional[float]) -> Dict[str, Any]:
    """
    价值陷阱 vs 沧海遗珠。

    判断的核心是"便宜"和"基本面"是否匹配：
      便宜 + 基本面好  -> 可能被低估
      便宜 + 基本面差  -> 便宜有便宜的原因，典型价值陷阱形态
      贵   + 成长强    -> 成长溢价，需要业绩兑现
      贵   + 成长弱    -> 估值缺乏支撑
    """
    def get(k):
        for a in axes:
            if a["key"] == k:
                return a["marketPct"]
        return None

    val, prof, grow = get("valuation"), get("profitability"), get("growth")
    if val is None or (prof is None and grow is None):
        return {"tag": "数据不足", "cls": "flat",
                "text": "缺少足够的基本面数据，无法给出结构判断。"}

    fundamentals = [x for x in (prof, grow) if x is not None]
    fund = sum(fundamentals) / len(fundamentals)

    # 盈利和成长严重背离时，平均值会把信息抹平：
    # "盈利第 1 分位 + 成长第 99 分位" 平均成 50，被描述为"中等"，
    # 可这跟"样样中等"完全是两回事，而且恰恰是最该看清楚的形态。
    if prof is not None and grow is not None and abs(prof - grow) >= 40:
        if grow > prof:
            return {"tag": "增长未兑现盈利", "cls": "down",
                    "text": f"成长第 {grow:.0f} 分位、盈利第 {prof:.0f} 分位，两者严重背离。"
                            f"收入在快速扩张但没有转化成利润，典型的烧钱换增长阶段；"
                            f"估值（第 {val:.0f} 分位）押的是未来兑现，"
                            f"一旦增速掉下来就没有盈利托底。"}
        return {"tag": "高盈利低增长", "cls": "flat",
                "text": f"盈利第 {prof:.0f} 分位、成长第 {grow:.0f} 分位，两者严重背离。"
                        f"赚钱能力强但增长停滞，属于成熟期或周期见顶的形态；"
                        f"估值第 {val:.0f} 分位，关键看这份盈利能维持多久。"}

    # 两边各自分三档。早先只写了"便宜/贵"×"强/弱"四个分支，
    # 一边极端而另一边中等时会掉进兜底分支，而兜底文案硬说"两边都没有明显偏离"
    # —— 估值第 9 分位被说成没有偏离，是明显的错误结论。
    v_state = "cheap" if val >= 60 else "rich" if val <= 40 else "mid"
    f_state = "strong" if fund >= 60 else "weak" if fund <= 40 else "mid"

    v_word = {"cheap": f"估值第 {val:.0f} 分位（相对便宜）",
              "rich":  f"估值第 {val:.0f} 分位（相对偏贵）",
              "mid":   f"估值第 {val:.0f} 分位（中性）"}[v_state]
    f_word = {"strong": f"盈利与成长第 {fund:.0f} 分位（偏强）",
              "weak":   f"盈利与成长第 {fund:.0f} 分位（偏弱）",
              "mid":    f"盈利与成长第 {fund:.0f} 分位（中等）"}[f_state]
    base = f"{v_word}，{f_word}。"

    table = {
        ("cheap", "strong"): ("沧海遗珠形态", "up",
                              "便宜且基本面不差，值得进一步研究——"
                              "但要先查清楚市场为什么不肯给估值。"),
        ("cheap", "weak"): ("价值陷阱风险", "down",
                            "便宜通常有便宜的道理。这是典型的价值陷阱形态，"
                            "低估值可能反映的是基本面持续恶化。"),
        ("cheap", "mid"): ("估值偏低", "flat",
                           "估值明显低于市场多数，但基本面没有对应的亮点，"
                           "需要判断折价来自周期还是结构性问题。"),
        ("rich", "strong"): ("成长溢价", "flat",
                             "高估值由基本面支撑，风险在于增速一旦放缓，估值会先杀。"),
        ("rich", "weak"): ("估值缺乏支撑", "down",
                           "贵而基本面不强，缺乏安全边际。"),
        ("rich", "mid"): ("估值偏高", "down",
                          "估值排在市场前列，基本面却只是中等，"
                          "溢价主要靠预期而非当期数据支撑。"),
        ("mid", "strong"): ("基本面占优", "up",
                            "估值不极端，盈利成长明显强于多数公司，属于质量优先的形态。"),
        ("mid", "weak"): ("基本面偏弱", "down",
                          "估值不便宜也不贵，但盈利成长落后于多数公司。"),
        ("mid", "mid"): ("中性均衡", "flat",
                         "估值与基本面都在市场中段，没有明显的错误定价信号。"),
    }
    tag, cls, comment = table[(v_state, f_state)]
    return {"tag": tag, "cls": cls, "text": base + comment}
