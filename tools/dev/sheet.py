# Dev only: a contact sheet of flow screenshots. python3 tools/dev/sheet.py out.jpg a.jpg b.jpg ...
import sys
from PIL import Image
out, files = sys.argv[1], sys.argv[2:]
ims = [Image.open(f).convert('RGB') for f in files]
h = 640
ims = [im.resize((round(im.width * h / im.height), h)) for im in ims]
W = sum(im.width for im in ims) + 8 * (len(ims) - 1)
sheet = Image.new('RGB', (W, h), (40, 40, 40))
x = 0
for im in ims:
    sheet.paste(im, (x, 0)); x += im.width + 8
sheet.save(out, quality=72)
