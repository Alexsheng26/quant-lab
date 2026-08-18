"""前端 JS 单元测试的 pytest 驱动。

前端是零依赖的经典 <script> 结构，没有 package.json 也没有模块系统，
所以不引入 npm/jest —— 直接在 Chromium 里加载真实源文件跑断言，
由 Playwright（无障碍审计已经在用）驱动，本地和 CI 都只需要 Python 一套工具链。

浏览器同时也是这些代码的真实运行环境，比在 Node 里模拟更有说服力。
"""

import http.server
import os
import socketserver
import threading
from functools import partial

import pytest

pytestmark = pytest.mark.js

PORT = 5713


@pytest.fixture(scope="session")
def js_results(project_root):
    """跑一次测试页，把结果带回来给所有用例共享。"""
    playwright = pytest.importorskip(
        "playwright.sync_api", reason="需要 playwright 才能跑前端测试")

    handler = partial(http.server.SimpleHTTPRequestHandler,
                      directory=project_root)
    socketserver.TCPServer.allow_reuse_address = True
    httpd = socketserver.TCPServer(("127.0.0.1", PORT), handler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()

    errors = []
    try:
        with playwright.sync_playwright() as p:
            browser = p.chromium.launch()
            page = browser.new_page()
            page.on("pageerror", lambda e: errors.append(str(e)))
            page.goto(f"http://127.0.0.1:{PORT}/tests/js/harness.html",
                      wait_until="load")
            page.wait_for_function("() => window.__QL_TEST_RESULTS__ !== undefined",
                                   timeout=15000)
            results = page.evaluate("() => window.__QL_TEST_RESULTS__")
            browser.close()
    finally:
        httpd.shutdown()

    assert not errors, "页面加载时抛了异常：" + "; ".join(errors)
    assert results, "测试套件没有产出任何结果"
    return results


def _check(results, group_prefix):
    """断言某一组全部通过，失败时把每条都打出来。"""
    subset = [r for r in results if r["group"].startswith(group_prefix)]
    assert subset, f"没有找到分组 {group_prefix!r} 的测试"
    failed = [r for r in subset if not r["ok"]]
    if failed:
        lines = [f"  {r['group']} / {r['name']}\n      {r.get('message', '')}"
                 for r in failed]
        pytest.fail(f"{len(failed)}/{len(subset)} 个前端断言失败：\n"
                    + "\n".join(lines), pytrace=False)


def test_js_suite_ran(js_results):
    """套件本身要有足够的规模，避免 harness 悄悄坏掉后"0 个测试全部通过"。"""
    assert len(js_results) >= 30, f"只跑了 {len(js_results)} 条，套件可能没加载全"


def test_indicators(js_results):
    _check(js_results, "indicators")


def test_backtest_no_lookahead(js_results):
    """最关键的一组：信号在下一根开盘成交，任何策略都拿不到未来数据。"""
    _check(js_results, "backtest 防未来函数")


def test_backtest_costs(js_results):
    _check(js_results, "backtest 成本模型")


def test_backtest_equity(js_results):
    _check(js_results, "backtest 资金曲线")


def test_backtest_strategies(js_results):
    _check(js_results, "backtest 策略信号")


def test_backtest_metrics(js_results):
    _check(js_results, "backtest 绩效指标")


def test_utils(js_results):
    _check(js_results, "utils")
