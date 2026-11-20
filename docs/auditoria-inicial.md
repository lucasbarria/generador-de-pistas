# Auditoría inicial — transformación a reconstructor de tramos reales

Fecha: 2026-11-20. Rama: `reconstructor/real-stages`. Auditoría anterior a cualquier modificación de código.

## 1. Arquitectura existente

- `index.html` es un **artefacto generado**: `build.py` incrusta `core.js`, `rgmask.js`, `app.js`, `editor3d.js`, `objetos.js`, `entorno.js`, los parámetros físicos y los archivos RBR. Nunca se edita a mano.
- `src/core.js` contiene la geometría pura: proyección local, remuestreo, tangentes, `buildRoute` con caché (`155-172`), mallas de camino/terreno y exportación OBJ.
- `src/app.js` concentra estado (`S`, `17-23`), mapa Leaflet, captura de clics, elevación, texturas, generación y exportadores.
- `src/editor3d.js` maneja ediciones con snapshots `edSnap/edPushUndo/edConfirm/edCancel` (`159-201`) y actualización en vivo. El historial es transaccional y puede reutilizarse para correcciones reversibles.
- `src/template.html` define la UI lateral y carga Leaflet, Three.js y JSZip desde CDN.
- No hay `package.json` ni suite npm; el test existente es `tests/editor_textos.test.js` y pasa con `node --test`.

## 2. Lo que ya funcionaba y se reutiliza

| Capacidad | Ubicación | Uso en la reconstrucción |
| --- | --- | --- |
| Mapa y selección de calles reales | `app.js:236-501`, OSM/OpenFreeMap | Elegir tramo sin GIS |
| Importación GPX/KML/GeoJSON/CSV y GPS GoPro | `app.js:5327-5442` | Mantener; se mejoró GPX/KML con el parser nuevo |
| Búsqueda de alternativas por caminos reales | `app.js:2872-2915` | Proponer tramos sin inventarlos |
| Descarga de DEM y reconstrucción base | `app.js:2069-2115` | Ya genera relieve real; se conserva |
| Máscaras de ripio/cuneta/talud | `rgmask.js:76-124`, `config/parametros_fisicos.json` | Base para fidelidad geométrica |
| Undo/redo del editor 3D | `editor3d.js:159-380` | Base para correcciones IA reversibles |
| Materiales y exportación AC | `app.js:1448,1833,1924,5491-5573` | Exportador completo `.kn5` |
| Exportación RBR | `app.js:4683-4756`, `tools/rbr/` | Flujo local con Blender 4.5 + addon |
| Anclaje OSM/DEM lejano | `entorno.js:19-145` | Ya consulta Overpass y DEM para horizonte |

## 3. Deudas y componentes que faltaban

- **Guardado**: `projectState/loadProject` (`app.js:5671-5719`) guarda inputs, grafo, GPS, ediciones y vista, pero no procedencia/confianza, elevación por muestra ni evidencia fotográfica. No validaba versión.
- **PBR**: `docs/biblioteca_materiales.md` afirma que no hay mapas separados, pero `MANIFIESTO.csv:178-194` y el preset sí los listan. Los `_ao_rough_h` **no se consumen**: solo se generan normales desde el albedo (`app.js:3992-4013`). Es PBR aproximado por capas, no AO/rugosidad medidos.
- **Fotos**: `PHOTOS` está vacío y `renderPhotoPanel/REFS.calibrate` son remnants inactivos (`app.js:1396-1431,4048`). La ayuda prometía Wikimedia/Panoramax/Mapillary, pero no había clients reales; Mapillary solo guardaba token y abría el visor web (`app.js:5911-5932`).
- **Vegetación**: `obSpecies` elige especie con `Math.random()` (`objetos.js:162-166`); no mapea `natural=wood`/`landuse` de OSM. Hay anclaje geo real, pero la especie no responde a él.
- **Geografía**: Overpass funciona pero el endpoint público se saturó con una consulta de caminos (502). No es fallo del código; requiere retry/backoff o instancia propia para cargas altas.
- **Medidas físicas**: `config/parametros_fisicos.json:2` las marca PROVISIONALES. No deben presentarse como medidas del tramo real.

## 4. Decisión de implementación del primer hito

No se migró nada a Blender ni se reemplazó el generador. Se agregó una capa `src/recon/` encima del estado existente y se extendió el JSON de proyecto con un campo `recon`. Así el flujo anterior queda intacto y los proyectos viejos se convierten al cargarlos.
