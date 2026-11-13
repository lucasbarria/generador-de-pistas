# Auditoría de un .kn5 de pista contra los límites y convenciones de Assetto Corsa
# Uso: python3 tools/kn5_auditoria.py pista.kn5 [data/surfaces.ini]
import struct, sys, collections, math, re, json
kn5 = sys.argv[1]; surf_ini = sys.argv[2] if len(sys.argv) > 2 else None
d = open(kn5, 'rb').read(); p = 0
def rd(fmt):
    global p; v = struct.unpack_from('<' + fmt, d, p); p += struct.calcsize('<' + fmt); return v if len(v) > 1 else v[0]
def s():
    global p; n = rd('i'); v = d[p:p + n].decode('utf8', 'replace'); p += n; return v
assert d[:6] == b'sc6969'; p = 6
ver = rd('i'); extra = rd('i') if ver > 5 else 0
STD_SHADERS = {'ksPerPixel', 'ksPerPixelAT', 'ksPerPixelNM', 'ksPerPixelAT_NM', 'ksPerPixelMultiMap', 'ksPerPixelMultiMap_AT', 'ksPerPixelMultiMap_NMDetail',
               'ksMultilayer', 'ksMultilayer_fresnel_nm', 'ksMultilayer_objsp', 'ksPerPixelAlpha', 'ksTree', 'ksGrass', 'ksPerPixelReflection',
               'ksPerPixelSimpleRefl', 'ksPerPixelNM_UV2', 'ksFlags', 'ksDiffuse', 'ksPerPixel_dual_layer', 'ksPerPixelMultiMapSimpleRefl'}
probs = collections.defaultdict(list); info = {}
tex = {}
for _ in range(rd('i')):
    act = rd('i'); name = s(); ln = rd('I'); blob = d[p:p + ln]; p += ln
    w = h = fmt = None
    if blob[:4] == b'DDS ':
        h, w = struct.unpack_from('<2I', blob, 12); fourcc = blob[84:88]; fmt = fourcc.decode('latin1') if fourcc.strip(b'\0') else 'RGBA'
        mips = struct.unpack_from('<I', blob, 28)[0]
    else: fmt = blob[:4]
    tex[name] = (w, h, fmt, ln)
    if w and (w & (w - 1) or h & (h - 1)): probs['textura no potencia de 2'].append(f'{name} {w}x{h}')
    if w and max(w, h) > 4096: probs['textura > 4096'].append(f'{name} {w}x{h}')
    if blob[:4] != b'DDS ': probs['textura no DDS'].append(name)
mats = []
for _ in range(rd('i')):
    name = s(); sh = s(); blend = rd('B'); at = rd('?'); depth = rd('i')
    props = {}
    for _ in range(rd('i')): pn = s(); v = rd('f'); rest = rd('9f'); props[pn] = v
    maps = [(s(), rd('i'), s()) for _ in range(rd('i'))]
    mats.append(dict(name=name, sh=sh, at=at, maps=maps, props=props, blend=blend))
    if sh not in STD_SHADERS: probs['shader no estándar'].append(f'{name}: {sh}')
    for mn, slot, tn in maps:
        if tn not in tex: probs['textura faltante'].append(f'{name}.{mn} → {tn}')
    if any(k in name for k in ('tree', 'lenga', 'tuft', 'people')) and not at and blend == 0: probs['follaje sin alpha test'].append(name)
meshes = []; nodes = []
def node(depth=0):
    cls = rd('i'); name = s(); nch = rd('i'); act = rd('?')
    if cls == 1: rd('16f'); nodes.append(name)
    elif cls in (2, 3):
        cast, vis, tr = rd('3?'); nv = rd('I')
        vb = struct.unpack_from('<%df' % (nv * 11), d, p); globals()['p'] += nv * 44
        if cls == 3: pass
        ni = rd('I'); idx = struct.unpack_from('<%dH' % ni, d, p); globals()['p'] += ni * 2
        mid, layer = rd('2I'); lodin, lodout = rd('2f'); c = rd('3f'); r = rd('f'); ren = rd('?')
        bad = sum(1 for x in vb if not math.isfinite(x))
        nbad = 0
        for i in range(nv):
            nx, ny, nz = vb[i * 11 + 3:i * 11 + 6]; L = math.sqrt(nx * nx + ny * ny + nz * nz)
            if abs(L - 1) > 0.05: nbad += 1
        meshes.append(dict(name=name, nv=nv, nt=ni // 3, mat=mats[mid]['name'] if mid < len(mats) else None, r=r, vis=vis, cast=cast, lod=(lodin, lodout)))
        if nv > 65535: probs['malla > 65535 vértices'].append(f'{name} {nv}')
        if ni and max(idx) >= nv: probs['índice fuera de rango'].append(name)
        if ni % 3: probs['índices no múltiplo de 3'].append(name)
        if bad: probs['valores NaN/inf'].append(f'{name} ({bad})')
        if nbad > nv * 0.01: probs['normales no unitarias'].append(f'{name} {nbad}/{nv}')
        if mid >= len(mats): probs['material inválido'].append(name)
        if nv == 0 or ni == 0: probs['malla vacía'].append(name)
    for _ in range(nch): node(depth + 1)
node()
info['lectura'] = 'completa' if p == len(d) else f'SOBRAN {len(d) - p} bytes'
# física: nombres <número><CLAVE> deben existir en surfaces.ini
keys = set()
if surf_ini:
    for m in re.finditer(r'KEY\s*=\s*(\w+)', open(surf_ini).read()): keys.add(m.group(1))
phys = collections.Counter(); phys_unknown = set(); foliage_phys = []
for m in meshes:
    mm = re.match(r'^(\d+)([A-Z_]+?)(?:_\d+)?$', m['name']) or re.match(r'^(\d+)([A-Z]+)', m['name'])
    if mm:
        k = mm.group(2); phys[k] += m['nt']
        if keys and k not in keys and k != 'WALL': phys_unknown.add(k)
        if m['mat'] and any(f in m['mat'] for f in ('tree', 'lenga', 'tuft')): foliage_phys.append(m['name'])
if phys_unknown: probs['superficie sin KEY en surfaces.ini'].extend(sorted(phys_unknown))
if foliage_phys: probs['follaje con física'].extend(foliage_phys[:5])
for n in ['AC_START_0', 'AC_PIT_0', 'AC_HOTLAP_START_0']:
    if n not in nodes: probs['falta nodo de AC'].append(n)
p2p = all(n in nodes for n in ['AC_AB_START_L', 'AC_AB_START_R', 'AC_AB_FINISH_L', 'AC_AB_FINISH_R']); circ = all(n in nodes for n in ['AC_TIME_0_L', 'AC_TIME_0_R'])
info['cronometraje'] = 'tramo (AC_AB_START/FINISH)' if p2p else 'circuito (AC_TIME_0)' if circ else 'FALTA'
if not (p2p or circ): probs['falta cronometraje'].append('AC_AB_START/FINISH_L/R o AC_TIME_0_L/R')
# rendimiento
tris = sum(m['nt'] for m in meshes); vis = [m for m in meshes if m['vis']]
big = [m for m in vis if m['r'] > 1500 and not re.match(r'^\d', m['name'])]
tiny = [m for m in vis if m['nt'] < 20]
vram = sum(v[3] for v in tex.values())
lods = collections.Counter(f"{m['lod'][0]:.0f}-{m['lod'][1]:.0f}" for m in meshes if m['lod'][1] > 0)
info['niveles_de_detalle'] = dict(lods)
for m in meshes:
    if m['lod'][1] and m['lod'][1] <= m['lod'][0]: probs['LOD invertido (lodOut <= lodIn)'].append(m['name'])
info.update(version=ver, mallas=len(meshes), visibles=len(vis), triangulos=tris, vertices=sum(m['nv'] for m in meshes), texturas=len(tex), texturas_MB=round(vram / 2**20, 1),
            materiales=len(mats), mallas_radio_mayor_1500m=len(big), mallas_menos_20_tris=len(tiny), max_vert_por_malla=max(m['nv'] for m in meshes),
            superficies_fisicas={k: v for k, v in phys.most_common()}, shaders=dict(collections.Counter(m['sh'] for m in mats)))
if len(vis) > 3000: probs['demasiadas mallas (draw calls)'].append(str(len(vis)))
if tris > 6_000_000: probs['demasiados triángulos'].append(str(tris))
if len(tiny) > 200: probs['muchas mallas chicas (draw calls desperdiciadas)'].append(f'{len(tiny)} con <20 triángulos')
if big: probs['mallas visibles muy extendidas (no se descartan fuera de cámara)'].extend(f"{m['name']} r={m['r']:.0f}m" for m in big[:8])
print(json.dumps(info, ensure_ascii=False, indent=1))
print('PROBLEMAS:' if probs else 'PROBLEMAS: ninguno')
for k, v in probs.items(): print(f' - {k}: {len(v)} → {v[:8]}')
