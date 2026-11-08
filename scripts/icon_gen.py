#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""生成 DeepSeek Harness 应用图标 (1024x1024 PNG)"""
from PIL import Image, ImageDraw, ImageFont
import os

SIZE = 1024
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'build', 'icon.png')
OUT = os.path.abspath(OUT)

# 圆角矩形（DeepSeek 蓝渐变）
img = Image.new('RGBA', (SIZE, SIZE), (0, 0, 0, 0))
d = ImageDraw.Draw(img)

# 垂直渐变蓝
top = (77, 107, 254)      # #4D6BFE
bottom = (37, 59, 235)    # #253BEB
for y in range(SIZE):
    t = y / (SIZE - 1)
    r = int(top[0] + (bottom[0] - top[0]) * t)
    g = int(top[1] + (bottom[1] - top[1]) * t)
    b = int(top[2] + (bottom[2] - top[2]) * t)
    d.line([(0, y), (SIZE, y)], fill=(r, g, b, 255))

# 圆角遮罩
radius = 200
mask = Image.new('L', (SIZE, SIZE), 0)
md = ImageDraw.Draw(mask)
md.rounded_rectangle([0, 0, SIZE - 1, SIZE - 1], radius=radius, fill=255)
img.putalpha(mask)

# 鲸鱼图形：白色主体 + 尾鳍 + 眼睛
d = ImageDraw.Draw(img)
white = (255, 255, 255, 255)

# 主体（近似椭圆的鲸鱼身体）
body = [260, 400, 760, 700]  # 宽大的身体
d.ellipse(body, fill=white)

# 头部鼓起（左侧）
d.ellipse([220, 430, 420, 660], fill=white)

# 尾鳍（右侧两个三角）
d.polygon([(700, 520), (860, 400), (840, 540)], fill=white)
d.polygon([(700, 580), (860, 700), (840, 560)], fill=white)

# 肚皮弧线（蓝色，勾勒鲸鱼腹部）
blue = (70, 100, 245, 255)
d.arc([280, 480, 720, 760], start=20, end=160, fill=blue, width=22)

# 眼睛
d.ellipse([330, 500, 370, 540], fill=blue)

# 顶部喷水弧线（白色，DeepSeek 鲸鱼标志性的上扬弧线）
d.arc([380, 260, 700, 560], start=180, end=300, fill=white, width=40)

# 保存
os.makedirs(os.path.dirname(OUT), exist_ok=True)
img.save(OUT, 'PNG')
print('ICON_SAVED', OUT)
