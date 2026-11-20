# Generador de Pistas

Recreá cualquier camino real desde el mapa y exportalo a **Assetto Corsa** (`.kn5` listo para Content Manager) o como referencia para **Richard Burns Rally**.

**Usar la app:** abrí `index.html` en Chrome o Edge (necesita internet), o entrá al link de GitHub Pages del repositorio.

## Qué hace
- Elegís el tramo cruce por cruce, con puntos libres o importando el GPS de una GoPro / GPX.
- Elevación real, cunetas, banquinas, piedras y peralte.
- Vegetación y bosque según la foto satelital; ripio y pasto automáticos según la zona (bosque o estepa).
- Casas y estancias (mapa + techos detectados en el satélite), alambrados y tranqueras.
- Largada con pancarta y reloj, control horario 30 m antes, llegada y control stop 30 m después.
- Editor del camino (perfil, superficies, zonas resbaladizas, nieve), arrastre de curvas en 3D y notas de ruta.
- Objetos a mano en la vista 3D: pincel de árboles (densidad, especie y altura), goma, casas, galpones, personas, público, piedras, puentes y lagos.
- **Proyectos de reconstrucción** (etapa nueva): ancla geográfica verificada, importación GPX/KML/GeoJSON, elevación con procedencia declarada y búsqueda real de fotos en Wikimedia Commons y Panoramax.

## Reconstrucción de tramos reales

En el panel **0 · Proyecto de reconstrucción** podés crear un proyecto, cargar el piloto **Aguas Blancas · Tolhuin** y seguir el flujo:

1. Elegir o importar el recorrido con las herramientas del paso 1 (no se inventa trazado).
2. Descargar alturas reales del recorrido desde Open-Meteo (Copernicus DEM GLO-90, 90 m).
3. Importar un GeoTIFF local: se registra CRS, unidades, resolución, NoData y procedencia; es base del terreno, no genera cunetas ni baches.
4. Buscar fotos reales (Commons / Panoramax y, con Client Token, Mapillary v4) y revisarlas antes de usarlas como referencia. Las fotos aprobadas solo asocian materiales y vegetación ya existentes: no se derivan texturas ni PBR.
5. Consultar OpenStreetMap con Overpass resiliente y usar correcciones asistidas: se planifican, se pueden comparar y se deshacen.
6. Guardar / abrir el proyecto: el JSON mantiene coordenadas, fuentes, confianza, evidencia y rasters.

El generador clásico sigue funcionando igual; los proyectos viejos se convierten automáticamente al formato nuevo. Ver `docs/auditoria-inicial.md`, `docs/arquitectura-reconstruccion.md`, `docs/piloto-aguas-blancas.md` y `docs/REAL_STAGE_RECONSTRUCTION_PHASE_2.md`.

## Cómo modificarla
El código está en `src/`:
- `src/core.js` — geometría: camino, terreno, árboles, piedras.
- `src/app.js` — mapa, datos, texturas, objetos, exportación `.kn5`.
- `src/editor3d.js` — edición directa en la vista 3D: selección, manijas, actualización en vivo y perfil sincronizado.
- `src/objetos.js` — objetos puestos a mano (árboles con pincel, casas, personas, piedras, puentes, lagos) y navegación simple (mapa chico, botones, barra de km).
- `src/template.html` — la página y los controles.
- `src/recon/` — modelo de proyecto, GPX/KML/GeoJSON, DEM, GeoTIFF local, evidencia, clientes Mapillary/Overpass y correcciones asistidas.

Después de cambiar algo en `src/`, corré `python3 build.py` para regenerar `index.html` y subí los dos.

Pruebas: `node --test tests/*.test.js`.

## Datos
Mapa y calles © colaboradores de OpenStreetMap (OpenFreeMap). Imágenes satelitales y mapa base © Esri. Elevación: Terrain Tiles (AWS / Mapzen) y Copernicus DEM GLO-90 vía Open-Meteo. Fotos: Wikimedia Commons y Panoramax según la licencia de cada imagen.
