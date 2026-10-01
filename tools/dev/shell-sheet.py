# Dev only: contact sheets of shell screenshots for review.
#   python3 tools/dev/shell-sheet.py 390x844 intro form rewind   → .cache/dev/shell/sheet-<vp>-<first>.png
import sys, os
from PIL import Image
root = os.path.join(os.path.dirname(__file__), '..', '..', '.cache', 'dev', 'shell')
vp, names = sys.argv[1], sys.argv[2:]
w, h = map(int, vp.split('x'))
col = 480 if w >= 960 else 400
scale = col / w
tiles = []
for n in names:
    p = os.path.join(root, vp, n + '.png')
    if not os.path.exists(p):
        continue
    im = Image.open(p).convert('RGB')
    tiles.append(im.resize((col, round(h * scale)), Image.LANCZOS))
per = 2 if w >= 960 else 3
rows = (len(tiles) + per - 1) // per
sheet = Image.new('RGB', (per * col + (per - 1) * 8, rows * round(h * scale) + (rows - 1) * 8), (60, 60, 60))
for i, t in enumerate(tiles):
    sheet.paste(t, ((i % per) * (col + 8), (i // per) * (round(h * scale) + 8)))
out = os.path.join(root, f'sheet-{vp}-{names[0]}.png')
sheet.save(out)
print(out)
