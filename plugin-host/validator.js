'use strict';
// Analiza un plugin YA extraído (nunca lo ejecuta). Devuelve:
//   veredicto: 'bloqueado' (señales de robo de datos/malware → se borra)
//              'incompatible' (usa procesos/red/binarios: no se puede activar aquí; sus datos sí se pueden usar)
//              'advertencias' | 'limpio'
//   hallazgos, permisos pedidos, compatibilidad, contribuciones.
// Importante: es análisis por patrones. Detecta lo común y lo obvio, NO garantiza que algo sea seguro.
// Por eso el plugin además se ejecuta en un entorno aislado (runner.js).
const fs = require('fs');
const path = require('path');
const { API_SOPORTADA, API_SIN_SOPORTE_CONOCIDA } = require('./shim-api');

const MAX_JS = 6 * 1024 * 1024;

const PELIGRO = [
    { id: 'exfiltracion', re: /(discord(app)?\.com\/api\/webhooks|webhook\.site|requestbin|pipedream\.net|ngrok(-free)?\.(io|app|dev)|api\.telegram\.org\/bot|pastebin\.com\/raw|transfer\.sh|oast\.(fun|live|site|pro)|burpcollaborator|interact\.sh|canarytokens)/i, msg: 'Envía datos a un servicio de captura de datos (webhook/túnel)' },
    { id: 'minero', re: /(stratum\+tcp|xmrig|coinhive|cryptonight|minexmr)/i, msg: 'Parece un minero de criptomonedas' },
    { id: 'credenciales', re: /(\.ssh[\/\\]|id_rsa|id_ed25519|\.aws[\/\\]credentials|\.npmrc|\.git-credentials|\.docker[\/\\]config\.json|\.kube[\/\\]config|Login Data|Local State|wallet\.dat|\/etc\/(passwd|shadow))/, msg: 'Intenta leer archivos de credenciales o carteras' },
    { id: 'entorno-completo', re: /(JSON\.stringify\(\s*process\.env\s*\)|Object\.(keys|entries|values)\(\s*process\.env\s*\))/, msg: 'Copia TODAS las variables de entorno (donde viven las claves)' },
    { id: 'carga-oculta', re: /\b(eval|Function)\s*\(\s*(atob|Buffer\.from|unescape|decodeURIComponent)\s*\(/, msg: 'Ejecuta código escondido (decodifica y evalúa)' },
    { id: 'descarga-ejecuta', re: /(curl|wget)\s+[^'"`\n]{0,200}\|\s*(sh|bash|zsh)\b|powershell[^'"`\n]{0,40}-(enc|encodedcommand)\b/i, msg: 'Descarga y ejecuta programas' },
];

const INCOMPATIBLE = [
    { id: 'procesos', re: /require\(\s*['"](node:)?(child_process|cluster|worker_threads)['"]\s*\)/, msg: 'Lanza procesos del sistema (child_process/worker)' },
    { id: 'sockets', re: /require\(\s*['"](node:)?(net|tls|dgram|http2)['"]\s*\)/, msg: 'Abre conexiones de red de bajo nivel' },
    { id: 'lsp', re: /vscode-languageclient/, msg: 'Necesita un servidor de lenguaje externo (proceso aparte)' },
];

const AVISO = [
    { id: 'eval', re: /\b(eval\s*\(|new\s+Function\s*\()/, msg: 'Usa eval/new Function (común en paquetes empaquetados, pero se revisa)' },
    { id: 'red', re: /(\brequire\(\s*['"](node:)?https?['"]\s*\)|\bfetch\s*\(|XMLHttpRequest|new\s+WebSocket\s*\()/, msg: 'Hace peticiones de red', permiso: 'red' },
    { id: 'archivos', re: /\bfs\.(writeFile|appendFile|unlink|rm|rmdir|rename|mkdir|createWriteStream)/, msg: 'Escribe o borra archivos', permiso: 'archivos' },
    { id: 'portapapeles', re: /\bclipboard\b/i, msg: 'Accede al portapapeles', permiso: 'portapapeles' },
    { id: 'terminal', re: /\b(createTerminal|sendText)\b/, msg: 'Quiere controlar una terminal', permiso: 'terminal' },
    { id: 'entorno', re: /process\.env\.[A-Z_]*(TOKEN|SECRET|PASSWORD|API_?KEY|PRIVATE)/i, msg: 'Lee variables de entorno con aspecto de secreto' },
];

const BINARIOS = /\.(exe|dll|so|dylib|node|bat|cmd|ps1|sh|msi|jar|apk|scr|com)$/i;
const DATOS_EXT = new Set(['.json', '.tmlanguage', '.plist', '.md', '.txt', '.png', '.svg', '.jpg', '.gif', '.woff', '.woff2', '.ttf']);

function recorrer(dir, base = dir, salida = []) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isSymbolicLink()) continue;
        if (e.isDirectory()) recorrer(p, base, salida);
        else salida.push({ ruta: path.relative(base, p).replace(/\\/g, '/'), abs: p });
    }
    return salida;
}

// JSON con comentarios y comas finales (los temas de VS Code lo usan)
function jsonLaxo(txt) {
    const s = String(txt).replace(/^\uFEFF/, '');
    let out = '', i = 0, enStr = false;
    while (i < s.length) {
        const c = s[i], n = s[i + 1];
        if (enStr) { out += c; if (c === '\\') { out += n || ''; i += 2; continue; } if (c === '"') enStr = false; i++; continue; }
        if (c === '"') { enStr = true; out += c; i++; continue; }
        if (c === '/' && n === '/') { while (i < s.length && s[i] !== '\n') i++; continue; }
        if (c === '/' && n === '*') { i += 2; while (i < s.length && !(s[i] === '*' && s[i + 1] === '/')) i++; i += 2; continue; }
        out += c; i++;
    }
    return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1'));
}

function leerManifiesto(dir) {
    const p = path.join(dir, 'package.json');
    if (!fs.existsSync(p)) throw new Error('El paquete no tiene package.json (no es un plugin de VS Code)');
    const m = jsonLaxo(fs.readFileSync(p, 'utf8'));
    if (!m || typeof m !== 'object') throw new Error('package.json inválido');
    return m;
}

function analizarPaquete(dir) {
    const hallazgos = [];
    const permisos = new Set();
    const hosts = new Set();
    const apisUsadas = new Set();
    const extraSinSoporte = new Set();
    let hayPeligro = false, hayIncompat = false, hayAviso = false;
    const marcar = (nivel, id, msg, archivo) => {
        if (hallazgos.some((h) => h.id === id && h.archivo === archivo)) return;
        hallazgos.push({ nivel, id, mensaje: msg, archivo });
        if (nivel === 'peligro') hayPeligro = true;
        else if (nivel === 'incompatible') hayIncompat = true;
        else hayAviso = true;
    };

    const manifiesto = leerManifiesto(dir);
    const nombre = String(manifiesto.name || '');
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,80}$/.test(nombre)) throw new Error('El campo "name" del plugin no es válido');
    const publisher = String(manifiesto.publisher || 'local');
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,60}$/.test(publisher)) throw new Error('El campo "publisher" del plugin no es válido');

    // Scripts de instalación: nunca se ejecutan aquí, pero se avisa
    const sc = manifiesto.scripts || {};
    for (const k of ['preinstall', 'install', 'postinstall']) {
        if (sc[k]) marcar('aviso', 'script-instalacion', `Trae un script "${k}" (CodeIDE nunca lo ejecuta)`, 'package.json');
    }

    const archivos = recorrer(dir);
    for (const f of archivos) {
        if (BINARIOS.test(f.ruta)) marcar('incompatible', 'binario', 'Incluye un programa o librería nativa (' + path.extname(f.ruta) + ')', f.ruta);
        if (!/\.(m?js|cjs)$/i.test(f.ruta)) continue;
        const st = fs.statSync(f.abs);
        if (st.size > MAX_JS) { marcar('aviso', 'js-enorme', 'Archivo JavaScript muy grande: no se pudo analizar completo', f.ruta); }
        const txt = fs.readFileSync(f.abs, 'utf8').slice(0, MAX_JS);

        for (const r of PELIGRO) if (r.re.test(txt)) marcar('peligro', r.id, r.msg, f.ruta);
        for (const r of INCOMPATIBLE) if (r.re.test(txt)) marcar('incompatible', r.id, r.msg, f.ruta);
        for (const r of AVISO) if (r.re.test(txt)) { marcar('aviso', r.id, r.msg, f.ruta); if (r.permiso) permisos.add(r.permiso); }

        // Ofuscación fuerte (típica de malware) junto a eval/red
        const ofusc = (txt.match(/_0x[0-9a-f]{4,6}/g) || []).length;
        if (ofusc > 40) marcar(/\beval\s*\(|\bfetch\s*\(/.test(txt) ? 'peligro' : 'aviso', 'ofuscado', 'Código ofuscado (' + ofusc + ' nombres tipo _0x…)', f.ruta);

        // Dominios a los que podría hablar (solo informativo)
        for (const m of txt.matchAll(/https?:\/\/([a-z0-9.-]+\.[a-z]{2,})/gi)) {
            const h = m[1].toLowerCase();
            if (!/^(localhost|127\.|github\.com|raw\.githubusercontent\.com|json-schema\.org|schemastore\.org|(www\.)?w3\.org|(www\.)?ecma-international\.org|marketplace\.visualstudio\.com|code\.visualstudio\.com|aka\.ms|npmjs\.(com|org)|nodejs\.org|developer\.mozilla\.org|stackoverflow\.com|opensource\.org|apache\.org|(www\.)?mozilla\.org)/.test(h)) hosts.add(h);
        }
        for (const x of API_SIN_SOPORTE_CONOCIDA) if (txt.includes(x)) extraSinSoporte.add(x);
        // APIs de VS Code que usa
        for (const m of txt.matchAll(/\bvscode\.(window|workspace|commands|languages|env|debug|tasks|scm|extensions|authentication|notebooks|tests|chat|lm)\.([A-Za-z_]+)/g)) {
            apisUsadas.add(m[1] + '.' + m[2]);
        }
    }

    // Compatibilidad
    const sinSoporte = [];
    for (const a of apisUsadas) {
        const [ns, miembro] = a.split('.');
        const ok = (API_SOPORTADA[ns] || []).includes(miembro);
        if (!ok) sinSoporte.push(a);
    }
    for (const x of extraSinSoporte) if (!sinSoporte.some((y) => y.endsWith('.' + x))) sinSoporte.push('vscode.' + x);

    // Contribuciones (datos que SÍ funcionan en el teléfono sin ejecutar código)
    const c = manifiesto.contributes || {};
    const lista = (v) => (Array.isArray(v) ? v : []);
    const contribuciones = {
        temas: lista(c.themes).map((t, i) => ({ idx: i, etiqueta: t.label || ('Tema ' + (i + 1)), tipo: t.uiTheme || null, ruta: t.path })),
        iconos: lista(c.iconThemes).map((t, i) => ({ idx: i, etiqueta: t.label || ('Iconos ' + (i + 1)), ruta: t.path })),
        snippets: lista(c.snippets).map((s, i) => ({ idx: i, lenguaje: s.language, ruta: s.path })),
        gramaticas: lista(c.grammars).map((g, i) => ({ idx: i, lenguaje: g.language || null, scope: g.scopeName, ruta: g.path })),
        lenguajes: lista(c.languages).map((l) => ({ id: l.id, extensiones: l.extensions || [], configuracion: l.configuration || null })),
        comandos: lista(c.commands).map((x) => ({ comando: x.command, titulo: x.title, categoria: x.category || null })),
        atajos: lista(c.keybindings).map((k) => ({ comando: k.command, tecla: k.key })),
    };
    const hayDatos = contribuciones.temas.length || contribuciones.iconos.length || contribuciones.snippets.length
        || contribuciones.gramaticas.length || contribuciones.lenguajes.length;

    const principal = manifiesto.main || manifiesto.browser || null;
    if (principal && !archivos.some((f) => f.ruta === String(principal).replace(/^\.\//, '') || f.ruta === String(principal).replace(/^\.\//, '') + '.js')) {
        marcar('aviso', 'main-no-existe', 'El archivo principal declarado no está en el paquete', String(principal));
    }

    let nivel, motivo;
    if (hayPeligro) { nivel = 'bloqueado'; motivo = 'Se detectaron señales de robo de datos o malware'; }
    else if (hayIncompat) {
        nivel = hayDatos ? 'datos' : 'solo-catalogo';
        motivo = 'El código necesita cosas que un teléfono/entorno aislado no ofrece (procesos, red de bajo nivel, binarios o paneles web)' + (hayDatos ? '; se aprovechan solo sus temas/snippets/gramáticas' : '');
    } else if (principal && sinSoporte.length === 0) { nivel = 'ejecutable'; motivo = 'Usa solo APIs soportadas'; }
    else if (principal) { nivel = 'parcial'; motivo = 'Se ejecuta, pero usa APIs que aún no existen: ' + sinSoporte.slice(0, 6).join(', '); }
    else if (hayDatos) { nivel = 'datos'; motivo = 'Solo aporta temas/snippets/gramáticas (no tiene código)'; }
    else { nivel = 'solo-catalogo'; motivo = 'No aporta nada utilizable en CodeIDE'; }

    let veredicto = 'limpio';
    if (hayPeligro) veredicto = 'bloqueado';
    else if (hayIncompat) veredicto = 'incompatible';
    else if (hayAviso) veredicto = 'advertencias';

    return {
        veredicto,
        activable: !hayPeligro && !hayIncompat && Boolean(principal),
        hallazgos,
        permisos: [...permisos],
        dominios: [...hosts].slice(0, 25),
        apisUsadas: [...apisUsadas].sort(),
        apisSinSoporte: sinSoporte.sort(),
        compatibilidad: { nivel, motivo },
        manifiesto: {
            id: `${publisher}.${nombre}`.toLowerCase(), name: nombre, publisher,
            version: String(manifiesto.version || '0.0.0'), displayName: manifiesto.displayName || nombre,
            description: String(manifiesto.description || '').slice(0, 300), main: principal,
            activationEvents: lista(manifiesto.activationEvents).map(String).slice(0, 50),
            engines: manifiesto.engines || {},
        },
        contribuciones,
        archivos: archivos.length,
    };
}

module.exports = { analizarPaquete, jsonLaxo, recorrer, DATOS_EXT };
