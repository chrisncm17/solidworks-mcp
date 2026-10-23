"""v3.6 analyze for photos/images: EXIF orientation (phone photos), gray, auto-contrast, sharpening, and overlapping tiles
zoomed for reading small numbers. Writes PNGs into the given output folder and prints JSON."""
import json, math, os, sys, uuid
from PIL import Image, ImageOps, ImageFilter


def ink_box(rgb):
    """v3.7: bounding box of the DRAWING (dark, unsaturated strokes), ignoring coloured slide decorations and logos.
    Rows/columns need a few ink pixels so isolated specks do not widen the box."""
    small = rgb.copy(); small.thumbnail((800, 800))
    hsv = small.convert('HSV'); W, H = small.size
    px = hsv.load()
    rows = [0] * H; cols = [0] * W
    for y in range(H):
        for x in range(W):
            h, s, v = px[x, y]
            if v < 150 and s < 70:
                rows[y] += 1; cols[x] += 1
    ys = [y for y in range(H) if rows[y] >= 2]; xs = [x for x in range(W) if cols[x] >= 2]
    if not ys or not xs:
        return None
    k = rgb.width / W
    pad = 12
    return (max(0, int((xs[0] - pad) * k)), max(0, int((ys[0] - pad) * k)), min(rgb.width, int((xs[-1] + pad) * k)), min(rgb.height, int((ys[-1] + pad) * k)))


def main(a):
    src = Image.open(a['path'])
    rgb = ImageOps.exif_transpose(src).convert('RGB')
    crop = None; uncropped = None
    if a.get('crop', True):
        crop = ink_box(rgb)
        # only crop when it removes a meaningful margin (slides with logos/bands), never a tiny sliver
        if crop and (crop[2] - crop[0]) * (crop[3] - crop[1]) < 0.85 * rgb.width * rgb.height:
            # v3.7 review: light or coloured notes outside the black ink may be cut; the uncropped page is kept too
            uncropped = os.path.join(a['out'], f'{uuid.uuid4()}_completa.png')
            whole = rgb.copy(); whole.thumbnail((2400, 2400)); whole.save(uncropped, 'PNG')
            rgb = rgb.crop(crop)
        else:
            crop = None
    img = rgb.convert('L')
    img = ImageOps.autocontrast(img, cutoff=1)
    img = img.filter(ImageFilter.UnsharpMask(radius=2, percent=120, threshold=3))
    width = int(a.get('width', 1400))
    full_w = min(2400, max(width, img.width))
    full = img.resize((full_w, max(1, round(full_w * img.height / img.width))), Image.Resampling.LANCZOS) if img.width > full_w else img
    out = a['out']
    enhanced = os.path.join(out, f'{uuid.uuid4()}.png')
    full.save(enhanced, 'PNG')
    # tiles: 0 = automatic (2x2 for normal photos, 3x3 for big ones)
    n = int(a.get('tiles') or 0) or (3 if img.width * img.height > 8e6 else 2)
    ov = 0.08
    tw, th = img.width / n, img.height / n
    tiles = []
    for r in range(n):
        for c in range(n):
            box = (max(0, round(c * tw - ov * tw)), max(0, round(r * th - ov * th)), min(img.width, round((c + 1) * tw + ov * tw)), min(img.height, round((r + 1) * th + ov * th)))
            t = img.crop(box)
            t = t.resize((width, max(1, round(width * t.height / t.width))), Image.Resampling.LANCZOS)
            p = os.path.join(out, f'{uuid.uuid4()}.png')
            t.save(p, 'PNG')
            tiles.append(dict(row=r + 1, col=c + 1, region_px=list(box), image=p))
    return dict(path=a['path'], size_px=[img.width, img.height], enhanced=enhanced, tiles=tiles, drawing_crop_px=list(crop) if crop else None, uncropped=uncropped,
                rotated_by_exif=src.size != ImageOps.exif_transpose(src).size)


try:
    print(json.dumps(main(json.loads(sys.argv[1])), ensure_ascii=True))
except Exception as e:
    print(str(e), file=sys.stderr)
    sys.exit(1)
