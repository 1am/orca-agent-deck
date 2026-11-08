"""Builds the Elgato Marketplace images from the plugin art in orca-plugin/images.

Run from the repo root: python3 docs/marketplace/generate.py (needs Pillow, macOS fonts).
"""
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parents[2]
SRC = ROOT / "orca-plugin" / "images"
OUT = ROOT / "docs" / "marketplace"
BG = (14, 14, 16)
FG = (240, 242, 245)
MUTED = (150, 156, 166)
BOLD = "/System/Library/Fonts/Supplemental/Arial Bold.ttf"
REGULAR = "/System/Library/Fonts/Supplemental/Arial.ttf"


def font(path, size):
    return ImageFont.truetype(path, size)


def canvas():
    return Image.new("RGB", (1920, 960), BG)


def centered(draw, y, text, f, fill):
    w = draw.textlength(text, font=f)
    draw.text(((1920 - w) / 2, y), text, font=f, fill=fill)


def keys_row(width):
    row = Image.open(SRC / "cover.png").convert("RGB").crop((30, 350, 1570, 650))
    return row.resize((width, round(row.height * width / row.width)), Image.LANCZOS)


def app_icon():
    icon = Image.open(SRC / "icon.png").convert("RGBA").resize((288, 288), Image.LANCZOS)
    icon.save(OUT / "app-icon-288.png")
    return icon


def thumbnail(icon):
    img = canvas()
    d = ImageDraw.Draw(img)
    big = Image.open(SRC / "icon.png").convert("RGBA").resize((420, 420), Image.LANCZOS)
    img.paste(big, (260, 270), big)
    d.text((780, 330), "Orca Agent Deck", font=font(BOLD, 110), fill=FG)
    d.text((784, 480), "See which agent needs you.", font=font(REGULAR, 56), fill=MUTED)
    d.text((784, 560), "Press a key to jump to its pane.", font=font(REGULAR, 56), fill=MUTED)
    img.save(OUT / "thumbnail-1920x960.png")


def gallery_hero():
    img = canvas()
    d = ImageDraw.Draw(img)
    centered(d, 120, "Every Orca agent, one glance", font(BOLD, 96), FG)
    centered(d, 250, "Working, done, waiting or failed, live on your Stream Deck", font(REGULAR, 46), MUTED)
    row = keys_row(1700)
    img.paste(row, ((1920 - row.width) // 2, 440))
    img.save(OUT / "gallery-1-overview-1920x960.png")


def gallery_deck():
    img = canvas()
    deck = Image.open(SRC / "deck.png").convert("RGB")
    h = 960
    deck = deck.resize((round(deck.width * h / deck.height), h), Image.LANCZOS)
    img.paste(deck, ((1920 - deck.width) // 2, 0))
    img.save(OUT / "gallery-2-deck-1920x960.png")


def gallery_features():
    img = canvas()
    d = ImageDraw.Draw(img)
    centered(d, 120, "Built for working with agents", font(BOLD, 88), FG)
    cols = [
        ("Press a key", "Focus that pane in Orca"),
        ("Hold a key", "Assign the current pane"),
        ("Local or SSH", "Panes on remote hosts too"),
    ]
    for i, (head, sub) in enumerate(cols):
        cx = 320 + i * 640
        for text, f, fill, y in ((head, font(BOLD, 60), FG, 690), (sub, font(REGULAR, 38), MUTED, 780)):
            w = d.textlength(text, font=f)
            d.text((cx - w / 2, y), text, font=f, fill=fill)
    row = keys_row(1500)
    img.paste(row, ((1920 - 1500) // 2, 320))
    img.save(OUT / "gallery-3-actions-1920x960.png")


if __name__ == "__main__":
    thumbnail(app_icon())
    gallery_hero()
    gallery_deck()
    gallery_features()
