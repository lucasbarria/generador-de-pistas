# Estado del proyecto (actualizado 2026-11-19)

## Etapas
| Etapa | Estado |
|---|---|
| 1–4 Generador base, AC/RBR export | hecho |
| 5 Río Grande (curvas, banco de ripio) | hecho |
| 6 Bordes A/B/C/D, física calibrada (PROVISIONAL), preset "Ripio – Río Grande" | hecho, en main |
| 7 Entorno: horizonte 15 km, cielo HDRI, bruma, pasto instanciado (web), ext_config CSP, huellones, chequeos | publicado (main 10363a2 / 2026.11.19+1d82418) |
| 8 Parecido a las fotos (panel foto|render, color, camino, vegetación, cordón, alambrado, terreno) | en curso |

## Rutas
- Repo: `/home/claude/generador-de-pistas` (src/app.js, core.js, editor3d.js, entorno.js, objetos.js; build.py → index.html)
- Preset: `presets/pisos/ripio_rio_grande/` (texturas PNG, fotos_referencia JPG sin GPS, preset.json) · cielos: `presets/cielos/*.jpg` (Poly Haven CC0)
- Física: `config/parametros_fisicos.json` · prueba velocidad: `tools/prueba_velocidad.py` · prueba editor: `tests/editor_textos.test.js`
- PC: AC `D:\steam\steamapps\common\assettocorsa` (pistas `rio_grande_ripio_e6`, `rio_grande_ripio_e7` = Etapa 7) · CM `C:\Users\Lucas\Downloads\content-manager` · cfg `C:\Users\Lucas\Documents\Assetto Corsa\cfg`
- Sandbox: capturas/paneles en `/home/claude/E9` (comp.py, mos.py)

## Decisiones / congelados
- Física ripio: DAMPING 0.002–0.004, sin DIRT_ADDITIVE en calzada (Gol ~100 cv → 142 km/h en la recta larga, modelo).
- Superficies nuevas: BLOOSE, BANQ, CORDON; claves AC sin solapamiento (acKeyMap).
- Bandas de costado pintadas (SIDEVIS sb_*), no físicas; horizonte `far_*` sin física (excluidos de surfaces.ini).
- Cielo HDRI `overcast_soil_puresky` por defecto; bruma exponencial k=1.9e-4 (ESTIMADO).
- Terreno en modo mezcla (TMIX) en la estepa; detalle pasto 1,3 m.

## Pendientes
- CSP no instalado (descarga de CM se trabó). Validar en AC con CSP.
- OSM (Overpass) no responde desde el navegador integrado → lagunas/postes/estancia no salen de OSM.
- Etapa 8 (ver pedido 19/11 00:40): panel foto|render con GPS/EXIF, color/exposición/ACES, camino con piedras 3D, rosetas/flores/yuyos, cordón de tierra pelada triplanar, alambrado 4–5 hilos, unión rectangular del terreno, microrrelieve, laguna/barranca.
- Archivos .tmp en Descargas del usuario (descargas del navegador integrado).
