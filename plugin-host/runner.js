'use strict';
// ============================================================
// EJECUTOR AISLADO — se lanza desde host.js así:
//   node --permission --allow-fs-read=<carpeta-host> --allow-fs-read=<carpeta-plugin>
//        --disallow-code-generation-from-strings --max-old-space-size=96 runner.js <carpeta-plugin>
// con env VACÍO. Capas de protección:
//   1) Proceso aparte, sin variables de entorno (no hay claves que robar).
//   2) --permission: sin escritura en disco, sin procesos hijos, sin workers; lectura solo del plugin.
//   3) El código del plugin corre en un contexto vm SIN process/fetch/require reales ni eval.
//   4) require() propio: solo archivos del plugin y unos pocos módulos inofensivos.
//   5) Tiempo máximo por llamada (3 s para bucles síncronos; el host mata el proceso si tarda más).
// Aviso honesto: ningún aislamiento por software es perfecto. Por eso este ejecutor debe vivir en un
// servicio SEPARADO, sin claves ni datos importantes.
// ============================================================
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const util = require('util');
const events = require('events');

// Cerrar los caminos clásicos de escape: el constructor de funciones del propio ejecutor queda inutilizable
const bloquear = function () { throw new Error('Bloqueado en el entorno aislado'); };
for (const f of [Function.prototype, Object.getPrototypeOf(async function () {}), Object.getPrototypeOf(function* () {}), Object.getPrototypeOf(async function* () {})]) {
    try { Object.defineProperty(f, 'constructor', { value: bloquear, writable: false, configurable: false }); } catch (_) {}
}

const DIR = path.resolve(process.argv[2] || '.');
const send = (m) => { try { process.send(m); } catch (_) {} };
const jsonLaxo = (t) => JSON.parse(String(t).replace(/^\uFEFF/, ''));
const manifiesto = jsonLaxo(fs.readFileSync(path.join(DIR, 'package.json'), 'utf8'));

// ── Estado ──
const registro = { comandos: new Map(), completion: [], hover: [], formato: [], guardar: [], abrir: [], cambiar: [], config: [] };
let acciones = [];
let logsLlamada = 0;
const noSoportadas = new Set();
let editorActual = null;

const log = (nivel, ...a) => { if (logsLlamada++ < 200) send({ t: 'log', nivel, msg: util.format(...a).slice(0, 600) }); };
const poner = (a) => { if (acciones.length < 300) acciones.push(a); };

// ── Clases de la API de VS Code ──
class Disposable { constructor(f) { this._f = f; } dispose() { const f = this._f; this._f = null; if (f) { try { f(); } catch (_) {} } } static from(...d) { return new Disposable(() => d.forEach((x) => x && x.dispose && x.dispose())); } }
class EventEmitter {
    constructor() { this._l = []; this.event = (fn) => { this._l.push(fn); return new Disposable(() => { this._l = this._l.filter((x) => x !== fn); }); }; }
    fire(d) { for (const f of [...this._l]) { try { f(d); } catch (e) { log('error', 'Evento:', e && e.message); } } }
    dispose() { this._l = []; }
}
class Position {
    constructor(l, c) { this.line = l | 0; this.character = c | 0; }
    isEqual(o) { return o.line === this.line && o.character === this.character; }
    isBefore(o) { return this.line < o.line || (this.line === o.line && this.character < o.character); }
    isAfter(o) { return !this.isEqual(o) && !this.isBefore(o); }
    translate(dl = 0, dc = 0) { return new Position(this.line + dl, this.character + dc); }
    with(l, c) { return new Position(l === undefined ? this.line : l, c === undefined ? this.character : c); }
}
class Range {
    constructor(a, b, c, d) { if (typeof a === 'number') { this.start = new Position(a, b); this.end = new Position(c, d); } else { this.start = a; this.end = b; } }
    get isEmpty() { return this.start.isEqual(this.end); }
    get isSingleLine() { return this.start.line === this.end.line; }
    contains(x) { const p = x.start ? x : { start: x, end: x }; return !p.start.isBefore(this.start) && !p.end.isAfter(this.end); }
}
class Selection extends Range { constructor(a, b, c, d) { super(a, b, c, d); this.anchor = this.start; this.active = this.end; } }
class Uri {
    constructor(scheme, p, q) { this.scheme = scheme; this.path = p; this.authority = ''; this.query = q || ''; this.fragment = ''; this.fsPath = p; }
    static file(p) { return new Uri('file', String(p)); }
    static parse(s) { const m = /^([a-z][a-z0-9+.-]*):(?:\/\/[^\/]*)?([^?#]*)/i.exec(String(s)); return m ? new Uri(m[1], decodeURIComponent(m[2] || '/')) : new Uri('file', String(s)); }
    static joinPath(b, ...p) { return new Uri(b.scheme, [b.path.replace(/\/$/, ''), ...p].join('/')); }
    with(c) { return new Uri(c.scheme || this.scheme, c.path || this.path, c.query); }
    toString() { return this.scheme + '://' + this.path; }
    toJSON() { return { scheme: this.scheme, path: this.path }; }
}
class MarkdownString { constructor(v) { this.value = v || ''; this.isTrusted = false; } appendText(t) { this.value += t; return this; } appendMarkdown(t) { this.value += t; return this; } appendCodeblock(c, l = '') { this.value += '\n```' + l + '\n' + c + '\n```\n'; return this; } }
class SnippetString { constructor(v) { this.value = v || ''; } appendText(t) { this.value += t; return this; } appendTabstop() { return this; } appendPlaceholder(v) { this.value += String(typeof v === 'function' ? '' : v); return this; } }
class CompletionItem { constructor(label, kind) { this.label = label; this.kind = kind; } }
class CompletionList { constructor(items, inc) { this.items = items || []; this.isIncomplete = !!inc; } }
class Hover { constructor(c, r) { this.contents = Array.isArray(c) ? c : [c]; this.range = r; } }
class TextEdit {
    constructor(r, t) { this.range = r; this.newText = t; }
    static replace(r, t) { return new TextEdit(r, t); }
    static insert(p, t) { return new TextEdit(new Range(p, p), t); }
    static delete(r) { return new TextEdit(r, ''); }
}
class Diagnostic { constructor(r, m, s) { this.range = r; this.message = m; this.severity = s === undefined ? 0 : s; } }
const Enum = (...n) => { const o = {}; n.forEach((k, i) => { o[k] = i; o[i] = k; }); return o; };
const CompletionItemKind = Enum('Text', 'Method', 'Function', 'Constructor', 'Field', 'Variable', 'Class', 'Interface', 'Module', 'Property', 'Unit', 'Value', 'Enum', 'Keyword', 'Snippet', 'Color', 'File', 'Reference', 'Folder', 'EnumMember', 'Constant', 'Struct', 'Event', 'Operator', 'TypeParameter');
const DiagnosticSeverity = Enum('Error', 'Warning', 'Information', 'Hint');
const StatusBarAlignment = { Left: 1, Right: 2 };

// ── Documento ──
function crearDocumento(d) {
    const texto = String(d.texto == null ? '' : d.texto).replace(/\r\n/g, '\n');
    const lineas = texto.split('\n');
    const inicios = []; let o = 0;
    for (const l of lineas) { inicios.push(o); o += l.length + 1; }
    const offsetAt = (p) => { const li = Math.max(0, Math.min(lineas.length - 1, p.line)); return inicios[li] + Math.max(0, Math.min(lineas[li].length, p.character)); };
    const positionAt = (off) => { off = Math.max(0, Math.min(texto.length, off)); let li = 0; while (li + 1 < inicios.length && inicios[li + 1] <= off) li++; return new Position(li, off - inicios[li]); };
    const uri = Uri.parse(d.uri || 'file:///archivo');
    return {
        uri, fileName: uri.path, languageId: String(d.lenguaje || 'plaintext'), version: d.version || 1, isDirty: false, isUntitled: false,
        lineCount: lineas.length, eol: 1,
        getText(r) { return r ? texto.slice(offsetAt(r.start), offsetAt(r.end)) : texto; },
        lineAt(x) { const n = typeof x === 'number' ? x : x.line; const t = lineas[n] == null ? '' : lineas[n]; return { lineNumber: n, text: t, range: new Range(n, 0, n, t.length), isEmptyOrWhitespace: !t.trim(), firstNonWhitespaceCharacterIndex: t.length - t.trimStart().length }; },
        positionAt, offsetAt,
        getWordRangeAtPosition(p, re) {
            const t = lineas[p.line] || '';
            const rx = re ? new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g') : /[A-Za-z0-9_]+/g;
            let m; while ((m = rx.exec(t))) { if (m[0].length === 0) { rx.lastIndex++; continue; } if (p.character >= m.index && p.character <= m.index + m[0].length) return new Range(p.line, m.index, p.line, m.index + m[0].length); }
            return undefined;
        },
        save() { return Promise.resolve(false); },
    };
}

const coincide = (sel, doc) => (Array.isArray(sel) ? sel : [sel]).some((s) => {
    if (!s) return false;
    if (s === '*') return true;
    if (typeof s === 'string') return s === doc.languageId;
    if (s.language && s.language !== '*' && s.language !== doc.languageId) return false;
    if (s.scheme && s.scheme !== doc.uri.scheme) return false;
    return true;
});

// ── Configuración (valores por defecto que declara el propio plugin) ──
const defaults = {};
{
    const cfg = manifiesto.contributes && manifiesto.contributes.configuration;
    for (const bloque of Array.isArray(cfg) ? cfg : cfg ? [cfg] : []) {
        for (const [k, v] of Object.entries((bloque && bloque.properties) || {})) if (v && 'default' in v) defaults[k] = v.default;
    }
}
const configuracion = (seccion) => ({
    get: (clave, def) => { const k = seccion ? seccion + '.' + clave : clave; return k in defaults ? defaults[k] : def; },
    has: (clave) => (seccion ? seccion + '.' + clave : clave) in defaults,
    inspect: () => undefined,
    update: () => Promise.resolve(),
});

// ── El objeto "vscode" ──
function espacio(ns, miembros) {
    const base = Object.create(null);
    Object.assign(base, miembros);
    return new Proxy(base, {
        get(t, p) {
            if (p in t) return t[p];
            if (typeof p === 'symbol' || p === 'then' || p === 'toJSON') return undefined;
            return (..._a) => { noSoportadas.add(ns + '.' + String(p)); throw new Error('API de VS Code aún no soportada en CodeIDE: vscode.' + ns + '.' + String(p)); };
        },
        set() { return false; }, defineProperty() { return false; },
    });
}
const mensaje = (nivel) => (texto, ...resto) => { poner({ tipo: 'mensaje', nivel, texto: String(texto).slice(0, 500), botones: resto.filter((x) => typeof x === 'string').slice(0, 4) }); return Promise.resolve(undefined); };
let contadorBarra = 0;
const vscode = {
    Disposable, EventEmitter, Position, Range, Selection, Uri, MarkdownString, SnippetString, CompletionItem, CompletionList, Hover, TextEdit,
    Diagnostic, CompletionItemKind, DiagnosticSeverity, StatusBarAlignment,
    version: '1.90.0-codeide',
    window: espacio('window', {
        showInformationMessage: mensaje('info'), showWarningMessage: mensaje('aviso'), showErrorMessage: mensaje('error'),
        setStatusBarMessage: (t) => { poner({ tipo: 'barra', texto: String(t).slice(0, 200) }); return new Disposable(); },
        createStatusBarItem: () => { const id = 'b' + (++contadorBarra); const it = { text: '', tooltip: '', command: undefined, alignment: 1, show() { poner({ tipo: 'barra-item', id, texto: String(it.text).slice(0, 100), tooltip: String(it.tooltip || ''), comando: it.command && (it.command.command || it.command) }); }, hide() { poner({ tipo: 'barra-item-oculto', id }); }, dispose() { this.hide(); } }; return it; },
        createOutputChannel: (nombre) => ({ name: nombre, append: (t) => poner({ tipo: 'salida', canal: String(nombre), texto: String(t).slice(0, 2000) }), appendLine: (t) => poner({ tipo: 'salida', canal: String(nombre), texto: String(t).slice(0, 2000) + '\n' }), show() {}, hide() {}, clear() {}, dispose() {} }),
        get activeTextEditor() { return editorActual; },
    }),
    commands: espacio('commands', {
        registerCommand: (nombre, fn) => { registro.comandos.set(String(nombre), fn); return new Disposable(() => registro.comandos.delete(String(nombre))); },
        executeCommand: (nombre, ...args) => {
            const f = registro.comandos.get(String(nombre));
            if (!f) { poner({ tipo: 'comando-externo', comando: String(nombre), args: parseSeguro(jsonSeguro(args), []) }); return Promise.resolve(undefined); }
            return Promise.resolve(f(...args));
        },
        getCommands: () => Promise.resolve([...registro.comandos.keys()]),
    }),
    languages: espacio('languages', {
        registerCompletionItemProvider: (sel, prov, ...disparadores) => { const r = { sel, prov, disparadores }; registro.completion.push(r); return new Disposable(() => { registro.completion = registro.completion.filter((x) => x !== r); }); },
        registerHoverProvider: (sel, prov) => { const r = { sel, prov }; registro.hover.push(r); return new Disposable(() => { registro.hover = registro.hover.filter((x) => x !== r); }); },
        registerDocumentFormattingEditProvider: (sel, prov) => { const r = { sel, prov }; registro.formato.push(r); return new Disposable(() => { registro.formato = registro.formato.filter((x) => x !== r); }); },
        createDiagnosticCollection: (nombre) => ({
            name: nombre,
            set: (uri, items) => poner({ tipo: 'diagnosticos', coleccion: String(nombre), uri: String(uri && uri.toString ? uri.toString() : uri), items: (items || []).slice(0, 500).map((d) => ({ rango: rango(d.range), mensaje: String(d.message).slice(0, 500), severidad: Number(d.severity) || 0, fuente: d.source ? String(d.source) : undefined, codigo: d.code !== undefined ? String(d.code) : undefined })) }),
            delete: (uri) => poner({ tipo: 'diagnosticos', coleccion: String(nombre), uri: String(uri), items: [] }),
            clear: () => poner({ tipo: 'diagnosticos-limpiar', coleccion: String(nombre) }), dispose() {},
        }),
    }),
    workspace: espacio('workspace', {
        getConfiguration: configuracion,
        onDidChangeConfiguration: (fn) => { registro.config.push(fn); return new Disposable(() => { registro.config = registro.config.filter((x) => x !== fn); }); },
        onDidChangeTextDocument: (fn) => { registro.cambiar.push(fn); return new Disposable(() => { registro.cambiar = registro.cambiar.filter((x) => x !== fn); }); },
        onDidOpenTextDocument: (fn) => { registro.abrir.push(fn); return new Disposable(() => { registro.abrir = registro.abrir.filter((x) => x !== fn); }); },
        onDidSaveTextDocument: (fn) => { registro.guardar.push(fn); return new Disposable(() => { registro.guardar = registro.guardar.filter((x) => x !== fn); }); },
        get workspaceFolders() { return undefined; },
        get textDocuments() { return editorActual ? [editorActual.document] : []; },
    }),
    env: espacio('env', { appName: 'CodeIDE', language: 'es', machineId: 'aislado', sessionId: 'aislado', uriScheme: 'codeide' }),
    extensions: espacio('extensions', { getExtension: () => undefined, all: [] }),
};
const rango = (r) => (r && r.start ? { ini: { l: r.start.line, c: r.start.character }, fin: { l: r.end.line, c: r.end.character } } : null);

// ── Contexto vm: SIN process, fetch, require, eval ni import() reales ──
const consolaFalsa = {};
for (const n of ['log', 'info', 'warn', 'error', 'debug']) consolaFalsa[n] = (...a) => log(n === 'warn' ? 'aviso' : n === 'error' ? 'error' : 'info', ...a);
const procesoFalso = {
    platform: 'linux', arch: 'x64', env: Object.freeze({}), version: 'v22.0.0', versions: Object.freeze({ node: '22.0.0' }), argv: [], pid: 1, title: 'codeide', execPath: '/ext/node',
    cwd: () => '/ext', nextTick: (f, ...a) => queueMicrotask(() => f(...a)), emitWarning() {}, on() { return procesoFalso; }, once() { return procesoFalso; }, off() { return procesoFalso; },
    exit() { throw new Error('process.exit está bloqueado'); }, uptime: () => process.uptime(), hrtime: process.hrtime, memoryUsage: () => ({ rss: 0, heapTotal: 0, heapUsed: 0, external: 0 }),
};
const sandbox = {
    console: consolaFalsa, process: procesoFalso, Buffer, URL, URLSearchParams, TextEncoder, TextDecoder, queueMicrotask,
    setTimeout, clearTimeout, setInterval, clearInterval, setImmediate, clearImmediate,
    atob: (s) => Buffer.from(String(s), 'base64').toString('latin1'), btoa: (s) => Buffer.from(String(s), 'latin1').toString('base64'),
    performance: { now: () => performance.now() },
};
const ctx = vm.createContext(sandbox, { name: 'plugin', codeGeneration: { strings: false, wasm: false } });
vm.runInContext('globalThis.global = globalThis; globalThis.self = globalThis;', ctx);
const envolver = vm.runInContext('(function (f, t, a) { return f.apply(t, a); })', ctx);
// Se captura JSON.stringify ANTES de que corra código del plugin (así no puede sustituirlo)
const jsonCtx = vm.runInContext('(function () { var s = JSON.stringify; return function (v) { return s(v); }; })()', ctx);
const parseSeguro = (t, def) => { try { return JSON.parse(t); } catch (_) { return def; } };

// Llamar al código del plugin con límite de tiempo para bucles síncronos
function llamarSeguro(fn, esto, args, ms = 3000) {
    sandbox.__w = envolver; sandbox.__f = fn; sandbox.__t = esto; sandbox.__a = args;
    try { return vm.runInContext('__w(__f, __t, __a)', ctx, { timeout: ms }); }
    finally { delete sandbox.__w; delete sandbox.__f; delete sandbox.__t; delete sandbox.__a; }
}
function jsonSeguro(v) {
    if (v === undefined) return 'null';
    sandbox.__j = jsonCtx; sandbox.__v = v;
    try { return vm.runInContext('__j(__v)', ctx, { timeout: 1500 }) || 'null'; }
    catch (_) { return 'null'; }
    finally { delete sandbox.__j; delete sandbox.__v; }
}

// ── require propio ──
const BUILTINS_OK = { path: require('path').posix, util, events, assert: require('assert'), url: require('url'), string_decoder: require('string_decoder'), querystring: require('querystring'), buffer: { Buffer }, punycode: undefined };
const OS_FALSO = { EOL: '\n', platform: () => 'linux', arch: () => 'x64', homedir: () => '/', tmpdir: () => '/tmp', hostname: () => 'codeide', type: () => 'Linux', release: () => '', cpus: () => [], totalmem: () => 0, freemem: () => 0, endianness: () => 'LE' };
const BLOQUEADOS = new Set(['fs', 'fs/promises', 'child_process', 'net', 'tls', 'dgram', 'http', 'https', 'http2', 'dns', 'cluster', 'worker_threads', 'vm', 'v8', 'inspector', 'repl', 'module', 'process', 'crypto', 'zlib', 'stream', 'readline', 'tty', 'perf_hooks', 'async_hooks', 'wasi']);

const esArchivo = (p) => { try { return fs.statSync(p).isFile(); } catch (_) { return false; } };
const dentro = (p) => p === DIR || p.startsWith(DIR + path.sep);
const virtual = (p) => '/ext/' + path.relative(DIR, p).split(path.sep).join('/');

function probar(base) {
    for (const c of [base, base + '.js', base + '.json', base + '.cjs', path.join(base, 'index.js'), path.join(base, 'index.json')]) if (dentro(c) && esArchivo(c)) return c;
    const pj = path.join(base, 'package.json');
    if (dentro(pj) && esArchivo(pj)) { try { const m = jsonLaxo(fs.readFileSync(pj, 'utf8')); if (m.main) return probar(path.resolve(base, m.main)); } catch (_) {} }
    return null;
}
function resolver(desde, spec) {
    if (spec.startsWith('.') || spec.startsWith('/')) {
        const a = probar(path.resolve(desde, spec.startsWith('/ext/') ? path.join(DIR, spec.slice(5)) : spec));
        if (!a) throw new Error("No se encontró el módulo '" + spec + "' dentro del plugin");
        return a;
    }
    let d = desde;
    for (let i = 0; i < 20 && dentro(d); i++) {
        const a = probar(path.join(d, 'node_modules', spec));
        if (a) return a;
        if (d === DIR) break;
        d = path.dirname(d);
    }
    throw new Error("No se encontró el módulo '" + spec + "' dentro del plugin");
}

const cacheMod = new Map();
function cargar(archivo) {
    if (cacheMod.has(archivo)) return cacheMod.get(archivo).exports;
    if (!dentro(archivo)) throw new Error('Ruta fuera del plugin');
    if (/\.json$/i.test(archivo)) { const m = { exports: jsonLaxo(fs.readFileSync(archivo, 'utf8')) }; cacheMod.set(archivo, m); return m.exports; }
    const codigo = fs.readFileSync(archivo, 'utf8');
    if (codigo.length > 8 * 1024 * 1024) throw new Error('Archivo demasiado grande');
    const modulo = { exports: {}, id: virtual(archivo), filename: virtual(archivo), loaded: false };
    cacheMod.set(archivo, modulo);
    const script = new vm.Script('(function (exports, require, module, __filename, __dirname) {' + codigo.replace(/^#!.*/, '') + '\n})', { filename: virtual(archivo) });
    const fn = script.runInContext(ctx, { timeout: 5000 });
    const dir = path.dirname(archivo);
    fn.call(modulo.exports, modulo.exports, crearRequire(dir), modulo, virtual(archivo), virtual(dir));
    modulo.loaded = true;
    return modulo.exports;
}
function crearRequire(desde) {
    return (spec) => {
        spec = String(spec);
        const s = spec.replace(/^node:/, '');
        if (s === 'vscode') return vscode;
        if (s === 'os') return OS_FALSO;
        if (BLOQUEADOS.has(s)) throw new Error("El módulo '" + s + "' está bloqueado en el entorno aislado de CodeIDE");
        if (BUILTINS_OK[s] !== undefined) return BUILTINS_OK[s];
        return cargar(resolver(desde, spec));
    };
}

// ── Mensajes con el servidor ──
const memento = () => { const m = new Map(); return { get: (k, d) => (m.has(k) ? m.get(k) : d), update: (k, v) => { if (v === undefined) m.delete(k); else m.set(k, v); return Promise.resolve(); }, keys: () => [...m.keys()] }; };
let moduloExt = null;
const contextoExt = { subscriptions: [], extensionPath: '/ext', extensionUri: Uri.file('/ext'), globalState: memento(), workspaceState: memento(), asAbsolutePath: (p) => '/ext/' + String(p).replace(/^\/+/, ''), extension: { id: String(manifiesto.publisher || 'local') + '.' + String(manifiesto.name), packageJSON: { name: manifiesto.name, version: manifiesto.version } }, environmentVariableCollection: {} };

async function activar() {
    if (manifiesto.main) {
        moduloExt = cargar(resolver(DIR, './' + String(manifiesto.main).replace(/^\.\//, '')));
        if (moduloExt && typeof moduloExt.activate === 'function') await Promise.resolve(llamarSeguro(moduloExt.activate, moduloExt, [contextoExt], 5000));
    }
    return { comandos: [...registro.comandos.keys()], completion: registro.completion.length, hover: registro.hover.length, formato: registro.formato.length, eventos: registro.guardar.length + registro.abrir.length + registro.cambiar.length };
}
const comoTexto = (c) => (typeof c === 'string' ? c : c && typeof c.value === 'string' ? c.value : '');
const token = () => ({ isCancellationRequested: false, onCancellationRequested: () => new Disposable() });

async function proveedor(tipo, d, pos, extra) {
    const doc = crearDocumento(d); const p = new Position(pos && pos.l, pos && pos.c);
    if (tipo === 'completion') {
        const salida = [];
        for (const r of registro.completion.filter((x) => coincide(x.sel, doc))) {
            if (!r.prov || typeof r.prov.provideCompletionItems !== 'function') continue;
            let res = await Promise.resolve(llamarSeguro(r.prov.provideCompletionItems, r.prov, [doc, p, token(), { triggerKind: 0, triggerCharacter: extra && extra.caracter }]));
            if (res && res.items) res = res.items;
            for (const it of Array.isArray(res) ? res : []) {
                if (salida.length >= 200) break;
                const et = typeof it === 'string' ? it : comoTexto(it.label) || (it.label && it.label.label) || '';
                salida.push({ etiqueta: String(et).slice(0, 120), tipo: it.kind === undefined ? null : Number(it.kind), detalle: it.detail ? String(it.detail).slice(0, 200) : null, documentacion: comoTexto(it.documentation).slice(0, 2000), insertar: it.insertText === undefined ? String(et) : comoTexto(it.insertText) || String(it.insertText), esSnippet: it.insertText instanceof SnippetString, orden: it.sortText || null, filtro: it.filterText || null });
            }
        }
        return salida;
    }
    if (tipo === 'hover') {
        for (const r of registro.hover.filter((x) => coincide(x.sel, doc))) {
            const h = await Promise.resolve(llamarSeguro(r.prov.provideHover, r.prov, [doc, p, token()]));
            if (h && h.contents) return { textos: (Array.isArray(h.contents) ? h.contents : [h.contents]).map((c) => (typeof c === 'string' ? c : c && c.language ? '```' + c.language + '\n' + c.value + '\n```' : comoTexto(c))).filter(Boolean).slice(0, 10), rango: rango(h.range) };
        }
        return null;
    }
    if (tipo === 'formato') {
        const out = [];
        for (const r of registro.formato.filter((x) => coincide(x.sel, doc))) {
            const e = await Promise.resolve(llamarSeguro(r.prov.provideDocumentFormattingEdits, r.prov, [doc, { tabSize: 4, insertSpaces: true }, token()]));
            for (const x of Array.isArray(e) ? e : []) { if (out.length < 500) out.push({ rango: rango(x.range), texto: String(x.newText).slice(0, 200000) }); }
        }
        return out;
    }
    throw new Error('Tipo de proveedor desconocido: ' + tipo);
}

async function manejar(m) {
    if (m.editor) { const doc = crearDocumento(m.editor.documento || {}); editorActual = { document: doc, selection: new Selection(0, 0, 0, 0), viewColumn: 1 }; }
    switch (m.t) {
        case 'activar': return activar();
        case 'comando': {
            const f = registro.comandos.get(String(m.nombre));
            if (!f) throw new Error('El plugin no registró el comando: ' + m.nombre);
            return Promise.resolve(llamarSeguro(f, undefined, Array.isArray(m.args) ? m.args : []));
        }
        case 'proveedor': return proveedor(m.tipo, m.doc || {}, m.pos, m.extra);
        case 'evento': {
            const lista = { guardar: registro.guardar, abrir: registro.abrir, cambiar: registro.cambiar, config: registro.config }[m.nombre];
            if (!lista) throw new Error('Evento desconocido');
            const doc = crearDocumento(m.doc || {});
            for (const f of [...lista]) await Promise.resolve(llamarSeguro(f, undefined, [m.nombre === 'cambiar' ? { document: doc, contentChanges: [] } : m.nombre === 'config' ? { affectsConfiguration: () => true } : doc]));
            return true;
        }
        case 'desactivar': { if (moduloExt && typeof moduloExt.deactivate === 'function') { try { await Promise.resolve(llamarSeguro(moduloExt.deactivate, moduloExt, [])); } catch (_) {} } for (const d of contextoExt.subscriptions) { try { d && d.dispose && d.dispose(); } catch (_) {} } setTimeout(() => process.exit(0), 20); return true; }
        default: throw new Error('Mensaje desconocido');
    }
}

let cola = Promise.resolve();
process.on('message', (m) => {
    cola = cola.then(async () => {
        acciones = []; logsLlamada = 0; noSoportadas.clear();
        try {
            const valor = await manejar(m);
            send({ t: 'res', id: m.id, ok: true, valorJson: jsonSeguro(valor), acciones: parseSeguro(jsonSeguro(acciones), []), noSoportadas: [...noSoportadas] });
        } catch (e) {
            const msg = e && e.message ? String(e.message) : String(e);
            send({ t: 'res', id: m.id, ok: false, error: msg.slice(0, 400), acciones: parseSeguro(jsonSeguro(acciones), []), noSoportadas: [...noSoportadas] });
        }
    }).catch(() => {});
});
process.on('uncaughtException', (e) => { send({ t: 'log', nivel: 'error', msg: 'Error no capturado: ' + (e && e.message) }); });
process.on('unhandledRejection', (e) => { send({ t: 'log', nivel: 'error', msg: 'Promesa rechazada: ' + (e && e.message) }); });
send({ t: 'listo' });
