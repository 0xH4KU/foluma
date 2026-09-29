import shutil
import subprocess
from pathlib import Path

from PIL import Image, ImageDraw

root = Path(__file__).resolve().parents[1] / "src-tauri" / "icons"
root.mkdir(exist_ok=True)
image = Image.new("RGBA", (1024, 1024))
draw = ImageDraw.Draw(image)
draw.rounded_rectangle((36, 36, 988, 988), 218, fill="#153f39")
draw.rounded_rectangle((245, 213, 713, 811), 34, fill="#f6f4e9")
draw.rounded_rectangle((319, 288, 786, 885), 34, fill="#b8cec3")
draw.rectangle((402, 384, 486, 759), fill="#153f39")
draw.rectangle((447, 384, 699, 466), fill="#153f39")
draw.rectangle((447, 533, 648, 609), fill="#153f39")
image.save(root / "icon.png")
image.save(root / "icon.ico", sizes=[(16, 16), (32, 32), (48, 48), (256, 256)])
iconset = root / "icon.iconset"
iconset.mkdir(exist_ok=True)
for size in (16, 32, 128, 256, 512):
    for scale in (1, 2):
        suffix = "@2x" if scale == 2 else ""
        image.resize((size * scale, size * scale), Image.Resampling.LANCZOS).save(
            iconset / f"icon_{size}x{size}{suffix}.png"
        )
subprocess.run(["iconutil", "-c", "icns", str(iconset)], check=True)
shutil.rmtree(iconset)
