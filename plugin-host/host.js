'use strict';
// Gestor de plugins del lado del servidor. Nunca ejecuta código del plugin en ESTE proceso:
// cada plugin vive en su propio proceso aislado (runner.js).
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawn, spawnSync } = require('child_process');
const { extraerZip, leerEntradas } = require('./unzip');
const { analizarPaquete, jsonLaxo } = require('./validator');
const { sublimeAVsCode } = require('./adaptadores');

const HOST_DIR = __dirname;
const DATA_DIR = process.env.PH_DATA || path.join(os.tmpdir(), 'codeide-plugins');
const ID_OK = /^[a-z0-9][a-z0-9._-]{0,120}$/;
const validarId = (id) => { if (!ID_OK.test(String(id))) throw Object.assign(new Error('Id de plugin inválido'), { status: 400 }); return String(id); };

// ¿Este Node sabe aislar procesos de verdad? (prueba real: intenta escribir y debe fallar)
function comprobarAislamiento() {
    try {
        const r = spawnSync(process.execPath, ['--permission', '--disallow-code-generation-from-strings', '-e',
            "try{require('fs').writeFileSync(require('os').tmpdir()+'/ph-prueba','1');process.exit(2)}catch(e){process.exit(e&&e.code==='ERR_ACCESS_DENIED'?0:3)}"],
        { env: {}, timeout: 6000 });
        return r.status === 0;
    } catch (_) { return false; }
}

class PluginHost {
    constructor() {
        for (const d of ['p', 'meta', 'tmp']) fs.mkdirSync(path.join(DATA_DIR, d), { recursive: true });
        this.procesos = new Map();
        this.aislado = comprobarAislamiento();
        this.maxProcesos = Number(process.env.PH_MAX_PROCESOS) || 6;
        this.inactividadMs = 5 * 60 * 1000;
        setInterval(() => { const ahora = Date.now(); for (const [id, p] of this.procesos) if (ahora - p.ultimo > this.inactividadMs) this.detener(id); }, 60 * 1000).unref();
    }

    rutaPlugin(id) { return path.join(DATA_DIR, 'p', validarId(id)); }
    rutaMeta(id) { return path.join(DATA_DIR, 'meta', validarId(id) + '.json'); }
    meta(id) {
        try { return JSON.parse(fs.readFileSync(this.rutaMeta(id), 'utf8')); }
        catch (_) { throw Object.assign(new Error('Plugin no instalado'), { status: 404 }); }
    }
    guardarMeta(m) { fs.writeFileSync(this.rutaMeta(m.id), JSON.stringify(m)); }

    // ── Instalar ──
    // buf: bytes del .vsix / .zip. opciones.formato: 'vscode' (por defecto) | 'sublime'
    instalar(buf, opciones = {}) {
        const tmp = fs.mkdtempSync(path.join(DATA_DIR, 'tmp', 'i-'));
        try {
            let carpeta = tmp;
            if (opciones.formato === 'sublime') {
                const crudo = fs.mkdtempSync(path.join(DATA_DIR, 'tmp', 's-'));
                try {
                    extraerZip(buf, crudo);
                    const hijos = fs.readdirSync(crudo);
                    const raiz = hijos.length === 1 && fs.statSync(path.join(crudo, hijos[0])).isDirectory() ? path.join(crudo, hijos[0]) : crudo;
                    const r = sublimeAVsCode(raiz, tmp, opciones.info || {});
                    if (!r.snippets) return { ok: false, veredicto: 'incompatible', mensaje: 'Este paquete de Sublime no trae snippets convertibles (sus plugins en Python no se pueden ejecutar en CodeIDE).' };
                } finally { fs.rmSync(crudo, { recursive: true, force: true }); }
            } else {
                const nombres = leerEntradas(buf).map((e) => e.nombre.replace(/\\/g, '/'));
                const esVsix = nombres.some((n) => n === 'extension/package.json');
                extraerZip(buf, tmp, esVsix ? { prefijo: 'extension/' } : {});
            }
            const analisis = analizarPaquete(carpeta);
            if (analisis.veredicto === 'bloqueado') {
                return { ok: false, veredicto: 'bloqueado', mensaje: 'Plugin bloqueado: se detectaron señales de robo de datos o malware. No se instaló.', hallazgos: analisis.hallazgos, compatibilidad: analisis.compatibilidad };
            }
            const id = analisis.manifiesto.id;
            if (!ID_OK.test(id)) return { ok: false, veredicto: 'incompatible', mensaje: 'El id del plugin no es válido: ' + id };
            const destino = this.rutaPlugin(id);
            this.detener(id);
            fs.rmSync(destino, { recursive: true, force: true });
            fs.renameSync(carpeta, destino);
            const previa = (() => { try { return this.meta(id); } catch (_) { return null; } })();
            const m = {
                id, nombre: analisis.manifiesto.displayName, version: analisis.manifiesto.version, descripcion: analisis.manifiesto.description,
                autor: analisis.manifiesto.publisher, fuente: opciones.fuente || 'subida', publicado: Boolean(opciones.publicar),
                activable: analisis.activable, veredicto: analisis.veredicto, hallazgos: analisis.hallazgos, permisos: analisis.permisos,
                dominios: analisis.dominios, apisSinSoporte: analisis.apisSinSoporte, compatibilidad: analisis.compatibilidad,
                contribuciones: analisis.contribuciones, activationEvents: analisis.manifiesto.activationEvents,
                concedidos: previa ? previa.concedidos : [], instaladoEn: new Date().toISOString(),
            };
            this.guardarMeta(m);
            return { ok: true, plugin: this.resumen(m) };
        } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
    }

    resumen(m) {
        const { id, nombre, version, descripcion, autor, fuente, publicado, activable, veredicto, hallazgos, permisos, dominios, apisSinSoporte, compatibilidad, contribuciones, concedidos, instaladoEn, activationEvents } = m;
        return { id, nombre, version, descripcion, autor, fuente, publicado, activable, veredicto, hallazgos, permisos, dominios, apisSinSoporte, compatibilidad, contribuciones, concedidos, instaladoEn, activationEvents, activo: this.procesos.has(id) };
    }
    listar() {
        const out = [];
        for (const f of fs.readdirSync(path.join(DATA_DIR, 'meta'))) {
            try { out.push(this.resumen(JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'meta', f), 'utf8')))); } catch (_) {}
        }
        return out.sort((a, b) => String(a.nombre).localeCompare(String(b.nombre)));
    }
    desinstalar(id) {
        this.detener(id);
        fs.rmSync(this.rutaPlugin(id), { recursive: true, force: true });
        fs.rmSync(this.rutaMeta(id), { force: true });
        return true;
    }
    permisos(id, concedidos) {
        const m = this.meta(id);
        m.concedidos = (Array.isArray(concedidos) ? concedidos : []).map(String).filter((p) => m.permisos.includes(p)).slice(0, 10);
        this.guardarMeta(m);
        return m.concedidos;
    }

    // ── Datos que el teléfono puede usar sin ejecutar código (temas, snippets, gramáticas…) ──
    leerContribucion(id, tipo, idx) {
        const m = this.meta(id);
        const lista = m.contribuciones && m.contribuciones[tipo];
        const item = Array.isArray(lista) ? lista[Number(idx)] : null;
        const rel = item && (item.ruta || item.configuracion);
        if (!rel) throw Object.assign(new Error('Contribución no encontrada'), { status: 404 });
        const base = path.resolve(this.rutaPlugin(id));
        const abs = path.resolve(base, String(rel));
        if (!abs.startsWith(base + path.sep)) throw Object.assign(new Error('Ruta no permitida'), { status: 400 });
        if (!/\.(json|tmlanguage|plist|svg)$/i.test(abs)) throw Object.assign(new Error('Tipo de archivo no permitido'), { status: 400 });
        const st = fs.statSync(abs);
        if (st.size > 2 * 1024 * 1024) throw Object.assign(new Error('Archivo demasiado grande'), { status: 413 });
        const txt = fs.readFileSync(abs, 'utf8');
        if (/\.json$/i.test(abs)) return { tipo: 'json', datos: jsonLaxo(txt) };
        return { tipo: 'texto', texto: txt };
    }

    // ── Procesos aislados ──
    async asegurarProceso(id) {
        const m = this.meta(id);
        let p = this.procesos.get(id);
        if (p && p.vivo) { p.ultimo = Date.now(); return p; }
        if (!m.activable) throw Object.assign(new Error('Este plugin no se puede ejecutar: ' + m.compatibilidad.motivo), { status: 409 });
        if (!this.aislado && !process.env.PH_PERMITIR_SIN_AISLAMIENTO) throw Object.assign(new Error('Este servidor no puede aislar plugins (Node sin --permission). Por seguridad no se ejecuta nada.'), { status: 503 });
        if (this.procesos.size >= this.maxProcesos) {
            const masViejo = [...this.procesos.entries()].sort((a, b) => a[1].ultimo - b[1].ultimo)[0];
            if (masViejo) this.detener(masViejo[0]);
        }
        const dir = this.rutaPlugin(id);
        const args = ['--permission', `--allow-fs-read=${HOST_DIR}${path.sep}`, `--allow-fs-read=${dir}${path.sep}`,
            '--disallow-code-generation-from-strings', '--max-old-space-size=96', path.join(HOST_DIR, 'runner.js'), dir];
        const flags = this.aislado ? args : args.filter((a) => !a.startsWith('--permission') && !a.startsWith('--allow-fs-read'));
        const child = spawn(process.execPath, flags, { stdio: ['ignore', 'ignore', 'pipe', 'ipc'], env: {}, cwd: dir });
        p = { child, vivo: true, ultimo: Date.now(), pendientes: new Map(), logs: [], stderr: '' };
        this.procesos.set(id, p);
        p.listo = new Promise((resolve, reject) => {
            const t = setTimeout(() => { reject(new Error('El plugin no arrancó a tiempo')); this.detener(id); }, 6000);
            child.once('message', (msg) => { if (msg && msg.t === 'listo') { clearTimeout(t); resolve(); } });
            child.once('exit', () => { clearTimeout(t); reject(new Error('El plugin se cerró al arrancar' + (/Error:/.test(p.stderr) ? ': ' + (p.stderr.match(/Error: [^\n]{0,160}/) || [''])[0] : ''))); });
        });
        p.listo.catch(() => {});
        child.stderr.on('data', (d) => { p.stderr = (p.stderr + d).slice(-2000); });
        child.on('message', (msg) => {
            if (!msg) return;
            if (msg.t === 'log') { p.logs.push({ nivel: msg.nivel, mensaje: msg.msg }); if (p.logs.length > 200) p.logs.shift(); }
            else if (msg.t === 'res') {
                const w = p.pendientes.get(msg.id);
                if (!w) return;
                clearTimeout(w.t); p.pendientes.delete(msg.id);
                let valor = null; try { valor = JSON.parse(msg.valorJson || 'null'); } catch (_) {}
                w.resolve({ ok: !!msg.ok, valor, error: msg.error, acciones: msg.acciones || [], noSoportadas: msg.noSoportadas || [], registros: p.logs.slice(w.desde) });
            }
        });
        child.on('exit', () => {
            p.vivo = false;
            if (this.procesos.get(id) === p) this.procesos.delete(id);
            const sinMemoria = /heap out of memory|Allocation failed|JavaScript heap/i.test(p.stderr);
            for (const [, w] of p.pendientes) { clearTimeout(w.t); w.reject(Object.assign(new Error(sinMemoria ? 'El plugin se quedó sin memoria (límite 96 MB) y fue detenido' : 'El plugin se cerró inesperadamente'), { status: 500 })); }
            p.pendientes.clear();
        });
        await p.listo;
        return p;
    }

    async llamar(id, mensaje, ms = 6000) {
        const p = await this.asegurarProceso(id);
        p.ultimo = Date.now();
        // Un proceso recién arrancado (o reiniciado tras un fallo) primero se activa solo
        if (!p.activado && mensaje.t !== 'activar') {
            const a = await this.llamar(id, { t: 'activar' }, 8000);
            if (!a.ok) return a;
        }
        if (mensaje.t === 'activar') p.activado = true;
        const reqId = crypto.randomBytes(6).toString('hex');
        return new Promise((resolve, reject) => {
            const t = setTimeout(() => {
                p.pendientes.delete(reqId);
                this.detener(id);
                reject(Object.assign(new Error('El plugin tardó más de ' + ms / 1000 + ' s y fue detenido'), { status: 504 }));
            }, ms);
            p.pendientes.set(reqId, { resolve, reject, t, desde: p.logs.length });
            try { p.child.send(Object.assign({}, mensaje, { id: reqId })); }
            catch (e) { clearTimeout(t); p.pendientes.delete(reqId); reject(e); }
        });
    }

    detener(id) {
        const p = this.procesos.get(id);
        if (!p) return;
        this.procesos.delete(id);
        try { p.child.kill('SIGKILL'); } catch (_) {}
    }
    detenerTodos() { for (const id of [...this.procesos.keys()]) this.detener(id); }

    // ── Reseñas (archivo local; en el plan gratis de Render se pierden al reiniciar) ──
    _rutaResenas() { return path.join(DATA_DIR, 'resenas.json'); }
    _leerResenas() { try { return JSON.parse(fs.readFileSync(this._rutaResenas(), 'utf8')); } catch (_) { return {}; } }
    resenas(id) {
        validarId(id);
        const lista = this._leerResenas()[id] || [];
        const media = lista.length ? lista.reduce((a, r) => a + r.estrellas, 0) / lista.length : 0;
        return { total: lista.length, media: Math.round(media * 10) / 10, lista: lista.slice(-20).reverse() };
    }
    agregarResena(id, { estrellas, comentario, nombre }) {
        validarId(id);
        const n = parseInt(estrellas, 10);
        if (!(n >= 1 && n <= 5)) throw Object.assign(new Error('Las estrellas van de 1 a 5'), { status: 400 });
        const todo = this._leerResenas();
        todo[id] = (todo[id] || []).concat({ estrellas: n, comentario: String(comentario || '').slice(0, 400), nombre: String(nombre || 'Anónimo').slice(0, 40), fecha: new Date().toISOString() }).slice(-200);
        fs.writeFileSync(this._rutaResenas(), JSON.stringify(todo));
        return this.resenas(id);
    }
}

module.exports = { PluginHost, validarId, DATA_DIR };
