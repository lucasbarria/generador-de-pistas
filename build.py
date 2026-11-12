# Arma index.html (la app de un solo archivo) a partir de src/.
# Uso: python3 build.py
from pathlib import Path
s = Path(__file__).parent / 'src'
core = (s / 'core.js').read_text(encoding='utf8').replace("if (typeof module !== 'undefined') module.exports = Core;", '')
html = (s / 'template.html').read_text(encoding='utf8').replace('/*CORE*/', core).replace('/*APP*/', (s / 'app.js').read_text(encoding='utf8'))
(Path(__file__).parent / 'index.html').write_text(html, encoding='utf8')
print('index.html listo')
