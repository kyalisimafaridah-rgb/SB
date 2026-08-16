#!/usr/bin/env python3
"""Regenerate ScholarBase PWA icons. Requires: pip install pillow"""
from PIL import Image, ImageDraw, ImageFont
import os

ROOT = os.path.join(os.path.dirname(__file__), "..")
OUT = os.path.join(ROOT, "client/public")
ASSETS = os.path.join(ROOT, "client/src/assets")

NAVY = (20, 27, 46)
NAVY_LIGHT = (30, 41, 68)
GOLD = (212, 168, 67)
WHITE = (255, 255, 255)

def rounded_rect(draw, xy, radius, fill):
    draw.rounded_rectangle(list(xy), radius=radius, fill=fill)

def draw_mark(size: int) -> Image.Image:
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)
    pad = size * 0.06
    rounded_rect(d, (pad, pad, size - pad, size - pad), size * 0.22, NAVY)
    inset = size * 0.12
    rounded_rect(d, (inset, inset, size - inset, size - inset), size * 0.16, NAVY_LIGHT)
    cx, cy = size / 2, size / 2
    book_w, book_h = size * 0.52, size * 0.36
    left, top = cx - book_w / 2, cy - book_h / 2 + size * 0.02
    mid, right, bottom = cx, cx + book_w / 2, top + book_h
    d.polygon([(mid, top + size * 0.02), (left, top), (left, bottom), (mid, bottom - size * 0.02)], fill=WHITE)
    d.polygon([(mid, top + size * 0.02), (right, top), (right, bottom), (mid, bottom - size * 0.02)], fill=(245, 245, 250))
    d.line([(mid, top + size * 0.02), (mid, bottom - size * 0.02)], fill=GOLD, width=max(2, size // 64))
    bx = mid + size * 0.08
    d.polygon([(bx, top - size * 0.02), (bx + size * 0.08, top - size * 0.02), (bx + size * 0.08, top + size * 0.18), (bx + size * 0.04, top + size * 0.14), (bx, top + size * 0.18)], fill=GOLD)
    return img

def main():
    os.makedirs(OUT, exist_ok=True)
    os.makedirs(ASSETS, exist_ok=True)
    for s, name in [(512, "icon-512.png"), (192, "icon-192.png"), (180, "apple-touch-icon.png"), (32, "favicon-32.png"), (16, "favicon-16.png")]:
        draw_mark(s).save(os.path.join(OUT, name), "PNG", optimize=True)
        print("wrote", name)
    # wordmarks
    for light, path in [(False, "logo-wordmark.png"), (True, "logo-wordmark-light.png")]:
        w, h = 640, 128
        img = Image.new("RGBA", (w, h), (0, 0, 0, 0))
        d = ImageDraw.Draw(img)
        mark = draw_mark(h)
        img.paste(mark, (0, 0), mark)
        try:
            font = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf", size=int(h * 0.42))
            font_sub = ImageFont.truetype("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf", size=int(h * 0.18))
        except Exception:
            font = font_sub = ImageFont.load_default()
        fill = WHITE if light else NAVY
        d.text((h + int(h * 0.12), h * (0.28 if light else 0.22)), "ScholarBase", font=font, fill=fill)
        if not light:
            d.text((h + int(h * 0.12), h * 0.62), "School Fees · Uganda", font=font_sub, fill=(100, 110, 130))
        img.save(os.path.join(ASSETS, path), "PNG", optimize=True)
        print("wrote", path)

if __name__ == "__main__":
    main()
