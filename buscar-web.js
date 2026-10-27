// ==========================================================
// BÚSQUEDA WEB — usa SearXNG (motor de código abierto que
// junta resultados de Google, Bing, DuckDuckGo y más).
//
// SearXNG no busca él mismo — le pregunta a otros buscadores
// y te junta las respuestas, como un mesero que va a varios
// restaurantes y regresa con todo en una sola bandeja.
//
// Puedes poner VARIAS instancias, separadas por coma, en orden
// de prioridad — se prueban en ese orden hasta que una responda:
//   SEARXNG_URLS=https://tu-propia-instancia.com/search,https://una-publica.com/search
//
// La primera debería ser TU PROPIA instancia (rápida, sin
// compartir con nadie más). Las siguientes son de respaldo,
// por si la tuya se cae — pueden ser instancias públicas,
// más lentas porque las comparte mucha gente, pero gratis.
// ==========================================================

const { MongoClient } = require('mongodb');

const SEARXNG_URLS = (process.env.SEARXNG_URLS || process.env.SEARXNG_URL || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);

let clienteMongoBusqueda = null;
async function coleccionCacheBusqueda() {
    if (!process.env.MONGODB_URI) return null;
    if (!clienteMongoBusqueda) {
        clienteMongoBusqueda = new MongoClient(process.env.MONGODB_URI);
        await clienteMongoBusqueda.connect();
    }
    return clienteMongoBusqueda.db('mi_servidor').collection('cache_busqueda');
}

async function buscarEnCache(termino, tipo = 'web') {
    const col = await coleccionCacheBusqueda();
    if (!col) return null;
    return col.findOne({ termino: termino.toLowerCase(), tipo });
}

async function guardarEnCache(termino, resultados, fuente, tipo = 'web') {
    const col = await coleccionCacheBusqueda();
    if (!col) return;
    await col.updateOne(
        { termino: termino.toLowerCase(), tipo },
        { $set: { termino: termino.toLowerCase(), tipo, resultados, fuente, actualizado: new Date() } },
        { upsert: true }
    );
}

async function buscarEnUnaInstancia(base, termino, categoria = 'general') {
    const url = `${base}?q=${encodeURIComponent(termino)}&format=json&categories=${categoria}`;
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), 8000);
    try {
        const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: controller.signal });
        clearTimeout(t);
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const data = await res.json();
        if (categoria === 'videos') {
            return (data.results || []).slice(0, 10).map(r => ({
                titulo: r.title,
                url: r.url,
                miniatura: r.thumbnail || r.img_src || null,
                duracion: r.length || null,
                motor: r.engine || 'desconocido'
            }));
        }
        return (data.results || []).slice(0, 10).map(r => ({
            titulo: r.title,
            url: r.url,
            resumen: r.content || '',
            motor: r.engine || 'desconocido'
        }));
    } catch (e) {
        clearTimeout(t);
        throw e;
    }
}

// Prueba tu instancia propia primero; si falla o tarda mucho, cae a las
// de respaldo en orden — igual que el balanceo del resto del servidor.
async function buscarEnSearXNG(termino, categoria = 'general') {
    if (!SEARXNG_URLS.length) throw new Error('Falta SEARXNG_URLS (o SEARXNG_URL) en las variables de entorno');
    let ultimoError = null;
    for (const base of SEARXNG_URLS) {
        try {
            const resultados = await buscarEnUnaInstancia(base, termino, categoria);
            if (resultados.length) return { resultados, fuente: base };
        } catch (e) {
            ultimoError = e;
            continue;
        }
    }
    throw ultimoError || new Error('Ninguna instancia de SearXNG respondió');
}


// ── Respaldo SIN SearXNG: Brave (con clave gratis) y Wikipedia (sin clave) ──
async function getJsonSimple(url, headers, ms = 8000) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), ms);
    try {
        const res = await fetch(url, { headers: Object.assign({ 'User-Agent': 'CodeIDE/1.0 (buscador web; https://mi-servidor-v2.onrender.com)', Accept: 'application/json' }, headers || {}), signal: ctrl.signal });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return await res.json();
    } finally { clearTimeout(t); }
}
const limpiarHtml = (h) => String(h || '').replace(/<[^>]+>/g, '').replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/&#039;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>');
async function buscarEnBrave(termino) {
    if (!process.env.BRAVE_API_KEY) return [];
    const data = await getJsonSimple('https://api.search.brave.com/res/v1/web/search?count=10&q=' + encodeURIComponent(termino), { 'X-Subscription-Token': process.env.BRAVE_API_KEY });
    return ((data.web && data.web.results) || []).slice(0, 10).map(r => ({ titulo: limpiarHtml(r.title), url: r.url, resumen: limpiarHtml(r.description), motor: 'brave' }));
}
async function buscarEnWikipedia(termino) {
    for (const lang of ['es', 'en']) {
        const url = `https://${lang}.wikipedia.org/w/api.php?action=query&list=search&srlimit=8&format=json&origin=*&srsearch=${encodeURIComponent(termino)}`;
        const data = await getJsonSimple(url);
        const lista = ((data.query && data.query.search) || []).map(r => ({
            titulo: r.title,
            url: `https://${lang}.wikipedia.org/wiki/${encodeURIComponent(String(r.title).replace(/ /g, '_'))}`,
            resumen: limpiarHtml(r.snippet),
            motor: 'wikipedia-' + lang
        }));
        if (lista.length) return lista;
    }
    return [];
}

async function buscarWeb(termino) {
    const enCache = await buscarEnCache(termino, 'web');
    if (enCache) {
        return { exito: true, resultados: enCache.resultados, deCache: true, actualizado: enCache.actualizado };
    }

    // Cadena de respaldo: SearXNG (si lo configuraste) → Brave (si pusiste BRAVE_API_KEY) → Wikipedia (gratis, sin clave)
    let resultado = null;
    const errores = [];
    try {
        resultado = await buscarEnSearXNG(termino, 'general');
    } catch (e) { errores.push(e.message); }
    if (!resultado) {
        try {
            const r = await buscarEnBrave(termino);
            if (r.length) resultado = { resultados: r, fuente: 'brave' };
        } catch (e) { errores.push('Brave: ' + e.message); }
    }
    if (!resultado) {
        try {
            const r = await buscarEnWikipedia(termino);
            if (r.length) resultado = { resultados: r, fuente: 'wikipedia' };
        } catch (e) { errores.push('Wikipedia: ' + e.message); }
    }
    if (!resultado) {
        return { exito: false, error: 'No se encontraron resultados. ' + errores.join(' · ') };
    }

    await guardarEnCache(termino, resultado.resultados, resultado.fuente, 'web');
    return { exito: true, resultados: resultado.resultados, deCache: false, fuente: resultado.fuente };
}

// ── Búsqueda de videos — junta YouTube, Vimeo, Dailymotion, sin API keys ──
async function buscarVideos(termino) {
    const enCache = await buscarEnCache(termino, 'videos');
    if (enCache) {
        return { exito: true, resultados: enCache.resultados, deCache: true, actualizado: enCache.actualizado };
    }

    let resultado;
    try {
        resultado = await buscarEnSearXNG(termino, 'videos');
    } catch (e) {
        return { exito: false, error: e.message };
    }

    await guardarEnCache(termino, resultado.resultados, resultado.fuente, 'videos');
    return { exito: true, resultados: resultado.resultados, deCache: false, fuente: resultado.fuente };
}

module.exports = { buscarWeb, buscarVideos };
