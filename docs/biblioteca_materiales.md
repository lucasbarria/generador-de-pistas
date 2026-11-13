# Biblioteca de materiales de AC — análisis y uso

Las texturas **no están en este repositorio** (son de terceros: un tramo de rally finlandés). Se cargan en cada compu desde
*Avanzado / Materiales → Pack de texturas DDS → Elegir carpeta*, quedan guardadas solo en el navegador y la app las reconoce por el nombre.

## Cómo está armado el tramo original
- **Terreno**: técnica ksMultilayer. `Ground_XX_diff` es luz y sombra horneadas de un sector de *su* mapa (gris), `Ground_XX_mask`
  es el mapa de materiales pintado a mano para ese sector (R/G/B/A = 4 suelos). Los detalles que repite son las texturas chicas de abajo.
- **Taludes**: `Penkka_XX_mask` igual que el terreno, pintadas para sus taludes.
- **Camino**: tiras a lo largo (`Road_Plate1`, familia `Rajatievix`) con huellas, bordes con pasto y pozos pintados, más máscara multicapa y normal.

Las máscaras y sombras están hechas para la geografía de ese tramo: **no sirven para otras rutas**. Lo que se reutiliza es la técnica
(la app genera su propia máscara por sector) y los detalles repetibles.

## Clasificación (por nombre)
| Rol en la app | Archivos | Uso |
|---|---|---|
| `det_grass` (detalle pasto) | Ruoho_02 ★, Grass_01, Ruoho_03, Ruoho_01, Pelto, kulunut_leikattu | canal R del terreno, banquinas |
| `det_forest` (suelo de bosque) | Mustikkapohja2 ★, mustikka4_metsa, Mustikkapohja4, Metsa_02 | canal G del terreno |
| `det_dirt` (tierra) | Maasto_02 ★, Maasto_01 | canal B del terreno, tierra/barro del camino |
| `det_rock` (roca) | Kallio ★, Kallio6, kivet (atlas 3×3) | canal A del terreno |
| `det_road` (ripio) | gravel_01_detail ★, Rajatievix_detail, Sora | detalle fino del camino |
| `det_ditch` (cuneta) | oja | cuneta |
| `grass` · `side_a` · `forest` · `side_c` (colores base) | Grass_02 · Ruoho_P01 · Metsa_google · Ruoho_P02 | pasto, talud verde, suelo de bosque, talud seco |
| `bank` (próxima etapa) | tienpenkka_4/6/7, ojanpenkka(4), ruotsipenkka, kallioleikkaus2 (+ _NM) | caras de talud y cortes de roca |
| `brake` (próxima etapa) | lapinakyva_jarrutus(2) | marcas de frenada solo en zonas de frenada |
| no se usa | Ground_*, Penkka_* (máscaras de su mapa), Road/Risteys plates (próxima etapa), otpo/otpt/ttpo (atlas de objetos y vehículos), carteles, buzones, postes, cintas, agua, treewall/mantymetsaa/horisontti (bosque boreal de pino y abeto, no lenga) | — |

★ = el que se elige primero cuando hay varios del mismo rol.

No hay mapas separados de rugosidad, altura ni oclusión: en AC eso va en los canales de la máscara y en el normal.

## Formatos
DXT5 (90), RGBA sin comprimir (29), DXT1 (7), DXT3 (6). En DXT3/DXT5 el bloque de color usa siempre 4 colores.
