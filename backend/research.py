"""
研究 Agent —— 挖公告与财报
==========================

数据来自 SEC EDGAR 官方接口：免费、无需 API Key、覆盖全部美股上市公司。

关键点：**不去解析 PDF**。SEC 强制上市公司用 XBRL 提交结构化财务数据，
`companyfacts` 接口直接返回机读的营收/净利/资产/现金流等科目，
比从几百页 10-K 里抽文本可靠得多，也快得多。

接口：
    https://www.sec.gov/files/company_tickers.json      代码 -> CIK 映射
    https://data.sec.gov/submissions/CIK##########.json 申报历史
    https://data.sec.gov/api/xbrl/companyfacts/CIK...   全部 XBRL 财务事实

SEC 要求请求头带 User-Agent 说明用途和联系方式，否则会被限流。
"""

from __future__ import annotations

import threading
import time
from typing import Any, Dict, List, Optional

import requests

SEC_UA = {
    "User-Agent": "QuantLab research tool (educational; contact: quantlab@example.com)",
    "Accept-Encoding": "gzip, deflate",
}

TICKERS_URL = "https://www.sec.gov/files/company_tickers.json"
SUBMISSIONS_URL = "https://data.sec.gov/submissions/CIK{cik}.json"
COMPANYFACTS_URL = "https://data.sec.gov/api/xbrl/companyfacts/CIK{cik}.json"

# SEC 建议每秒不超过 10 次请求，这里保守一点
_MIN_INTERVAL = 0.15
_last_call = [0.0]
_rate_lock = threading.Lock()


def _get(url: str, timeout: int = 30) -> Any:
    with _rate_lock:
        wait = _MIN_INTERVAL - (time.time() - _last_call[0])
        if wait > 0:
            time.sleep(wait)
        _last_call[0] = time.time()
    resp = requests.get(url, headers=SEC_UA, timeout=timeout)
    resp.raise_for_status()
    return resp.json()


# ----------------------------------------------------------------------
# CIK 映射
# ----------------------------------------------------------------------
_cik_map: Optional[Dict[str, Dict[str, Any]]] = None
_cik_lock = threading.Lock()


def cik_for(symbol: str) -> Optional[Dict[str, Any]]:
    """代码 -> {cik, title}。整张表约 10400 条，进程内缓存一次。"""
    global _cik_map
    with _cik_lock:
        if _cik_map is None:
            try:
                raw = _get(TICKERS_URL)
                _cik_map = {
                    str(v["ticker"]).upper(): {
                        "cik": str(v["cik_str"]).zfill(10),
                        "title": v["title"],
                    }
                    for v in raw.values()
                }
                print(f"[research] SEC 代码表已加载 {len(_cik_map)} 家")
            except Exception as exc:                  # noqa: BLE001
                print(f"[research] SEC 代码表加载失败: {type(exc).__name__}: {exc}")
                _cik_map = {}
    # 类别股在 SEC 那边写作 BRK-B，和我们前端一致；再兜一层去掉后缀的写法
    sym = symbol.strip().upper()
    return _cik_map.get(sym) or _cik_map.get(sym.split("-")[0])


# ----------------------------------------------------------------------
# 申报历史
# ----------------------------------------------------------------------

# 真正值得看的表单类型；Form 4（高管交易）数量最多但信息量低，单独归类
FORM_MEANING = {
    "10-K": "年报",
    "10-Q": "季报",
    "8-K": "重大事件",
    "S-1": "招股说明书",
    "S-3": "增发登记",
    "DEF 14A": "股东委托书",
    "SC 13D": "5%以上持股",
    "SC 13G": "被动持股披露",
    "4": "高管/董事交易",
    "144": "限制性股票出售",
    "SD": "冲突矿产披露",
    "6-K": "外国发行人临时报告",
    "20-F": "外国发行人年报",
}

KEY_FORMS = {"10-K", "10-Q", "8-K", "20-F", "6-K", "DEF 14A", "S-1"}


def filings(symbol: str, limit: int = 25) -> Dict[str, Any]:
    """最近申报列表，按重要性拆成两组。"""
    meta = cik_for(symbol)
    if not meta:
        return {"symbol": symbol, "found": False,
                "reason": f"{symbol} 不在 SEC 登记名录中（ETF、ADR 或非美国注册主体可能没有）"}

    data = _get(SUBMISSIONS_URL.format(cik=meta["cik"]))
    recent = data.get("filings", {}).get("recent", {})
    n = len(recent.get("form", []))

    key_items: List[Dict[str, Any]] = []
    other_items: List[Dict[str, Any]] = []

    for i in range(n):
        form = recent["form"][i]
        acc = recent["accessionNumber"][i].replace("-", "")
        doc = recent.get("primaryDocument", [""] * n)[i]
        item = {
            "form": form,
            "meaning": FORM_MEANING.get(form, form),
            "filingDate": recent["filingDate"][i],
            "reportDate": recent.get("reportDate", [""] * n)[i],
            "description": recent.get("primaryDocDescription", [""] * n)[i],
            "url": (f"https://www.sec.gov/Archives/edgar/data/"
                    f"{int(meta['cik'])}/{acc}/{doc}") if doc else "",
        }
        if form in KEY_FORMS:
            if len(key_items) < limit:
                key_items.append(item)
        elif len(other_items) < limit:
            other_items.append(item)

        if len(key_items) >= limit and len(other_items) >= limit:
            break

    return {
        "symbol": symbol,
        "found": True,
        "cik": meta["cik"],
        "companyName": data.get("name") or meta["title"],
        "sic": data.get("sicDescription"),
        "exchanges": data.get("exchanges", []),
        "keyFilings": key_items,
        "otherFilings": other_items,
    }


# ----------------------------------------------------------------------
# XBRL 结构化财务
# ----------------------------------------------------------------------

# 同一个经济含义在不同年份/公司可能用不同的 us-gaap 标签，按优先级依次尝试
CONCEPTS = [
    ("revenue", "营业收入", [
        "RevenueFromContractWithCustomerExcludingAssessedTax",
        "RevenueFromContractWithCustomerIncludingAssessedTax",
        "Revenues", "SalesRevenueNet",
    ]),
    ("netIncome", "净利润", ["NetIncomeLoss", "ProfitLoss"]),
    ("grossProfit", "毛利", ["GrossProfit"]),
    ("operatingIncome", "营业利润", ["OperatingIncomeLoss"]),
    ("assets", "总资产", ["Assets"]),
    ("liabilities", "总负债", ["Liabilities"]),
    ("equity", "股东权益", [
        "StockholdersEquity",
        "StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest",
    ]),
    ("cashFromOps", "经营现金流", ["NetCashProvidedByUsedInOperatingActivities"]),
    ("eps", "每股收益", ["EarningsPerShareDiluted", "EarningsPerShareBasic"]),
]


def _annual_series(facts: Dict[str, Any], tags: List[str], max_years: int = 6) -> List[Dict[str, Any]]:
    """从 companyfacts 里取某个概念的年度序列（优先 10-K 的 FY 数据）。"""
    us_gaap = facts.get("facts", {}).get("us-gaap", {})
    for tag in tags:
        node = us_gaap.get(tag)
        if not node:
            continue
        for unit_name, records in node.get("units", {}).items():
            annual = [
                r for r in records
                if r.get("form") in ("10-K", "20-F") and r.get("fp") == "FY" and r.get("frame")
            ]
            # 有 frame 标记的是 SEC 归一化过的年度值，最干净；没有就退回按期间长度筛
            if not annual:
                annual = [
                    r for r in records
                    if r.get("form") in ("10-K", "20-F") and r.get("start") and r.get("end")
                    and 300 <= _days(r["start"], r["end"]) <= 400
                ]
            if not annual:
                # 资产负债表科目是时点值，没有 start
                annual = [r for r in records if r.get("form") in ("10-K", "20-F") and not r.get("start")]
            if not annual:
                continue

            # 同一年可能有多条（原报 + 重述），按 end 去重保留最后申报的
            by_end: Dict[str, Dict[str, Any]] = {}
            for r in sorted(annual, key=lambda x: (x["end"], x.get("filed", ""))):
                by_end[r["end"]] = r
            out = [
                {"end": r["end"], "fy": r.get("fy"), "val": r["val"], "unit": unit_name, "tag": tag}
                for r in sorted(by_end.values(), key=lambda x: x["end"])
            ][-max_years:]
            if out:
                return out
    return []


def _days(start: str, end: str) -> int:
    from datetime import date
    a = date(*map(int, start.split("-")))
    b = date(*map(int, end.split("-")))
    return (b - a).days


def financials(symbol: str) -> Dict[str, Any]:
    """把 XBRL 事实整理成几条可直接画图的年度序列，并算出同比增速。"""
    meta = cik_for(symbol)
    if not meta:
        return {"symbol": symbol, "found": False,
                "reason": f"{symbol} 不在 SEC 登记名录中"}

    facts = _get(COMPANYFACTS_URL.format(cik=meta["cik"]))

    series: Dict[str, Any] = {}
    for key, label, tags in CONCEPTS:
        rows = _annual_series(facts, tags)
        if rows:
            series[key] = {"label": label, "rows": rows, "tag": rows[0]["tag"]}

    # 派生指标：最近一个完整财年的利润率与同比
    derived: Dict[str, Any] = {}
    rev = series.get("revenue", {}).get("rows", [])
    ni = series.get("netIncome", {}).get("rows", [])
    eq = series.get("equity", {}).get("rows", [])

    if rev and ni and rev[-1]["end"] == ni[-1]["end"] and rev[-1]["val"]:
        derived["netMargin"] = ni[-1]["val"] / rev[-1]["val"]
    if len(rev) >= 2 and rev[-2]["val"]:
        derived["revenueYoY"] = rev[-1]["val"] / rev[-2]["val"] - 1
    if len(ni) >= 2 and ni[-2]["val"]:
        derived["netIncomeYoY"] = ni[-1]["val"] / ni[-2]["val"] - 1
    if ni and eq and eq[-1]["val"]:
        derived["roe"] = ni[-1]["val"] / eq[-1]["val"]

    return {
        "symbol": symbol,
        "found": True,
        "cik": meta["cik"],
        "companyName": facts.get("entityName") or meta["title"],
        "series": series,
        "derived": derived,
        "source": "SEC EDGAR XBRL companyfacts",
    }
