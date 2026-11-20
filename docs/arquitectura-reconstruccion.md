# Arquitectura de reconstrucción — primer hito

## Decisión general

Arquitectura híbrida, web primero:

- La app de un solo archivo sigue siendo la interfaz principal.
- `src/core.js` sigue siendo el motor de geometría; no se duplica.
- Los servicios geográficos se integran como componentes internos con clientes explícitos.
- Blender sigue siendo opcional y local para RBR; no es obligatorio ni se migró la app a él.
- Ninguna función real fue reemplazada por simulación: donde un servicio no está implementado, la UI lo dice.

## Tres dimensiones separadas

| Dimensión | Datos del hito 1 | Estado |
| --- | --- | --- |
| A. Fidelidad geográfica | Ancla OSM verificada, GPX/KML/GeoJSON, recorrido dibujado en mapa, bbox | Operativa. El tramo se mide o se dibuja; nunca se genera un tramo falso automáticamente. |
| B. Fidelidad geométrica | Alturas por punto desde Copernicus GLO-90 (90 m), más el DEM previo de 30 m del generador | Operativa con resolución declarada. No representa cunetas ni baches. |
| C. Fidelidad visual | `AB_REF`/`PHOTOMAT`, materiales internos, PBR por capas, vegetación procedural | Reutilizada sin cambios de calidad. Queda pendiente conectar fotos revisadas a materiales y especies. |

## Modelo de datos

`recon-project` v1, guardado dentro del JSON de proyecto del generador (`campo recon`):

```
stage.anchor        → lat/lon + fuente verificada + confianza
route.points[]      → lat, lon, ele, time, name, provenance, confidence, source
route.source        → archivo/map/OSM, fecha, número de puntos originales
elevation.samples[] → lat, lon, elevation, provenance, source(dataset/resolución/URL)
photos[]            → URL, licencia, autor, coordenadas, visualVerified=false por defecto
changes[]           → registro de correcciones, reversible=true por defecto
validation          → state, checkedAt, issues[]
```

Provenancia: `measured`, `observed`, `estimated`, `generated`. Ninguna estimación se presenta como dato medido. La confianza por defecto es `0.9 / 0.7 / 0.35 / 0.15` respectivamente y puede ajustarse por dato.

Precisión: no se aplica `toFixed` a lat/lon en el modelo ni en el importador. Se conserva la precisión representable por IEEE-754 doble; la conversión a claves `f:lat,lon` del generador usa `Number.toString()`.

## Módulos nuevos

- `src/recon/model.js` — esquema, normalización, roundtrip, validación, conversión desde el estado anterior.
- `src/recon/formats.js` — GPX (trkseg/rtept/wpt), KML (LineString/gx:Track) y GeoJSON con rutas separadas y precisión conservada.
- `src/recon/dem.js` — Open-Meteo Elevation API, lotes de 100, caché y procedencia por muestra.
- `src/recon/photos.js` — Commons geosearch y Panoramax STAC bbox; para Mapillary delega en `networks.js` y queda `pending-client` sin token.
- `src/recon/geotiff.js` — GeoTIFF local con CRS/unidades/NoData, muestreo y perfiles con procedencia.
- `src/recon/evidence.js` — revisión de fotos, licencias, materiales existentes y vegetación identificada/estimada/procedural.
- `src/recon/networks.js` — Mapillary Graph API v4 REST y Overpass resiliente (service-error vs empty-result).
- `src/recon/assist.js` — detección, planes, aplicación y deshacer de correcciones dentro de un scope.

`build.py` incrusta estos módulos antes de `app.js`; el alias corto `Recon` está disponible para la UI.

## Integraciones externas

| Servicio | Estado | Uso | Observación |
| --- | --- | --- | --- |
| Open-Meteo Elevation | Real, sin credenciales | Alturas del recorrido | Copernicus DEM GLO-90, 90 m; endpoint público **no comercial**. Atribución y DOI en la respuesta. |
| Wikimedia Commons | Real, sin credenciales | Fotos georreferenciadas | `generator=geosearch` + `imageinfo`, licencia por archivo. |
| Panoramax | Real, sin credenciales | Fotos georreferenciadas | `/api/search?bbox=...` STAC. En Aguas Blancas devolvió 0. |
| Mapillary | Real con Client Token | Fotos georreferenciadas | Graph API v4 REST (`Authorization: OAuth`). Sin token: `pending-client`, sin red y sin simulaciones. |
| Overpass | Real y resiliente | Calles/objetos | Sectores pequeños, reintentos y caché. `service-error` no se reporta como ausencia de datos; `empty-result` solo con HTTP 200 y lista vacía. |

## Límites honestos

- La elevación de 90 m no sustituye un levantamiento topográfico ni reproduce cunetas.
- Las fotos se guardan como evidencia; `visualVerified=false` hasta revisión humana.
- El piloto no incluye un tramo real importado: solo el ancla verificada.
- El undo/redo cubre ediciones del generador; las correcciones asistidas se apoyan en ese mismo mecanismo con `snapshot()`/`applyLocal()`/`restore()` y scope validado.
- Los PNG `*_ao_rough_h` se leen y miden como diagnóstico (`docs/manifiesto_canales_ao_rough_h.json`), pero su semántica de canales sigue siendo desconocida: no se afirma PBR ni se crean slots AO/roughness en `.kn5`.

## Actualización Etapa 2

El detalle de integración, pruebas y límites está en `docs/REAL_STAGE_RECONSTRUCTION_PHASE_2.md`. Incluye GeoTIFF local, evidencia revisada → materiales/vegetación, Mapillary v4, Overpass resiliente y correcciones asistidas reversibles.
