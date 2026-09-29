"""Small reproducible PDF for manual app checks; no external sample files needed."""

import io
from pathlib import Path

import pymupdf as fitz
from PIL import Image, ImageDraw, ImageFont

root = Path(__file__).resolve().parents[1] / "artifacts"
root.mkdir(exist_ok=True)
with fitz.open() as document:
    for index in range(1, 9):
        width, height = (1200, 800) if index == 4 else (600, 800)
        image = Image.new("RGB", (width, height), "#f5f4ef")
        draw = ImageDraw.Draw(image)
        title = ImageFont.load_default(size=30)
        small = ImageFont.load_default(size=15)
        draw.text((35, 30), "FOLUMA / REFERENCE", fill="#222a34", font=title)
        draw.text((35, 76), "IMAGE-BASED PDF     /     EDITOR TEST DOCUMENT", fill="#727b86", font=small)
        draw.line((35, 115, width - 35, 115), fill="#222a34", width=2)
        for row in range(2):
            for col in range(2):
                x = 35 + col * (width - 60) // 2
                y = 150 + row * 280
                right = x + (width - 90) // 2
                draw.rectangle((x, y, right, y + 250), outline="#222a34", width=3)
                draw.line((x, y + 250, right, y), fill="#aab4be", width=2)
                draw.ellipse((x + 35, y + 40, right - 35, y + 200), outline="#5d6977", width=3)
                draw.text((x + 12, y + 12), f"{index}.{row * 2 + col + 1}", fill="#222a34", font=small)
        draw.text((35, 751), f"PAGE {index:02d}     /     LOSSLESS SOURCE IMAGE", fill="#586675", font=small)
        buffer = io.BytesIO()
        image.save(buffer, "JPEG", quality=95)
        page = document.new_page(width=width, height=height)
        xref = page.insert_image(page.rect, stream=buffer.getvalue())
        document.xref_set_key(xref, "ColorSpace", "/DeviceRGB")
    document.save(root / "Foluma-reference.pdf")
print(root / "Foluma-reference.pdf")
