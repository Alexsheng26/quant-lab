"""pytest 公共配置。

backend/ 里的模块用的是同级导入（`import news`、`import research`），
所以要把 backend/ 直接放进 sys.path，而不是当成一个包来 import。
这也是 uvicorn 必须在 backend/ 目录里启动的原因。
"""

import os
import sys

import pytest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BACKEND = os.path.join(ROOT, "backend")

for p in (BACKEND, ROOT):
    if p not in sys.path:
        sys.path.insert(0, p)


@pytest.fixture(scope="session")
def project_root() -> str:
    return ROOT


def _is_loopback(addr) -> bool:
    """本机地址一律放行。

    asyncio 事件循环自己要建自管道（Windows 的 Proactor 循环尤其明显），
    TestClient、Playwright 的本地静态服务也都走回环。
    真正要拦的是"测试偷偷连了外网"。
    """
    if not isinstance(addr, tuple) or not addr:
        return True                                   # AF_UNIX 之类，不是外网
    host = str(addr[0])
    return host in ("127.0.0.1", "::1", "localhost", "0.0.0.0", "")


@pytest.fixture(autouse=True)
def _no_network(monkeypatch, request):
    """默认禁止访问外网。

    单元测试连外网会变慢，还会因为 SEC / Yahoo 抖动随机失败，在 CI 上尤其致命。
    需要联网的测试显式标 @pytest.mark.network。

    拦的是"连接到非回环地址"这一步，而不是 socket 的创建——
    后者会把 asyncio 自己的内部管道一起拦掉。
    """
    if request.node.get_closest_marker("network"):
        return

    import socket

    real_connect = socket.socket.connect

    def guarded(self, addr, *a, **kw):
        if not _is_loopback(addr):
            raise RuntimeError(
                f"测试里发生了真实外网请求（{addr}）。请 monkeypatch 掉数据源，"
                f"或给这个测试加 @pytest.mark.network 标记。")
        return real_connect(self, addr, *a, **kw)

    monkeypatch.setattr(socket.socket, "connect", guarded)


def pytest_configure(config):
    config.addinivalue_line("markers", "network: 需要访问真实外网的测试")


@pytest.fixture(autouse=True)
def _no_real_api_keys(monkeypatch, request):
    """测试一律在"没有任何真实 Key"的环境下跑。

    开发机上通常设着 DEEPSEEK_API_KEY / ANTHROPIC_API_KEY。
    如果不清掉，llm.available() 会返回 True，测试就可能真的去打付费接口——
    既花钱又让结果依赖外部服务。需要模拟有 Key 的测试自己 monkeypatch.setenv。
    """
    if request.node.get_closest_marker("network"):
        return
    for name in ("DEEPSEEK_API_KEY", "ANTHROPIC_API_KEY", "LLM_PROVIDER"):
        monkeypatch.delenv(name, raising=False)
