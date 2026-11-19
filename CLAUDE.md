# Reglas fijas del proyecto (Generador de Pistas · AC / RBR)

- Responder en español, informes cortos (qué se hizo, resultado, qué falta, qué se necesita). Detalle largo → `REPORT/`.
- Al empezar: leer `ESTADO_PROYECTO.md`; no re-explorar el repo. Actualizarlo al cerrar cada tarea (≤150 líneas).
- No inventar medidas: valores PROVISIONAL o ESTIMADO_DE_FOTOS, con el método.
- Exportar ≠ validar en simulador. Validar en la vista web y en AC (con CSP cuando esté instalado).
- Fotos originales del usuario: nunca modificarlas ni borrarlas. Las del repo van sin GPS.
- Commits como `Lucas Barria <lucasbarria@users.noreply.github.com>` + líneas Co-Authored-By/Claude-Session. Push solo cuando se pide; antes de pushear a `main`, `git fetch` y unir lo que haya (otros también suben a main).
- Texturas/fotos del repo por Git LFS (`presets/**`). No subir ZIP/kn5/exports.
- RBR: no pisar los stages 7001–7005.
- Explorador de archivos y cmd en la PC: solo clic, nunca escribir. No instalar nada sin avisar.
- Ahorro de tokens: grep/sed en vez de leer archivos enteros; salida larga a archivo + resumen; capturas ≤1280 px en un panel; iteraciones chicas; si algo falla 2 veces igual, parar y explicar; sin subagentes salvo aviso.
- El sandbox no puede dibujar la pista completa (Chrome muere por memoria ~1,7 GB): validar en el navegador integrado de la PC del usuario (página en example.com + document.write del index de la rama; GPX guardado en localStorage `__RG`).
