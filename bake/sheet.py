# A comparison sheet from look.mjs's pictures: rows are views, columns are renderers.
#   /usr/bin/python3 bake/sheet.py <out.jpg> <scale> <view,...> <key=label,...>
import os, sys
from PIL import Image, ImageDraw

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
out, scale, views, cols = sys.argv[1], float(sys.argv[2]), sys.argv[3].split(','), [c.split('=', 1) for c in sys.argv[4].split(',')]
first = Image.open(os.path.join(ROOT, 'out', f'{views[0]}_{cols[0][0]}.png'))
w, h = int(first.width * scale), int(first.height * scale)
sheet = Image.new('RGB', (w * len(cols), (h + 18) * len(views)), (20, 20, 24))
d = ImageDraw.Draw(sheet)
for r, v in enumerate(views):
    for c, (k, label) in enumerate(cols):
        p = os.path.join(ROOT, 'out', f'{v}_{k}.png')
        if os.path.exists(p):
            sheet.paste(Image.open(p).convert('RGB').resize((w, h)), (c * w, r * (h + 18) + 18))
        d.text((c * w + 6, r * (h + 18) + 3), f'{v}: {label}', fill=(230, 230, 230))
sheet.save(os.path.join(ROOT, out), quality=90)
print(out, sheet.size)
