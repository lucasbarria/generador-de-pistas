# Piloto: Aguas Blancas, Tolhuin, Tierra del Fuego

Estado al 2026-11-20. Este documento separa dato verificado de dato pendiente.

## Dato verificado

- Ancla consultada en Nominatim el 2026-11-20:
  - nombre: `Aguas blancas`
  - tipo: `amenity=parking`, sobre Ruta Provincial 27, Municipio de Tolhuin, Departamento Tolhuin, Tierra del Fuego, Argentina
  - coordenadas: `-54.6266558, -67.2432701`
  - fuente: `https://www.openstreetmap.org/node/6987631224` (OSM, ODbL)
- El botón **Cargar piloto Aguas Blancas** coloca esa ancla, centra el mapa y rellena el campo de inicio. **No crea ni dibuja un recorrido**.
- Wikimedia Commons devolvió 3 fotos georreferenciadas a ~121 m del ancla (archivos `Ushuaia, Tierra del Fuego, Argentina - panoramio - Cayetano Roso (6..8).jpg`, licencia CC BY 3.0, autor Cayetano Roso). Se guardan como evidencia con `visualVerified=false`: todavía no se afirmó que muestren el tramo.
- Panoramax devolvió 0 fotos en el bounding box de 1 km alrededor del ancla.
- Open-Meteo respondió alturas reales para las coordenadas consultadas; la resolución declarada es 90 m (Copernicus DEM GLO-90).

## Trabajo anterior reutilizable

- `AB_REF`/`PHOTOMAT` (`app.js:3556+`): medidas de materiales tomadas de fotografías de Street View aportadas por el usuario, activadas por cercanía a `-54.592,-67.230`. Son calibración visual de ripio, no prueba geográfica del tramo: el repo **no incluye esas imágenes ni su GPS**.
- Presets de Río Grande y sus fotos de referencia locales: útiles como comparación de materiales, no como geografía de Aguas Blancas.
- Geometría, materiales y exportadores AC/RBR existentes.

## Datos que faltan y cómo conseguirlos

1. **Trazado real del tramo**: GPX/KML del usuario, track de cámara/GoPro o dibujo sobre satélite confirmado en campo. No se genera automáticamente.
2. **Inicio y final exactos**: marks GPS o referencias fotográficas verificadas.
3. **Elevación de mayor detalle**: MDE-Ar del IGN, dron o LiDAR. El importador GeoTIFF existente (`demFile`) ya puede cargarla; falta registrar su resolución y procedencia en el modelo `recon`.
4. **Ancho real, banquinas y cunetas**: medición en campo o foto con escala. Hoy los valores del config están marcados PROVISIONALES.
5. **Fotos del camino**: las del usuario con GPS y licencia conocida; revisar las de Commons para decidir si realmente muestran este tramo. Panoramax/Mapillary no aportan datos en este momento.
6. **Validación en simulador**: comparación contra video/GPS real, pendiente hasta importar el tramo definitivo.

## Prueba realizada (no incorporada al piloto)

Se importó un GPX sintético de 3 puntos cerca del ancla solo para verificar el flujo completo en navegador: importación → elevación → fotos → guardado → recuperación. Ese recorrido **no forma parte del piloto** y sus alturas no deben citarse como datos de Aguas Blancas.
