# -*- coding: utf-8 -*-
"""
Generador de Pistas -> Richard Burns Rally (RallySimFans)

Arma y exporta un tramo de RBR a partir del paquete rbr_<tramo> que exporta el generador
(track.obj + texturas DDS + rbr_datos.json), usando el complemento oficial "RBR Track Addon"
(https://richardburnsrally.github.io/blender-track-exporter/) por su API de Python, sin tocar la interfaz.

Uso (lo hace CREAR_TRAMO_RBR.bat):
  blender --background --python rbr_construir.py -- --datos rbr_datos.json --maps "C:\\...\\Maps"
          [--id 7001] [--addon rbr-track-exporter-v0.3.3.zip] [--solo-blend]

Requiere Blender 4.5 (el complemento 0.3.3 pide 4.5.5; en Blender 5.x falla la driveline).
Todo lo que hace queda en rbr_registro.txt al lado de rbr_datos.json.
"""
import json
import math
import os
import re
import sys
import time
import traceback

import bpy  # type: ignore
from mathutils import Vector  # type: ignore

# ---------------------------------------------------------------- argumentos y registro
ARGS = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []


def arg(name, default=None):
    if name in ARGS:
        i = ARGS.index(name)
        return ARGS[i + 1] if i + 1 < len(ARGS) and not ARGS[i + 1].startswith("--") else True
    return default


DATOS = os.path.abspath(arg("--datos", "rbr_datos.json"))
BASE = os.path.dirname(DATOS)
REG_PATH = os.path.join(BASE, "rbr_registro.txt")
_reg = open(REG_PATH, "w", encoding="utf-8")
ERRORES, AVISOS = [], []


def log(*a):
    s = " ".join(str(x) for x in a)
    line = time.strftime("%H:%M:%S ") + s
    print(line, flush=True)
    _reg.write(line + "\n")
    _reg.flush()


def aviso(s):
    AVISOS.append(s)
    log("AVISO:", s)


def error(s):
    ERRORES.append(s)
    log("ERROR:", s)


def fase(nombre):
    log("")
    log("=" * 70)
    log(nombre)
    log("=" * 70)


# ---------------------------------------------------------------- superficies -> materiales físicos de RBR
# Clave de superficie del generador (nombre de la malla física: 12GRAVEL, 3DITCHGRAVEL...) -> material de RBR
# (seco, húmedo, mojado). Los nombres son los del enum MaterialID del complemento (rbr_track_formats/mat.py).
RBR_MAT = {
    "GRAVEL": ("GRAVEL_MEDIUM_SHALLOW_DRY", "GRAVEL_MEDIUM_SHALLOW_DAMP", "GRAVEL_MEDIUM_SHALLOW_WET"),  # huellas firmes
    "LOOSE": ("GRAVEL_MEDIUM_DEEP_DRY", "GRAVEL_MEDIUM_DEEP_DAMP", "GRAVEL_MEDIUM_DEEP_WET"),            # ripio: lomo y bordes sueltos (Etapa 5: grava media)
    "STONY": ("GRAVEL_COARSE_SHALLOW_DRY", "GRAVEL_COARSE_SHALLOW_DAMP", "GRAVEL_COARSE_SHALLOW_WET"),   # pedregoso: huellas (Etapa 5, PROVISIONAL)
    "STONYL": ("GRAVEL_COARSE_DEEP_DRY", "GRAVEL_COARSE_DEEP_DAMP", "GRAVEL_COARSE_DEEP_WET"),          # pedregoso: lomo y bordes con piedras sueltas
    "CLAY": ("DIRT_HARD_DRY", "DIRT_HARD_DAMP", "DIRT_HARD_WET"),
    "MUD": ("DIRT_SOFT_DRY", "DIRT_SOFT_DAMP", "DIRT_SOFT_WET"),
    "ROAD": ("TARMAC_MEDIUM_CLEAN_DRY", "TARMAC_MEDIUM_CLEAN_DAMP", "TARMAC_MEDIUM_CLEAN_WET"),
    "KERB": ("TARMAC_FINE_CLEAN_DRY", "TARMAC_FINE_CLEAN_DAMP", "TARMAC_FINE_CLEAN_WET"),
    "GRASS": ("GRASS_MEDIUM_DRY", "GRASS_MEDIUM_DAMP", "GRASS_MEDIUM_WET"),
    "SAND": ("GRAVEL_FINE_DEEPER_DRY", "GRAVEL_FINE_DEEPER_DAMP", "GRAVEL_FINE_DEEPER_WET"),
    "SNOW": ("SNOWONGRAVEL_MEDIUM", "SNOWONGRAVEL_MEDIUM", "SNOWONGRAVEL_MEDIUM"),
    "ICE": ("SNOWONICE_SHALLOW", "SNOWONICE_SHALLOW", "SNOWONICE_SHALLOW"),
    "WET": ("GRAVEL_MEDIUM_SHALLOW_WET", "GRAVEL_MEDIUM_SHALLOW_WET", "GRAVEL_MEDIUM_SHALLOW_WET"),
    "ROCK": ("ROCK_MEDIUM", "ROCK_MEDIUM", "ROCK_MEDIUM"),
    "WALL": ("TRUNK_MEDIUM", "TRUNK_MEDIUM", "TRUNK_MEDIUM"),            # troncos de árboles cercanos y piedras grandes
    "BRIDGE": ("TARMAC_COARSE_CLEAN_DRY", "TARMAC_COARSE_CLEAN_DAMP", "TARMAC_COARSE_CLEAN_WET"),
    "DITCH": ("GRAVEL_FINE_DEEP_DRY", "GRAVEL_FINE_DEEP_DAMP", "GRAVEL_FINE_DEEP_WET"),
    "SOFT": ("DIRT_MEDIUM_DRY", "DIRT_MEDIUM_DAMP", "DIRT_MEDIUM_WET"),
}
# Cuneta / banquina junto a un suelo: en el generador tienen el agarre del camino apenas menor (3-4 %).
# RBR no tiene agarres "un poco menores": se usa el mismo material del camino (banquina) o su variante más fina (cuneta).
SIDE_RULE = {
    "VERGE": lambda base: RBR_MAT.get(base),
    "DITCH": lambda base: {"GRAVEL": RBR_MAT["DITCH"], "LOOSE": RBR_MAT["DITCH"], "STONY": RBR_MAT["DITCH"], "STONYL": RBR_MAT["DITCH"], "CLAY": RBR_MAT["CLAY"],
                           "ROAD": RBR_MAT["KERB"]}.get(base, RBR_MAT.get(base)),
    "SOFT": lambda base: RBR_MAT["SOFT"],
}


def rbr_materials_for(key):
    if key in RBR_MAT:
        return RBR_MAT[key]
    m = re.match(r"^(DITCH|SOFT|VERGE)([A-Z]+)$", key)
    if m and m.group(2) in RBR_MAT:
        return SIDE_RULE[m.group(1)](m.group(2))
    return None


# ---------------------------------------------------------------- 1. complemento
def preparar_complemento():
    fase("1. Complemento RBR Track Addon")
    log("Blender", bpy.app.version_string)
    if bpy.app.version[0] != 4 or bpy.app.version[1] < 5:
        aviso(f"Blender {bpy.app.version_string}: el complemento 0.3.3 está hecho para Blender 4.5. "
              "Con otra versión puede fallar (en 5.x falla la driveline).")
    import addon_utils  # type: ignore
    name = "rbr_track_addon"
    installed = any(m.__name__ == name for m in addon_utils.modules())
    if not installed:
        z = arg("--addon")
        if not z or not os.path.exists(str(z)):
            raise RuntimeError("El complemento no está instalado y no se encontró el ZIP (--addon). "
                               "Descargá rbr-track-exporter-v0.3.3.zip y ponelo al lado de este script.")
        log("Instalando complemento desde", z)
        bpy.ops.preferences.addon_install(filepath=str(z), overwrite=True)
    addon_utils.enable(name, default_set=True, persistent=True)
    if name not in bpy.context.preferences.addons:
        raise RuntimeError("No se pudo activar el complemento rbr_track_addon.")
    prefs = bpy.context.preferences.addons[name].preferences
    maps = arg("--maps")
    if not maps or not os.path.isdir(str(maps)):
        raise RuntimeError(f"No existe la carpeta Maps de RBR: {maps}")
    maps = os.path.abspath(str(maps))
    found = None
    for d in prefs.export_directories:
        if d.name == "RSF":
            found = d
    if found is None:
        found = prefs.export_directories.add()
        found.name = "RSF"
    found.directory = maps
    found.style = "RSF"
    bpy.context.preferences.use_preferences_save = True
    bpy.ops.wm.save_userpref()
    log("Carpeta de exportación 'RSF' ->", maps, "(guardada en las preferencias)")
    return maps


# ---------------------------------------------------------------- 2. identificador libre
def carpeta_propia(maps, n, pid, nombre):
    """True si Maps/<n> es una carpeta que dejó este mismo tramo en una corrida anterior
    (mismo nombre, y sólo archivos que escribe el exportador para ese identificador)."""
    d = os.path.join(maps, n)
    if not os.path.isdir(d):
        return False
    try:
        from rbr_track_formats import tracks_ini  # type: ignore
        esperado = f"{pid}-{tracks_ini.sanitise_stage_name(nombre)}"
    except Exception:
        esperado = f"{pid}-" + re.sub(r"[^0-9a-zA-Z]", "-", nombre)
    if n.lower() != esperado.lower():
        return False
    if os.path.exists(os.path.join(d, "generador_de_pistas.txt")):
        return True
    ok = re.compile(rf"^((tracks?|tracksettings){pid}\.ini|track-{pid}_.*)$", re.I)
    return all(ok.match(f) for f in os.listdir(d))


def elegir_id(maps, pedido, nombre=""):
    fase("2. Identificador del tramo")
    usados = set()
    propios = set()
    for n in os.listdir(maps):
        m0 = re.match(r"^(\d+)-", n)
        if m0 and nombre and carpeta_propia(maps, n, int(m0.group(1)), nombre):
            propios.add(int(m0.group(1)))
            continue
        m = re.match(r"^(\d+)[-_ ]", n) or re.match(r"^track-(\d+)_", n) or re.match(r"^Tracks?(\d+)\.ini$", n, re.I)
        if m:
            usados.add(int(m.group(1)))
    tr = os.path.join(maps, "Tracks.ini")
    if os.path.exists(tr):
        for line in open(tr, encoding="latin-1", errors="ignore"):
            m = re.match(r"^\s*\[Map(\d+)\]", line)
            if m:
                usados.add(int(m.group(1)))
    propios -= usados
    if propios and not pedido:
        pid = min(propios)
        log(f"Se reutiliza el identificador {pid}: su carpeta es de una corrida anterior de este mismo tramo")
        return pid
    log(f"{len(usados)} identificadores ocupados en Maps (máximo {max(usados) if usados else '-'})")
    if pedido:
        pid = int(pedido)
        if pid in usados and pid not in propios:
            raise RuntimeError(f"El identificador {pid} ya está usado en {maps}: no se pisa otro tramo.")
        return pid
    pid = 7001
    while pid in usados:
        pid += 1
    log("Identificador libre elegido:", pid)
    return pid


# ---------------------------------------------------------------- 3. escena e importación
def importar(D):
    fase("3. Importación del modelo")
    bpy.ops.wm.read_homefile(use_empty=True)
    partes = D["modelo"] if isinstance(D["modelo"], list) else [D["modelo"]]
    t0 = time.time()
    for k, nm in enumerate(partes):
        log(f"  importando {nm} ({k + 1}/{len(partes)})")
        bpy.ops.wm.obj_import(filepath=os.path.join(BASE, nm), forward_axis="NEGATIVE_Z", up_axis="Y")
    objs = [o for o in bpy.context.scene.objects if o.type == "MESH"]
    nv = sum(len(o.data.vertices) for o in objs)
    log(f"{len(objs)} mallas, {nv:,} vértices importados en {time.time() - t0:.0f} s")
    # control de escala y posición: el eje del camino tiene que caer sobre la calzada
    p0 = D["driveline"][len(D["driveline"]) // 2]
    best = None
    for o in objs:
        if not re.match(r"^\d+(STONYL|STONY|GRAVEL|LOOSE|CLAY|MUD|ROAD|SNOW|ICE|SAND|WET)$", o.name.split(".")[0]):
            continue
        # el importador de OBJ deja el giro de ejes en la transformación del objeto:
        # se compara en coordenadas de mundo, que son las que exporta el complemento
        mw = o.matrix_world
        vs = o.data.vertices
        for i in range(0, len(vs), 7):
            w = mw @ vs[i].co
            dd = (w.x - p0[0]) ** 2 + (w.y - p0[1]) ** 2
            if best is None or dd < best[0]:
                best = (dd, w.z)
    if best is None:
        aviso("No encontré la calzada para comprobar la escala.")
    else:
        dz = abs(best[1] - p0[2])
        log(f"Control: eje vs. calzada a mitad del tramo: {math.sqrt(best[0]):.2f} m en planta, {dz:.2f} m en altura")
        if math.sqrt(best[0]) > 3 or dz > 1.5:
            error("El eje no coincide con la calzada: revisar ejes de importación (1 unidad = 1 metro, Y arriba).")
    return objs


# ---------------------------------------------------------------- 3b. diagnóstico de transparencias (opcional)
DIAG_MATS = ("tuft", "fwire", "banner", "fgate")
DIAG_VAR = {"b": ("_b", "DXT5 con color rellenado bajo el alfa"), "c": ("_c", "DXT1 de 1 bit (OneBitOpacity) con color rellenado"),
            "d": ("_b", "DXT5 rellenado, como Object Block en vez de Geom Block")}


def diag_alfa(D, objs):
    """Divide matas, alambrados y carteles cerca de la largada en 4 variantes (A = actual, B, C, D) para ver en RBR
    cuál se dibuja bien. Desde el auto, en los primeros 90 m: izquierda A, derecha B; de 90 a 180 m: izquierda C, derecha D."""
    fase("3b. Diagnóstico de transparencias (variantes A/B/C/D)")
    from mathutils.kdtree import KDTree  # type: ignore
    dl = D["driveline"]
    cum = [0.0]
    for i in range(1, len(dl)):
        cum.append(cum[-1] + math.hypot(dl[i][0] - dl[i - 1][0], dl[i][1] - dl[i - 1][1]))
    kd = KDTree(len(dl))
    for i, p in enumerate(dl):
        kd.insert((p[0], p[1], 0.0), i)
    kd.balance()
    dcar = float(D.get("auto", {}).get("m", 0))

    def variante(w):
        _, i, _ = kd.find((w.x, w.y, 0.0))
        d = cum[i] - dcar
        j, i0 = min(i + 1, len(dl) - 1), max(i - 1, 0)
        tx, ty = dl[j][0] - dl[i0][0], dl[j][1] - dl[i0][1]
        izq = tx * (w.y - dl[i][1]) - ty * (w.x - dl[i][0]) > 0
        orden = str(arg("--diag-orden", "ab,cd"))  # qué variantes van en los primeros 90 m y en los 90 siguientes (izquierda, derecha)
        p1, p2 = (orden.split(",") + ["ab", "cd"])[:2]
        if 0 <= d < 90:
            return p1[0] if izq else p1[1]
        if 90 <= d < 180:
            return p2[0] if izq else p2[1]
        return "a"

    for nm in DIAG_MATS:
        t = D["texturas"].get(nm)
        if not t:
            continue
        for v, (suf, _) in DIAG_VAR.items():
            D["texturas"][f"{nm}_{v}"] = {**t, "dds": f"texturas/{nm}{suf}.dds", "alfa": True}
            if not os.path.exists(os.path.join(BASE, "texturas", f"{nm}{suf}.dds")):
                raise RuntimeError(f"Falta texturas/{nm}{suf}.dds (la arma dds_alfa.py)")
    cuenta = {}
    for o in list(objs):
        if not o.material_slots or not o.material_slots[0].material:
            continue
        m = o.material_slots[0].material
        nm = m.name.split(".")[0]
        if nm not in DIAG_MATS:
            continue
        me, mw = o.data, o.matrix_world
        grupos = {}
        for p in me.polygons:
            grupos.setdefault(variante(mw @ p.center), []).append(p.index)
        if set(grupos) == {"a"}:
            continue
        for v, idx in grupos.items():
            cuenta[f"{nm}_{v}"] = cuenta.get(f"{nm}_{v}", 0) + len(idx)
            if v == "a":
                continue
            mv = bpy.data.materials.get(f"{nm}_{v}")
            if mv is None:
                mv = m.copy()
                mv.name = f"{nm}_{v}"
            me.materials.append(mv)
            k = len(me.materials) - 1
            for i in idx:
                me.polygons[i].material_index = k
        bpy.ops.object.select_all(action="DESELECT")
        o.select_set(True)
        bpy.context.view_layer.objects.active = o
        bpy.ops.object.mode_set(mode="EDIT")
        bpy.ops.mesh.separate(type="MATERIAL")
        bpy.ops.object.mode_set(mode="OBJECT")
    # cada pieza queda con un solo material (el que usa)
    for o in [o for o in bpy.context.scene.objects if o.type == "MESH"]:
        me = o.data
        if len(me.materials) <= 1 or not len(me.polygons):
            continue
        usado = me.materials[me.polygons[0].material_index]
        me.materials.clear()
        me.materials.append(usado)
        me.polygons.foreach_set("material_index", [0] * len(me.polygons))
    for k in sorted(cuenta):
        log(f"  {k}: {cuenta[k]} caras")
    for v, (suf, desc) in DIAG_VAR.items():
        log(f"  variante {v.upper()}: {desc}")
    log("  variante A: la actual (DXT5, color negro bajo el alfa, Geom Block)")
    return [o for o in bpy.context.scene.objects if o.type == "MESH"]


def diag_ini(maps, tid, D):
    """El complemento escribe siempre OneBitOpacity=false: para la variante C se corrige en el .ini del tramo."""
    from rbr_track_formats import tracks_ini  # type: ignore
    d = os.path.join(maps, f"{tid}-{tracks_ini.sanitise_stage_name(D['nombre'])}")
    for f in os.listdir(d):
        if not re.match(rf"track-{tid}_[MNEO]\.ini$", f, re.I):
            continue
        p = os.path.join(d, f)
        txt = open(p, encoding="latin-1").read()
        n = 0

        def fix(mo):
            nonlocal n
            n += 1
            return mo.group(0).replace("OneBitOpacity=false", "OneBitOpacity=true")
        txt = re.sub(r"\[(?:" + "|".join(DIAG_MATS) + r")_c(?:_[A-Z]+)?_T\.dds\][^\[]*", fix, txt)
        open(p, "w", encoding="latin-1").write(txt)
        log(f"  {f}: OneBitOpacity=true en {n} texturas de la variante C")


def corregir_opacidad(maps, tid, D):
    """Etapa 4: en Blender 4.5 el complemento marca TODAS las texturas como transparentes (OpacityMap=true, sufijo _T),
    también el piso. Se deja OpacityMap=true sólo en las que tienen alfa (matas, alambrado, carteles, tranquera)."""
    fase("9b. Opacidad de las texturas en el .ini del tramo")
    from rbr_track_formats import tracks_ini  # type: ignore
    alfa = {k for k, v in D["texturas"].items() if v.get("alfa") and not v.get("detalle")}
    d = os.path.join(maps, f"{tid}-{tracks_ini.sanitise_stage_name(D['nombre'])}")
    for f in os.listdir(d):
        if not re.match(rf"track-{tid}_[MNEO]\.ini$", f, re.I):
            continue
        p = os.path.join(d, f)
        txt = open(p, encoding="latin-1").read()
        cuenta = {"opaca": 0, "alfa": 0}

        def fix(mo):
            nombre = re.sub(r"_[TO]\.dds$", "", mo.group(1), flags=re.I)
            es_alfa = any(nombre == a or nombre.startswith(a + "_") for a in alfa)
            cuenta["alfa" if es_alfa else "opaca"] += 1
            return mo.group(0) if es_alfa else re.sub(r"OpacityMap=true", "OpacityMap=false", mo.group(0))
        txt = re.sub(r"\[([^\]]+\.dds)\][^\[]*", fix, txt)
        open(p, "w", encoding="latin-1").write(txt)
        log(f"  {f}: {cuenta['alfa']} texturas con transparencia, {cuenta['opaca']} opacas (OpacityMap=false)")


# ---------------------------------------------------------------- 4. agrupar mallas
def clasificar(D, objs):
    fase("4. Clasificación y unión de mallas")
    info = D["objetos"]
    groups = {}
    quitadas = 0
    for o in objs:
        nm = o.name.split(".")[0]
        meta = info.get(nm)
        if meta is None:
            meta = {"fis": None, "rbr": "visual"}
        if meta.get("rbr") == "omitir":
            bpy.data.objects.remove(o, do_unlink=True)
            quitadas += 1
            continue
        mat = o.material_slots[0].material.name.split(".")[0] if o.material_slots and o.material_slots[0].material else "sin_material"
        k = (meta.get("fis") or "", mat, meta.get("rbr", "visual"))
        groups.setdefault(k, []).append(o)
    log(f"{quitadas} mallas omitidas (niveles de detalle repetidos: RBR no los usa así)")
    out = []
    for (fis, mat, cat), lst in groups.items():
        bpy.ops.object.select_all(action="DESELECT")
        for o in lst:
            o.select_set(True)
        bpy.context.view_layer.objects.active = lst[0]
        if len(lst) > 1:
            bpy.ops.object.join()
        o = bpy.context.view_layer.objects.active
        o.name = f"{cat}_{fis or 'visual'}_{mat}"
        out.append((o, fis or None, mat, cat))
    log(f"{len(out)} objetos después de unir por superficie y material")
    return out


# ---------------------------------------------------------------- 5. materiales y texturas RBR
def materiales(D, grupos):
    fase("5. Materiales RBR (texturas DDS + material físico por superficie)")
    from rbr_track_addon.shaders.texture import setup_texture_node_tree, RBR_TEXTURE_NODE_TREE_PREFIX  # type: ignore
    from rbr_track_addon.shaders.shader_node import make_rbr_blender_material, UV_DIFFUSE_1, VC_COLOR  # type: ignore
    try:
        from rbr_track_addon.shaders.shader_node import UV_DIFFUSE_2  # type: ignore
    except Exception:
        UV_DIFFUSE_2 = "RBR_DIFFUSE_2"
    from rbr_track_formats.mat import MaterialID  # type: ignore
    tex = D["texturas"]
    # Los materiales que trae el OBJ se llaman igual que las texturas: el complemento arma el
    # material RBR con el nombre de la textura y, si ya existe uno con ese nombre, lo reutiliza
    # (y ése no es un material RBR -> error E0104). Se les cambia el nombre antes.
    for m in list(bpy.data.materials):
        if not m.name.startswith("obj_"):
            m.name = "obj_" + m.name
    cache = {}
    imgs = {}
    sin_fis = []
    for o, fis, mat, cat in grupos:
        t = tex.get(mat)
        if t is None:
            aviso(f"Material sin textura en el paquete: {mat} (se deja sin exportar el objeto {o.name})")
            o.rbr_object_settings.exported = False
            continue
        key = (mat, fis)
        if key not in cache:
            p = os.path.join(BASE, t["dds"])
            if not os.path.exists(p):
                raise RuntimeError(f"Falta la textura {p}")
            if p not in imgs:
                imgs[p] = bpy.data.images.load(p, check_existing=True)
            tree = setup_texture_node_tree()
            tree.name = RBR_TEXTURE_NODE_TREE_PREFIX + (f"{mat}_{fis}" if fis else mat)  # nombre de la textura en RBR
            for cond in ("dry", "damp", "wet"):
                for age in ("new", "normal", "worn"):
                    tree.nodes[f"{cond}/{age}"].image = imgs[p]
            internal = tree.nodes["internal"]
            internal.is_road_surface = False
            if fis:
                ids = rbr_materials_for(fis)
                if ids is None:
                    sin_fis.append(fis)
                    ids = RBR_MAT["GRASS"]
                fb = internal.fallback_materials
                for cond, mid in zip(("dry", "damp", "wet"), ids):
                    for age in ("new", "normal", "worn"):
                        getattr(fb, f"{cond}_{age}").material_id = MaterialID[mid].value
            tree2 = None
            det = ((D.get("detalle_calzada") or {}).get("por_superficie") or {}).get(fis) if fis else None
            if det and det in tex and not arg("--sin-detalle"):
                # Etapa 5: segunda textura (detalle fino a escala real) sólo en las mallas de la calzada
                p2 = os.path.join(BASE, tex[det]["dds"])
                if os.path.exists(p2):
                    if p2 not in imgs:
                        imgs[p2] = bpy.data.images.load(p2, check_existing=True)
                    tree2 = bpy.data.node_groups.get(RBR_TEXTURE_NODE_TREE_PREFIX + det)
                    if tree2 is None:
                        tree2 = setup_texture_node_tree()
                        tree2.name = RBR_TEXTURE_NODE_TREE_PREFIX + det
                        for cond in ("dry", "damp", "wet"):
                            for age in ("new", "normal", "worn"):
                                tree2.nodes[f"{cond}/{age}"].image = imgs[p2]
                        tree2.nodes["internal"].is_road_surface = False
                else:
                    aviso(f"Falta la textura de detalle {p2}: la calzada va sin detalle fino")
            try:
                m = make_rbr_blender_material(diffuse_1=tree, diffuse_2=tree2, specular=None, uv_velocity=None)
            except Exception as ex:
                if tree2 is None:
                    raise
                aviso(f"No se pudo armar la doble textura en {mat}/{fis} ({ex}): va sin detalle fino")
                tree2 = None
                m = make_rbr_blender_material(diffuse_1=tree, diffuse_2=None, specular=None, uv_velocity=None)
            m["rg_detalle"] = det if tree2 is not None else ""
            try:  # el complemento marca la textura como transparente si blend_method no es OPAQUE
                m.blend_method = "CLIP" if t.get("alfa") else "OPAQUE"
            except Exception as ex:
                aviso(f"blend_method en {m.name}: {ex}")
            try:  # Blender 4.2+: blend_method quedó obsoleto; el modo real es surface_render_method
                m.surface_render_method = "BLENDED" if t.get("alfa") else "DITHERED"
            except Exception:
                pass
            if not t.get("alfa") and getattr(m, "blend_method", "OPAQUE") != "OPAQUE" and not getattr(materiales, "_avisado", False):
                materiales._avisado = True
                log(f"  nota: Blender devuelve blend_method={m.blend_method!r} aunque se pidió OPAQUE; "
                    "la opacidad de cada textura se corrige en el .ini después de exportar (paso 9b)")
            m.use_backface_culling = bool(fis) and not t.get("alfa")
            cache[key] = m
            log(f"  {mat}{' + ' + fis if fis else ''} -> {'DXT5 con alfa' if t.get('alfa') else 'DXT1'}"
                + (f", agarre {rbr_materials_for(fis)[0] if rbr_materials_for(fis) else '?'}" if fis else ", sólo visual"))
        me = o.data
        me.materials.clear()
        me.materials.append(cache[key])
        if me.uv_layers:
            me.uv_layers[0].name = UV_DIFFUSE_1
        else:
            error(f"{o.name} no tiene UV")
        if cache[key].get("rg_detalle"):
            # UV del detalle: coordenadas de mundo / tamaño del tile (2 m): escala real, sin costuras entre mallas vecinas
            tm = float((D.get("detalle_calzada") or {}).get("tile_m", 2))
            uv2 = me.uv_layers.get(UV_DIFFUSE_2) or me.uv_layers.new(name=UV_DIFFUSE_2)
            mw = o.matrix_world
            co = [mw @ v.co for v in me.vertices]
            vals = []
            for lp in me.loops:
                w = co[lp.vertex_index]
                vals += [w.x / tm, w.y / tm]
            uv2.data.foreach_set("uv", vals)
            me.uv_layers.active = me.uv_layers[UV_DIFFUSE_1]
            n_det = getattr(materiales, "_ndet", 0) + 1
            materiales._ndet = n_det
        if VC_COLOR not in me.color_attributes:
            ca = me.color_attributes.new(VC_COLOR, "BYTE_COLOR", "CORNER")
            g = float(D.get("luz_vertices", 0.82))
            ca.data.foreach_set("color", [g, g, g, 1.0] * len(ca.data))
    if sin_fis:
        aviso("Superficies sin equivalente directo en RBR (se usó pasto): " + ", ".join(sorted(set(sin_fis))))
    log(f"{len(cache)} materiales RBR, {len(imgs)} texturas DDS"
        + (f", detalle fino (doble textura) en {getattr(materiales, '_ndet', 0)} mallas de la calzada" if getattr(materiales, "_ndet", 0) else ""))


# ---------------------------------------------------------------- 6. colisiones y tipos de objeto
def tipos(grupos, D=None):
    fase("6. Colisiones y tipos de objeto")
    ncol = 0
    alfa = {k for k, v in ((D or {}).get("texturas") or {}).items() if v.get("alfa") and not v.get("detalle")}
    nob, ninv = 0, 0
    for o, fis, mat, cat in list(grupos):
        s = o.rbr_object_settings
        if not s.exported:
            continue
        s.type = "GEOM_BLOCKS"
        # Etapa 4 (probado en RBR, tramos 7010/7011): en los Geom Blocks RBR NO aplica el alfa de la textura (matas,
        # alambrado y tranqueras se ven como cuadrados enteros). Como Object Blocks sí. Lo que tenía colisión (alambrado)
        # se duplica como Geom Block invisible con colisión, para que el auto lo siga sintiendo.
        if not arg("--diag-alfa") and mat in alfa and not arg("--alfa-geom"):
            if fis:
                dup = o.copy()
                dup.data = o.data.copy()
                dup.name = o.name + "_col"
                bpy.context.scene.collection.objects.link(dup)
                ds = dup.rbr_object_settings
                ds.exported = True
                ds.type = "GEOM_BLOCKS"
                ds.geom_blocks_distance = "NEAR"
                ds.is_geom_blocks_collision = True
                ds.is_geom_blocks_invisible = True
                ninv += 1
                ncol += 1
            s.type = "OBJECT_BLOCKS"
            s.object_blocks_detail = "BOTH"
            nob += 1
            continue
        if arg("--diag-alfa") and mat.endswith("_d"):
            s.type = "OBJECT_BLOCKS"
            s.object_blocks_detail = "BOTH"
            continue
        if fis:
            s.geom_blocks_distance = "NEAR"
            s.is_geom_blocks_collision = True
            s.is_geom_blocks_invisible = False
            ncol += 1
        else:
            s.geom_blocks_distance = "ANY" if cat == "lejos" else "NEAR"
            s.is_geom_blocks_collision = False
    log(f"{nob} objetos con transparencia como Object Blocks (matas, alambrado, tranqueras, carteles); {ninv} copias invisibles con colisión")
    log(f"{ncol} objetos con colisión (camino, cunetas, banquinas, terreno, troncos y piedras que se tocan); "
        f"{len(grupos) - ncol} sólo visuales (copas, gravilla fina, líneas)")


# ---------------------------------------------------------------- 7. driveline, eventos y notas
def driveline(D):
    fase("7. Driveline, largada, parciales, llegada y notas de ruta")
    from rbr_track_addon.driveline import fixup_driveline  # type: ignore
    P = [Vector(p) for p in D["driveline"]]
    cu = bpy.data.curves.new("Driveline", "CURVE")
    cu.dimensions = "3D"
    sp = cu.splines.new("BEZIER")
    sp.bezier_points.add(len(P) - 1)
    for i, p in enumerate(P):
        a = P[max(0, i - 1)]
        b = P[min(len(P) - 1, i + 1)]
        t = (b - a)
        t.normalize()
        L = ((P[min(len(P) - 1, i + 1)] - p).length + (p - P[max(0, i - 1)]).length) / 2 / 3
        bp = sp.bezier_points[i]
        bp.co = p
        bp.handle_left_type = bp.handle_right_type = "ALIGNED"
        bp.handle_left = p - t * L
        bp.handle_right = p + t * L
        bp.radius = 1.0
    ob = bpy.data.objects.new("Driveline", cu)
    bpy.context.scene.collection.objects.link(ob)
    ob.rbr_object_settings.type = "DRIVELINE"
    fixup_driveline(ob, full_fixup=True)
    largo = sp.calc_length(resolution=32)
    log(f"Driveline: {len(P)} puntos, {largo:.0f} m (eje del camino del generador, con su altimetría)")
    dl = ob.rbr_driveline_settings
    for ev in D["eventos"]:
        pn = dl.pacenotes.add()
        pn.location = float(ev["m"])
        pn.pacenote_id = ev["id"]
        log(f"  {ev['nombre']}: {ev['m']:.0f} m")
    nn = 0
    for nt in D.get("notas", []):
        pn = dl.pacenotes.add()
        pn.location = float(nt["m"])
        pn.pacenote_id = nt["id"]
        nn += 1
    dl.update_sorted_pacenotes()
    log(f"  {nn} notas de copiloto")
    if abs(largo - D["largo_driveline_m"]) > max(5, 0.01 * largo):
        aviso(f"El largo de la driveline ({largo:.0f} m) difiere del eje ({D['largo_driveline_m']:.0f} m)")
    return ob


def auto_y_sol(D):
    fase("8. Posición del auto, sol y clima")
    c = D["auto"]
    e = bpy.data.objects.new("Car Location", None)
    e.empty_display_type = "ARROWS"
    e.empty_display_size = 2
    e.location = Vector(c["pos"])
    e.rotation_euler = (0.0, 0.0, float(c["rumbo"]) - math.pi / 2)  # el auto mira hacia +Y local
    bpy.context.scene.collection.objects.link(e)
    e.rbr_object_settings.type = "CAR_LOCATION"
    log(f"Auto en {tuple(round(x, 1) for x in c['pos'])}, {c['m']:.0f} m antes de la largada, mirando el sentido del tramo")
    sd = bpy.data.lights.new("Sol", "SUN")
    so = bpy.data.objects.new("Sol", sd)
    so.rotation_euler = tuple(D.get("sol_euler", (math.radians(40), 0.0, math.radians(30))))
    bpy.context.scene.collection.objects.link(so)
    so.rbr_object_settings.type = "SUN"
    ts = bpy.context.scene.rbr_track_settings
    try:
        ts.surface_types = {"DRY", "DAMP", "WET"}
    except Exception as ex:
        aviso(f"No se pudieron activar húmedo y mojado: {ex}")
    w = bpy.data.worlds.new("Despejado")
    ptr = ts.world_weathers.add()
    try:
        ptr.world = w
    except Exception as ex:  # el callback de actualización usa la interfaz; el valor queda asignado igual
        aviso(f"Clima: {ex}")
    if ptr.world is None:
        error("No se pudo asignar el clima (world) al tramo")
    log("Superficies: seco, húmedo y mojado. Clima: despejado (mañana)")


# ---------------------------------------------------------------- 9. exportación
def exportar(D, tid):
    fase("9. Exportación a RSF")
    from rbr_track_addon.exporter.exporter import export_restoring_data_blocks  # type: ignore
    from rbr_track_formats.logger import Logger  # type: ignore
    from rbr_track_formats.errors import RBRAddonError, Language  # type: ignore
    s = bpy.data.scenes[0].rbr_export_settings
    s.export_to = "RSF"
    s.track_id = tid
    s.track_name = D["nombre"]
    s.author = D.get("autor", "Generador de Pistas")
    s.surface = D.get("superficie_rbr", "GRAVEL")
    try:
        s.country = D.get("pais", "AR")
    except Exception:
        aviso("País no reconocido por el complemento; queda el de fábrica")
    blend = os.path.join(BASE, f"{D['carpeta']}.blend")
    bpy.ops.wm.save_as_mainfile(filepath=blend)
    log("Proyecto guardado:", blend)
    if arg("--solo-blend"):
        log("--solo-blend: no se exporta")
        return None
    t0 = time.time()
    try:
        export_restoring_data_blocks(bpy.context, Logger())
    except RBRAddonError as e:
        raise RuntimeError("El exportador de RBR rechazó el tramo: " + e.report(Language.EN))
    log(f"Exportado en {time.time() - t0:.0f} s")
    try:
        from rbr_track_formats import tracks_ini  # type: ignore
        d = os.path.join(os.path.abspath(str(arg("--maps"))), f"{tid}-{tracks_ini.sanitise_stage_name(D['nombre'])}")
        with open(os.path.join(d, "generador_de_pistas.txt"), "w", encoding="utf-8") as f:
            f.write(f"Tramo generado por Generador de Pistas: {D['nombre']} (id {tid}).\n"
                    "Esta marca permite volver a exportarlo en el mismo identificador sin tocar otros tramos.\n")
    except Exception as ex:
        aviso(f"No pude escribir la marca del tramo: {ex}")
    return tid


def validar(maps, tid, D):
    fase("10. Validación de archivos exportados")
    from rbr_track_formats import tracks_ini  # type: ignore
    sub = f"{tid}-{tracks_ini.sanitise_stage_name(D['nombre'])}"
    d = os.path.join(maps, sub)
    esperados = [f"track-{tid}_M.lbs", f"track-{tid}_M.trk", f"track-{tid}_M.ini", f"track-{tid}_M_textures.rbz",
                 f"track-{tid}_M.col", f"track-{tid}_M.mat", f"track-{tid}_M.dls", f"track-{tid}_M.fnc", f"Tracks{tid}.ini", f"TrackSettings{tid}.ini"]
    if not os.path.isdir(d):
        error(f"No se creó la carpeta del tramo: {d}")
        return d
    hay = set(os.listdir(d))
    opcionales = {f"track-{tid}_M.fnc".lower()}
    for f in esperados:
        alt = [h for h in hay if h.lower() == f.lower()]
        if alt:
            log(f"  OK  {alt[0]}  ({os.path.getsize(os.path.join(d, alt[0])) / 1e6:.2f} MB)")
        elif f.lower() in opcionales:
            log(f"  (no está {f}: es opcional)")
        else:
            error(f"Falta {f} en {d}")
    otros = sorted(hay - set(esperados))
    if otros:
        log("  Otros archivos:", ", ".join(otros))
    return d


# ---------------------------------------------------------------- principal
def main():
    t0 = time.time()
    log("Generador de Pistas -> RBR / RSF")
    log("Paquete:", DATOS)
    with open(DATOS, encoding="utf-8") as f:
        D = json.load(f)
    log(f"Tramo: {D['nombre']} · {D['largo_driveline_m'] / 1000:.2f} km · generado {D.get('generado', '?')}")
    maps = preparar_complemento()
    if arg("--diag-alfa"):
        D["nombre"] = D["nombre"][:40] + " DIAG ALFA" + (" " + str(arg("--diag-orden")).upper().replace(",", "-") if arg("--diag-orden") else "")
    tid = elegir_id(maps, arg("--id"), D["nombre"])
    fase("0. Chequeo previo del paquete (superficie continua, solapes, normales, escalones, colisión, texturas)")
    try:
        sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
        import chequeo_previo  # type: ignore
        cp = chequeo_previo.main(BASE)
        log(f"  cobertura {cp['cobertura_superficie_pct']} % · huecos {cp['n_huecos']} · solapes {cp['n_solapamientos']} · normales mal {cp['n_normales_invertidas']}"
            f" · escalones {cp['n_escalones_largo']}+{cp['n_escalones_ancho']} · texturas faltantes {len(cp['texturas_faltantes'])}")
        for p_ in cp["problemas"]:
            aviso("chequeo previo: " + p_)
    except Exception as ex:
        aviso(f"No se pudo hacer el chequeo previo: {ex}")
    objs = importar(D)
    if arg("--diag-alfa"):
        objs = diag_alfa(D, objs)
    grupos = clasificar(D, objs)
    materiales(D, grupos)
    tipos(grupos, D)
    driveline(D)
    auto_y_sol(D)
    exportar(D, tid)
    if not arg("--solo-blend"):
        corregir_opacidad(maps, tid, D)
    if arg("--diag-alfa") and not arg("--solo-blend"):
        diag_ini(maps, tid, D)
    carpeta = None if arg("--solo-blend") else validar(maps, tid, D)
    fase("RESUMEN")
    log(f"Identificador: {tid}")
    if carpeta:
        log(f"Carpeta del tramo: {carpeta}")
        log("En RSF el tramo aparece en la categoría 'Test stages' (no hace falta tocar Tracks.ini).")
    log(f"Avisos: {len(AVISOS)}  ·  Errores: {len(ERRORES)}  ·  {time.time() - t0:.0f} s")
    for a in AVISOS:
        log("  aviso:", a)
    for e in ERRORES:
        log("  error:", e)
    log("NOTA: esto comprueba los archivos, no la conducción. La prueba real es cargar el tramo en RBR.")
    with open(os.path.join(BASE, "rbr_resultado.json"), "w", encoding="utf-8") as f:
        json.dump({"ok": not ERRORES, "id": tid, "carpeta": carpeta, "avisos": AVISOS, "errores": ERRORES}, f, ensure_ascii=False, indent=1)


try:
    main()
except Exception as ex:
    error(str(ex))
    log(traceback.format_exc())
    with open(os.path.join(BASE, "rbr_resultado.json"), "w", encoding="utf-8") as f:
        json.dump({"ok": False, "errores": ERRORES, "avisos": AVISOS}, f, ensure_ascii=False, indent=1)
finally:
    _reg.close()
