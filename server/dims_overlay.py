# v3.8 annotated drawing: every linear dimension drawn in colour between the two points it measures, with its value,
# and every view box numbered. usage: python dims_overlay.py <page.png> <out.png> <json {size_mm, views, dimensions}>
import sys, json
from PIL import Image, ImageDraw, ImageFont

src, out, data = sys.argv[1], sys.argv[2], json.loads(sys.argv[3])
im = Image.open(src).convert('RGB')
W, H = im.size
sx, sy = W / data['size_mm'][0], H / data['size_mm'][1]
dr = ImageDraw.Draw(im)
try:
    font = ImageFont.truetype('arialbd.ttf', max(14, W // 110))
    small = ImageFont.truetype('arial.ttf', max(12, W // 140))
except Exception:
    font = small = ImageFont.load_default()
P = lambda p: (p[0] * sx, p[1] * sy)
for v in data['views']:
    b = v['box_mm']
    dr.rectangle([b[0] * sx - 6, b[1] * sy - 6, b[2] * sx + 6, b[3] * sy + 6], outline=(0, 150, 0), width=2)
    dr.text((b[0] * sx - 4, b[1] * sy - 6 - font.size), 'VISTA %d' % v['id'], fill=(0, 140, 0), font=font)
colors = [(220, 0, 0), (255, 120, 0), (180, 0, 180), (0, 120, 220), (0, 160, 160), (120, 60, 0)]
k = 0
for d in data['dimensions']:
    if 'vertex_mm' in d:
        import math
        c = colors[k % len(colors)]; k += 1
        p = P(d['vertex_mm'])
        for ang in d['rays_deg']:
            q = (p[0] + 25 * sx * math.cos(math.radians(ang)), p[1] - 25 * sy * math.sin(math.radians(ang)))
            dr.line([p, q], fill=c, width=3)
        dr.ellipse([p[0] - 6, p[1] - 6, p[0] + 6, p[1] + 6], outline=c, width=3)
        dr.text((p[0] + 8, p[1] + 4), d['raw'], fill=c, font=small)
        continue
    if 'center_mm' in d:
        c = colors[k % len(colors)]; k += 1
        p, rr = P(d['center_mm']), d['sheet_radius_mm'] * sx
        dr.ellipse([p[0] - rr, p[1] - rr, p[0] + rr, p[1] + rr], outline=c, width=3)
        dr.line([p[0] - 6, p[1], p[0] + 6, p[1]], fill=c, width=2); dr.line([p[0], p[1] - 6, p[0], p[1] + 6], fill=c, width=2)
        dr.text((p[0] + rr + 4, p[1] - small.size), d['raw'], fill=c, font=small)
        continue
    if 'from_mm' not in d:
        continue
    c = colors[k % len(colors)]; k += 1
    a, b = P(d['from_mm']), P(d['to_mm'])
    # draw the measurement along its axis (the two feet can be at different heights), thin connector to the true foot
    b2 = (b[0], a[1]) if d.get('direction') == 'horizontal' else (a[0], b[1]) if d.get('direction') == 'vertical' else b
    dr.line([a, b2], fill=c, width=3)
    if b2 != b: dr.line([b2, b], fill=c, width=1)
    for p in (a, b):
        dr.ellipse([p[0] - 6, p[1] - 6, p[0] + 6, p[1] + 6], outline=c, width=3)
    m = ((a[0] + b2[0]) / 2, (a[1] + b2[1]) / 2)
    label = '%s %s' % (d['raw'], 'H' if d.get('direction') == 'horizontal' else 'V' if d.get('direction') == 'vertical' else '')
    tw = dr.textlength(label, font=small)
    dr.rectangle([m[0] + 4, m[1] - small.size - 2, m[0] + 8 + tw, m[1] + 2], fill=(255, 255, 255))
    dr.text((m[0] + 6, m[1] - small.size - 1), label, fill=c, font=small)
# the image goes back to the chat: 1800 px wide is still readable and costs a fraction of the tokens of the 3000 px render
if im.size[0] > 1800:
    im = im.resize((1800, round(im.size[1] * 1800 / im.size[0])), Image.LANCZOS)
im.save(out, optimize=True)
print(out)
