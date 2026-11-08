"""Gera logos e ícones do DiakoPlayer a partir de brand/logo-diakonia.pdf.

Requer: pip install pymupdf pillow
Uso:    python scripts/make-brand.py
"""
from pathlib import Path

import pymupdf
from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
PDF = ROOT / "brand" / "logo-diakonia.pdf"

SCALE = 2  # renderiza a 2x (o PDF guarda a arte em 1605x455 px)
# Recortes na renderização 2x: o logo completo e só o símbolo (livro aberto).
FULL_BOX = (171, 175, 3082, 739)
SYMBOL_BOX = (171, 175, 1283, 739)

BG = (17, 20, 24)          # #111418 — fundo do tema "Palco"
AMBER = (245, 165, 36)     # #f5a524 — destaque
LIGHT = (244, 245, 247)    # #f4f5f7 — texto claro
DARK = (74, 74, 68)        # cinza original do logo


def render_gray() -> Image.Image:
    page = pymupdf.open(PDF)[0]
    pix = page.get_pixmap(matrix=pymupdf.Matrix(SCALE, SCALE), alpha=False)
    return Image.frombytes("RGB", (pix.width, pix.height), pix.samples).convert("L")


def to_alpha(gray: Image.Image) -> Image.Image:
    """Fundo branco -> transparente; traço escuro -> opaco (com antisserrilhado)."""
    lo, hi = 80, 245
    return gray.point(lambda v: 0 if v >= hi else 255 if v <= lo else int((hi - v) * 255 / (hi - lo)))


def tinted(alpha: Image.Image, color, pad=0) -> Image.Image:
    img = Image.new("RGBA", alpha.size, color + (0,))
    img.putalpha(alpha)
    if pad:
        out = Image.new("RGBA", (img.width + 2 * pad, img.height + 2 * pad), color + (0,))
        out.paste(img, (pad, pad))
        img = out
    return img


def fit_width(img: Image.Image, width: int) -> Image.Image:
    return img.resize((width, round(img.height * width / img.width)), Image.LANCZOS)


def app_icon(symbol_alpha: Image.Image, size: int, maskable=False) -> Image.Image:
    """Quadrado arredondado escuro com o livro em âmbar no centro."""
    ss = 4  # supersampling para bordas suaves
    big = size * ss
    canvas = Image.new("RGBA", (big, big), (0, 0, 0, 0))
    draw = ImageDraw.Draw(canvas)
    if maskable:
        draw.rectangle((0, 0, big, big), fill=BG + (255,))
        box_w = big * 0.58  # zona segura do ícone adaptável
    else:
        inset = round(big * 0.04)
        draw.rounded_rectangle((inset, inset, big - inset, big - inset), radius=round(big * 0.22), fill=BG + (255,))
        box_w = big * 0.74
    sym = tinted(symbol_alpha, AMBER)
    sym = sym.resize((round(box_w), round(sym.height * box_w / sym.width)), Image.LANCZOS)
    canvas.alpha_composite(sym, ((big - sym.width) // 2, (big - sym.height) // 2 + round(big * 0.02)))
    return canvas.resize((size, size), Image.LANCZOS)


def save(img: Image.Image, rel: str):
    path = ROOT / rel
    path.parent.mkdir(parents=True, exist_ok=True)
    img.save(path, optimize=True)
    print("ok", rel, img.size)


def main():
    gray = render_gray()
    full = to_alpha(gray.crop(FULL_BOX))
    symbol = to_alpha(gray.crop(SYMBOL_BOX))

    # Arquivos de marca (alta resolução, fundo transparente)
    save(tinted(full, DARK, pad=40), "brand/logo-escuro.png")
    save(tinted(full, LIGHT, pad=40), "brand/logo-claro.png")
    save(tinted(symbol, DARK, pad=24), "brand/simbolo-escuro.png")
    save(tinted(symbol, LIGHT, pad=24), "brand/simbolo-claro.png")
    save(tinted(symbol, AMBER, pad=24), "brand/simbolo-ambar.png")

    # Controle web / APK
    save(fit_width(tinted(full, LIGHT), 720), "web/brand/logo-claro.png")
    save(fit_width(tinted(symbol, LIGHT), 160), "web/brand/simbolo-claro.png")
    save(fit_width(tinted(symbol, AMBER), 160), "web/brand/simbolo-ambar.png")
    save(app_icon(symbol, 192), "web/icons/icon-192.png")
    save(app_icon(symbol, 512), "web/icons/icon-512.png")
    save(app_icon(symbol, 512, maskable=True), "web/icons/icon-maskable-512.png")
    save(app_icon(symbol, 64), "web/icons/favicon-64.png")

    # Desktop (Electron)
    save(app_icon(symbol, 512), "desktop/build/icon.png")
    save(app_icon(symbol, 256), "desktop/assets/icon.png")
    save(app_icon(symbol, 32), "desktop/assets/tray.png")
    save(fit_width(tinted(full, LIGHT), 720), "desktop/assets/logo-claro.png")

    # Android
    for dpi, s in {"mdpi": 48, "hdpi": 72, "xhdpi": 96, "xxhdpi": 144, "xxxhdpi": 192}.items():
        save(app_icon(symbol, s), f"android/app/src/main/res/mipmap-{dpi}/ic_launcher.png")


if __name__ == "__main__":
    main()
