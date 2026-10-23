# v3.8 vector geometry of a PDF page (what the drawing really draws): straight segments in mm, origin top-left like the words
# of drawing_read.py. Used to find, for every dimension text, its dimension line and the two extension lines (what it measures).
# usage: python pdf_lines.py <pdf> <page 1-based>  -> JSON {size_mm, segments:[[x1,y1,x2,y2,width_mm]], filled:[[x,y,w,h]]}
import sys, json, math
from pypdf import PdfReader
from pypdf.generic import ContentStream

PT = 25.4 / 72

def mul(a, b):  # 2D affine [a b c d e f] composition: a then b
    return [a[0]*b[0] + a[1]*b[2], a[0]*b[1] + a[1]*b[3], a[2]*b[0] + a[3]*b[2], a[2]*b[1] + a[3]*b[3],
            a[4]*b[0] + a[5]*b[2] + b[4], a[4]*b[1] + a[5]*b[3] + b[5]]

def main(path, page_no):
    reader = PdfReader(path)
    page = reader.pages[page_no - 1]
    # Codex review: exactly the normalisation drawing_read.py uses for the words (rotation flattened, CropBox, UserUnit)
    if page.rotation: page.transfer_rotation_to_content()
    box = page.cropbox
    U = float(page.get('/UserUnit', 1))
    W, H = float(box.width), float(box.height)
    x0, y0 = float(box.left), float(box.bottom)
    PTU = PT * U
    segs, fills, arcs = [], [], []
    def walk(content, ctm0, resources, depth):
        ctm = ctm0[:]; stack = []; path = []; cur = None; start = None; lw = 1.0
        ops = ContentStream(content, reader).operations
        for operands, op in ops:
            o = op.decode('latin-1') if isinstance(op, bytes) else op
            if o == 'q': stack.append((ctm[:], lw))
            elif o == 'Q':
                if stack: ctm, lw = stack.pop()
            elif o == 'cm': ctm = mul([float(v) for v in operands], ctm)
            elif o == 'w': lw = float(operands[0])
            elif o == 'm': cur = start = (float(operands[0]), float(operands[1])); path.append(('m', cur))
            elif o == 'l':
                p = (float(operands[0]), float(operands[1])); path.append(('l', cur, p)); cur = p
            elif o == 'c':
                q = [float(v) for v in operands]; p = (q[4], q[5]); path.append(('c', cur, (q[0], q[1]), (q[2], q[3]), p)); cur = p
            elif o == 'v':
                q = [float(v) for v in operands]; p = (q[2], q[3]); path.append(('c', cur, cur, (q[0], q[1]), p)); cur = p
            elif o == 'y':
                q = [float(v) for v in operands]; p = (q[2], q[3]); path.append(('c', cur, (q[0], q[1]), p, p)); cur = p
            elif o == 're':
                x, y, w, h = [float(v) for v in operands]; path.append(('re', (x, y, w, h)))
            elif o == 'h':
                if cur and start: path.append(('l', cur, start)); cur = start
            elif o in ('S', 's', 'f', 'F', 'f*', 'B', 'B*', 'b', 'b*', 'n'):
                stroke = o in ('S', 's', 'B', 'B*', 'b', 'b*'); fill = o in ('f', 'F', 'f*', 'B', 'B*', 'b', 'b*')
                scale = math.sqrt(abs(ctm[0] * ctm[3] - ctm[1] * ctm[2])) or 1
                pts_all = []
                for it in path:
                    if it[0] == 'l' and it[1] is not None:
                        (ax, ay), (bx, by) = it[1], it[2]
                        A = (ax * ctm[0] + ay * ctm[2] + ctm[4], ax * ctm[1] + ay * ctm[3] + ctm[5])
                        B = (bx * ctm[0] + by * ctm[2] + ctm[4], bx * ctm[1] + by * ctm[3] + ctm[5])
                        pts_all += [A, B]
                        if stroke: segs.append([(A[0] - x0) * PTU, (H - (A[1] - y0)) * PTU, (B[0] - x0) * PTU, (H - (B[1] - y0)) * PTU, lw * scale * PTU, 0])
                    elif it[0] == 're':
                        x, y, w, h = it[1]
                        cs = [(x, y), (x + w, y), (x + w, y + h), (x, y + h)]
                        T = [(px * ctm[0] + py * ctm[2] + ctm[4], px * ctm[1] + py * ctm[3] + ctm[5]) for px, py in cs]
                        pts_all += T
                        if stroke:
                            for k in range(4):
                                A, B = T[k], T[(k + 1) % 4]
                                segs.append([(A[0] - x0) * PTU, (H - (A[1] - y0)) * PTU, (B[0] - x0) * PTU, (H - (B[1] - y0)) * PTU, lw * scale * PTU, 0])
                    elif it[0] == 'c' and it[1] is not None:
                        # Bezier in 8 straight pieces, flagged 1: they count for the views (a round view has no straight line)
                        # but never as dimension or extension lines
                        P0, P1, P2, P3 = it[1], it[2], it[3], it[4]
                        bz = [tuple((1-t)**3*P0[k] + 3*(1-t)**2*t*P1[k] + 3*(1-t)*t*t*P2[k] + t**3*P3[k] for k in (0, 1)) for t in [i / 8 for i in range(9)]]
                        T = [(px * ctm[0] + py * ctm[2] + ctm[4], px * ctm[1] + py * ctm[3] + ctm[5]) for px, py in bz]
                        pts_all += T
                        if stroke:
                            for k in range(8):
                                A, B = T[k], T[k + 1]
                                segs.append([(A[0] - x0) * PTU, (H - (A[1] - y0)) * PTU, (B[0] - x0) * PTU, (H - (B[1] - y0)) * PTU, lw * scale * PTU, 1])
                            q = [((p[0] - x0) * PTU, (H - (p[1] - y0)) * PTU) for p in (T[0], T[4], T[8])]
                            (ax, ay), (bx, by), (cx, cy) = q
                            dd = 2 * (ax * (by - cy) + bx * (cy - ay) + cx * (ay - by))
                            if abs(dd) > 1e-9:
                                ux = ((ax*ax + ay*ay) * (by - cy) + (bx*bx + by*by) * (cy - ay) + (cx*cx + cy*cy) * (ay - by)) / dd
                                uy = ((ax*ax + ay*ay) * (cx - bx) + (bx*bx + by*by) * (ax - cx) + (cx*cx + cy*cy) * (bx - ax)) / dd
                                arcs.append([ux, uy, math.hypot(ax - ux, ay - uy), lw * scale * PTU])
                if fill and pts_all:
                    xs = [(p[0] - x0) * PTU for p in pts_all]; ys = [(H - (p[1] - y0)) * PTU for p in pts_all]
                    fills.append([min(xs), min(ys), max(xs) - min(xs), max(ys) - min(ys)])
                path = []; cur = None
            elif o == 'Do' and depth < 4:
                try:
                    xo = resources['/XObject'][operands[0]].get_object()
                    if xo.get('/Subtype') == '/Form':
                        m = [float(v) for v in xo.get('/Matrix', [1, 0, 0, 1, 0, 0])]
                        walk(xo, mul(m, ctm), xo.get('/Resources', resources), depth + 1)
                except Exception:
                    pass
    walk(page.get_contents(), [1, 0, 0, 1, 0, 0], page.get('/Resources', {}), 0)
    segs = [s for s in segs if math.hypot(s[2] - s[0], s[3] - s[1]) > (0.005 if s[5] else 0.05)]
    print(json.dumps({'size_mm': [W * PTU, H * PTU], 'segments': [[round(v, 3) for v in s] for s in segs], 'filled': [[round(v, 3) for v in f] for f in fills], 'arcs': [[round(v, 3) for v in a] for a in arcs]}))

if __name__ == '__main__':
    main(sys.argv[1], int(sys.argv[2]))
