"""research.py —— SEC EDGAR XBRL 解析。

这里的重点是 `_is_annual`。它修的是一个真实且很隐蔽的 bug：
一份 10-K 里同时含年度数字和季度对比数字，`fp == "FY"` 描述的是
**申报文件**的周期而不是数据点的，只靠它过滤会把单季当成全年。
NVDA FY2020 营收 109 亿曾被显示成 30 亿（实际是 Q3 单季）。
"""

import pytest

import research


# ----------------------------------------------------------------------
# _is_annual：期间长度而不是 fp 字段
# ----------------------------------------------------------------------

def _rec(form="10-K", start=None, end=None, fp="FY", val=1.0):
    r = {"form": form, "fp": fp, "val": val}
    if start:
        r["start"] = start
    if end:
        r["end"] = end
    return r


def test_annual_period_accepted():
    """标准财年：约 365 天。"""
    assert research._is_annual(_rec(start="2019-01-28", end="2020-01-26"))


def test_quarter_inside_10k_rejected():
    """核心回归用例。

    这条记录来自 10-K、fp 也是 FY，但期间只有 ~91 天——它是 Q3 单季，
    不是全年。旧代码只看 form + fp，就是在这里把 30 亿当成了 109 亿。
    """
    q3 = _rec(start="2019-07-29", end="2019-10-27")
    assert q3["form"] == "10-K" and q3["fp"] == "FY"      # 两个旧条件都满足
    assert research._is_annual(q3) is False               # 但期间长度出卖了它


def test_half_year_rejected():
    """半年报（~180 天）也不能算年度。"""
    assert research._is_annual(_rec(start="2020-01-01", end="2020-06-30")) is False


def test_instant_value_accepted():
    """时点值（总资产、股东权益）没有 start，本身就是年报口径。"""
    assert research._is_annual(_rec(end="2020-01-26")) is True


def test_non_annual_form_rejected():
    """10-Q 一律不要，哪怕期间凑巧是一年。"""
    assert research._is_annual(
        _rec(form="10-Q", start="2019-01-28", end="2020-01-26")) is False


def test_20f_accepted():
    """外国发行人年报 20-F 同样算年报（ADR 要靠它）。"""
    assert research._is_annual(
        _rec(form="20-F", start="2019-01-01", end="2019-12-31")) is True


@pytest.mark.parametrize("days,expected", [
    (299, False),   # 刚好落在窗口外
    (300, True),    # 下边界
    (365, True),
    (400, True),    # 上边界
    (401, False),
])
def test_period_window_boundaries(days, expected):
    """52/53 周财年和跨年财年都要能进来，两个季度拼起来的不能进。"""
    from datetime import date, timedelta
    start = date(2020, 1, 1)
    end = start + timedelta(days=days)
    assert research._is_annual(
        _rec(start=start.isoformat(), end=end.isoformat())) is expected


def test_missing_end_rejected():
    """有 start 没 end 的残缺记录，宁可丢掉也不能猜。"""
    assert research._is_annual(_rec(start="2020-01-01")) is False


# ----------------------------------------------------------------------
# _annual_series：去重与年份归并
# ----------------------------------------------------------------------

def _facts(tag, records, unit="USD"):
    return {"facts": {"us-gaap": {tag: {"units": {unit: records}}}}}


def test_restatement_keeps_latest_filing():
    """同一个财年被重述过，要保留后申报的那条。"""
    facts = _facts("Revenues", [
        _rec(start="2019-01-01", end="2019-12-31", val=100) | {"filed": "2020-02-01"},
        _rec(start="2019-01-01", end="2019-12-31", val=105) | {"filed": "2020-08-01"},
    ])
    rows = research._annual_series(facts, ["Revenues"])
    assert len(rows) == 1
    assert rows[0]["val"] == 105


def test_quarters_do_not_leak_into_series():
    """整条链路验证：年度 + 三个季度混在一起，只应剩年度那条。"""
    facts = _facts("Revenues", [
        _rec(start="2019-01-28", end="2020-01-26", val=10_918_000_000),   # FY2020 全年
        _rec(start="2019-04-29", end="2019-07-28", val=2_579_000_000),    # Q2
        _rec(start="2019-07-29", end="2019-10-27", val=3_014_000_000),    # Q3
    ])
    rows = research._annual_series(facts, ["Revenues"])
    assert [r["val"] for r in rows] == [10_918_000_000]


def test_series_sorted_and_capped():
    """按 end 升序，并且只保留最近 max_years 年。"""
    facts = _facts("Revenues", [
        _rec(start=f"{y}-01-01", end=f"{y}-12-31", val=y)
        for y in range(2015, 2025)
    ])
    rows = research._annual_series(facts, ["Revenues"], max_years=3)
    assert [r["val"] for r in rows] == [2022, 2023, 2024]
    assert [r["year"] for r in rows] == ["2022", "2023", "2024"]


def test_falls_back_to_next_tag():
    """首选标签没数据时要退到下一个候选标签。"""
    facts = {"facts": {"us-gaap": {
        "RevenueFromContractWithCustomerExcludingAssessedTax": {"units": {"USD": []}},
        "Revenues": {"units": {"USD": [
            _rec(start="2023-01-01", end="2023-12-31", val=42)]}},
    }}}
    rows = research._annual_series(
        facts, ["RevenueFromContractWithCustomerExcludingAssessedTax", "Revenues"])
    assert [r["val"] for r in rows] == [42]
    assert rows[0]["tag"] == "Revenues"


def test_unknown_concept_returns_empty():
    assert research._annual_series({"facts": {"us-gaap": {}}}, ["Revenues"]) == []


# ----------------------------------------------------------------------
# cik_for：类别股写法
# ----------------------------------------------------------------------

def test_cik_lookup_handles_class_shares(monkeypatch):
    """BRK-B 在 SEC 表里可能只有 BRK，要能退一层找到。"""
    monkeypatch.setattr(research, "_cik_map",
                        {"BRK": {"cik": "0001067983", "title": "BERKSHIRE HATHAWAY INC"}})
    assert research.cik_for("BRK-B")["cik"] == "0001067983"
    assert research.cik_for("brk-b")["cik"] == "0001067983"     # 大小写不敏感


def test_cik_lookup_miss_returns_none(monkeypatch):
    monkeypatch.setattr(research, "_cik_map", {"AAPL": {"cik": "1", "title": "APPLE"}})
    assert research.cik_for("NOTAREALTICKER") is None


def test_financials_reports_not_found(monkeypatch):
    """查不到 CIK 时要给出可读理由，而不是抛异常。"""
    monkeypatch.setattr(research, "_cik_map", {})
    out = research.financials("NOPE")
    assert out["found"] is False and "reason" in out
