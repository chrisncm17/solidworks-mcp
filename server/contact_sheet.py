"""v3.7: contact sheets (hojas de contacto) - many page thumbnails with their page number on a few images, so a long
scanned PDF (a slide deck of exercises) can be surveyed in one look. Prints JSON with the sheet paths and the pages on each."""
import json, os, sys, uuid
from PIL import Image, ImageDraw, ImageOps


def main(a):
    pages = a['pages']  # [{page, path}]
    cols, rows = int(a.get('cols', 4)), int(a.get('rows', 3))
    cell_w = int(a.get('cell_w', 600))
    sheets = []
    per = cols * rows
    for s in range(0, len(pages), per):
        chunk = pages[s:s + per]
        thumbs = []
        for p in chunk:
            im = Image.open(p['path']).convert('RGB')
            im = ImageOps.contain(im, (cell_w, int(cell_w * 0.78)))
            thumbs.append((p['page'], im))
        cell_h = max(t[1].height for t in thumbs) + 34
        sheet = Image.new('RGB', (cols * (cell_w + 10) + 10, rows * (cell_h + 10) + 10), 'white')
        d = ImageDraw.Draw(sheet)
        for k, (num, im) in enumerate(thumbs):
            x = 10 + (k % cols) * (cell_w + 10); y = 10 + (k // cols) * (cell_h + 10)
            sheet.paste(im, (x, y + 30))
            d.rectangle([x, y, x + 150, y + 26], fill=(20, 60, 160))
            d.text((x + 8, y + 6), f'Pagina {num}', fill='white')
            d.rectangle([x, y + 30, x + im.width, y + 30 + im.height], outline=(150, 150, 150))
        path = os.path.join(a['out'], f'contacto_{uuid.uuid4().hex[:8]}_{chunk[0]["page"]}-{chunk[-1]["page"]}.png')
        sheet.save(path, 'PNG')
        sheets.append(dict(path=path, pages=[c['page'] for c in chunk]))
    return dict(sheets=sheets)


try:
    print(json.dumps(main(json.loads(sys.argv[1]))))
except Exception as e:
    print(str(e), file=sys.stderr)
    sys.exit(1)
