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
- `src/recon/photos.js` — Commons geosearch y Panoramax STAC bbox; Mapillary queda `pending-client`.

`build.py` incrusta estos módulos antes de `app.js`; el alias corto `Recon` está disponible para la UI.

## Integraciones externas

| Servicio | Estado | Uso | Observación |
| --- | --- | --- | --- |
| Open-Meteo Elevation | Real, sin credenciales | Alturas del recorrido | Copernicus DEM GLO-90, 90 m; endpoint público **no comercial**. Atribución y DOI en la respuesta. |
| Wikimedia Commons | Real, sin credenciales | Fotos georreferenciadas | `generator=geosearch` + `imageinfo`, licencia por archivo. |
| Panoramax | Real, sin credenciales | Fotos georreferenciadas | `/api/search?bbox=...` STAC. En Aguas Blancas devolvió 0. |
| Mapillary | **Pendiente** | No implementado | Requiere Client Token y cliente GraphQL. Guardar el token no activa búsqueda. |
| Overpass | Real pero frágil | Calles/objetos | El endpoint público devolvió 502 en una consulta amplia; el generador ya continúa sin esos datos. |

## Límites honestos

- La elevación de 90 m no sustituye un levantamiento topográfico ni reproduce cunetas.
- Las fotos se guardan como evidencia; `visualVerified=false` hasta revisión humana.
- El piloto no incluye un tramo real importado: solo el ancla verificada.
- El undo/redo actual cubre ediciones del generador; las correcciones IA del siguiente hito deben apoyarse en ese mismo mecanismo.
- No se amplió el consumo de `_ao_rough_h`: primero hay que auditar/validar los assets ausentes (`texturas_v5.json`, permisos DDS).
