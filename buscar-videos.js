// ==========================================================
// BUSCADOR DE VIDEOS — Dailymotion + Internet Archive + PeerTube
// ----------------------------------------------------------
// Sin API keys: las tres APIs son públicas.
//   · Dailymotion   → catálogo general (api.dailymotion.com)
//   · Internet Archive → mediatype:movies y SOLO dominio público
//   · PeerTube      → vía Sepia Search (el buscador oficial que junta
//                     cientos de instancias), SOLO licencias
//                     licenceOneOf = 1 (CC BY), 2 (CC BY-SA), 7 (CC0)
//
// Cada resultado trae `embed_url`: el reproductor OFICIAL de su
// plataforma, listo para ponerlo en un <iframe>. Nunca se descarga
// ni se re-transmite el video: se reproduce desde su plataforma.
//
// Búsqueda segura (por defecto ACTIVA, tu público incluye menores):
// se apaga SOLO desde Render con BUSQUEDA_SEGURA=off. Mientras esté
// activa se pide el filtro familiar a Dailymotion, se excluye NSFW en
// PeerTube y se filtran temas para adultos en Internet Archive.
//
// Endpoint:  GET /api/videos/buscar?q=gatos
//   opcionales: &fuentes=dailymotion,archive,peertube
//               &limite=8 (por fuente, máx. 15)   &pagina=1
// ==========================================================

const { busquedaSegura, terminoBloqueado } = require('./buscar-web');

const UA = 'CodeIDE/1.0 (buscador de videos; https://mi-servidor-v2.onrender.com)';
const FUENTES_VALIDAS = ['dailymotion', 'archive', 'peertube'];

// Licencias de PeerTube que se aceptan (las que pediste: 1, 2 y 7)
const LICENCIAS_PEERTUBE = {
    1: { nombre: 'CC BY 4.0', url: 'https://creativecommons.org/licenses/by/4.0/' },
    2: { nombre: 'CC BY-SA 4.0', url: 'https://creativecommons.org/licenses/by-sa/4.0/' },
    7: { nombre: 'CC0 (dominio público)', url: 'https://creativecommons.org/publicdomain/zero/1.0/' },
};

// ── Ayudantes ──
async function pedirJson(url, ms = 8000) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), ms);
    try {
        const res = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' }, signal: ctrl.signal });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return await res.json();
    } catch (e) {
        if (e && e.name === 'AbortError') throw new Error('tiempo de espera agotado');
        throw e;
    } finally { clearTimeout(t); }
}

// Solo se aceptan enlaces https (miniaturas y páginas): nada de javascript:, http:, etc.
function soloHttps(u) {
    try { const x = new URL(String(u || '')); return x.protocol === 'https:' ? x.href : null; } catch (_) { return null; }
}
const texto = (v, max = 200) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, max);

function formatearDuracion(valor) {
    if (valor == null || valor === '') return null;
    let seg;
    if (typeof valor === 'number') seg = valor;
    else if (/^\d+(\.\d+)?$/.test(String(valor))) seg = parseFloat(valor);
    else if (/^\d{1,2}:\d{2}(:\d{2})?$/.test(String(valor).trim())) {
        const p = String(valor).trim().split(':').map(Number);
        seg = p.length === 3 ? p[0] * 3600 + p[1] * 60 + p[2] : p[0] * 60 + p[1];
    } else return null;
    if (!isFinite(seg) || seg <= 0) return null;
    seg = Math.round(seg);
    const h = Math.floor(seg / 3600), m = Math.floor((seg % 3600) / 60), s = seg % 60;
    const dos = (n) => String(n).padStart(2, '0');
    return h ? `${h}:${dos(m)}:${dos(s)}` : `${m}:${dos(s)}`;
}

// ── URLs de los reproductores oficiales (se construyen aquí, no se confía en lo que mande la API) ──
const embedDailymotion = (id) => (/^[A-Za-z0-9]{3,20}$/.test(String(id)) ? 'https://www.dailymotion.com/embed/video/' + id : null);
const embedArchive = (id) => (/^[A-Za-z0-9._-]{1,200}$/.test(String(id)) ? 'https://archive.org/embed/' + encodeURIComponent(id) : null);
function embedPeerTube(host, uuid) {
    const h = String(host || '').toLowerCase();
    if (!/^(?=.{4,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/.test(h)) return null;
    if (!/^[A-Za-z0-9-]{8,40}$/.test(String(uuid))) return null;
    return `https://${h}/videos/embed/${uuid}`;
}

// ── 1) Dailymotion ──
async function buscarDailymotion(q, limite, pagina, seguro) {
    const p = new URLSearchParams({
        search: q, limit: String(limite), page: String(pagina), sort: 'relevance',
        fields: 'id,title,thumbnail_360_url,duration,owner.screenname',
    });
    if (seguro) p.set('family_filter', '1');
    const data = await pedirJson('https://api.dailymotion.com/videos?' + p.toString());
    return (data.list || []).map((v) => {
        const embed = embedDailymotion(v.id);
        if (!embed) return null;
        const canal = texto(v['owner.screenname'], 80);
        return {
            titulo: texto(v.title, 160) || 'Video de Dailymotion',
            url: 'https://www.dailymotion.com/video/' + v.id,
            embed_url: embed,
            miniatura: soloHttps(v.thumbnail_360_url),
            duracion: formatearDuracion(v.duration),
            canal: canal || null,
            motor: 'dailymotion',
            fuente: 'Dailymotion',
            licencia: 'Estándar de Dailymotion (solo reproducción en su reproductor oficial)',
            atribucion: 'Fuente: Dailymotion' + (canal ? ' · ' + canal : ''),
        };
    }).filter(Boolean);
}

// ── 2) Internet Archive: películas en dominio público ──
async function buscarArchive(q, limite, pagina, seguro) {
    const limpio = q.replace(/[()"\\:[\]{}^~*?!|&/]/g, ' ').replace(/\s+/g, ' ').trim();
    if (!limpio) return [];
    let consulta = `(${limpio}) AND mediatype:(movies) AND licenseurl:(*publicdomain*)`;
    if (seguro) consulta += ' AND -subject:(adult OR porn OR xxx OR nsfw OR erotic)';
    const p = new URLSearchParams({ q: consulta, output: 'json', rows: String(limite), page: String(pagina) });
    ['identifier', 'title', 'creator', 'licenseurl', 'runtime'].forEach((f) => p.append('fl[]', f));
    const data = await pedirJson('https://archive.org/advancedsearch.php?' + p.toString());
    return ((data.response && data.response.docs) || []).map((d) => {
        const embed = embedArchive(d.identifier);
        if (!embed) return null;
        const titulo = Array.isArray(d.title) ? d.title[0] : d.title;
        const creador = Array.isArray(d.creator) ? d.creator[0] : d.creator;
        const runtime = Array.isArray(d.runtime) ? d.runtime[0] : d.runtime;
        return {
            titulo: texto(titulo, 160) || texto(d.identifier, 80),
            url: 'https://archive.org/details/' + encodeURIComponent(d.identifier),
            embed_url: embed,
            miniatura: 'https://archive.org/services/img/' + encodeURIComponent(d.identifier),
            duracion: formatearDuracion(runtime),
            canal: texto(creador, 80) || null,
            motor: 'internet-archive',
            fuente: 'Internet Archive',
            licencia: 'Dominio público',
            licencia_url: soloHttps(Array.isArray(d.licenseurl) ? d.licenseurl[0] : d.licenseurl),
            atribucion: 'Fuente: Internet Archive · Dominio público',
        };
    }).filter(Boolean);
}

// ── 3) PeerTube (Sepia Search) — solo licencias 1, 2 y 7 ──
async function buscarPeerTube(q, limite, pagina, seguro) {
    const p = new URLSearchParams();
    p.set('search', q);
    p.set('count', String(limite));
    p.set('start', String((pagina - 1) * limite));
    Object.keys(LICENCIAS_PEERTUBE).forEach((id) => p.append('licenceOneOf', id));
    if (seguro) p.set('nsfw', 'false');
    const data = await pedirJson('https://sepiasearch.org/api/v1/search/videos?' + p.toString());
    return (data.data || []).map((v) => {
        const lic = LICENCIAS_PEERTUBE[v.licence && v.licence.id];
        if (!lic) return null;                                   // doble seguro: solo las licencias pedidas
        if (seguro && v.nsfw) return null;
        const host = (v.channel && v.channel.host) || (v.account && v.account.host);
        const embed = embedPeerTube(host, v.uuid);
        if (!embed) return null;
        const canal = texto((v.channel && v.channel.displayName) || (v.account && v.account.displayName), 80);
        return {
            titulo: texto(v.name, 160) || 'Video de PeerTube',
            url: soloHttps(v.url) || `https://${host}/w/${v.uuid}`,
            embed_url: embed,
            miniatura: soloHttps(v.thumbnailUrl),
            duracion: formatearDuracion(v.duration),
            canal: canal || null,
            instancia: String(host).toLowerCase(),
            motor: 'peertube',
            fuente: 'PeerTube',
            licencia: lic.nombre,
            licencia_url: lic.url,
            atribucion: `${texto(v.name, 100)}${canal ? ' — ' + canal : ''} · ${lic.nombre} · ${String(host).toLowerCase()}`,
        };
    }).filter(Boolean);
}

const BUSCADORES = { dailymotion: buscarDailymotion, archive: buscarArchive, peertube: buscarPeerTube };

// Alterna una de cada fuente para que no domine solo la primera
function intercalar(listas, max) {
    const out = [];
    const n = Math.max(0, ...listas.map((l) => l.length));
    for (let i = 0; i < n && out.length < max; i++) for (const l of listas) if (l[i] && out.length < max) out.push(l[i]);
    return out;
}

// Caché en memoria (10 min): protege a las APIs públicas y acelera búsquedas repetidas
const cache = new Map();
const TTL_CACHE = 10 * 60 * 1000;

async function buscarVideosLibres(termino, opciones = {}) {
    const seguro = busquedaSegura();
    const q = texto(termino, 100);
    if (!q) return { exito: false, error: 'Falta el parámetro ?q=' };
    if (seguro && terminoBloqueado(q)) {
        return { exito: true, resultados: [], modo_seguro: true, aviso: 'Esta búsqueda no está permitida en el modo seguro.' };
    }

    const pedidas = Array.isArray(opciones.fuentes) && opciones.fuentes.length ? opciones.fuentes : FUENTES_VALIDAS;
    const fuentes = FUENTES_VALIDAS.filter((f) => pedidas.includes(f));
    if (!fuentes.length) return { exito: false, error: 'Fuentes válidas: ' + FUENTES_VALIDAS.join(', ') };
    const limite = Math.max(1, Math.min(15, parseInt(opciones.limite, 10) || 8));
    const pagina = Math.max(1, Math.min(50, parseInt(opciones.pagina, 10) || 1));

    const clave = [q.toLowerCase(), fuentes.join(','), limite, pagina, seguro].join('|');
    const guardado = cache.get(clave);
    if (guardado && Date.now() - guardado.t < TTL_CACHE) return Object.assign({}, guardado.r, { deCache: true });

    const respuestas = await Promise.allSettled(fuentes.map((f) => BUSCADORES[f](q, limite, pagina, seguro)));
    const estado = {};
    const listas = respuestas.map((r, i) => {
        const f = fuentes[i];
        if (r.status === 'fulfilled') { estado[f] = { ok: true, cantidad: r.value.length }; return r.value; }
        estado[f] = { ok: false, error: texto(r.reason && r.reason.message, 120) };
        return [];
    });

    const resultados = intercalar(listas, limite * fuentes.length);
    if (!resultados.length && Object.values(estado).every((s) => !s.ok)) {
        return { exito: false, error: 'No respondió ninguna fuente de video.', fuentes: estado };
    }

    const resultado = { exito: true, resultados, fuentes: estado, modo_seguro: seguro, pagina, deCache: false };
    if (cache.size > 200) cache.clear();
    cache.set(clave, { t: Date.now(), r: resultado });
    return resultado;
}

// Conecta la ruta al servidor Express. Si algo falla, el resto del servidor sigue funcionando.
function attachBuscadorVideos(app, opciones = {}) {
    const limitador = typeof opciones.rateLimit === 'function'
        ? opciones.rateLimit({
            windowMs: 60 * 1000, max: 30, standardHeaders: true, legacyHeaders: false,
            message: { exito: false, error: 'Demasiadas búsquedas, espera un momento' },
        })
        : (req, res, next) => next();

    app.get('/api/videos/buscar', limitador, async (req, res) => {
        try {
            const fuentes = String(req.query.fuentes || '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
            res.json(await buscarVideosLibres(req.query.q, { fuentes, limite: req.query.limite, pagina: req.query.pagina }));
        } catch (e) {
            console.error('[buscar-videos] error: ' + e.message);
            res.status(500).json({ exito: false, error: 'Error al buscar videos' });
        }
    });
}

module.exports = { buscarVideosLibres, attachBuscadorVideos, formatearDuracion, embedDailymotion, embedArchive, embedPeerTube };
