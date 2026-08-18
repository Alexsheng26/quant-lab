"""FastAPI 路由层。

用 TestClient 在进程内跑，不起服务器也不联网。
重点是响应模型校验——`/api/search` 曾因为返回值里混进布尔字段而 500，
这类问题只有真正走一遍 FastAPI 的序列化才能发现。
"""

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
