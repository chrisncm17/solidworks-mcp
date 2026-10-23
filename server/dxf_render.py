# v3.9 picture of a DXF drawing (the DXF has no page image): geometry by line class, dimension graphics and texts on white.
# usage: python dxf_render.py <in.json {size_mm, segments:[[x1,y1,x2,y2,cls]], dimension_lines, words:[{text,bbox_mm}]}> <out.png> <width_px>
import sys, json
from PIL import Image, ImageDraw, ImageFont

src, out, width = sys.argv[1], sys.argv[2], int(sys.argv[3])
data = json.load(open(src, encoding='utf-8'))
W, H = data['size_mm']
s = width / max(W, 1e-6)
im = Image.new('RGB', (width, max(1, int(round(H * s)))), 'white')
dr = ImageDraw.Draw(im)
style = {'visible': ((0, 0, 0), 2), 'hidden': ((120, 120, 120), 1), 'center': ((0, 110, 0), 1), 'phantom': ((200, 0, 0), 2), 'dimension': ((0, 70, 200), 1)}
def seg(x, cls):
    col, w = style.get(cls, ((0, 0, 0), 1))
    dr.line([x[0] * s, x[1] * s, x[2] * s, x[3] * s], fill=col, width=w)
for x in data.get('dimension_lines', []):
    seg(x, 'dimension')
for x in data['segments']:
    seg(x, x[4])
fonts = {}
for w in data.get('words', []):
    b = w['bbox_mm']
    h = max(8, int((b[3] - b[1]) * s))
    if h not in fonts:
        try:
            fonts[h] = ImageFont.truetype('arial.ttf', h)
        except Exception:
            fonts[h] = ImageFont.load_default()
    dr.text((b[0] * s, b[1] * s), w['text'], fill=(0, 70, 200) if w.get('source') == 'DIMENSION' else (0, 0, 0), font=fonts[h])
im.save(out)
print(json.dumps({'path': out, 'size_px': im.size}))
