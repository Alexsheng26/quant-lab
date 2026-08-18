"""代码搜索的排序逻辑。

全量代码表有 11749 条，排序不对就等于搜不到。这里的用例大多来自
真实踩过的坑：搜 "voo" 没结果、BABA/NIO 被过滤掉、B-Right Horizons
被当成杠杆产品、BRK.B 因为带点被丢掉。
"""

import pytest

import app as backend_app


def score(symbol, name, key, pop=False):
    return backend_app._score_match(
        {"symbol": symbol, "name": name, "pop": pop}, key)


# ----------------------------------------------------------------------
# 排序优先级
# ----------------------------------------------------------------------

def test_exact_symbol_wins():
    """精确匹配代码永远排第一。"""
    exact = score("VOO", "Vanguard S&P 500 ETF", "voo")
    prefix = score("VOOG", "Vanguard S&P 500 Growth", "voo")
    contains = score("AVOO", "Something", "voo")
    assert exact > prefix > contains


def test_shorter_symbol_ranks_higher_on_prefix():
    """同为前缀匹配时，代码越短越可能是用户想要的那个。"""
    assert score("TS", "Tenaris", "ts") > score("TSLAQ", "Whatever", "ts")


def test_popular_symbols_get_boost():
    """热门标的加权，否则搜 "a" 会被一堆没人听过的代码淹没。"""
    assert score("AAPL", "Apple Inc.", "aapl", pop=True) > \
           score("AAPL", "Apple Inc.", "aapl", pop=False)


def test_name_match_scores_below_symbol_match():
    assert score("XYZ", "Apple Supplier Co", "apple") < \
           score("APLE", "Apple Hospitality REIT", "apl")


def test_no_match_returns_negative():
    assert score("AAPL", "Apple Inc.", "tesla") == -1


# ----------------------------------------------------------------------
# 杠杆/衍生品降权 —— 用词边界，不能用子串
# ----------------------------------------------------------------------

@pytest.mark.parametrize("name", [
    "Direxion Daily Semiconductor Bull 3X Shares",
    "ProShares UltraShort Bear ETF",
    "YieldMax TSLA Option Income Strategy ETF",
    "Some Acquisition Corp",
])
def test_leveraged_products_penalised(name):
    plain = score("AAA", "Plain Company Inc", "aaa")
    lev = score("AAA", name, "aaa")
    assert lev < plain, f"{name} 应该被降权"


@pytest.mark.parametrize("name", [
    "B-Right Horizons Inc",        # 含 "right"，但不是 bright/bear/bull
    "Bearings Manufacturing Co",   # 含 "bear" 子串
    "Bullish Brands Holdings",     # 含 "bull" 子串
    "Dailies Fresh Foods",         # 含 "daily" 相近子串
])
def test_legitimate_names_not_penalised(name):
    """回归用例：早先用子串匹配，把正经公司一起降权了。

    DERIVATIVE_RE 必须用 \\b 词边界。
    """
    plain = score("AAA", "Plain Company Inc", "aaa")
    assert score("AAA", name, "aaa") == plain, f"{name} 不该被降权"


def test_adr_names_survive():
    """回归用例：NOISE 关键词里曾有 "depositary shares"，
       一刀切掉了 BABA、NIO 等全部中概 ADR。"""
    plain = score("BABA", "Plain Company", "baba")
    adr = score("BABA", "Alibaba Group Holding Ltd American Depositary Shares", "baba")
    assert adr == plain


# ----------------------------------------------------------------------
# 别名
# ----------------------------------------------------------------------

@pytest.mark.parametrize("alias,expect", [
    ("tsmc", "TSM"), ("台积电", "TSM"),
    ("google", "GOOGL"), ("facebook", "META"),
    ("伯克希尔", "BRK-B"), ("sp500", "SPY"),
])
def test_alias_table(alias, expect):
    """用户搜 tsmc / 台积电，代码表里只有 TSM，必须靠别名接上。"""
    assert backend_app.ALIASES[alias] == expect


def test_alias_targets_use_dash_form():
    """类别股统一用 BRK-B（yfinance 写法），不能是 BRK.B。"""
    for target in backend_app.ALIASES.values():
        assert "." not in target, f"{target} 应该用 - 而不是 ."


# ----------------------------------------------------------------------
# _public 投影
# ----------------------------------------------------------------------

def test_public_strips_internal_flags():
    """回归用例：/api/search 声明返回 List[Dict[str, str]]，
       内部记录带 etf/pop 布尔字段，直接返回会被响应校验变成 500。"""
    out = backend_app._public(
        {"symbol": "SPY", "name": "标普500 ETF", "exchange": "NYSEARCA",
         "etf": True, "pop": True})
    assert out == {"symbol": "SPY", "name": "标普500 ETF", "exchange": "NYSEARCA"}
    assert all(isinstance(v, str) for v in out.values())


def test_public_fills_missing_fields():
    """名称/交易所缺失时要有兜底，不能返回 None 撞校验。"""
    out = backend_app._public({"symbol": "ZZZZ"})
    assert out["name"] == "ZZZZ" and out["exchange"] == "US"
    assert all(isinstance(v, str) for v in out.values())
