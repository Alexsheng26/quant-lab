"""
无障碍审计（axe-core + Playwright）
==================================

用业界标准的 axe-core 引擎跑一遍，而不是凭感觉挑几个 aria 属性加上。
逐个标签页检测，因为不同视图的 DOM 差别很大。

前置：后端 + 静态服务都跑起来（同 build_screenshots.py）。

用法：
    .venv\\Scripts\\python backend\\audit_a11y.py
    .venv\\Scripts\\python backend\\audit_a11y.py --json out.json   # 存明细
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from collections import Counter

AXE_CDN = "https://cdnjs.cloudflare.com/ajax/libs/axe-core/4.10.2/axe.min.js"

VIEWS = [
    ("market",   "行情"),
    ("agent",    "AI 量化打分"),
    ("panorama", "个股全景"),
    ("backtest", "策略回测"),
    ("paper",    "模拟交易"),
]

IMPACT_ORDER = {"critical": 0, "serious": 1, "moderate": 2, "minor": 3, None: 4}


def check_hover_contrast(page):
    """axe 只测静止状态，测不到 :hover。这里逐个悬停实测两件事：

    1. 悬停态对比度仍 >= 4.5:1；
    2. 实心按钮悬停后没有被打回基础 .btn 样式。

    第 2 条是因为 CSS 特异度会在这里咬人：`.btn:hover` 是 (0,2,0)，高于
    `.btn-primary` 的 (0,1,0)，实心按钮的 hover 规则只要漏写 background，
    悬停瞬间就变回灰底——注意这种情况对比度反而是达标的（灰底白字约 12:1），
    所以光测对比度抓不到，必须单独断言主色还在。
    """
    page.evaluate("""() => {
        window.__contrast = (fg, bg) => {
            const p = s => s.match(/[\\d.]+/g).slice(0, 3).map(Number);
            const lin = c => { c /= 255;
                return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
            const L = ([r, g, b]) => 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
            const a = L(p(fg)), b2 = L(p(bg));
            const hi = Math.max(a, b2), lo = Math.min(a, b2);
            return (hi + 0.05) / (lo + 0.05);
        };
    }""")

    # 按钮各自散在不同标签页里，不先切过去就是不可见的，hover 根本测不到。
    # 所以先把「按钮 -> 所属视图」问出来，逐个切过去再悬停。
    targets = page.evaluate("""() => {
        return [...document.querySelectorAll('.btn-primary,.btn-buy,.btn-sell')]
            .filter(e => e.id)
            .map(e => {
                const v = e.closest('.view');
                return { id: e.id, view: v ? v.id.replace(/^view-/, '') : null };
            });
    }""")

    # 主题里所有「中性面板色」。实心按钮无论静止还是悬停都不该落到这些颜色上——
    # 一旦落上去，就说明主色被基础 .btn 规则盖掉了。
    # （注意不能只比 --bg-elev：.btn 静止用 --bg-elev、悬停用 --bg-hover，是两个值。）
    neutral_bgs = page.evaluate("""() => {
        const cs = getComputedStyle(document.documentElement);
        const probe = document.createElement('div');
        document.body.appendChild(probe);
        const out = [];
        for (const name of ['--bg', '--bg-elev', '--bg-hover', '--panel', '--border']) {
            const v = cs.getPropertyValue(name).trim();
            if (!v) continue;
            probe.style.backgroundColor = v;              // 借浏览器把 hex 归一成 rgb()
            const rgb = getComputedStyle(probe).backgroundColor;
            if (rgb && rgb !== 'rgba(0, 0, 0, 0)') out.push(rgb);
        }
        probe.remove();
        return out;
    }""")

    bad = []
    checked = 0
    for t in targets:
        if t["view"]:
            page.click(f'.tab[data-view="{t["view"]}"]')
            page.wait_for_timeout(350)
        sel = t["id"]
        el = page.query_selector(f"#{sel}")
        if not el or not el.is_visible():
            print(f"  （跳过 #{sel}：切到 {t['view']} 后仍不可见）", file=sys.stderr)
            continue
        el.hover()
        page.wait_for_timeout(200)
        checked += 1
        r = page.evaluate("""(id) => {
            const el = document.getElementById(id);
            const cs = getComputedStyle(el);
            let bg = cs.backgroundColor, node = el;
            // 背景透明就往上找真正画出颜色的祖先
            while (bg === 'rgba(0, 0, 0, 0)' && node.parentElement) {
                node = node.parentElement; bg = getComputedStyle(node).backgroundColor;
            }
            return { fg: cs.color, bg, ratio: +window.__contrast(cs.color, bg).toFixed(2) };
        }""", sel)
        if r["ratio"] < 4.5:
            bad.append({"sel": "#" + sel, "why": "对比度不足", **r})
        elif r["bg"] in neutral_bgs:
            bad.append({"sel": "#" + sel,
                        "why": "悬停时丢了主色，被 .btn:hover 打回中性底色", **r})
    # 把鼠标挪开，免得影响后续截图
    page.mouse.move(0, 0)
    print(f"悬停态对比度：实测 {checked}/{len(targets)} 个实心按钮"
          f"，{len(bad)} 个不达标")
    return bad


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--url", default="http://127.0.0.1:5710/index.html")
    ap.add_argument("--json", default=None, help="把完整结果写到这个文件")
    args = ap.parse_args()

    try:
        from playwright.sync_api import sync_playwright
    except ImportError:
        print("未安装 playwright", file=sys.stderr)
        return 1

    all_violations = []

    with sync_playwright() as p:
        browser = p.chromium.launch()
        page = browser.new_page(viewport={"width": 1440, "height": 900})
        page.goto(args.url, wait_until="networkidle")
        page.wait_for_timeout(6000)

        try:
            page.add_script_tag(url=AXE_CDN)
        except Exception as exc:                      # noqa: BLE001
            print(f"加载 axe-core 失败（需要联网）：{exc}", file=sys.stderr)
            browser.close()
            return 1

        # 先把需要点击才出内容的视图跑一遍，让 DOM 完整
        page.click('.tab[data-view="agent"]')
        page.wait_for_timeout(500)
        page.click("#btnRunAgent")
        page.wait_for_timeout(1500)
        page.click('.tab[data-view="backtest"]')
        page.wait_for_timeout(400)
        page.click("#btnRunBacktest")
        page.wait_for_timeout(1500)

        for view, label in VIEWS:
            page.click(f'.tab[data-view="{view}"]')
            page.wait_for_timeout(900)
            result = page.evaluate("""async () => {
                const r = await axe.run(document, {
                    runOnly: { type: 'tag',
                               values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'] }
                });
                return r.violations.map(v => ({
                    id: v.id, impact: v.impact, help: v.help,
                    nodes: v.nodes.length,
                    targets: v.nodes.slice(0, 4).map(n => n.target.join(' ')),
                }));
            }""")
            for v in result:
                v["view"] = label
            all_violations.extend(result)

        hover_bad = check_hover_contrast(page)

        browser.close()

    if hover_bad:
        print("悬停态有问题：")
        for b in hover_bad:
            print(f"  - {b['sel']}  {b['why']}：{b['fg']} on {b['bg']}  {b['ratio']}:1")
        print()
        all_violations.append({"id": "button-hover-state", "impact": "serious",
                               "help": "按钮悬停时对比度不足或丢失主色",
                               "nodes": len(hover_bad), "view": "悬停态",
                               "targets": [b["sel"] for b in hover_bad[:4]]})

    # ---- 汇总 ----
    if not all_violations:
        print("axe-core 未发现 WCAG 2.1 A/AA 违规 ✓")
        return 0

    # 同一条规则可能在多个视图重复，按规则聚合
    by_rule = {}
    for v in all_violations:
        key = v["id"]
        if key not in by_rule:
            by_rule[key] = {"id": key, "impact": v["impact"], "help": v["help"],
                            "nodes": 0, "views": set(), "targets": []}
        by_rule[key]["nodes"] += v["nodes"]
        by_rule[key]["views"].add(v["view"])
        for t in v["targets"]:
            if t not in by_rule[key]["targets"] and len(by_rule[key]["targets"]) < 5:
                by_rule[key]["targets"].append(t)

    rules = sorted(by_rule.values(),
                   key=lambda r: (IMPACT_ORDER.get(r["impact"], 4), -r["nodes"]))

    counts = Counter(r["impact"] for r in rules)
    print(f"发现 {len(rules)} 类问题，共 {sum(r['nodes'] for r in rules)} 处")
    print("  " + "  ".join(f"{k}:{v}" for k, v in counts.most_common()))
    print()

    for r in rules:
        print(f"[{str(r['impact']).upper():<8}] {r['id']}  ({r['nodes']} 处)")
        print(f"           {r['help']}")
        print(f"           出现在：{'、'.join(sorted(r['views']))}")
        for t in r["targets"]:
            print(f"             - {t}")
        print()

    if args.json:
        with open(args.json, "w", encoding="utf-8") as f:
            json.dump([{**r, "views": sorted(r["views"])} for r in rules],
                      f, ensure_ascii=False, indent=2)
        print(f"明细已写入 {args.json}")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
