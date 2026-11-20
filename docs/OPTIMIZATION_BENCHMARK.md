# Benchmark de optimización — rama `optimization/3d-performance-textures`

Documento permanente. Todo tiempo acá fue **medido**, no estimado. Fecha: 2026-11-20.
Rama de trabajo: `optimization/3d-performance-textures` (nunca `main`). Sin Release, tag ni merge.

## 1. Pista de referencia (congelada)

`tools/benchmark_opt.js` construye una pista **sintética** (no es una ubicación real) ejecutando el
`Core.buildRoute` real extraído de `src/core.js`:

| Parámetro | Valor |
| --- | --- |
| Longitud | 2699,5 m (1351 puntos de eje, paso 20 m) |
| Curvatura | `sin(d/180)*0.55 + sin(d/70)*0.13` rad |
| Elevación | `100 + 8*sin(x/220) + 3*sin(y/95)` |
| Ancho / suavizado | 6 m / 12 |
| Costados | `bordes_rio_grande`, `cunetas_v5`, `taludes` de `config/parametros_fisicos.json` |
| Humedad y forestación | funciones deterministas de `d` |
| Repeticiones | 3 por fase, se reporta la **mediana** (`performance.now()`) |

Resultado congelado (idéntico antes y después): 29 mallas, 47.238 vértices, 70.200 caras,
UV completos, materiales `asphalt, ditchbot, ditchwall, grass, loose, verge`.
Hashes: geometría `83f751f8ba77b1ce`, mallas `1bc506d92004f0c1`.

## 2. Baseline (antes de tocar código)

`docs/benchmark_baseline.json`:

| Fase | Mediana |
| --- | --- |
| `buildRoute` completo | 194,64 ms |
| Edición con caché en planta + `offsetAt` | 50,47 ms |
| `profileOnly` | 18,17 ms |

## 3. Cambios aplicados

### 3D / render (`src/app.js`, `src/editor3d.js`, `src/entorno.js`)
1. Loop de render: si `#viewer` está oculto, no se ejecutan cámara, pasto, controles ni `render()`.
2. `renderer.shadowMap.autoUpdate = false`; se marca `needsUpdate` al crear/borrar/mover geometría,
   al mover el sol con la cámara y al reconstruir el pasto. El sol sólo se reevalúa si el objetivo
   se movió > 0,5 m o cambió el radio.
3. Materiales de gizmos, líneas, selección y pasto se crean una vez y se reutilizan (antes se
   creaban y disponían en cada reconstrucción del panel o movimiento de cámara).
4. Geometrías de gizmos ya estaban cacheadas; ahora el dispose respeta también los materiales
   compartidos para no liberarlos por error.

### Texturas / exportación (`src/app.js`, `tools/rbr/rbr_construir.py`)
5. `rgbaToDDS` y `canvasToDDS` sangran el RGB bajo píxeles transparentes **también en DXT1**
   (antes DXT1 guardaba negro y aparecía en mipmaps/juego).
6. `rbrBakeChan`: si no hay máscara o capas de detalle devuelve la textura base; si la máscara está
   vacía conserva la base; piso de 75 % para que una máscara oscura no ennegrezca el tramo.
7. `texAudit(R)`: auditoría previa al ZIP (materiales sin textura, rutas, alfa incorrecto, UV y
   posiciones no finitas). Escribe `AUDITORIA_TEXTURAS.txt` dentro del ZIP y avisa en consola.
8. `ddsToCanvas`: valida cabecera, dimensiones y longitud de bloques/píxeles antes de leer; errores
   explícitos en vez de `RangeError` críptico o imagen de basura.
9. `--solo-blend` en `rbr_construir.py` **no** llama a `corregir_opacidad`: revisado, es correcto
   (ese modo sólo genera el `.blend`, no hay `.ini` que corregir). Sin cambios.

## 4. Medición posterior

`docs/benchmark_after.json`:

| Fase | Antes | Después | Observación |
| --- | --- | --- | --- |
| `buildRoute` completo | 194,64 ms | 84,11 ms | **No es una mejora del código.** `src/core.js` no se modificó. |
| Edición con caché | 50,47 ms | 50,93 ms | Sin cambio relevante. |
| `profileOnly` | 18,17 ms | 17,34 ms | Sin cambio relevante. |

**Control de ruido:** al repetir el benchmark 3 veces sin cambiar nada, `build_ms` dio
128,55 / 90,05 / 115,30 ms y `edit_ms` 52,61 / 51,15 / 80,09 ms. La dispersión (84–194 ms)
supera cualquier diferencia aparente: **no se reclama mejora en la generación de geometría**.
Los hashes confirman que la geometría es idéntica.

### Verificación en navegador (efectos reales del cambio)
- `PV.renderer.shadowMap.autoUpdate === false` después de `showPreview`.
- Con `#viewer` oculto: **0** llamadas a `PV.render()` en 700 ms; visible: 4 llamadas en 700 ms.
  El código anterior no tenía el guardián (`requestAnimationFrame` + `PV.render()` incondicionales).
- El timing de GPU no es fiable en este entorno headless (0,3 ms con y sin sombras), por lo que
  **no se cuantifica** el ahorro de sombras; sólo se verifica el comportamiento por código y conteo
  de frames.

## 5. Resultados

- ✅ Geometría y UV sin cambios (hashes idénticos): ninguna optimización alteró la pista exportada.
- ✅ El render se detiene cuando el visor está oculto; no se midió consumoGPU real.
- ✅ Materiales compartidos en gizmos, selección y pasto (menos asignaciones por frame de edición).
- ✅ DXT1 ya no entierra negro bajo el alfa (test de ida y vuelta incluido).
- ✅ Horneado RBR protegido contra texturas negras.
- ✅ Auditoría de texturas dentro del ZIP.
- ✅ Decodificador DDS con errores explícitos.

## 6. Validación ejecutada

- `node tests/editor_textos.test.js` → OK.
- `node tests/texturas_export.test.js` → 7/7 OK (DDS DXT1, endpoints, ida y vuelta, RBR sin máscara,
  RBR con máscara vacía, DDS cortado, DDS con dimensiones imposibles).
- `python build.py` → `index.html` regenerado (`2026.11.20+214dc83`).
- Exportación AC real en navegador: ZIP de 31 archivos, 3.937.043 bytes,
  `content/tracks/bench/bench.kn5` con firma `sc6969`, `AUDITORIA_TEXTURAS.txt` con 0 errores y
  0 avisos, sin errores en consola.
- Exportación RBR real en navegador: ZIP de 45 archivos, 4.820.151 bytes, 3 texturas DDS
  (`asphalt.dds` con cabecera `DXT1`, 174.888 bytes) y `rbr_datos.json`, sin errores en consola.

## 7. Limitaciones / pendiente

1. **Sin simulador:** no hay RBR ni Assetto Corsa instalados. Compatibilidad visual en juego **no validada**.
2. El benchmark es de CPU sobre geometría sintética; no mide FPS reales. El entorno de navegador
   es headless y no expone GPU fiable.
3. El piso de 75 % en `rbrBakeChan` cambia la apariencia respecto del horneado anterior cuando la
   máscara era muy oscura: es una decisión deliberada para evitar tramos negros; conviene comparar
   en juego antes de considerarlo definitivo.
4. `docs/benchmark_*.json` son mediciones de una máquina; repetir `node tools/benchmark_opt.js`
   para comparar en otro equipo.
5. Push/PR pendientes de credenciales de GitHub en este entorno (no hay `gh`, `GITHUB_TOKEN` ni
   sesión `opencode auth`).
