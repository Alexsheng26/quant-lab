"""FastAPI 路由层。

用 TestClient 在进程内跑，不起服务器也不联网。
重点是响应模型校验——`/api/search` 曾因为返回值里混进布尔字段而 500，
这类问题只有真正走一遍 FastAPI 的序列化才能发现。
"""

import json

import pytest
from fastapi.testclient import TestClient

import app as backend_app


@pytest.fixture(scope="module")
def client():
    return TestClient(backend_app.app)


# ----------------------------------------------------------------------
# 健康检查
# ----------------------------------------------------------------------

def test_health(client):
    r = client.get("/api/health")
    assert r.status_code == 200
    body = r.json()
    assert body["ok"] is True and body["service"] == "quantlab"


# ----------------------------------------------------------------------
# 搜索
# ----------------------------------------------------------------------

def test_search_returns_200_not_500(client):
    """回归用例：内部记录带 etf/pop 布尔字段，
       撞上 List[Dict[str, str]] 的响应校验会变成 500。"""
    r = client.get("/api/search", params={"q": "AAPL"})
    assert r.status_code == 200, r.text
    assert r.json(), "搜 AAPL 不应该没有结果"


@pytest.mark.parametrize("q", ["voo", "tsm", "spy", "nvda", "brk"])
def test_common_searches_have_hits(client, q):
    """这几个都是用户真实搜过、当时没结果的。"""
    r = client.get("/api/search", params={"q": q})
    assert r.status_code == 200
    assert r.json(), f"搜 {q} 没有结果"


def test_search_response_values_are_all_strings(client):
    """响应模型声明的是 Dict[str, str]，任何非字符串都会炸。"""
    r = client.get("/api/search", params={"q": "a", "limit": 20})
    assert r.status_code == 200
    for row in r.json():
        assert set(row) == {"symbol", "name", "exchange"}
        for k, v in row.items():
            assert isinstance(v, str), f"{k} 不是字符串: {v!r}"


def test_search_respects_limit(client):
    r = client.get("/api/search", params={"q": "a", "limit": 3})
    assert len(r.json()) <= 3


def test_empty_query_returns_default_list(client):
    r = client.get("/api/search", params={"q": ""})
    assert r.status_code == 200 and r.json()


def test_unknown_symbol_passes_through(client):
    """清单外的代码放行，交给上游数据源验证——不然新上市的股票永远搜不到。"""
    r = client.get("/api/search", params={"q": "ZZZQ"})
    assert r.status_code == 200
    assert r.json()[0]["symbol"] == "ZZZQ"


def test_search_does_not_crash_on_junk(client):
    """奇怪输入不能 500。"""
    for q in ["'; DROP TABLE--", "<script>", "   ", "日本語", "%%%", "a" * 300]:
        r = client.get("/api/search", params={"q": q})
        assert r.status_code == 200, f"{q!r} -> {r.status_code}"


# ----------------------------------------------------------------------
# 限流
# ----------------------------------------------------------------------

def test_rate_limit_blocks_after_quota(monkeypatch):
    """/api/news/ask 是要花钱的，部署到公网后必须有闸。"""
    monkeypatch.setattr(backend_app, "LLM_CALLS_PER_HOUR", 3)
    monkeypatch.setattr(backend_app, "_llm_calls", {})

    assert [backend_app._llm_rate_ok("1.2.3.4") for _ in range(3)] == [True] * 3
    assert backend_app._llm_rate_ok("1.2.3.4") is False


def test_rate_limit_is_per_ip(monkeypatch):
    monkeypatch.setattr(backend_app, "LLM_CALLS_PER_HOUR", 1)
    monkeypatch.setattr(backend_app, "_llm_calls", {})

    assert backend_app._llm_rate_ok("1.1.1.1") is True
    assert backend_app._llm_rate_ok("1.1.1.1") is False
    assert backend_app._llm_rate_ok("2.2.2.2") is True, "别的 IP 不该被牵连"


def test_rate_limit_window_slides(monkeypatch):
    """一小时前的调用要过期，否则用满一次就永久锁死。"""
    import time as _t
    monkeypatch.setattr(backend_app, "LLM_CALLS_PER_HOUR", 2)
    monkeypatch.setattr(backend_app, "_llm_calls",
                        {"9.9.9.9": [_t.time() - 3601, _t.time() - 3700]})
    assert backend_app._llm_rate_ok("9.9.9.9") is True


def test_llm_status_endpoint_never_leaks_key(client, monkeypatch):
    """接口层再兜一次底：整个响应里不能出现 Key。"""
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-ant-api03-LEAKCANARY123")
    r = client.get("/api/llm/status")
    assert r.status_code == 200
    assert "LEAKCANARY123" not in r.text


# ----------------------------------------------------------------------
# CORS
# ----------------------------------------------------------------------

def test_cors_header_present(client):
    """前端是从 GitHub Pages 跨域调这个后端的，没有 CORS 头就全废。"""
    r = client.get("/api/health", headers={"Origin": "https://example.github.io"})
    assert "access-control-allow-origin" in {k.lower() for k in r.headers}

# ----------------------------------------------------------------------
# 新增两个 LLM 端点
# ----------------------------------------------------------------------

@pytest.fixture(autouse=True)
def _clear_cache():
    """TTL 缓存是模块级的，会让用例互相串味。"""
    backend_app.cache._data.clear()
    backend_app._llm_calls.clear()


def test_risk_changes_degrades_without_key(client, monkeypatch):
    """没有 Key 时仍然要返回文本比对结果——diff 是本地算的，不花钱。"""
    monkeypatch.setattr(backend_app.filing_text, "risk_changes",
                        lambda sym, use_llm=True: {
                            "symbol": sym, "found": True, "mode": "diff",
                            "addedCount": 2, "removedCount": 1,
                            "added": ["新段落"], "removed": ["旧段落"],
                            "newFiling": {"year": "2026", "url": "u1", "form": "10-K"},
                            "oldFiling": {"year": "2025", "url": "u2", "form": "10-K"},
                            "llmError": "未设置 DEEPSEEK_API_KEY 或 ANTHROPIC_API_KEY"})
    r = client.get("/api/filings/risk-changes", params={"symbol": "NVDA"})
    assert r.status_code == 200
    body = r.json()
    assert body["ok"] is True and body["mode"] == "diff"
    assert body["addedCount"] == 2
    assert body["llmError"]


def test_risk_changes_still_diffs_when_rate_limited(client, monkeypatch):
    """超限只砍掉解读那一步，比对结果照给。"""
    seen = {}

    def fake(sym, use_llm=True):
        seen["use_llm"] = use_llm
        return {"symbol": sym, "found": True, "mode": "diff", "addedCount": 1,
                "removedCount": 0, "added": ["x"], "removed": [],
                "newFiling": {"year": "2026", "url": "u", "form": "10-K"},
                "oldFiling": {"year": "2025", "url": "u", "form": "10-K"}}

    monkeypatch.setattr(backend_app.filing_text, "risk_changes", fake)
    monkeypatch.setattr(backend_app, "LLM_CALLS_PER_HOUR", 0)

    body = client.get("/api/filings/risk-changes", params={"symbol": "NVDA"}).json()
    assert seen["use_llm"] is False, "超限时不该再去调模型"
    assert body["addedCount"] == 1
    assert "上限" in body["llmError"]


def test_risk_changes_is_cached(client, monkeypatch):
    calls = []
    monkeypatch.setattr(backend_app.filing_text, "risk_changes",
                        lambda sym, use_llm=True: (calls.append(sym), {
                            "symbol": sym, "found": True, "mode": "diff",
                            "addedCount": 0, "removedCount": 0,
                            "added": [], "removed": [],
                            "newFiling": {"year": "2026", "url": "u", "form": "10-K"},
                            "oldFiling": {"year": "2025", "url": "u", "form": "10-K"}})[1])
    client.get("/api/filings/risk-changes", params={"symbol": "NVDA"})
    client.get("/api/filings/risk-changes", params={"symbol": "NVDA"})
    assert len(calls) == 1, "抓两份几十页的 10-K 很贵，必须缓存"


def test_panorama_brief_needs_two_agents(client, monkeypatch):
    """只有一个 Agent 有数据时，没什么可"综合"的，不该白花一次调用。"""
    monkeypatch.setattr(backend_app.quant_agent, "evaluate",
                        lambda s: {"axes": [], "total": None})
    monkeypatch.setattr(backend_app.news_agent, "fetch", lambda s, n: {"items": []})
    monkeypatch.setattr(backend_app.research_agent, "financials",
                        lambda s: {"derived": {}})
    body = client.get("/api/panorama/brief", params={"symbol": "NVDA"}).json()
    assert body["ok"] is False
    assert "至少要有两个" in body["reason"]


def _stub_three_agents(monkeypatch):
    monkeypatch.setattr(backend_app.quant_agent, "evaluate", lambda s: {
        "axes": [{"label": "估值", "marketPct": 72.0}],
        "total": 61.0, "sector": "Technology",
        "universeSize": 503, "peerCount": 60,
        "verdict": {"tag": "沧海遗珠形态", "text": "便宜且基本面不差"},
        "coverage": {"missing": []}})
    monkeypatch.setattr(backend_app.news_agent, "fetch", lambda s, n: {
        "count": 3,
        "items": [{"title": "T1", "publisher": "Reuters"}],
        "overall": {"label": "偏负面", "positive": 0, "negative": 2, "neutral": 1},
        "sources": [{"name": "Reuters", "count": 3}]})
    monkeypatch.setattr(backend_app.research_agent, "financials", lambda s: {
        "companyName": "NVIDIA", "derived": {"roe": 0.76, "revenueYoY": 0.94},
        "series": {"revenue": {"rows": [{"year": "2026", "val": 1}]}}})


def test_panorama_brief_sends_only_conclusions(client, monkeypatch):
    """喂给模型的必须是算好的结论，不能是原始行情数据。"""
    _stub_three_agents(monkeypatch)
    captured = {}

    def fake_brief(sym, facts):
        captured["facts"] = facts
        return {"ok": True, "mode": "generative", "provider": "deepseek",
                "model": "deepseek-chat", "brief": "一段话",
                "conflicts": ["分位说便宜但新闻偏负面"], "caveat": ""}

    import llm
    monkeypatch.setattr(llm, "available", lambda: True)
    monkeypatch.setattr(llm, "panorama_brief", fake_brief)

    body = client.get("/api/panorama/brief", params={"symbol": "NVDA"}).json()
    assert body["ok"] is True
    assert body["conflicts"]
    assert set(body["sources"]) == {"量化分位", "新闻扫描", "财报研究"}

    facts = captured["facts"]
    assert facts["量化分位"]["结论"] == "沧海遗珠形态"
    assert facts["新闻扫描"]["整体情绪"] == "偏负面"
    # 不该把 K 线 / 逐笔数据塞进去
    assert "bars" not in json.dumps(facts, ensure_ascii=False)


def test_panorama_brief_rate_limited(client, monkeypatch):
    _stub_three_agents(monkeypatch)
    monkeypatch.setattr(backend_app, "LLM_CALLS_PER_HOUR", 0)
    body = client.get("/api/panorama/brief", params={"symbol": "NVDA"}).json()
    assert body["ok"] is False and "上限" in body["reason"]


def test_panorama_brief_degrades_without_key(client, monkeypatch):
    _stub_three_agents(monkeypatch)
    body = client.get("/api/panorama/brief", params={"symbol": "NVDA"}).json()
    assert body["ok"] is False
    assert "API_KEY" in body["reason"], "要告诉用户缺什么，而不是只说失败"


def test_llm_status_reports_provider(client, monkeypatch):
    monkeypatch.setenv("DEEPSEEK_API_KEY", "sk-testkey12345678")
    r = client.get("/api/llm/status")
    body = r.json()
    assert body["enabled"] is True
    assert body["provider"] == "deepseek"
    assert "sk-testkey12345678" not in r.text, "状态接口绝不能回传 Key"
