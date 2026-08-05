"""
生成 README 用的截图
====================

用 Playwright 驱动无头 Chromium 逐页截图，结果写到 assets/screenshots/。
脚本化而不是手动截屏，是为了 UI 改动后能一条命令重新生成，
不会出现"README 里还是三个版本前的界面"这种情况。

前置条件：
  1. 后端在跑（否则截出来是模拟数据 + 水印）：
       .venv\\Scripts\\python backend\\app.py
  2. 前端起静态服务（file:// 下 Playwright 截图会有路径问题）：
       python -m http.server 5710
  3. 装依赖：
       .venv\\Scripts\\pip install playwright
       .venv\\Scripts\\python -m playwright install chromium

用法：
  .venv\\Scripts\\python backend\\build_screenshots.py
  .venv\\Scripts\\python backend\\build_screenshots.py --url http://127.0.0.1:5710/index.html
"""

from __future__ import annotations

import argparse
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
OUT_DIR = os.path.join(os.path.dirname(HERE), "assets", "screenshots")

VIEWPORT = {"width": 1440, "height": 900}
SCALE = 2                      # 2 倍图，在 GitHub 上和高分屏都清晰


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--url", default="http://127.0.0.1:5710/index.html")
    ap.add_argument("--symbol", default="NVDA")
    args = ap.parse_args()

    try:
        from playwright.sync_api import sync_playwright
    except ImportError:
        print("未安装 playwright：.venv\\Scripts\\pip install playwright", file=sys.stderr)
        return 1

    os.makedirs(OUT_DIR, exist_ok=True)

    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page(viewport=VIEWPORT, device_scale_factor=SCALE)
        page.goto(args.url, wait_until="networkidle")

        # 等自动探测后端 + 首个标的加载完
        page.wait_for_timeout(6000)

        mode = page.evaluate("() => QL.data.mode")
        print(f"数据模式：{mode}" + ("" if mode == "live" else "  ⚠ 后端没起，截图会带模拟水印"))

        # 选一只走势好看的标的
        page.evaluate(f"() => QL.app.setSymbol('{args.symbol}')")
        page.wait_for_timeout(3500)

        shots = []

        def shot(name, label):
            """点击会把鼠标留在按钮上，:hover 样式会被拍进图里，
               README 上看着像按钮坏了。截图前先把指针挪开。"""
            page.mouse.move(0, 0)
            page.wait_for_timeout(250)
            shots.append((name, label))
            page.screenshot(path=os.path.join(OUT_DIR, name))

        # ---- 1. 行情页（K 线 + MACD 副图 + BOLL）----
        page.click('.tab[data-view="market"]')
        page.click('#subGroup .btn[data-sub="macd"]')
        page.click('#maGroup .btn[data-ma="boll"]')
        page.click('#rangeGroup .btn[data-range="250"]')
        page.wait_for_timeout(1800)
        shot("01-market.png", "行情页")

        # ---- 2. AI 量化打分（评分环 + 因子条 + 参考价位）----
        page.click('.tab[data-view="agent"]')
        page.wait_for_timeout(600)
        page.click("#btnRunAgent")
        page.wait_for_timeout(2000)
        shot("02-agent.png", "AI 量化打分")

        # ---- 3. 个股全景 · 六边形雷达 ----
        page.click('.tab[data-view="panorama"]')
        page.wait_for_timeout(14000)          # 三个 Agent 并行，SEC 那边慢
        shot("03-panorama.png", "个股全景·雷达")

        # ---- 3b. 往下滚，露出新闻 Agent 和研究 Agent ----
        # 雷达图在视口内，新闻和 SEC 财报在下面，单独截一张才看得到三个 Agent 协同
        page.evaluate("""() => {
            const el = document.querySelector('#newsList');
            if (el) el.scrollIntoView({ block: 'center' });
            window.scrollBy(0, -140);
        }""")
        page.wait_for_timeout(1200)
        shot("03b-agents.png", "新闻+研究 Agent")
        page.evaluate("() => window.scrollTo(0, 0)")

        # ---- 4. 策略回测（资金曲线 + 绩效指标）----
        page.click('.tab[data-view="backtest"]')
        page.wait_for_timeout(600)
        page.click("#btnRunBacktest")
        page.wait_for_timeout(2500)
        shot("04-backtest.png", "策略回测")

        # ---- 5. 移动端（证明窄屏可用）----
        mobile = browser.new_page(
            viewport={"width": 390, "height": 844}, device_scale_factor=SCALE)
        mobile.goto(args.url, wait_until="networkidle")
        mobile.wait_for_timeout(6000)
        mobile.evaluate(f"() => QL.app.setSymbol('{args.symbol}')")
        mobile.wait_for_timeout(2500)
        shots.append(("05-mobile.png", "移动端"))
        mobile.screenshot(path=os.path.join(OUT_DIR, "05-mobile.png"))

        browser.close()

    print()
    for name, label in shots:
        path = os.path.join(OUT_DIR, name)
        size = os.path.getsize(path) / 1024
        print(f"  {name:<20} {label:<14} {size:6.0f} KB")
    print(f"\n共 {len(shots)} 张 → {OUT_DIR}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
