"""v3.6 analyze: grow each view region (found from its texts) to the drawing strokes connected to it, so views without
dimensions are not cut. Works on a downscaled, dilated black/white copy of the page render; ignores the sheet frame."""
import json, sys
from collections import deque
from PIL import Image, ImageFilter


def main(a):
    img = Image.open(a['image']).convert('L')
    W0, H0 = img.size
    f = 700.0 / W0
    small = img.resize((700, max(1, round(H0 * f))), Image.Resampling.BILINEAR).filter(ImageFilter.MinFilter(3))
    W, H = small.size
    px = small.load()
    dark = bytearray(W * H)
    for y in range(H):
        for x in range(W):
            if px[x, y] < 170:
                dark[y * W + x] = 1
    seen = bytearray(W * H)
    comps = []
    for start in range(W * H):
        if not dark[start] or seen[start]:
            continue
        q = deque([start]); seen[start] = 1
        x0 = x1 = start % W; y0 = y1 = start // W; n = 0
        while q:
            i = q.popleft(); n += 1
            x, y = i % W, i // W
            x0 = min(x0, x); x1 = max(x1, x); y0 = min(y0, y); y1 = max(y1, y)
            for j in (i - 1 if x > 0 else -1, i + 1 if x < W - 1 else -1, i - W, i + W):
                if 0 <= j < W * H and dark[j] and not seen[j]:
                    seen[j] = 1; q.append(j)
        # sheet frame / border: big AND touching the outer 4 % of the sheet (big geometry in the middle is kept)
        edge = x0 < 0.04 * W or y0 < 0.04 * H or x1 > 0.96 * W or y1 > 0.96 * H
        if edge and ((x1 - x0) > 0.6 * W or (y1 - y0) > 0.6 * H):
            continue
        comps.append((x0, y0, x1, y1))
    regs = [[r[0] * f, r[1] * f, r[2] * f, r[3] * f] for r in a['regions_px']]
    grown = [list(r) for r in regs]

    def overlap(c, r):
        w = min(c[2], r[2]) - max(c[0], r[0]); h = min(c[3], r[3]) - max(c[1], r[1])
        return max(0, w) * max(0, h)
    def gap(c, r):
        dx = max(r[0] - c[2], 0, c[0] - r[2]); dy = max(r[1] - c[3], 0, c[1] - r[3])
        return (dx * dx + dy * dy) ** 0.5
    near = 0.02 * W  # strokes not touching the text box but this close (about 8 mm on A3) still belong to the view
    for c in comps:
        if not regs:
            break
        areas = [overlap(c, r) for r in regs]
        best = max(range(len(regs)), key=lambda k: areas[k])
        if areas[best] <= 0:
            gaps = [gap(c, r) for r in regs]
            best = min(range(len(regs)), key=lambda k: gaps[k])
            if gaps[best] > near:
                continue
        g = grown[best]
        g[0] = min(g[0], c[0]); g[1] = min(g[1], c[1]); g[2] = max(g[2], c[2]); g[3] = max(g[3], c[3])
    pad = 6
    out = [[max(0, round((g[0] - pad) / f)), max(0, round((g[1] - pad) / f)), min(W0, round((g[2] + pad) / f)), min(H0, round((g[3] + pad) / f))] for g in grown]
    return dict(regions_px=out, components=len(comps))


try:
    print(json.dumps(main(json.loads(sys.argv[1]))))
except Exception as e:
    print(str(e), file=sys.stderr)
    sys.exit(1)
