"""
生成全量美股代码表
==================

数据来自 NASDAQ Trader 官方公开清单（免费、无需 API Key、每日更新）：
    nasdaqlisted.txt  —— 所有纳斯达克上市证券
    otherlisted.txt   —— NYSE / NYSE American / NYSE Arca / BATS / IEX 等

可选：用 akshare 的 stock_us_spot_em() 补中文名，这样搜"英伟达"也能搜到。

产出两份文件（内容一致，格式不同）：
    assets/data/symbols.js    —— 前端用。故意做成 .js 而不是 .json，
                                 因为 file:// 下 fetch() 读本地 json 会被 CORS 拦掉，
                                 用 <script> 标签加载则不受限制，双击 index.html 也能搜。
    backend/data/symbols.json —— 后端用。

用法：
    .venv\\Scripts\\python backend\\build_symbols.py
"""

from __future__ import annotations

import io
import json
import os
import re
import sys

import requests

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)

NASDAQ_URL = "https://www.nasdaqtrader.com/dynamic/SymDir/nasdaqlisted.txt"
OTHER_URL = "https://www.nasdaqtrader.com/dynamic/SymDir/otherlisted.txt"

# otherlisted.txt 里的交易所代码
EXCHANGE_MAP = {
    "A": "NYSEAMERICAN",
    "N": "NYSE",
    "P": "NYSEARCA",
    "Z": "BATS",
    "V": "IEX",
}

HEADERS = {"User-Agent": "Mozilla/5.0 (QuantLab symbol builder)"}


def fetch(url: str) -> list[dict]:
    """下载并解析管道分隔的清单文件（最后一行是 File Creation Time，要丢掉）。"""
    resp = requests.get(url, headers=HEADERS, timeout=60)
    resp.raise_for_status()
    lines = resp.text.splitlines()
    if not lines:
        return []

    header = lines[0].split("|")
    rows = []
    for line in lines[1:]:
        if line.startswith("File Creation Time"):
            break
        parts = line.split("|")
        if len(parts) != len(header):
            continue
        rows.append(dict(zip(header, parts)))
    return rows


# "Alibaba Group Holding Limited American Depositary Shares each representing
# eight Ordinary share" —— 后半段对搜索毫无价值，从这些词开始整段截掉
TRUNCATE_RE = re.compile(
    r"\s*[-,]?\s*(american\s+depositary|depositary\s+shares?|"
    r"each\s+representing|represent(ing|s)\s+)",
    re.IGNORECASE,
)

TAIL_RE = re.compile(
    r"\s*[-,]?\s*(new\s+common\s+stock|common\s+stock|common\s+shares?|"
    r"ordinary\s+shares?|class\s+[a-z]\s+common\s+stock|"
    r"registered\s+shares?|new)\s*$",
    re.IGNORECASE,
)


def clean_name(name: str) -> str:
    """砍掉证券全称里的冗余描述，让搜索结果好读。"""
    name = TRUNCATE_RE.split(name, maxsplit=1)[0]
    # 后缀可能叠好几层（"Inc. - Class A Common Stock"），循环剥到不变为止
    for _ in range(4):
        stripped = TAIL_RE.sub("", name).strip()
        if stripped == name.strip():
            break
        name = stripped
    return name.strip().strip("-").strip().rstrip(",").strip()


# 权证 / 优先股 / SPAC 单位 / 票据这些没法做量化，滤掉能让搜索结果干净很多。
#
# 必须用词边界而不是子串：子串匹配会把 "right" 命中 "Bright Horizons"、
# 把 "unit" 命中 "Unit Corporation" 这种正常公司。
#
# 注意这里**不能**过滤 "depositary shares"——所有 ADR（BABA、NIO、TSM、
# 台积电、中概股）的证券全称都带这个词，滤掉就把中概股全删了。
# 优先股形式的存托凭证已经被 "preferred" 覆盖。
NOISE_RE = re.compile(
    r"\b(warrants?|rights?|units|preferred|debentures?|subordinated"
    r"|when[-\s]issued|contingent\s+value)\b"
    r"|%\s*notes|notes\s+due",
    re.IGNORECASE,
)


def is_noise(name: str) -> bool:
    return bool(NOISE_RE.search(name))


# akshare 的东财接口经常连不上，用这份手工映射兜底，
# 保证常搜的标的用中文也能搜到。拿到 akshare 数据时它会被覆盖。
CN_NAME_FALLBACK = {
    "AAPL": "苹果", "MSFT": "微软", "NVDA": "英伟达", "GOOGL": "谷歌A", "GOOG": "谷歌C",
    "AMZN": "亚马逊", "META": "脸书", "TSLA": "特斯拉", "AMD": "超威半导体",
    "AVGO": "博通", "NFLX": "奈飞", "INTC": "英特尔", "MU": "美光科技",
    "QCOM": "高通", "TXN": "德州仪器", "ADBE": "奥多比", "CRM": "赛富时",
    "ORCL": "甲骨文", "CSCO": "思科", "IBM": "国际商业机器",
    "PLTR": "帕兰提尔", "UBER": "优步", "ABNB": "爱彼迎",
    "PYPL": "贝宝", "SNOW": "雪花",
    "TSM": "台积电", "ASML": "阿斯麦", "ARM": "安谋", "SMCI": "超微电脑",
    "JPM": "摩根大通", "BAC": "美国银行", "WFC": "富国银行", "GS": "高盛",
    "MS": "摩根士丹利", "V": "维萨", "MA": "万事达", "AXP": "美国运通",
    "BRK-B": "伯克希尔B", "BRK-A": "伯克希尔A", "BLK": "贝莱德",
    "JNJ": "强生", "UNH": "联合健康", "PFE": "辉瑞", "MRK": "默克",
    "LLY": "礼来", "ABBV": "艾伯维", "TMO": "赛默飞世尔", "NVO": "诺和诺德",
    "XOM": "埃克森美孚", "CVX": "雪佛龙", "COP": "康菲石油",
    "WMT": "沃尔玛", "COST": "好市多", "TGT": "塔吉特", "HD": "家得宝",
    "KO": "可口可乐", "PEP": "百事可乐", "MCD": "麦当劳", "SBUX": "星巴克",
    "NKE": "耐克", "PG": "宝洁", "DIS": "迪士尼", "BA": "波音",
    "CAT": "卡特彼勒", "GE": "通用电气", "F": "福特", "GM": "通用汽车",
    "LMT": "洛克希德马丁", "RTX": "雷神",
    "BABA": "阿里巴巴", "PDD": "拼多多", "JD": "京东", "NIO": "蔚来",
    "XPEV": "小鹏汽车", "LI": "理想汽车", "BIDU": "百度", "NTES": "网易",
    "TCOM": "携程", "BILI": "哔哩哔哩", "TME": "腾讯音乐", "IQ": "爱奇艺",
    "ZTO": "中通快递", "YUMC": "百胜中国", "BEKE": "贝壳",
    "SPY": "标普500ETF", "VOO": "先锋标普500ETF", "IVV": "安硕标普500ETF",
    "QQQ": "纳指100ETF", "DIA": "道指ETF", "IWM": "罗素2000ETF",
    "VTI": "先锋全市场ETF", "VT": "先锋全球ETF", "VEA": "先锋发达市场ETF",
    "TQQQ": "纳指三倍做多ETF", "SQQQ": "纳指三倍做空ETF",
    "SOXL": "半导体三倍做多ETF", "SOXX": "半导体ETF", "SMH": "半导体ETF",
    "GLD": "黄金ETF", "SLV": "白银ETF", "USO": "原油ETF",
    "TLT": "20年期美债ETF", "HYG": "高收益债ETF", "VNQ": "房地产ETF",
    "ARKK": "方舟创新ETF", "XLK": "科技板块ETF", "XLF": "金融板块ETF",
    "XLE": "能源板块ETF", "XLV": "医疗板块ETF", "VXX": "波动率ETF",
}


def normalize(sym: str) -> str:
    """
    统一成 yfinance 认的写法。

    类别股在官方清单里写作 BRK.B / BF.B，yfinance 要 BRK-B / BF-B。
    早先版本直接把带点的代码丢掉，结果伯克希尔这种大票整个不见了。
    """
    return sym.strip().upper().replace(".", "-")


def build() -> list[dict]:
    out: dict[str, dict] = {}

    print("下载 nasdaqlisted.txt ...")
    for r in fetch(NASDAQ_URL):
        sym = normalize(r.get("Symbol", ""))
        if not sym or r.get("Test Issue") == "Y":
            continue
        out[sym] = {
            "symbol": sym,
            "name": clean_name(r.get("Security Name", "")),
            "exchange": "NASDAQ",
            "etf": r.get("ETF", "N") == "Y",
        }

    print("下载 otherlisted.txt ...")
    for r in fetch(OTHER_URL):
        sym = normalize(r.get("NASDAQ Symbol") or r.get("ACT Symbol") or "")
        if not sym or r.get("Test Issue") == "Y":
            continue
        out.setdefault(sym, {
            "symbol": sym,
            "name": clean_name(r.get("Security Name", "")),
            "exchange": EXCHANGE_MAP.get(r.get("Exchange", "").strip(), "NYSE"),
            "etf": r.get("ETF", "N") == "Y",
        })

    # 带 $ 的是优先股代码，行情源基本不支持，丢掉
    raw_count = len(out)
    symbols = [
        v for k, v in out.items()
        if "$" not in k and not is_noise(v["name"])
    ]
    print(f"原始 {raw_count} 个，滤掉权证/优先股/单位后剩 {len(symbols)} 个")

    # ---- 可选：用 akshare 补中文名（东财接口偶尔掐连接，重试几次）----
    cn: dict[str, str] = {}
    try:
        import akshare as ak
        for attempt in range(1, 4):
            try:
                print(f"从 akshare 拉取中文名（第 {attempt} 次）...")
                df = ak.stock_us_spot_em()
                for _, row in df.iterrows():
                    raw = str(row.get("代码", ""))      # 形如 "105.AAPL"
                    ticker = raw.split(".")[-1].strip().upper()
                    name = str(row.get("名称", "")).strip()
                    if ticker and name:
                        cn[ticker] = name
                break
            except Exception as exc:                  # noqa: BLE001
                print(f"  第 {attempt} 次失败：{type(exc).__name__}")
    except ImportError:
        print("未安装 akshare，跳过中文名")

    # akshare 拿到就用它的，没拿到就用内置映射兜底
    merged = dict(CN_NAME_FALLBACK)
    merged.update(cn)

    hit = 0
    for s in symbols:
        zh = merged.get(s["symbol"])
        # 中文名放前面、英文名保留，两种关键字都能搜到
        if zh and zh.upper() != s["symbol"]:
            s["name"] = f"{zh} {s['name']}" if s["name"] else zh
            hit += 1
        # 手工清单里的都是常搜标的，给搜索排序当权重用：
        # 否则搜 "brk" 会被一堆 BRKC/BRKL 这种衍生 ETF 挤掉伯克希尔
        s["pop"] = s["symbol"] in CN_NAME_FALLBACK
    print(f"补上 {hit} 个中文名（akshare {len(cn)} 个 + 内置 {len(CN_NAME_FALLBACK)} 个）")

    symbols.sort(key=lambda s: s["symbol"])
    return symbols


def write(symbols: list[dict]) -> None:
    # 后端用的 json
    backend_dir = os.path.join(HERE, "data")
    os.makedirs(backend_dir, exist_ok=True)
    backend_path = os.path.join(backend_dir, "symbols.json")
    with io.open(backend_path, "w", encoding="utf-8") as f:
        json.dump(symbols, f, ensure_ascii=False, separators=(",", ":"))

    # 前端用的 js：压成 "SYM|名称|交易所|是否ETF" 字符串数组，体积小一半
    front_dir = os.path.join(ROOT, "assets", "data")
    os.makedirs(front_dir, exist_ok=True)
    front_path = os.path.join(front_dir, "symbols.js")
    packed = [
        "{}|{}|{}|{}{}".format(
            s["symbol"], s["name"].replace("|", "/"), s["exchange"],
            "1" if s["etf"] else "0",
            "|1" if s.get("pop") else "",
        )
        for s in symbols
    ]
    with io.open(front_path, "w", encoding="utf-8") as f:
        f.write("/* 自动生成，请勿手改。重新生成：python backend/build_symbols.py */\n")
        f.write("window.QL = window.QL || {};\n")
        f.write("QL.SYMBOLS_PACKED = ")
        json.dump(packed, f, ensure_ascii=False, separators=(",", ":"))
        f.write(";\n")

    for p in (backend_path, front_path):
        print(f"写入 {p}  ({os.path.getsize(p) / 1024:.0f} KB)")


if __name__ == "__main__":
    try:
        write(build())
    except Exception as exc:                          # noqa: BLE001
        print(f"失败：{type(exc).__name__}: {exc}", file=sys.stderr)
        sys.exit(1)
