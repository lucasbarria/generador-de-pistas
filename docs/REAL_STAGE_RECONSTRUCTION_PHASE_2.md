# Reconstrucción de tramos reales — Etapa 2

Fecha: 2026-11-20. Rama: `reconstructor/real-stages`.

Esta etapa convierte evidencia real en terreno, materiales y vegetación dentro del motor existente. No reemplaza `src/core.js`, no publica releases y no inventa geografía, fotos ni mediciones. El generador clásico sigue funcionando igual.

## 1. Qué quedó implementado

### 1.1 GeoTIFF local como base geográfica

- `src/recon/geotiff.js` abre GeoTIFFs locales con `geotiff@2.1.3` y `proj4@2.15.0` vendorizados en `src/vendor/` (licencias incluidas).
- Se registran `CRS`, `EPSG`, unidades horizontales y verticales (`VerticalUnitsGeoKey = 4099`), resolución en metros, `NoData`, tamaño de raster, huella/procedencia y avisos de calidad.
- `sampleRaster()` muestrea el recorrido y devuelve alturas con `rasterId`, `source.kind='geotiff'` y `layer='geographic-base'`.
- `attachRaster()` guarda `elevation.rasters[]`, marca `elevation.geographicBase` y fija `provider='geotiff-local'`.
- La UI (`#reconTif`) lee el archivo sin subirlo, muestra `rasterSummary()` y los avisos de `meta.quality`, e intenta además alimentar el lector legacy `DEM.custom` para que la malla 3D use la misma base. Si el lector simple falla, el raster queda documentado y se avisa que la malla no cambió.
- Un GeoTIFF es **solo base del terreno**: no genera cunetas, roderas ni baches, y no sustituye mediciones del camino.

No hay archivos `.tif/.tiff` reales en el repo. Las pruebas usan rasters sintéticos etiquetados `SYNTHETIC TEST DATA` y no son evidencia de Aguas Blancas.

### 1.2 Fotos revisadas → materiales y vegetación

- `src/recon/evidence.js` gestiona revisión humana con `reviewer`, licencia, coordenadas o zona, sector opcional en km y decisión aprobada/rechazada.
- `visualVerified` nunca se activa solo por aprobar: debe declararse explícitamente que la foto se revisó visualmente.
- Política de licencias: CC0, CC BY, CC BY-SA y dominio público permitidas; Mapillary Terms excluidos por defecto y habilitables solo con aceptación explícita del revisor.
- `deriveMaterials()` solo reutiliza materiales/presets que ya existen en el repo (`PRESET_ID = ripio_rio_grande`). `textureDerivation='none-reviewed-assignment'` y `generatedTextures=0`: no se derivan texturas, normales, AO ni mapas PBR desde fotos.
- `deriveVegetation()` distingue `identified` (especie declarada en OSM y presente en el catálogo), `estimated` (cobertura por etiqueta OSM/revisión sin especie) y `procedural` (fallback del generador). `density` y `patchiness` son parámetros de distribución, nunca conteos medidos.
- El botón **Aplicar evidencia a la vista 3D** pide confirmación y solo cambia el preset de piso cuando todos los materiales derivados pertenecen a un único preset reconocido, o la densidad cuando hay vegetación derivada. Cada cambio queda en `project.changes[]`.

### 1.3 Servicios externos reales

- `src/recon/networks.js` implementa Mapillary Graph API v4 REST (`https://graph.mapillary.com/images`, `Authorization: OAuth <token>`) con paginación por `after`, caché, errores GraphQL y manejo de 429.
  - Sin token: `status='pending-client'`, `photos=[]`, sin llamadas de red y sin resultados simulados.
  - El token se lee de `options.token`, `globalThis.MLY_TOKEN`, `process.env.MLY_TOKEN` o `localStorage.mlyToken`; en la UI se guarda solo en el navegador.
  - `src/recon/photos.js` delega el proveedor `mapillary` a este cliente; dejó de describirlo como no implementado.
- Overpass consulta OpenStreetMap en sectores pequeños con reintentos, backoff y caché. Distingue:
  - `service-error` para 5xx, timeout o fallo de red: **no** se afirma que no haya datos.
  - `empty-result` para HTTP 200 con `elements: []`: ausencia confirmada por el servicio.
- Los resultados OSM con coordenadas se guardan como `e.osmFeatures` y pueden alimentar vegetación estimada por etiqueta, nunca una especie inventada.

### 1.4 Correcciones asistidas reversibles

- `src/recon/assist.js` detecta problemas con evidencia citada y scope en metros: perfiles inconsistentes, cobertura vegetal discrepante, taludes artificiales, material/textura discordante y transiciones abruptas.
- `planFix()` no muta el proyecto; propone una única acción dentro del scope y registra `confidence`, `before` y `after`.
- `applyFix()` valida que el scope esté dentro de la ruta, exige un engine con `snapshot()`/`applyLocal()`/`restore()` y guarda un token de deshacer.
- `compareFix()` muestra alturas y ediciones dentro/fuera del scope; `undoFix()` restaura exactamente el snapshot previo.
- El adaptador de `src/app.js` traduce las acciones a ediciones reales de `S.edits`:

| Acción del asistente | Edición del generador | Regla |
| --- | --- | --- |
| `set-profile` | `flat` / `grade` | Según `Δh`; sin inventar alturas nuevas. |
| `set-slope` | `section` con `talud` | Dentro del rango configurado. |
| `set-surface` / `set-material` | `surface` con clave `SURF` | Solo si la clase de material tiene equivalente verificado. |
| `blend-materials` | `floor` | Transición `ripio`/`pedregoso` con longitud limitada. |
| `set-vegetation` | zona en `e.vegetation` | Cobertura observada/estimada con parámetros de distribución explícitos. |

Nada se aplica automáticamente: hay que planificar y confirmar. La vista 3D se actualiza solo si ya existe una pista generada; si no, la edición queda registrada y se avisa.

### 1.5 Mapas `*_ao_rough_h` y PBR

- `tools/inspect_ao_rough_h.js` decodifica los cuatro PNG reales de `presets/pisos/ripio_rio_grande/texturas/` sin dependencias externas y mide R/G/B.
- `docs/manifiesto_canales_ao_rough_h.json` conserva tamaño, SHA-256, estadísticas reales y correlaciones. Declara `semantics.status = 'unknown'`: el nombre sugiere AO/rugosidad/altura, pero falta `texturas_v5.json` y cualquier contrato que demuestre qué canal es cuál.
- Al cargar el preset, `reportAoRoughH()` lee los píxeles de esos mapas, mide R/G/B y compara con el manifiesto. Es un **consumo diagnóstico**, no una conversión PBR.
- No se afirma PBR implementado: no hay `aoMap`/`roughnessMap`/`metalnessMap`, no hay `MeshStandardMaterial`, y los slots `.kn5` verificados son `txDiffuse`, `txNormal`, `txMask`, `txDetailR/G/B/A` y `txDetailNM`. `PACK.classify` sigue asignando rol `none` a estos PNG.

## 2. Integración en la app

- `projectState()` y `loadProject()` usan `Recon.normalizeProjectWithEvidence()` para no perder `project.evidence` al guardar, autoguardar o abrir.
- `renderReconPanel()` muestra rasters, revisiones, resumen de evidencia, estado Mapillary/Overpass y el panel de asistencia.
- `build.py` incrusta vendor → módulos `recon` → `rgmask.js` → `app.js` → editor/objetos/entorno. También inyecta el manifiesto AO en `AO_ROUGH_MANIFEST`.
- `index.html` es el artefacto generado; no se edita a mano.

## 3. Estado de Aguas Blancas

- Único dato geográfico real del piloto: ancla OSM verificada `node/6987631224`, `-54.6266558, -67.2432701`, fuente OpenStreetMap/Nominatim.
- No existe todavía el tramo real: el GPX sintético anterior no es evidencia. El recorrido debe importarse de una fuente real o marcarse en el mapa.
- No hay GeoTIFF real del lugar, ni token de Mapillary configurado, ni fotos revisadas de Aguas Blancas en este repo.

## 4. Verificación ejecutada

```
node --check src/app.js
node --check src/recon/*.js
python build.py
node --test tests/
git diff --check
```

Resultado: **41/41 pruebas OK**. Se validó además en navegador real por HTTP (`python -m http.server`) que:

- `Recon.openGeoTIFF`, `statusMapillary`, `summaryEvidence` y `detectIssues` están disponibles.
- El piloto carga sin errores de consola y muestra el ancla real con el recorrido vacío.
- El estado Mapillary sin token es `pending-client` y muestra el endpoint v4.
- El flujo planificar → aplicar → comparar → deshacer funciona y restaura `S.edits`.
- `reportAoRoughH()` lee, mide y compara con el manifiesto sin create slots PBR.

Las pruebas con rasters, recorridos o fotos de validación están etiquetadas `SYNTHETIC TEST DATA` y se usaron solo en memoria; no se guardaron como datos del piloto.

## 5. Límites y pendientes

- Configurar un Mapillary Client Token de forma segura para consultar fotos reales; aceptar los términos solo si el revisor decide usarlas.
- Obtener un GeoTIFF real de la zona y un tramo GPX/medido antes de afirmar fidelidad de Aguas Blancas.
- Conseguir `texturas_v5.json` o una declaración del autor con la semántica R/G/B/A para poder evaluar PBR real.
- La exportación `.kn5` no tiene slots AO/roughness/metalness verificados: no se promete ese efecto en AC.
- Los datos OSM son referencia externa con su propia licencia; cada foto requiere revisión humana antes de aprobarla.
