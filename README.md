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

## Cómo modificarla
El código está en `src/`:
- `src/core.js` — geometría: camino, terreno, árboles, piedras.
- `src/app.js` — mapa, datos, texturas, objetos, exportación `.kn5`.
- `src/editor3d.js` — edición directa en la vista 3D: selección, manijas, actualización en vivo y perfil sincronizado.
- `src/template.html` — la página y los controles.

Después de cambiar algo en `src/`, corré `python3 build.py` para regenerar `index.html` y subí los dos.

## Datos
Mapa y calles © colaboradores de OpenStreetMap (OpenFreeMap). Imágenes satelitales y mapa base © Esri. Elevación: Terrain Tiles (AWS / Mapzen).
