"""
生成社交预览图 assets/og-cover.png（1200x630）

把仓库链接贴到简历、LinkedIn 或聊天里时，平台会抓 og:image 显示卡片。
没有这张图就是一块空白，观感差很多。

用法：.venv\\Scripts\\python backend\\build_og_image.py
"""

from __future__ import annotations

import math
import os
import random

from PIL import Image, ImageDraw, ImageFont

W, H = 1200, 630
BG = (11, 14, 20)
PANEL = (18, 22, 32)
ACCENT = (76, 141, 255)
PURPLE = (123, 92, 255)
UP = (38, 166, 154)
DOWN = (239, 83, 80)
TEXT = (216, 222, 233)
DIM = (139, 149, 168)

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(os.path.dirname(HERE), "assets", "og-cover.png")


def load_font(size: int, bold: bool = False):
    """Windows 上找一个能渲染中文的字体；找不到就退回默认。"""
    candidates = [
        "C:/Windows/Fonts/msyhbd.ttc" if bold else "C:/Windows/Fonts/msyh.ttc",
        "C:/Windows/Fonts/segoeuib.ttf" if bold else "C:/Windows/Fonts/segoeui.ttf",
        "/System/Library/Fonts/PingFang.ttc",
        "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
    ]
    for path in candidates:
        if os.path.exists(path):
            try:
                return ImageFont.truetype(path, size)
            except Exception:                         # noqa: BLE001
                continue
    return ImageFont.load_default()


def draw_candles(d: ImageDraw.ImageDraw, x0: int, y0: int, w: int, h: int) -> None:
    """画一段示意 K 线，让预览图一眼看出是行情工具。"""
    rnd = random.Random(20260729)                     # 固定种子，每次生成一致
    n = 44
    step = w / n
    price = h * 0.62
    pts = []
    for _ in range(n):
        price += rnd.gauss(-h * 0.004, h * 0.035)
        price = max(h * 0.18, min(h * 0.86, price))
        pts.append(price)

    for i, close in enumerate(pts):
        open_ = pts[i - 1] if i else close
        up = close <= open_                           # y 轴向下，值小 = 价高
        color = UP if up else DOWN
        cx = x0 + step * (i + 0.5)
        body_w = step * 0.6
        hi = min(open_, close) - rnd.random() * h * 0.03
        lo = max(open_, close) + rnd.random() * h * 0.03
        d.line([(cx, y0 + hi), (cx, y0 + lo)], fill=color, width=2)
        top, bot = sorted((open_, close))
        d.rectangle([cx - body_w / 2, y0 + top, cx + body_w / 2, y0 + max(bot, top + 2)],
                    fill=color)

    # 一条均线
    ma = []
    for i in range(len(pts)):
        window = pts[max(0, i - 6):i + 1]
        ma.append((x0 + step * (i + 0.5), y0 + sum(window) / len(window)))
    d.line(ma, fill=(240, 167, 66), width=2)


def main() -> int:
    img = Image.new("RGB", (W, H), BG)
    d = ImageDraw.Draw(img)

    # 顶部渐变条
    for x in range(W):
        t = x / W
        d.line([(x, 0), (x, 6)],
               fill=(int(ACCENT[0] + (PURPLE[0] - ACCENT[0]) * t),
                     int(ACCENT[1] + (PURPLE[1] - ACCENT[1]) * t),
                     int(ACCENT[2] + (PURPLE[2] - ACCENT[2]) * t)))

    # 品牌标记
    d.rounded_rectangle([64, 64, 144, 144], radius=18, fill=ACCENT)
    d.text((104, 100), "Q", font=load_font(52, True), fill=(255, 255, 255), anchor="mm")

    d.text((166, 82), "QuantLab", font=load_font(52, True), fill=TEXT)
    d.text((168, 142), "US Equity Research Terminal",
           font=load_font(22), fill=DIM)

    d.text((64, 204), "美股量化研究终端", font=load_font(40, True), fill=TEXT)
    d.text((64, 262),
           "手写 Canvas K 线  ·  事件驱动回测  ·  全市场分位打分  ·  三 Agent 协同",
           font=load_font(23), fill=DIM)

    # K 线面板
    px, py, pw, ph = 64, 322, W - 128, 208
    d.rounded_rectangle([px, py, px + pw, py + ph], radius=12,
                        fill=PANEL, outline=(35, 42, 58))
    draw_candles(d, px + 16, py + 16, pw - 32, ph - 32)

    # 底部标签
    tags = ["零依赖", "11700+ 美股代码", "SEC XBRL 财报", "MIT License"]
    tx = 64
    small = load_font(20)
    for tag in tags:
        tw = d.textlength(tag, font=small)
        d.rounded_rectangle([tx, 556, tx + tw + 28, 596], radius=20,
                            fill=(26, 32, 48))
        d.text((tx + 14, 566), tag, font=small, fill=DIM)
        tx += tw + 42

    d.text((W - 64, 576), "alexsheng26.github.io/quant-lab",
           font=load_font(20), fill=ACCENT, anchor="rm")

    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    img.save(OUT, "PNG", optimize=True)
    print(f"已生成 {OUT}  ({os.path.getsize(OUT) / 1024:.0f} KB, {W}x{H})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
