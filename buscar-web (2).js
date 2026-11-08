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
    const url = `${base}?q=${encodeURIComponent(termino)}&format=json&categories=${categoria}${busquedaSegura() ? '&safesearch=2' : ''}`;
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



// ── Búsqueda segura (por defecto ACTIVA, porque tu público incluye menores) ──
// Se apaga SOLO desde Render con BUSQUEDA_SEGURA=off; los usuarios no pueden desactivarla.
const busquedaSegura = () => String(process.env.BUSQUEDA_SEGURA || 'on').toLowerCase() !== 'off';
const TERMINOS_BLOQUEADOS = new Set(['porn', 'porno', 'pornografia', 'pornografico', 'xxx', 'sexo', 'sex', 'sexual', 'nude', 'nudes', 'naked',
    'desnudo', 'desnuda', 'desnudos', 'desnudas', 'nsfw', 'hentai', 'erotico', 'erotica', 'erotic', 'onlyfans', 'milf', 'gore', 'tetas',
    'puta', 'putas', 'fetish', 'fetiche', 'rule34']);
// Compara palabra por palabra (así "Essex" o "sexto" no se bloquean por error)
function terminoBloqueado(termino) {
    const palabras = String(termino || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
    return palabras.some((w) => TERMINOS_BLOQUEADOS.has(w));
}
const respuestaBloqueada = () => ({ exito: true, resultados: [], modo_seguro: true, aviso: 'Esta búsqueda no está permitida en el modo seguro.' });

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
// ── DuckDuckGo Lite (sin clave, "mejor esfuerzo") ──
// OJO: es extraer datos de una página web, no una API oficial. Puede dejar de funcionar si DuckDuckGo cambia su HTML
// o bloquea la IP del servidor, y sus términos pueden no permitir consultas automáticas. Por eso va antes de Wikipedia
// pero con respaldo: si falla, se salta 10 minutos para no hacer esperar a nadie.
let ddgBloqueadoHasta = 0;
const decodificarEntidades = (t) => String(t || '').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#0?39;|&#x27;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ');
function urlRealDeDuckDuckGo(href) {
    let h = decodificarEntidades(href).trim();
    if (h.startsWith('//')) h = 'https:' + h;
    try {
        const u = new URL(h);
        const real = u.searchParams.get('uddg');          // enlace de redirección: la URL verdadera va en "uddg"
        if (real) return real;
        if (/duckduckgo\.com\/y\.js/.test(h)) return null; // anuncio
        return h;
    } catch (_) { return null; }
}
function parsearDuckDuckGoLite(html) {
    const out = [];
    // tolerante al orden de los atributos: busca cada <a ... class='result-link' ...> sea cual sea su orden
    const reA = /<a\b([^>]*\bclass=['"]result-link['"][^>]*)>([\s\S]*?)<\/a>/gi;
    let m;
    while ((m = reA.exec(html)) !== null) {
        const href = (m[1].match(/\bhref=["']([^"']+)["']/i) || [])[1];
        const url = href ? urlRealDeDuckDuckGo(href) : null;
        if (!url) continue;
        const resto = html.slice(reA.lastIndex, reA.lastIndex + 3000);
        const sn = resto.match(/<td[^>]*class=['"]result-snippet['"][^>]*>([\s\S]*?)<\/td>/i);
        const resumen = decodificarEntidades(limpiarHtml(sn ? sn[1] : '')).replace(/\s+/g, ' ').trim();
        out.push({ titulo: decodificarEntidades(limpiarHtml(m[2])).replace(/\s+/g, ' ').trim(), url, resumen, descripcion: resumen, motor: 'duckduckgo' });
    }
    return out;
}
async function buscarEnDuckDuckGo(termino) {
    if (Date.now() < ddgBloqueadoHasta) return [];
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 8000);
    try {
        const res = await fetch('https://lite.duckduckgo.com/lite/?q=' + encodeURIComponent(termino) + (busquedaSegura() ? '&kp=1' : ''), {
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)', 'Accept-Language': 'es,en;q=0.8' }, signal: ctrl.signal
        });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const lista = parsearDuckDuckGoLite(await res.text()).slice(0, 15);
        if (!lista.length) throw new Error('sin resultados legibles (¿bloqueo o cambio de formato?)');
        return lista;
    } catch (e) {
        ddgBloqueadoHasta = Date.now() + 10 * 60 * 1000;
        console.error('[duckduckgo] falló, se salta 10 min: ' + e.message);
        throw e;
    } finally { clearTimeout(t); }
}

async function buscarEnBrave(termino) {
    if (!process.env.BRAVE_API_KEY) return [];
    const data = await getJsonSimple('https://api.search.brave.com/res/v1/web/search?count=10' + (busquedaSegura() ? '&safesearch=strict' : '') + '&q=' + encodeURIComponent(termino), { 'X-Subscription-Token': process.env.BRAVE_API_KEY });
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
            motor: 'wikipedia-' + lang,
            // Para leerlo dentro de tu app (con tu diseño) en vez de mandar al usuario a wikipedia.org
            articulo_api: '/api/articulo?idioma=' + lang + '&titulo=' + encodeURIComponent(r.title),
            // Crédito obligatorio de la licencia (CC BY-SA): muéstralo en pequeño debajo del resultado.
            fuente: 'Wikipedia',
            licencia: 'CC BY-SA 4.0',
            atribucion: 'Fuente: Wikipedia · CC BY-SA 4.0'
        }));
        if (lista.length) return lista;
    }
    return [];
}


// ── Libraries.io: paquetes de Python (PyPI), Ruby, Rust, PHP, .NET, Go, Java... (clave gratis: LIBRARIESIO_API_KEY) ──
const INSTALAR = {
    pypi: (n) => `pip install ${n}`, rubygems: (n) => `gem install ${n}`, npm: (n) => `npm install ${n}`, cargo: (n) => `cargo add ${n}`,
    nuget: (n) => `dotnet add package ${n}`, packagist: (n) => `composer require ${n}`, go: (n) => `go get ${n}`,
    maven: (n) => `Agrega ${n} a tu pom.xml`, pub: (n) => `dart pub add ${n}`, hex: (n) => `mix deps.get (agrega {:${n}, ...})`,
};
const cacheLibs = new Map(); // 10 min en memoria: Libraries.io permite ~60 consultas por minuto
async function buscarLibrerias(termino, plataforma) {
    if (busquedaSegura() && terminoBloqueado(termino)) return respuestaBloqueada();
    const key = process.env.LIBRARIESIO_API_KEY;
    if (!key) return { exito: false, error: 'Falta LIBRARIESIO_API_KEY (clave gratis en libraries.io, en tu cuenta) en las variables de Render.' };
    const plat = String(plataforma || '').replace(/[^A-Za-z0-9.]/g, '').slice(0, 20);
    const ck = (plat + '|' + String(termino).toLowerCase()).slice(0, 150);
    const c = cacheLibs.get(ck);
    if (c && Date.now() - c.t < 10 * 60 * 1000) return { exito: true, resultados: c.r, deCache: true };
    try {
        const url = 'https://libraries.io/api/search?per_page=10&q=' + encodeURIComponent(termino) + (plat ? '&platforms=' + encodeURIComponent(plat) : '') + '&api_key=' + encodeURIComponent(key);
        const data = await getJsonSimple(url);
        const resultados = (Array.isArray(data) ? data : []).slice(0, 10).map((p) => {
            const f = INSTALAR[String(p.platform || '').toLowerCase()];
            return {
                titulo: p.name, plataforma: p.platform, resumen: p.description || '', version: p.latest_release_number || '', estrellas: p.stars || 0,
                url: p.package_manager_url || p.homepage || p.repository_url || '', repo: p.repository_url || '',
                instalar: f ? f(p.name) : null, motor: 'libraries.io', fuente: 'Libraries.io', atribucion: 'Fuente: Libraries.io',
            };
        });
        if (resultados.length) cacheLibs.set(ck, { t: Date.now(), r: resultados });
        return { exito: true, resultados };
    } catch (e) {
        return { exito: false, error: 'No se pudo consultar Libraries.io: ' + e.message.replace(key, '***') };
    }
}

// ── Lector de artículos de Wikipedia: devuelve el TEXTO por secciones (sin el diseño de Wikipedia) ──
// El contenido tiene licencia CC BY-SA 4.0: puedes mostrarlo con tu propio diseño, pero debes mostrar el crédito
// (campo "atribucion") con un enlace al artículo original (campo "url_original").
const IDIOMAS_WIKI = new Set(['es', 'en', 'pt', 'fr', 'de', 'it']);
const SECCIONES_FINALES = /^(v[eé]ase tambi[eé]n|referencias|enlaces externos|notas|bibliograf[ií]a|see also|references|external links|further reading|notes|bibliography|voir aussi|r[eé]f[eé]rences|liens externes|siehe auch|einzelnachweise|weblinks|vedi anche|note|collegamenti esterni|ver tamb[eé]m|refer[eê]ncias|liga[cç][oõ]es externas)$/i;
const cacheArticulos = new Map(); // 1 hora en memoria
function seccionarExtracto(texto) {
    const secciones = []; let actual = { titulo: null, nivel: 1, parrafos: [] }; let buf = [];
    const cerrarParrafo = () => { const t = buf.join(' ').replace(/\s+/g, ' ').trim(); if (t) actual.parrafos.push(t); buf = []; };
    const cerrarSeccion = () => { cerrarParrafo(); if (actual.parrafos.length) secciones.push(actual); };
    for (const linea of String(texto || '').split('\n')) {
        const h = linea.match(/^(={2,6})\s*(.+?)\s*\1\s*$/);
        if (h) { cerrarSeccion(); actual = { titulo: h[2], nivel: h[1].length - 1, parrafos: [] }; }
        else if (!linea.trim()) cerrarParrafo();
        else buf.push(linea.trim());
    }
    cerrarSeccion();
    const out = []; let cortar = false;
    for (const sec of secciones) {
        if (sec.titulo && SECCIONES_FINALES.test(sec.titulo)) { if (sec.nivel === 1) cortar = true; continue; }
        if (cortar && sec.nivel > 1) continue;
        if (sec.nivel === 1 && sec.titulo) cortar = false;
        out.push(sec);
    }
    return out;
}
async function obtenerArticulo(titulo, idioma) {
    const lang = IDIOMAS_WIKI.has(String(idioma)) ? String(idioma) : 'es';
    const t = String(titulo || '').replace(/\s+/g, ' ').trim().slice(0, 200);
    if (!t) return { exito: false, error: 'Falta el parámetro ?titulo=' };
    if (busquedaSegura() && terminoBloqueado(t)) return respuestaBloqueada();
    const ck = lang + '|' + t.toLowerCase();
    const c = cacheArticulos.get(ck);
    if (c && Date.now() - c.t < 60 * 60 * 1000) return Object.assign({}, c.r, { deCache: true });
    try {
        const url = `https://${lang}.wikipedia.org/w/api.php?action=query&format=json&origin=*&redirects=1&prop=extracts|pageimages|info`
            + `&explaintext=1&exsectionformat=wiki&piprop=thumbnail&pithumbsize=900&inprop=url&titles=${encodeURIComponent(t)}`;
        const data = await getJsonSimple(url, null, 10000);
        const page = Object.values((data.query && data.query.pages) || {})[0];
        if (!page || page.missing !== undefined) return { exito: false, error: 'No se encontró ese artículo' };
        if (busquedaSegura() && terminoBloqueado(page.title)) return respuestaBloqueada();   // por si un redireccionamiento lleva a un tema bloqueado
        let secciones = seccionarExtracto(page.extract);
        let largo = 0, truncado = false;
        secciones = secciones.slice(0, 40).filter((sec) => { if (largo > 60000) { truncado = true; return false; } largo += sec.parrafos.join('').length; return true; });
        if (!secciones.length) return { exito: false, error: 'El artículo no tiene texto para mostrar' };
        const intro = secciones[0].titulo === null ? secciones[0].parrafos[0] : '';
        const resultado = {
            exito: true, idioma: lang, titulo: page.title, resumen: intro || '',
            secciones: secciones.map((sec) => ({ titulo: sec.titulo || 'Introducción', nivel: sec.nivel, parrafos: sec.parrafos })),
            imagen: (page.thumbnail && page.thumbnail.source) || null,
            imagen_nota: 'Las imágenes tienen licencias propias: los créditos están en la página original.',
            url_original: page.fullurl || `https://${lang}.wikipedia.org/wiki/${encodeURIComponent(page.title.replace(/ /g, '_'))}`,
            historial_url: `https://${lang}.wikipedia.org/w/index.php?title=${encodeURIComponent(page.title.replace(/ /g, '_'))}&action=history`,
            licencia: 'CC BY-SA 4.0', licencia_url: 'https://creativecommons.org/licenses/by-sa/4.0/',
            atribucion: 'Adaptado de Wikipedia, la enciclopedia libre · CC BY-SA 4.0', truncado,
        };
        if (cacheArticulos.size > 200) cacheArticulos.clear();
        cacheArticulos.set(ck, { t: Date.now(), r: resultado });
        return resultado;
    } catch (e) {
        return { exito: false, error: 'No se pudo cargar el artículo: ' + e.message };
    }
}

async function buscarWeb(termino) {
    if (busquedaSegura() && terminoBloqueado(termino)) return respuestaBloqueada();
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
            const r = await buscarEnDuckDuckGo(termino);
            if (r.length) resultado = { resultados: r, fuente: 'duckduckgo' };
        } catch (e) { errores.push('DuckDuckGo: ' + e.message); }
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
// ── Videos SIN clave ni registro: NASA, Wikimedia Commons e Internet Archive ──
async function videosNasa(termino) {
    const data = await getJsonSimple('https://images-api.nasa.gov/search?media_type=video&q=' + encodeURIComponent(termino));
    const items = ((data.collection && data.collection.items) || []).slice(0, 6);
    return Promise.all(items.map(async (it) => {
        const d = (it.data || [])[0] || {};
        let video_url = null;
        try { // la lista de archivos del video: se elige una versión ligera para el teléfono
            const files = await getJsonSimple(it.href, null, 4000);
            const mp4 = (Array.isArray(files) ? files : []).filter(f => /\.mp4$/i.test(f));
            video_url = mp4.find(f => /~(medium|small|mobile)\.mp4$/i.test(f)) || mp4[0] || null;
            if (video_url) video_url = video_url.replace(/^http:/, 'https:');
        } catch (_) {}
        return {
            titulo: d.title || 'Video de la NASA',
            url: 'https://images.nasa.gov/details/' + encodeURIComponent(d.nasa_id || ''),
            video_url,
            miniatura: ((it.links || [])[0] || {}).href || null,
            duracion: null,
            motor: 'nasa',
            fuente: 'NASA',
            licencia: 'Mayormente dominio público (NASA); revisa los términos de la NASA',
            atribucion: 'Fuente: NASA Image and Video Library'
        };
    }));
}
async function videosWikimedia(termino) {
    const url = 'https://commons.wikimedia.org/w/api.php?action=query&generator=search&gsrnamespace=6&gsrlimit=10'
        + '&gsrsearch=' + encodeURIComponent(termino + ' filetype:video')
        + '&prop=imageinfo&iiprop=url|mime|extmetadata&iiurlwidth=480&format=json&origin=*';
    const data = await getJsonSimple(url);
    return Object.values((data.query && data.query.pages) || {})
        .map(p => (p.imageinfo || [])[0])
        .filter(i => i && /^(video\/|application\/ogg)/.test(i.mime || ''))
        .slice(0, 6)
        .map(i => {
            const m = i.extmetadata || {};
            const lic = (m.LicenseShortName && m.LicenseShortName.value) || null;
            return {
                titulo: limpiarHtml((m.ObjectName && m.ObjectName.value) || (i.descriptionurl || '').split('File:').pop().replace(/_/g, ' ')),
                url: i.descriptionurl || i.url,
                video_url: i.url,
                miniatura: i.thumburl || null,
                duracion: null,
                motor: 'wikimedia',
                fuente: 'Wikimedia Commons',
                licencia: lic,
                atribucion: 'Fuente: Wikimedia Commons' + (lic ? ' · ' + lic : '')
            };
        });
}
async function videosInternetArchive(termino) {
    const q = '(' + termino.replace(/[()"]/g, ' ') + ') AND mediatype:(movies)';
    const url = 'https://archive.org/advancedsearch.php?output=json&rows=8&fl[]=identifier&fl[]=title&fl[]=licenseurl&q=' + encodeURIComponent(q);
    const data = await getJsonSimple(url);
    return ((data.response && data.response.docs) || []).slice(0, 6).map(d => ({
        titulo: Array.isArray(d.title) ? d.title[0] : (d.title || d.identifier),
        url: 'https://archive.org/details/' + d.identifier,
        embed_url: 'https://archive.org/embed/' + d.identifier,   // reproductor listo para incrustar
        miniatura: 'https://archive.org/services/img/' + d.identifier,
        duracion: null,
        motor: 'internet-archive',
        fuente: 'Internet Archive',
        licencia: d.licenseurl || 'Varía según el video: revisa la página de origen',
        atribucion: 'Fuente: Internet Archive'
    }));
}
// Mezcla alternando fuentes (uno de cada una) para que no domine solo la primera
function intercalar(listas, max) {
    const out = []; const n = Math.max(0, ...listas.map(l => l.length));
    for (let i = 0; i < n && out.length < max; i++) for (const l of listas) if (l[i] && out.length < max) out.push(l[i]);
    return out;
}
async function buscarVideosSinClave(termino) {
    const seguro = busquedaSegura();
    const r = await Promise.allSettled([videosNasa(termino), seguro ? Promise.resolve([]) : videosWikimedia(termino), seguro ? Promise.resolve([]) : videosInternetArchive(termino)]);
    const listas = r.map(x => (x.status === 'fulfilled' ? x.value : []));
    const errores = r.filter(x => x.status === 'rejected').map(x => x.reason && x.reason.message);
    return { resultados: intercalar(listas, 12), errores };
}

async function buscarVideos(termino) {
    if (busquedaSegura() && terminoBloqueado(termino)) return respuestaBloqueada();
    const enCache = await buscarEnCache(termino, 'videos');
    if (enCache) {
        return { exito: true, resultados: enCache.resultados, deCache: true, actualizado: enCache.actualizado };
    }

    // SearXNG (si lo configuraste) → si no, NASA + Wikimedia Commons + Internet Archive (gratis, sin clave)
    let resultado = null;
    const errores = [];
    try {
        resultado = await buscarEnSearXNG(termino, 'videos');
    } catch (e) { errores.push(e.message); }
    if (!resultado) {
        const r = await buscarVideosSinClave(termino);
        if (r.resultados.length) resultado = { resultados: r.resultados, fuente: 'nasa+wikimedia+internet-archive' };
        else errores.push(...r.errores.filter(Boolean));
    }
    if (!resultado) return { exito: false, error: 'No se encontraron videos. ' + errores.join(' · ') };

    await guardarEnCache(termino, resultado.resultados, resultado.fuente, 'videos');
    return { exito: true, resultados: resultado.resultados, deCache: false, fuente: resultado.fuente };
}

module.exports = { buscarWeb, buscarVideos, buscarLibrerias, obtenerArticulo, seccionarExtracto, parsearDuckDuckGoLite };
