"""
构建全市场基本面快照
====================

分位数评分需要一个"参照池"——要知道某只股的 PE 排第几，
就得先有一批股票的 PE。这个脚本负责离线把这个池子备好。

为什么不实时拉全市场：symbols.js 里有 11700+ 个代码，
yfinance 每只 info 要 0.5~1.5 秒且有速率限制，全量要跑好几个小时，
不可能放在用户点一下的请求里。所以离线跑一次存成快照，
后端启动时加载，排名瞬间完成。

标的池取标普 500 成分（覆盖美股约 80% 市值，做横截面参照足够），
从维基百科拿列表；取不到就退回内置的大盘股清单。

用法：
    .venv\\Scripts\\python backend\\build_universe_snapshot.py
    .venv\\Scripts\\python backend\\build_universe_snapshot.py --limit 120   # 快速试跑
"""

from __future__ import annotations

import argparse
import concurrent.futures
import json
import os
import sys
import time
from typing import Any, Dict, List

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from fundamentals import derive, SNAPSHOT_PATH        # noqa: E402

WIKI_SP500 = "https://en.wikipedia.org/wiki/List_of_S%26P_500_companies"

FALLBACK = """AAPL MSFT NVDA GOOGL AMZN META TSLA AVGO BRK-B LLY JPM V UNH XOM WMT
MA JNJ PG COST HD ORCL ABBV BAC KO MRK CVX AMD PEP ADBE CSCO CRM TMO ACN LIN MCD
ABT NFLX INTC DIS WFC TXN DHR VZ INTU PM CAT NEE AMGN IBM CMCSA PFE UNP LOW SPGI
GS RTX HON UPS AMAT BLK BKNG NKE T MS ELV SYK PLD MDT LMT BMY ADP DE GILD ADI
VRTX SBUX MMC CVS SCHW TJX C AXP CB ZTS MDLZ CI SO REGN BSX ETN SLB EOG DUK ITW
AON PGR CME BDX APD KLAC CSX NOC WM MU MCK EMR FDX ORLY MAR PSA MSI GD AJG TGT
GM F PYPL SQ SHOP UBER ABNB COIN PLTR SNOW NOW PANW CRWD DDOG NET TEAM WDAY
QCOM MRVL ON NXPI ASML TSM ARM SMCI DELL HPQ WDC STX
""".split()


def sp500_symbols() -> List[str]:
    try:
        import io
        import pandas as pd
        import requests
        # 维基百科会拒绝没有 User-Agent 的请求，read_html 直接传 URL 会 403
        html = requests.get(
            WIKI_SP500,
            headers={"User-Agent": "Mozilla/5.0 (QuantLab universe builder)"},
            timeout=30,
        ).text
        tables = pd.read_html(io.StringIO(html))
        for t in tables:
            cols = [str(c) for c in t.columns]
            if any("Symbol" in c for c in cols):
                col = [c for c in t.columns if "Symbol" in str(c)][0]
                syms = [str(s).strip().upper().replace(".", "-") for s in t[col].tolist()]
                syms = [s for s in syms if s and s != "NAN"]
                if len(syms) > 400:
                    print(f"从维基百科取到标普500成分 {len(syms)} 个")
                    return syms
    except Exception as exc:                          # noqa: BLE001
        print(f"维基百科取列表失败（{type(exc).__name__}），改用内置清单")
    print(f"使用内置大盘股清单 {len(FALLBACK)} 个")
    return FALLBACK


def fetch_one(symbol: str) -> Dict[str, Any] | None:
    try:
        import yfinance as yf
        info = yf.Ticker(symbol).info or {}
        if not info.get("marketCap"):
            return None                                # 没有市值的多半是拉取失败
        row = derive(info)
        row["symbol"] = symbol
        return row
    except Exception:                                 # noqa: BLE001
        return None


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--limit", type=int, default=0, help="只取前 N 只，用于快速试跑")
    ap.add_argument("--workers", type=int, default=6, help="并发数，太高会被限流")
    args = ap.parse_args()

    syms = sp500_symbols()
    if args.limit:
        syms = syms[:args.limit]

    print(f"开始拉取 {len(syms)} 只标的的基本面（并发 {args.workers}）...")
    t0 = time.time()
    rows: List[Dict[str, Any]] = []
    done = 0

    with concurrent.futures.ThreadPoolExecutor(max_workers=args.workers) as ex:
        futures = {ex.submit(fetch_one, s): s for s in syms}
        for fut in concurrent.futures.as_completed(futures):
            done += 1
            r = fut.result()
            if r:
                rows.append(r)
            if done % 25 == 0 or done == len(syms):
                el = time.time() - t0
                print(f"  {done}/{len(syms)}  成功 {len(rows)}  用时 {el:.0f}s", flush=True)

    rows.sort(key=lambda r: r.get("symbol", ""))
    os.makedirs(os.path.dirname(SNAPSHOT_PATH), exist_ok=True)
    payload = {
        "builtAt": time.strftime("%Y-%m-%d %H:%M:%S"),
        "source": "yfinance / S&P 500 constituents",
        "rows": rows,
    }
    with open(SNAPSHOT_PATH, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, separators=(",", ":"))

    size_kb = os.path.getsize(SNAPSHOT_PATH) / 1024
    print(f"\n完成：{len(rows)}/{len(syms)} 只写入 {SNAPSHOT_PATH} ({size_kb:.0f} KB)")
    print(f"总耗时 {time.time() - t0:.0f}s")

    # 覆盖率体检：某个字段缺失太多，对应的分位排名就不可信
    if rows:
        print("\n字段覆盖率：")
        for f_ in ("trailingPE", "priceToBook", "returnOnEquity", "revenueGrowth",
                   "earningsGrowth", "grossMargins", "debtToEquity", "52WeekChange"):
            got = sum(1 for r in rows if isinstance(r.get(f_), (int, float)))
            print(f"  {f_:20} {got:4}/{len(rows)}  ({got / len(rows) * 100:.0f}%)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
