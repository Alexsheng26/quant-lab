"""纯键盘走查。

axe-core 只看静态标记，查不出「Tab 能不能走到」「方向键切不切得动标签页」
这类交互问题——而这恰恰是键盘用户和读屏用户真正会卡住的地方。
本脚本模拟一遍真实的键盘操作，断言每一步的结果。

用法： .venv\\Scripts\\python.exe backend\\audit_keyboard.py
"""
import http.server
import socketserver
import sys
import threading
from functools import partial
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent
PORT = 5711
URL = f"http://127.0.0.1:{PORT}/index.html"

results = []


def check(name, ok, detail=""):
    results.append((name, ok, detail))
    print(f"  {'PASS' if ok else 'FAIL'}  {name}" + (f"   {detail}" if detail else ""))


def serve():
    handler = partial(http.server.SimpleHTTPRequestHandler, directory=str(ROOT))
    socketserver.TCPServer.allow_reuse_address = True
    httpd = socketserver.TCPServer(("127.0.0.1", PORT), handler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    return httpd


def active(pg):
    """当前焦点元素的简短标识，方便断言和排错。"""
    return pg.evaluate("""() => {
        const a = document.activeElement;
        if (!a) return null;
        return (a.id ? '#' + a.id : a.tagName.toLowerCase())
             + (a.className && typeof a.className === 'string'
                ? '.' + a.className.trim().split(/\\s+/).join('.') : '');
    }""")


def main():
    httpd = serve()
    with sync_playwright() as p:
        b = p.chromium.launch()
        pg = b.new_page(viewport={"width": 1440, "height": 900})
        pg.goto(URL, wait_until="networkidle")
        pg.wait_for_timeout(3000)

        # --- 1. 跳转链接：第一次 Tab 就该落在它上面 ---
        print("\n[1] 跳过导航链接")
        pg.keyboard.press("Tab")
        first = active(pg)
        check("首个 Tab 焦点是跳转链接", "skip-link" in (first or ""), first)
        pg.wait_for_timeout(300)          # 它是滑下来的（transition: top .15s），等动画走完再量
        top = pg.evaluate(
            "() => { const e = document.querySelector('.skip-link');"
            "return e ? e.getBoundingClientRect().top : null; }")
        check("跳转链接聚焦后滑入视口", top is not None and top >= 0, f"top={top}")
        pg.keyboard.press("Enter")
        pg.wait_for_timeout(300)
        check("按下后跳到主内容区",
              pg.evaluate("() => location.hash") == "#main", pg.evaluate("() => location.hash"))
        check("焦点确实落在 main 上", active(pg) == "#main.main", active(pg))

        # --- 2. 标签页：方向键切换，且只有一个能 Tab 到 ---
        print("\n[2] 标签页方向键导航")
        tabbable = pg.evaluate(
            "() => [...document.querySelectorAll('.tab')].filter(t => t.tabIndex === 0).length")
        check("标签组内只有 1 个 tabindex=0", tabbable == 1, f"实际 {tabbable}")

        pg.eval_on_selector(".tab.active", "e => e.focus()")
        start = pg.eval_on_selector(".tab.active", "e => e.dataset.view")
        pg.keyboard.press("ArrowRight")
        pg.wait_for_timeout(250)
        after = pg.eval_on_selector(".tab.active", "e => e.dataset.view")
        check("方向键右切换了标签页", after != start, f"{start} -> {after}")
        check("面板跟着切换",
              pg.evaluate(f"() => !document.getElementById('view-{after}').classList.contains('hidden') "
                          f"&& document.getElementById('view-{after}').classList.contains('active')"))
        check("焦点跟着走到新标签",
              (active(pg) or "").startswith("#tab-"), active(pg))
        check("aria-selected 同步",
              pg.evaluate("() => [...document.querySelectorAll('.tab')]"
                          ".filter(t => t.getAttribute('aria-selected') === 'true').length") == 1)
        pg.keyboard.press("End")
        pg.wait_for_timeout(200)
        check("End 跳到最后一个标签",
              pg.eval_on_selector(".tab.active", "e => e === document.querySelectorAll('.tab')[4]"))
        pg.keyboard.press("Home")
        pg.wait_for_timeout(400)

        # --- 3. 搜索框：打字 -> 下键进列表 -> Enter 选中 ---
        print("\n[3] 搜索下拉的键盘操作")
        pg.eval_on_selector("#symbolSearch", "e => e.focus()")
        pg.keyboard.type("MSFT", delay=60)
        pg.wait_for_timeout(900)
        check("aria-expanded 打开时为 true",
              pg.eval_on_selector("#symbolSearch", "e => e.getAttribute('aria-expanded')") == "true")
        pg.keyboard.press("ArrowDown")
        pg.wait_for_timeout(150)
        check("下键把焦点送进结果列表", "sr-row" in (active(pg) or ""), active(pg))
        pg.keyboard.press("ArrowDown")
        pg.wait_for_timeout(150)
        check("列表内继续下移仍在列表里", "sr-row" in (active(pg) or ""), active(pg))
        pg.keyboard.press("Escape")
        pg.wait_for_timeout(200)
        check("Esc 关闭下拉并把 aria-expanded 置 false",
              pg.eval_on_selector("#symbolSearch", "e => e.getAttribute('aria-expanded')") == "false")
        check("Esc 后焦点回到输入框", active(pg) == "#symbolSearch", active(pg))

        # --- 4. 焦点陷阱与不可见元素 ---
        print("\n[4] 焦点不会掉进隐藏区域")
        pg.eval_on_selector("#symbolSearch", "e => e.blur()")
        # 注意：display:none 的后代浏览器本来就不放进 Tab 序列，
        # 光看 tabIndex>=0 会误报。真正要防的是「看不见但还能 Tab 到」——
        # 也就是用 opacity:0 / 挪出视口之类方式隐藏、却仍占据 Tab 序列的元素。
        stuck = pg.evaluate("""() => {
            const bad = [];
            document.querySelectorAll('.view:not(.active)').forEach(v => {
                const cs = getComputedStyle(v);
                if (cs.display === 'none' || cs.visibility === 'hidden') return;  // 已被浏览器排除
                v.querySelectorAll('a[href],button,input,select,textarea,[tabindex]').forEach(el => {
                    if (el.tabIndex >= 0) bad.push(el.id || el.className);
                });
            });
            return bad.slice(0, 5);
        }""")
        check("隐藏面板不参与 Tab 序列", len(stuck) == 0, str(stuck))

        # 真正走一遍 Tab，确认焦点不会跑到看不见的地方去
        pg.evaluate("() => document.body.focus()")
        seen, ghost = [], []
        for _ in range(40):
            pg.keyboard.press("Tab")
            info = pg.evaluate("""() => {
                const a = document.activeElement;
                if (!a || a === document.body) return null;
                const r = a.getBoundingClientRect();
                return { id: a.id || a.className, off: a.offsetParent === null,
                         zero: r.width === 0 && r.height === 0,
                         skip: a.classList.contains('skip-link') };
            }""")
            if not info:
                continue
            seen.append(info["id"])
            if (info["off"] or info["zero"]) and not info["skip"]:
                ghost.append(info["id"])
        check("连按 40 次 Tab 焦点从不落在隐形元素上", len(ghost) == 0, str(ghost[:5]))
        check("Tab 能走到的控件数量合理", len(seen) >= 15, f"走到 {len(seen)} 个")

        # --- 5. 所有可交互控件都有无障碍名称 ---
        print("\n[5] 可交互控件的无障碍名称")
        nameless = pg.evaluate("""() => {
            const bad = [];
            document.querySelectorAll('button,a[href],input,select').forEach(el => {
                if (el.offsetParent === null) return;
                const name = (el.getAttribute('aria-label') || el.getAttribute('title') ||
                              el.textContent || el.value || '').trim();
                if (!name) bad.push(el.tagName + (el.id ? '#' + el.id : '.' + el.className));
            });
            return bad;
        }""")
        check("没有「无名」控件", len(nameless) == 0, str(nameless[:6]))

        b.close()
    httpd.shutdown()

    bad = [r for r in results if not r[1]]
    print(f"\n{'=' * 46}")
    print(f"{len(results) - len(bad)}/{len(results)} 项通过")
    if bad:
        print("未通过：")
        for n, _, d in bad:
            print(f"  - {n}  {d}")
    sys.exit(1 if bad else 0)


if __name__ == "__main__":
    main()
