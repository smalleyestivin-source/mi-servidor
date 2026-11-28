'use strict';
// Adaptadores: traducen lo que SÍ se puede traducir de otros ecosistemas al formato de VS Code.
//   Sublime Text (Package Control): sus plugins son Python que usa la API interna de Sublime → NO se pueden
//   ejecutar. Pero los .sublime-snippet son datos (XML) y se convierten a snippets de VS Code.
//   Zed (Rust/WASM), JetBrains (JVM) y Eclipse (Java/OSGi): solo catálogo, no hay forma honesta de ejecutarlos.
const fs = require('fs');
const path = require('path');
const { recorrer } = require('./validator');

const LENGUAJES_SCOPE = { python: 'python', js: 'javascript', ts: 'typescript', html: 'html', css: 'css', json: 'json', java: 'java', c: 'c', cpp: 'cpp', 'c++': 'cpp', go: 'go', rust: 'rust', ruby: 'ruby', php: 'php', shell: 'shellscript', sh: 'shellscript', markdown: 'markdown', yaml: 'yaml', sql: 'sql', lua: 'lua', swift: 'swift', kotlin: 'kotlin', 'c#': 'csharp', cs: 'csharp' };

function entre(xml, etiqueta) {
    const m = new RegExp('<' + etiqueta + '>([\\s\\S]*?)</' + etiqueta + '>', 'i').exec(xml);
    if (!m) return '';
    return m[1].replace(/^\s*<!\[CDATA\[/, '').replace(/\]\]>\s*$/, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

function lenguajeDeScope(scope) {
    // "source.python, source.js" → primera que conozcamos
    for (const s of String(scope || '').split(/[,\s]+/)) {
        const m = /^(?:source|text)\.([a-z0-9+#]+)/i.exec(s);
        if (m && LENGUAJES_SCOPE[m[1].toLowerCase()]) return LENGUAJES_SCOPE[m[1].toLowerCase()];
    }
    return null;
}

// Sublime usa $1, ${1:texto}, $0 (igual que VS Code). Solo hay que escapar los "$" que no son marcadores.
function cuerpo(contenido) {
    return String(contenido).replace(/\r\n/g, '\n').replace(/^\n/, '').replace(/\n$/, '').split('\n');
}

// Lee una carpeta (zip de Sublime ya extraído) y escribe en `destino` un plugin de VS Code con solo datos.
function sublimeAVsCode(origen, destino, info) {
    const snippets = {}; // lenguaje -> { nombre: {prefix, body, description} }
    let total = 0;
    for (const f of recorrer(origen)) {
        if (!/\.sublime-snippet$/i.test(f.ruta)) continue;
        if (fs.statSync(f.abs).size > 200 * 1024) continue;
        const xml = fs.readFileSync(f.abs, 'utf8');
        const contenido = entre(xml, 'content');
        const prefijo = entre(xml, 'tabTrigger').trim();
        if (!contenido || !prefijo) continue;
        const lang = lenguajeDeScope(entre(xml, 'scope')) || 'plaintext';
        const nombre = path.basename(f.ruta).replace(/\.sublime-snippet$/i, '').slice(0, 60);
        snippets[lang] = snippets[lang] || {};
        snippets[lang][nombre] = { prefix: prefijo, body: cuerpo(contenido), description: entre(xml, 'description').trim().slice(0, 200) || nombre };
        if (++total >= 1000) break;
    }
    const contributes = { snippets: [] };
    fs.mkdirSync(path.join(destino, 'snippets'), { recursive: true });
    for (const [lang, s] of Object.entries(snippets)) {
        fs.writeFileSync(path.join(destino, 'snippets', lang + '.json'), JSON.stringify(s, null, 1));
        contributes.snippets.push({ language: lang, path: './snippets/' + lang + '.json' });
    }
    const nombrePkg = String(info.nombre || 'paquete').toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'paquete';
    fs.writeFileSync(path.join(destino, 'package.json'), JSON.stringify({
        name: nombrePkg, publisher: 'sublime', version: String(info.version || '0.0.0').replace(/[^0-9a-zA-Z.+-]/g, '').slice(0, 30) || '0.0.0',
        displayName: String(info.nombre || nombrePkg).slice(0, 100), description: String(info.descripcion || '').slice(0, 300),
        engines: { vscode: '*' }, contributes,
    }, null, 1));
    return { snippets: total, lenguajes: Object.keys(snippets) };
}

module.exports = { sublimeAVsCode, lenguajeDeScope };
