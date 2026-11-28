'use strict';
// Rutas del servidor de plugins. Se puede:
//   · montar en un servidor Express existente:  require('./plugin-host').attachPluginHost(app, { express, rateLimit })
//   · o correr solo (recomendado, en un servicio de Render aparte):  node plugin-host/standalone.js
const crypto = require('crypto');
const { PluginHost } = require('./host');
const catalogos = require('./catalogos');

const HOSTS_DESCARGA = new Set(['open-vsx.org', 'openvsxorg.blob.core.windows.net', 'github.com', 'codeload.github.com',
    'objects.githubusercontent.com', 'raw.githubusercontent.com', 'gitlab.com', 'bitbucket.org']);
const MAX_DESCARGA = 30 * 1024 * 1024;

// Descarga segura: solo https, solo sitios de la lista, redirecciones revisadas una a una, tamaño máximo.
async function descargar(urlInicial) {
    let url = String(urlInicial || '');
    for (let salto = 0; salto < 5; salto++) {
        let u; try { u = new URL(url); } catch (_) { throw Object.assign(new Error('URL inválida'), { status: 400 }); }
        if (u.protocol !== 'https:' || !HOSTS_DESCARGA.has(u.hostname.toLowerCase()) || u.port) throw Object.assign(new Error('Descarga no permitida desde: ' + u.hostname), { status: 400 });
        const r = await fetch(u, { redirect: 'manual', headers: { 'User-Agent': 'CodeIDE-PluginHost/1.0' }, signal: AbortSignal.timeout(30000) });
        if ([301, 302, 303, 307, 308].includes(r.status)) { url = new URL(r.headers.get('location') || '', u).toString(); continue; }
        if (!r.ok) throw Object.assign(new Error('La descarga respondió ' + r.status), { status: 502 });
        const largo = Number(r.headers.get('content-length') || 0);
        if (largo > MAX_DESCARGA) throw Object.assign(new Error('El paquete es demasiado grande (máx. 30 MB)'), { status: 413 });
        const partes = []; let total = 0;
        const lector = r.body.getReader();
        for (;;) {
            const { done, value } = await lector.read();
            if (done) break;
            total += value.length;
            if (total > MAX_DESCARGA) { try { await lector.cancel(); } catch (_) {} throw Object.assign(new Error('El paquete es demasiado grande (máx. 30 MB)'), { status: 413 }); }
            partes.push(Buffer.from(value));
        }
        return Buffer.concat(partes);
    }
    throw Object.assign(new Error('Demasiadas redirecciones'), { status: 502 });
}

function attachPluginHost(app, deps) {
    const { express, rateLimit } = deps;
    const host = deps.host || new PluginHost();
    const CLAVE = process.env.PH_APP_KEY || process.env.APP_KEY || '';
    if (!CLAVE) console.warn('⚠️ [plugins] Sin PH_APP_KEY: cualquiera que conozca esta URL puede instalar y ejecutar plugins (aislados). Ponla en Render → Environment y en la app (cabecera x-app-key).');
    if (!host.aislado) console.warn('⚠️ [plugins] Este Node NO puede aislar procesos (--permission): no se ejecutará ningún plugin. Usa Node 22 o superior (NODE_VERSION=22 en Render).');

    const limite = (max) => rateLimit({ windowMs: 60 * 1000, max, standardHeaders: true, legacyHeaders: false, message: { ok: false, error: 'Demasiadas peticiones, espera un momento' } });
    // Límites por IP y por minuto (se pueden subir con PH_LIMITE_INSTALAR si tu app lo necesita)
    const lBuscar = limite(40), lInstalar = limite(Number(process.env.PH_LIMITE_INSTALAR) || 8), lEjecutar = limite(180), lLeer = limite(120), lResena = limite(12);
    const igual = (a, b) => crypto.timingSafeEqual(crypto.createHash('sha256').update(String(a || '')).digest(), crypto.createHash('sha256').update(String(b)).digest());
    const exigirClave = (req, res, next) => { if (!CLAVE || igual(req.headers['x-app-key'], CLAVE)) return next(); res.status(401).json({ ok: false, error: 'Falta la clave de la app (x-app-key) o es incorrecta' }); };
    const envolver = (fn) => async (req, res) => {
        try { await fn(req, res); }
        catch (e) { res.status(e.status || 500).json({ ok: false, error: String(e.message || e).slice(0, 300) }); }
    };
    const crudo = express.raw({ type: 'application/octet-stream', limit: '31mb' });
    const base = '/ph';

    app.get(base + '/salud', lLeer, (req, res) => res.json({ ok: true, node: process.version, aislamiento: host.aislado ? 'permission+vm' : 'NO DISPONIBLE', claveRequerida: Boolean(CLAVE), procesosActivos: host.procesos.size, fuentes: Object.keys(catalogos.FUENTES) }));

    app.get(base + '/fuentes', lLeer, (req, res) => res.json({ ok: true, fuentes: Object.entries(catalogos.FUENTES).map(([id, f]) => ({ id, nombre: f.nombre, compat: f.compat })) }));

    app.get(base + '/buscar', lBuscar, envolver(async (req, res) => {
        const q = String(req.query.q || '').trim();
        if (q.length < 2) return res.status(400).json({ ok: false, error: 'Escribe al menos 2 letras' });
        const fuentes = String(req.query.fuente || 'todas') === 'todas' ? null : String(req.query.fuente).split(',').map((s) => s.trim()).slice(0, 6);
        const r = await catalogos.buscar(q, fuentes, Math.min(25, Number(req.query.max) || 12));
        // Plugins publicados en tu propio marketplace (CodeIDE)
        const ql = q.toLowerCase();
        const locales = host.listar().filter((p) => p.publicado && (String(p.nombre) + ' ' + p.descripcion + ' ' + p.id).toLowerCase().includes(ql))
            .map((p) => ({ id: 'codeide:' + p.id, fuente: 'codeide', fuenteNombre: 'CodeIDE', nombre: p.nombre, descripcion: p.descripcion, autor: p.autor, version: p.version, icono: null, url: null, descargas: 0, descarga: null, instalado: p.id, compat: p.compatibilidad }));
        res.json({ ok: true, resultados: locales.concat(r.resultados), errores: r.errores, fuentes: r.fuentes });
    }));

    app.get(base + '/instalados', lLeer, envolver(async (req, res) => res.json({ ok: true, plugins: host.listar() })));

    // Instalar: o bien subiendo el archivo (Content-Type: application/octet-stream) o bien con JSON { fuente, url, info }
    const instalar = (publicar) => envolver(async (req, res) => {
        let buf, opciones = { fuente: 'subida', publicar };
        if (Buffer.isBuffer(req.body) && req.body.length) {
            buf = req.body;
            if (String(req.headers['x-formato'] || '') === 'sublime') opciones.formato = 'sublime';
        } else if (req.body && typeof req.body === 'object' && req.body.url) {
            const fuente = String(req.body.fuente || 'openvsx');
            if (['zed', 'jetbrains', 'eclipse'].includes(fuente)) return res.status(409).json({ ok: false, veredicto: 'solo-catalogo', error: 'Los plugins de ' + catalogos.FUENTES[fuente].nombre + ' no se pueden ejecutar en CodeIDE. Puedes ver su página, pero no instalarlos.', compat: catalogos.FUENTES[fuente].compat });
            if (!catalogos.FUENTES[fuente]) return res.status(400).json({ ok: false, error: 'Fuente desconocida' });
            buf = await descargar(req.body.url);
            opciones = { fuente, publicar, formato: fuente === 'packagecontrol' ? 'sublime' : 'vscode', info: req.body.info && typeof req.body.info === 'object' ? { nombre: req.body.info.nombre, version: req.body.info.version, descripcion: req.body.info.descripcion } : {} };
        } else return res.status(400).json({ ok: false, error: 'Manda el archivo (octet-stream) o JSON con { fuente, url }' });
        let r;
        try { r = host.instalar(buf, opciones); }
        catch (e) { return res.status(e.status || 422).json({ ok: false, error: String((e && e.message) || e).slice(0, 300) }); } // paquete roto o con rutas peligrosas
        res.status(r.ok ? 200 : (r.veredicto === 'bloqueado' ? 422 : 409)).json(r);
    });
    app.post(base + '/instalar', lInstalar, exigirClave, crudo, instalar(false));
    app.post(base + '/publicar', lInstalar, exigirClave, crudo, instalar(true));

    app.delete(base + '/p/:id', lInstalar, exigirClave, envolver(async (req, res) => { host.desinstalar(req.params.id); res.json({ ok: true }); }));
    app.post(base + '/p/:id/permisos', lEjecutar, exigirClave, envolver(async (req, res) => res.json({ ok: true, concedidos: host.permisos(req.params.id, req.body && req.body.concedidos) })));
    app.post(base + '/p/:id/detener', lEjecutar, exigirClave, envolver(async (req, res) => { host.detener(req.params.id); res.json({ ok: true }); }));

    const ejecutar = (armar, ms) => envolver(async (req, res) => {
        const b = req.body && typeof req.body === 'object' ? req.body : {};
        const r = await host.llamar(req.params.id, armar(b), ms);
        res.status(r.ok ? 200 : 422).json(r);
    });
    app.post(base + '/p/:id/activar', lEjecutar, exigirClave, ejecutar(() => ({ t: 'activar' }), 8000));
    app.post(base + '/p/:id/comando', lEjecutar, exigirClave, ejecutar((b) => ({ t: 'comando', nombre: String(b.comando || ''), args: Array.isArray(b.args) ? b.args.slice(0, 10) : [], editor: b.editor && b.editor.documento ? { documento: b.editor.documento } : undefined }), 8000));
    app.post(base + '/p/:id/proveedor', lEjecutar, exigirClave, ejecutar((b) => ({ t: 'proveedor', tipo: String(b.tipo || ''), doc: b.documento || {}, pos: b.posicion || { l: 0, c: 0 }, extra: b.extra || {} }), 6000));
    app.post(base + '/p/:id/evento', lEjecutar, exigirClave, ejecutar((b) => ({ t: 'evento', nombre: String(b.nombre || ''), doc: b.documento || {} }), 6000));

    app.get(base + '/p/:id/contribucion', lLeer, envolver(async (req, res) => res.json({ ok: true, ...host.leerContribucion(req.params.id, String(req.query.tipo || ''), req.query.idx) })));
    app.get(base + '/p/:id/resenas', lLeer, envolver(async (req, res) => res.json({ ok: true, ...host.resenas(req.params.id) })));
    app.post(base + '/p/:id/resenas', lResena, envolver(async (req, res) => res.json({ ok: true, ...host.agregarResena(req.params.id, req.body || {}) })));

    return host;
}

module.exports = { attachPluginHost, descargar, HOSTS_DESCARGA };
