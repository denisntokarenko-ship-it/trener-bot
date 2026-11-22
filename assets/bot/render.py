"""SVG -> PNG 640x640 і JPG 640x640 (Bot API setMyProfilePhoto приймає лише JPG).

Запуск із кореня репозиторію (потрібні `pip install resvg-py pillow`, лише для перегенерації):
    python assets/bot/render.py
Усі форми в SVG - контури, без шрифтів: результат не залежить від системи.
"""
import io
from pathlib import Path

import resvg_py
from PIL import Image

HERE = Path(__file__).parent
for name in ("prod", "preview"):
    png = bytes(resvg_py.svg_to_bytes(svg_path=str(HERE / f"{name}.svg"), width=640, height=640))
    (HERE / f"{name}.png").write_bytes(png)
    img = Image.open(io.BytesIO(png)).convert("RGB")
    img.save(HERE / f"{name}.jpg", "JPEG", quality=92, optimize=True)
    print(name, img.size)
