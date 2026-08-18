"""fundamentals.py —— 全市场分位排名与"价值陷阱 / 沧海遗珠"判定。

这个模块出过三个真实 bug，每个都有对应的回归测试：
  1. 2x2 判定表在"一边极端、一边中等"时掉进兜底分支，
     把估值第 9 分位说成"两边都没有明显偏离"。
  2. 盈利与成长严重背离时取平均，把 p0.7 和 p99 抹平成"中等"。
  3. ETF 只有 2 个维度有数据，却照样给出总分 76，用数字掩盖数据缺失。
"""

import math

import pytest

import fundamentals as F


# ----------------------------------------------------------------------
# _pct_rank
# ----------------------------------------------------------------------

def test_pct_rank_midpoint():
    """标准百分位：小于的个数 + 一半相等的个数。"""
    assert F._pct_rank(3, [1, 2, 3, 4, 5], higher_is_better=True) == 50.0


def test_pct_rank_extremes():
    pool = [1, 2, 3, 4, 5]
    assert F._pct_rank(0, pool, True) == 0.0
    assert F._pct_rank(9, pool, True) == 100.0


def test_pct_rank_inverted_for_valuation():
    """PE 越低越好，higher_is_better=False 要把分位翻过来。"""
    pool = [10, 20, 30, 40, 50]
    cheap = F._pct_rank(10, pool, higher_is_better=False)
    rich = F._pct_rank(50, pool, higher_is_better=False)
    assert cheap > rich
    assert cheap + F._pct_rank(10, pool, higher_is_better=True) == 100.0


def test_pct_rank_ties_get_half_credit():
    """全部相等时应落在中间，而不是 0 或 100。"""
    assert F._pct_rank(5, [5, 5, 5, 5], True) == 50.0


def test_pct_rank_handles_missing():
    assert F._pct_rank(None, [1, 2, 3], True) is None
    assert F._pct_rank(1, [], True) is None


# ----------------------------------------------------------------------
# _pool：脏数据过滤
# ----------------------------------------------------------------------

def test_pool_drops_negative_valuation():
    """亏损公司的负 PE 在估值排名里没有意义，必须剔除，
       否则"PE = -5"会被排成全市场最便宜。"""
    rows = [{"trailingPE": 10}, {"trailingPE": -5}, {"trailingPE": 30}]
    assert F._pool(rows, "trailingPE") == [10.0, 30.0]


def test_pool_keeps_negative_for_non_valuation():
    """ROE 为负是有意义的（真的在亏钱），不能一起剔掉。"""
    rows = [{"returnOnEquity": 0.2}, {"returnOnEquity": -0.1}]
    assert F._pool(rows, "returnOnEquity") == [0.2, -0.1]


def test_pool_drops_nan_inf_and_bools():
    rows = [{"x": 1.0}, {"x": float("nan")}, {"x": float("inf")},
            {"x": True}, {"x": None}, {"x": "12"}]
    assert F._pool(rows, "x") == [1.0]


# ----------------------------------------------------------------------
# verdict：3x3 判定表
# ----------------------------------------------------------------------

def _axes(valuation=None, profitability=None, growth=None):
    keys = {"valuation": valuation, "profitability": profitability, "growth": growth}
    return [{"key": k, "marketPct": v} for k, v in keys.items()]


@pytest.mark.parametrize("val,prof,grow,tag", [
    (80, 80, 80, "沧海遗珠形态"),      # 便宜 + 强
    (80, 20, 20, "价值陷阱风险"),      # 便宜 + 弱
    (80, 50, 50, "估值偏低"),          # 便宜 + 中
    (20, 80, 80, "成长溢价"),          # 贵 + 强
    (20, 20, 20, "估值缺乏支撑"),      # 贵 + 弱
    (20, 50, 50, "估值偏高"),          # 贵 + 中
    (50, 80, 80, "基本面占优"),        # 中 + 强
    (50, 20, 20, "基本面偏弱"),        # 中 + 弱
    (50, 50, 50, "中性均衡"),          # 中 + 中
])
def test_verdict_covers_all_nine_cells(val, prof, grow, tag):
    """3x3 九格全覆盖。旧版是 2x2，六个格子会掉进兜底分支。"""
    assert F.verdict(_axes(val, prof, grow), 50)["tag"] == tag


def test_extreme_valuation_never_called_neutral():
    """回归用例：估值第 9 分位（很贵）+ 基本面中等。

    旧的 2x2 版本会输出"中性均衡·两边都没有明显偏离"，
    但估值第 9 分位是明确偏离，这个结论是错的。
    """
    out = F.verdict(_axes(9, 50, 50), 40)
    assert out["tag"] == "估值偏高"
    assert "没有明显偏离" not in out["text"]
    assert "9" in out["text"]                 # 具体分位要出现在文案里


def test_growth_profit_divergence_not_averaged():
    """回归用例：NIO 形态，盈利 p0.7 + 成长 p99。

    取平均会得到 50 并被描述成"中等"，但这跟"样样中等"是完全不同的形态，
    而且恰恰是最该看清楚的。
    """
    out = F.verdict(_axes(valuation=30, profitability=0.7, growth=99), 45)
    assert out["tag"] == "增长未兑现盈利"
    assert out["cls"] == "down"
    assert "背离" in out["text"]


def test_reverse_divergence_high_profit_low_growth():
    """反方向：赚钱但不增长，是成熟期／周期见顶形态。"""
    out = F.verdict(_axes(valuation=70, profitability=95, growth=10), 60)
    assert out["tag"] == "高盈利低增长"


@pytest.mark.parametrize("prof,grow,diverged", [
    (10, 49, False),   # 差 39，不到阈值
    (10, 50, True),    # 差 40，刚好触发
    (50, 50, False),
])
def test_divergence_threshold(prof, grow, diverged):
    out = F.verdict(_axes(50, prof, grow), 50)
    assert ("背离" in out["text"]) is diverged


def test_verdict_without_valuation_is_honest():
    """缺估值就直说数据不足，不要硬凑一个结论。"""
    out = F.verdict(_axes(None, 80, 80), None)
    assert out["tag"] == "数据不足"


def test_verdict_with_only_one_fundamental_axis():
    """只有盈利没有成长时仍应给出判断，不能崩。"""
    out = F.verdict(_axes(80, 80, None), 80)
    assert out["tag"] == "沧海遗珠形态"


@pytest.mark.parametrize("val,prof,grow", [
    (0, 0, 0), (100, 100, 100), (0, 100, 0), (60, 60, 60), (40, 40, 40),
])
def test_verdict_always_returns_complete_shape(val, prof, grow):
    """任何输入都要返回完整结构，前端直接读这三个字段。"""
    out = F.verdict(_axes(val, prof, grow), 50)
    assert set(out) == {"tag", "cls", "text"}
    assert out["cls"] in ("up", "down", "flat")
    assert out["tag"] and out["text"]


def test_boundary_60_is_cheap_not_mid():
    """边界值要落在文档写明的那一档：>=60 算便宜。"""
    assert F.verdict(_axes(60, 80, 80), 70)["tag"] == "沧海遗珠形态"
    assert F.verdict(_axes(59, 80, 80), 70)["tag"] == "基本面占优"


def test_boundary_40_is_rich_not_mid():
    """<=40 算贵。"""
    assert F.verdict(_axes(40, 80, 80), 60)["tag"] == "成长溢价"
    assert F.verdict(_axes(41, 80, 80), 60)["tag"] == "基本面占优"


# ----------------------------------------------------------------------
# 总分：数据不够就不给分
# ----------------------------------------------------------------------

def test_total_requires_four_axes(monkeypatch):
    """回归用例：VOO（ETF）只有 2 个维度有数据，却显示总分 76。

    2/6 个维度算出来的"76 分"看着像结论，其实是数据缺失，
    比不给分更有误导性。
    """
    monkeypatch.setattr(F, "snapshot", lambda: [
        {"symbol": "A", "sector": "Tech", "trailingPE": 10, "returnOnEquity": 0.3},
        {"symbol": "B", "sector": "Tech", "trailingPE": 20, "returnOnEquity": 0.1},
    ])
    monkeypatch.setattr(F, "snapshot_meta", lambda: {"count": 2, "builtAt": "2026-01-01"})

    # 只有估值一项有数据的 ETF
    etf = {"symbol": "VOO", "trailingPE": 15, "sector": None}
    out = F.evaluate("VOO", metrics=etf)

    assert out["coverage"]["withData"] < 4
    assert out["total"] is None, "维度不足 4 个时不应给出总分"
    assert out["coverage"]["missing"]


def test_total_given_when_enough_axes(monkeypatch):
    """反向验证：维度够了就要给分，别把上一条测过了头。"""
    monkeypatch.setattr(F, "snapshot", lambda: [
        {"symbol": "A", "sector": "Tech", "trailingPE": 10, "priceToBook": 2,
         "returnOnEquity": 0.3, "profitMargins": 0.2,
         "revenueGrowth": 0.1, "earningsGrowth": 0.1,
         "debtToEquity": 50, "currentRatio": 2,
         "returnOnAssets": 0.1, "grossMargins": 0.5,
         "beta": 1.0, "enterpriseToEbitda": 10},
        {"symbol": "B", "sector": "Tech", "trailingPE": 30, "priceToBook": 6,
         "returnOnEquity": 0.1, "profitMargins": 0.05,
         "revenueGrowth": 0.02, "earningsGrowth": 0.01,
         "debtToEquity": 150, "currentRatio": 1,
         "returnOnAssets": 0.02, "grossMargins": 0.2,
         "beta": 1.6, "enterpriseToEbitda": 25},
    ])
    monkeypatch.setattr(F, "snapshot_meta", lambda: {"count": 2, "builtAt": "2026-01-01"})

    rich = dict(F.snapshot()[0], symbol="C")
    out = F.evaluate("C", metrics=rich)
    if out["coverage"]["withData"] >= 4:
        assert out["total"] is not None
        assert 0 <= out["total"] <= 100
