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
    "LOOSE": ("GRAVEL_COARSE_DEEP_DRY", "GRAVEL_COARSE_DEEP_DAMP", "GRAVEL_COARSE_DEEP_WET"),            # lomo y bordes sueltos
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
    "DITCH": lambda base: {"GRAVEL": RBR_MAT["DITCH"], "LOOSE": RBR_MAT["DITCH"], "CLAY": RBR_MAT["CLAY"],
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
def elegir_id(maps, pedido):
    fase("2. Identificador del tramo")
    usados = set()
    for n in os.listdir(maps):
        m = re.match(r"^(\d+)[-_ ]", n) or re.match(r"^track-(\d+)_", n) or re.match(r"^Tracks?(\d+)\.ini$", n, re.I)
        if m:
            usados.add(int(m.group(1)))
    tr = os.path.join(maps, "Tracks.ini")
    if os.path.exists(tr):
        for line in open(tr, encoding="latin-1", errors="ignore"):
            m = re.match(r"^\s*\[Map(\d+)\]", line)
            if m:
                usados.add(int(m.group(1)))
    log(f"{len(usados)} identificadores ocupados en Maps (máximo {max(usados) if usados else '-'})")
    if pedido:
        pid = int(pedido)
        if pid in usados:
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
    obj_path = os.path.join(BASE, D["modelo"])
    t0 = time.time()
    bpy.ops.wm.obj_import(filepath=obj_path, forward_axis="NEGATIVE_Z", up_axis="Y")
    objs = [o for o in bpy.context.scene.objects if o.type == "MESH"]
    nv = sum(len(o.data.vertices) for o in objs)
    log(f"{len(objs)} mallas, {nv:,} vértices importados en {time.time() - t0:.0f} s")
    # control de escala y posición: el eje del camino tiene que caer sobre la calzada
    p0 = D["driveline"][len(D["driveline"]) // 2]
    best = None
    for o in objs:
        if not re.match(r"^\d+(GRAVEL|LOOSE|CLAY|MUD|ROAD|SNOW|ICE|SAND|WET)$", o.name.split(".")[0]):
            continue
        vs = o.data.vertices
        for i in range(0, len(vs), 7):
            v = vs[i]
            dd = (v.co.x - p0[0]) ** 2 + (v.co.y - p0[1]) ** 2
            if best is None or dd < best[0]:
                best = (dd, v.co.z)
    if best is None:
        aviso("No encontré la calzada para comprobar la escala.")
    else:
        dz = abs(best[1] - p0[2])
        log(f"Control: eje vs. calzada a mitad del tramo: {math.sqrt(best[0]):.2f} m en planta, {dz:.2f} m en altura")
        if math.sqrt(best[0]) > 3 or dz > 1.5:
            error("El eje no coincide con la calzada: revisar ejes de importación (1 unidad = 1 metro, Y arriba).")
    return objs


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
    from rbr_track_formats.mat import MaterialID  # type: ignore
    tex = D["texturas"]
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
            m = make_rbr_blender_material(diffuse_1=tree, diffuse_2=None, specular=None, uv_velocity=None)
            try:  # el complemento marca la textura como transparente si blend_method no es OPAQUE
                m.blend_method = "CLIP" if t.get("alfa") else "OPAQUE"
            except Exception as ex:
                aviso(f"blend_method en {m.name}: {ex}")
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
        if VC_COLOR not in me.color_attributes:
            ca = me.color_attributes.new(VC_COLOR, "BYTE_COLOR", "CORNER")
            g = float(D.get("luz_vertices", 0.82))
            ca.data.foreach_set("color", [g, g, g, 1.0] * len(ca.data))
    if sin_fis:
        aviso("Superficies sin equivalente directo en RBR (se usó pasto): " + ", ".join(sorted(set(sin_fis))))
    log(f"{len(cache)} materiales RBR, {len(imgs)} texturas DDS")


# ---------------------------------------------------------------- 6. colisiones y tipos de objeto
def tipos(grupos):
    fase("6. Colisiones y tipos de objeto")
    ncol = 0
    for o, fis, mat, cat in grupos:
        s = o.rbr_object_settings
        if not s.exported:
            continue
        s.type = "GEOM_BLOCKS"
        if fis:
            s.geom_blocks_distance = "NEAR"
            s.is_geom_blocks_collision = True
            s.is_geom_blocks_invisible = False
            ncol += 1
        else:
            s.geom_blocks_distance = "ANY" if cat == "lejos" else "NEAR"
            s.is_geom_blocks_collision = False
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
    tid = elegir_id(maps, arg("--id"))
    objs = importar(D)
    grupos = clasificar(D, objs)
    materiales(D, grupos)
    tipos(grupos)
    driveline(D)
    auto_y_sol(D)
    exportar(D, tid)
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
