#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""生成 DeepSeek Harness 应用图标（1024x1024 PNG）：纯色蓝底圆角方形 + 白色粗体 "DSH" 字母"""
from PIL import Image, ImageDraw, ImageFont
import os

SIZE = 1024
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'build', 'icon.png')
OUT = os.path.abspath(OUT)

# 纯色背景（DeepSeek 蓝）
BG = (77, 107, 254, 255)   # #4D6BFE

img = Image.new('RGBA', (SIZE, SIZE), (0, 0, 0, 0))
d = ImageDraw.Draw(img)

# 圆角方形背景（透明四角，由 macOS 套用标准圆角）
d.rounded_rectangle([0, 0, SIZE - 1, SIZE - 1], radius=224, fill=BG)

# 白色粗体 "DSH"，字号自适应到约 70% 宽度并垂直水平居中
text = "DSH"
font_candidates = [
    ('/System/Library/Fonts/Helvetica.ttc', 1),                    # Helvetica Bold
    ('/System/Library/Fonts/Supplemental/Arial Bold.ttf', None),
    ('/System/Library/Fonts/Helvetica.ttc', 0),                    # Helvetica Regular
    ('/System/Library/Fonts/Arial.ttf', None),
]

def make_font(size):
    for fp, idx in font_candidates:
        try:
            return ImageFont.truetype(fp, size, index=idx) if idx is not None else ImageFont.truetype(fp, size)
        except Exception:
            continue
    return ImageFont.load_default()

# 扫描字号，找到使文字宽度最接近目标宽度的档位
target_w = int(SIZE * 0.70)
best_size = 100
for size in range(100, 901, 5):
    f = make_font(size)
    bb = d.textbbox((0, 0), text, font=f)
    w = bb[2] - bb[0]
    if w <= target_w:
        best_size = size
    else:
        break

font = make_font(best_size)
bbox = d.textbbox((0, 0), text, font=font)
w = bbox[2] - bbox[0]
h = bbox[3] - bbox[1]
x = (SIZE - w) / 2 - bbox[0]
y = (SIZE - h) / 2 - bbox[1]
d.text((x, y), text, font=font, fill=(255, 255, 255, 255))

os.makedirs(os.path.dirname(OUT), exist_ok=True)
img.save(OUT, 'PNG')
print('ICON_SAVED', OUT, 'font_size=', best_size)
