"""Local evidence extraction. Coordinates: displayed crop box, top-left, mm.
Glyph boxes are estimates, not OCR or a measurement of the physical part.
"""
import sys, json, math, re, os

MM = 25.4 / 72

def main(a):
    if a.get('output'):
        allowed=os.path.realpath(os.path.join(os.path.dirname(__file__),'generated','drawing_read'))
        if os.path.normcase(os.path.dirname(os.path.realpath(a['output'])))!=os.path.normcase(allowed) or not a['output'].lower().endswith('.png'):
            raise ValueError('Salida permitida solo en generated/drawing_read/*.png')
    pdf = a['pdf']
    page_number = a.get('page', 1)
    if pdf:
        from pypdf import PdfReader
        reader = PdfReader(a['path'])
        if reader.is_encrypted and not reader.decrypt(''):
            raise ValueError('PDF cifrado: requiere contraseña')
        if page_number > len(reader.pages):
            raise ValueError('Página fuera de rango')
        pages = []
        for n, p in enumerate(reader.pages):
            box = p.cropbox
            w, h = float(box.width), float(box.height)
            if p.rotation % 180: w, h = h, w
            unit = float(p.get('/UserUnit', 1))
            def has_image(resources, seen):
                if not resources: return False
                resources = resources.get_object()
                for ref in resources.get('/XObject', {}).get_object().values() if '/XObject' in resources else []:
                    obj = ref.get_object()
                    if id(obj) in seen: continue
                    seen.add(id(obj))
                    if obj.get('/Subtype') == '/Image': return True
                    if obj.get('/Subtype') == '/Form' and has_image(obj.get('/Resources'), seen): return True
                return False
            pages.append(dict(page=n+1, size_mm=[w*MM*unit,h*MM*unit], has_images=has_image(p.get('/Resources'),set())))
        p = reader.pages[page_number-1]
        size = pages[page_number-1]['size_mm']
        if a['action'] == 'info': return dict(path=a['path'], page_count=len(pages), pages=pages)
    else:
        from PIL import Image, ImageDraw
        image = Image.open(a['path'])
        count = getattr(image, 'n_frames', 1)
        if page_number > count: raise ValueError('Página/frame fuera de rango')
        image.seek(page_number-1)
        dpi = image.info.get('dpi')
        if dpi and (len(dpi)<2 or min(dpi)<=0): dpi=None
        if a['action'] == 'info':
            frames=[]
            for n in range(count):
                image.seek(n)
                d=image.info.get('dpi')
                frames.append(dict(page=n+1,width_px=image.width,height_px=image.height,dpi=d,
                                   size_mm=[image.width*25.4/d[0],image.height*25.4/d[1]] if d and min(d)>0 else None,kind='raster'))
            return dict(path=a['path'],page_count=count,pages=frames)
        size = list(image.size)
    if a['action']=='text':
        # Flatten inherited page rotation so extraction and WinRT render share axes.
        if p.rotation: p.transfer_rotation_to_content()
        box=p.cropbox
        unit=float(p.get('/UserUnit',1))
        factor=MM*unit
        words=[]
        def visitor(text, cm, tm, font, font_size):
            if not text.strip(): return
            # PDF text matrix followed by current transformation matrix.
            def transform(x,y):
                tx=x*tm[0]+y*tm[2]+tm[4]; ty=x*tm[1]+y*tm[3]+tm[5]
                return ((tx*cm[0]+ty*cm[2]+cm[4]-float(box.left))*factor,
                        (float(box.top)-(tx*cm[1]+ty*cm[3]+cm[5]))*factor)
            origin=transform(0,0); axis=transform(1,0)
            angle=math.degrees(math.atan2(-(axis[1]-origin[1]),axis[0]-origin[0]))
            widths=font.get('/Widths') if font else None
            first=int(font.get('/FirstChar',0)) if font else 0
            # Composite fonts need character-code/CMap mapping: do not treat Unicode as glyph IDs.
            widths=widths if font and font.get('/Subtype')!='/Type0' else None
            def advance(s):
                return sum(float(widths[ord(c)-first])/1000*font_size if widths and 0<=ord(c)-first<len(widths) else font_size*0.5 for c in s)
            for match in re.finditer(r'\S+',text):
                x=advance(text[:match.start()]); width=advance(match.group())
                corners=[transform(x,-font_size*.2),transform(x+width,-font_size*.2),transform(x,font_size*.8),transform(x+width,font_size*.8)]
                bbox=[min(c[0] for c in corners),min(c[1] for c in corners),max(c[0] for c in corners),max(c[1] for c in corners)]
                words.append(dict(text=match.group(),bbox_mm=bbox,angle_deg=angle,
                                  font_size_mm=math.dist(transform(0,0),transform(0,font_size)),bbox_estimated=True))
        p.extract_text(visitor_text=visitor)
        region=a.get('region_mm')
        if region:
            if region[2]>size[0]+.01 or region[3]>size[1]+.01: raise ValueError('region_mm fuera de página')
            words=[w for w in words if w['bbox_mm'][2]>=region[0] and w['bbox_mm'][0]<=region[2] and w['bbox_mm'][3]>=region[1] and w['bbox_mm'][1]<=region[3]]
        return dict(path=a['path'],page=page_number,size_mm=size,origin='top-left',coordinate_units='mm',region_mm=region or [0,0,*size],words=words,
                    warnings=['SolidWorks dibuja los s\u00edmbolos \u00d8, \u21a7 (profundidad) y \u2334 (caja) como l\u00edneas, no como texto: aqu\u00ed solo sale el n\u00famero (un \u00d88 aparece como 8.00 y kind linear). Confirma el s\u00edmbolo con action render.','Cajas de glifos estimadas; anchos de fuente cuando están disponibles, fallback 0.5 em. Verificar visualmente símbolos/codificaciones y cotas; las coordenadas son de la hoja, no de la pieza.'])
    region=a.get('region_mm' if pdf else 'region_px') or [0,0,*size]
    if region[2]>size[0]+.01 or region[3]>size[1]+.01: raise ValueError('Región fuera de página/imagen')
    if pdf:
        from PIL import Image, ImageDraw
        image=Image.open(a['output']).convert('RGB')
        # WinRT can apply the Windows display DPI factor to DestinationWidth.
        width=a.get('width_px',1600)
        height=max(1,round(width*image.height/image.width))
        if height>12000: raise ValueError('Recorte demasiado alto')
        if image.width!=width: image=image.resize((width,height),Image.Resampling.LANCZOS)
    else:
        image=image.convert('RGB').crop(tuple(region))
        width=a.get('width_px',1600)
        height=max(1,round(width*image.height/image.width))
        if height>12000: raise ValueError('Recorte demasiado alto; reduce width_px o la región')
        image=image.resize((width,height),Image.Resampling.LANCZOS)
    sx=image.width/(region[2]-region[0]); sy=image.height/(region[3]-region[1])
    if a.get('grid'):
        draw=ImageDraw.Draw(image)
        desired=(region[2]-region[0])/8
        step=10**math.floor(math.log10(desired))
        step*=next(v for v in [1,2,5,10] if v*step>=desired)
        for axis in [0,1]:
            start=math.ceil(region[axis]/step)*step
            for i in range(100):
                value=start+i*step
                if value>region[axis+2]: break
                pos=round((value-region[axis])*(sx if axis==0 else sy))
                line=(pos,0,pos,image.height) if axis==0 else (0,pos,image.width,pos)
                draw.line(line,fill=(70,150,220),width=1)
                xy=(pos+2,2) if axis==0 else (2,pos+2)
                label=f'{value:g} '+('mm' if pdf else 'px')
                draw.rectangle(draw.textbbox(xy,label),fill='white')
                draw.text(xy,label,fill='blue')
    image.save(a['output'],'PNG')
    return dict(path=a['output'],page=page_number,width_px=image.width,height_px=image.height,
                **{'region_mm' if pdf else 'region_px':region},px_per_mm=sx if pdf else None,
                px_per_unit=[sx,sy],grid=bool(a.get('grid')),origin='top-left')

try:
    print(json.dumps(main(json.loads(sys.argv[1])),ensure_ascii=True))
except Exception as e:
    print(str(e),file=sys.stderr)
    sys.exit(1)
