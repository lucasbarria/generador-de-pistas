# Arma index.html (la app de un solo archivo) a partir de src/.
# Uso: python3 build.py
# También escribe version.json y mete los datos de compilación en la app (BUILD): id = huella del código fuente,
# fecha de compilación y commit de GitHub sobre el que se compiló. Nada de esto se escribe a mano.
import hashlib, json, subprocess, datetime
from pathlib import Path
root = Path(__file__).parent
s = root / 'src'
core = (s / 'core.js').read_text(encoding='utf8').replace("if (typeof module !== 'undefined') module.exports = Core;", '')
app = (s / 'app.js').read_text(encoding='utf8') + '\n' + (s / 'editor3d.js').read_text(encoding='utf8') + '\n' + (s / 'objetos.js').read_text(encoding='utf8')
tpl = (s / 'template.html').read_text(encoding='utf8')
# archivos del paquete para Richard Burns Rally (tools/rbr): van dentro de la app, se agregan al ZIP si se pide
rbr = {f.name: f.read_text(encoding='utf8') for f in sorted((root / 'tools' / 'rbr').glob('*')) if f.suffix.lower() in ('.py', '.bat', '.txt')}
app = app.replace('/*RBR_FILES*/null', json.dumps(rbr, ensure_ascii=False).replace('</', '<\\/'))
html = tpl.replace('/*CORE*/', core).replace('/*APP*/', app)
bid = hashlib.sha1(html.encode('utf8')).hexdigest()[:12]
try: base = subprocess.run(['git', '-C', str(root), 'rev-parse', 'HEAD'], capture_output=True, text=True).stdout.strip()
except Exception: base = ''
# la fecha solo cambia si cambió el código (así recompilar sin cambios no ensucia el repo)
vf = root / 'version.json'
old = json.loads(vf.read_text()) if vf.exists() else {}
if old.get('id') == bid: info = old
else:
    now = datetime.datetime.now(datetime.timezone.utc)
    info = {'id': bid, 'date': now.strftime('%Y-%m-%dT%H:%M:%SZ'), 'version': now.strftime('%Y.%m.%d') + '+' + bid[:7], 'base': base}
vf.write_text(json.dumps(info, indent=1) + '\n', encoding='utf8')
html = html.replace('/*BUILD*/null', json.dumps(info))
(root / 'index.html').write_text(html, encoding='utf8')
print('index.html listo ·', info['version'])
