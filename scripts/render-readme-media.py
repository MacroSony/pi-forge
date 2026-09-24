#!/usr/bin/env python3
"""Package reviewed browser stills and a two-state GIF; requires Pillow.
Usage: python3 scripts/render-readme-media.py CAPTURE_DIR OUTPUT_DIR
"""
import sys
from pathlib import Path
from shutil import copyfile
from PIL import Image, ImageChops

source, target = map(Path, sys.argv[1:3])
for locale in ("en", "zh-CN"):
    directory = target / locale
    directory.mkdir(parents=True, exist_ok=True)
    for name in ("editor-overview.png", "draft-diff.png"):
        copyfile(source / locale / name, directory / name)
    # Both settled states have an unsaved draft, so the loop changes only the
    # slot's enabled state and its compiled output, not unrelated save chrome.
    images = [Image.open(source / locale / name).convert("RGB")
              for name in ("toggle-on-return.png", "toggle-off.png")]
    assert images[0].size == images[1].size
    width, height = images[0].size
    combined = Image.new("RGB", (width * 2, height))
    for index, image in enumerate(images):
        combined.paste(image, (width * index, 0))
    palette = combined.quantize(colors=256)
    frames = [image.quantize(palette=palette, dither=Image.Dither.NONE) for image in images]
    path = directory / "context-toggle.gif"
    frames[0].save(path, save_all=True, append_images=frames[1:], duration=[2500, 2500],
                   loop=0, disposal=2, optimize=True)
    with Image.open(path) as gif:
        assert gif.n_frames == 2 and gif.info["loop"] == 0
        assert gif.size == (1440, 900)
        for index, frame in enumerate(frames):
            gif.seek(index)
            assert gif.info["duration"] == 2500
            assert ImageChops.difference(gif.convert("RGB"), frame.convert("RGB")).getbbox() is None
    print(locale, "two settled UI states / 5-second loop", path.stat().st_size, "bytes")
