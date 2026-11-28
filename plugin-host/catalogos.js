'use strict';
// Catálogos de plugins. Cada uno devuelve la MISMA forma:
//   { id, fuente, nombre, descripcion, autor, version, icono, url, descargas, descarga, compat:{nivel,motivo} }
// "compat.nivel": 'posible'  → extensión de VS Code: se analiza al instalar
//                 'datos'    → solo se aprovechan snippets/temas (su código no se ejecuta)
//                 'solo-catalogo' → se puede ver y abrir su página, pero no se puede ejecutar en CodeIDE
const UA = 'CodeIDE-PluginHost/1.0';
const T = 9000;

const FUENTES = {
    openvsx: { nombre: 'Open VSX', compat: { nivel: 'posible', motivo: 'Extensión de VS Code (JavaScript): se analiza y se ejecuta aislada si es compatible' } },
    packagecontrol: { nombre: 'Sublime Package Control', compat: { nivel: 'datos', motivo: 'Los plugins de Sublime son Python con su API propia (no se ejecutan); se convierten sus snippets' } },
    zed: { nombre: 'Zed Extensions', compat: { nivel: 'solo-catalogo', motivo: 'Las extensiones de Zed son Rust compilado a WebAssembly con la API de Zed' } },
    jetbrains: { nombre: 'JetBrains Marketplace', compat: { nivel: 'solo-catalogo', motivo: 'Los plugins de JetBrains son Java/Kotlin (JVM) y dependen del IDE' } },
    eclipse: { nombre: 'Eclipse Marketplace', compat: { nivel: 'solo-catalogo', motivo: 'Los plugins de Eclipse son Java/OSGi y dependen del IDE' } },
};

async function pedir(url, tipo = 'json', ms = T) {
    const r = await fetch(url, { headers: { 'User-Agent': UA, Accept: tipo === 'json' ? 'application/json' : '*/*' }, signal: AbortSignal.timeout(ms) });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return tipo === 'json' ? r.json() : r.text();
}
const txt = (v, n = 300) => String(v == null ? '' : v).replace(/\s+/g, ' ').trim().slice(0, n);
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const https = (u) => { const s = String(u || ''); return /^https:\/\//i.test(s) ? s : (/^http:\/\//i.test(s) ? s.replace(/^http:/i, 'https:') : null); };
const norm = (fuente, key, o) => ({ id: fuente + ':' + key, fuente, fuenteNombre: FUENTES[fuente].nombre, nombre: txt(o.nombre, 100), descripcion: txt(o.descripcion, 300), autor: txt(o.autor, 80), version: txt(o.version, 30), icono: https(o.icono), url: https(o.url), descargas: num(o.descargas), descarga: https(o.descarga), compat: FUENTES[fuente].compat });

// ── Open VSX ──
async function openvsx(q, n) {
    const d = await pedir('https://open-vsx.org/api/-/search?query=' + encodeURIComponent(q) + '&size=' + n);
    return (d.extensions || []).map((e) => norm('openvsx', e.namespace + '.' + e.name, {
        nombre: e.displayName || e.name, descripcion: e.description, autor: e.namespace, version: e.version,
        icono: e.files && e.files.icon, url: 'https://open-vsx.org/extension/' + encodeURIComponent(e.namespace) + '/' + encodeURIComponent(e.name),
        descargas: e.downloadCount, descarga: e.files && e.files.download,
    }));
}

// ── Eclipse Marketplace (devuelve XML) ──
const decodificar = (s) => String(s).replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&amp;/g, '&');
const etiqueta = (xml, t) => { const m = new RegExp('<' + t + '[^>]*>([\\s\\S]*?)</' + t + '>', 'i').exec(xml); return m ? decodificar(m[1]).replace(/<[^>]+>/g, ' ') : ''; };
async function eclipse(q, n) {
    const xml = await pedir('https://marketplace.eclipse.org/api/p/search/apachesolr_search/' + encodeURIComponent(q), 'texto');
    const out = [];
    for (const m of xml.matchAll(/<node\b([^>]*)>([\s\S]*?)<\/node>/gi)) {
        const attrs = {}; for (const a of m[1].matchAll(/(\w+)="([^"]*)"/g)) attrs[a[1]] = decodificar(a[2]);
        if (!attrs.name) continue;
        out.push(norm('eclipse', attrs.id || attrs.name, {
            nombre: attrs.name, descripcion: etiqueta(m[2], 'shortdescription') || etiqueta(m[2], 'body'), autor: etiqueta(m[2], 'companyname') || etiqueta(m[2], 'owner'),
            version: etiqueta(m[2], 'version'), icono: etiqueta(m[2], 'image').trim(), url: attrs.url, descargas: etiqueta(m[2], 'installstotal'),
        }));
        if (out.length >= n) break;
    }
    return out;
}

// ── Sublime Package Control (canal público; archivo grande, se guarda 6 h en memoria) ──
let cachePC = { t: 0, lista: null };
async function listaPackageControl() {
    if (cachePC.lista && Date.now() - cachePC.t < 6 * 3600 * 1000) return cachePC.lista;
    const d = await pedir('https://packagecontrol.io/channel_v3.json', 'json', 25000);
    const lista = [];
    for (const paquetes of Object.values(d.packages_cache || {})) for (const p of Array.isArray(paquetes) ? paquetes : []) if (p && p.name) lista.push(p);
    if (!lista.length) throw new Error('Respuesta inesperada del canal');
    cachePC = { t: Date.now(), lista };
    return lista;
}
async function packagecontrol(q, n) {
    const lista = await listaPackageControl();
    const palabras = q.toLowerCase().split(/\s+/).filter(Boolean);
    const puntuados = [];
    for (const p of lista) {
        const nombre = String(p.name).toLowerCase(), resto = (String(p.description || '') + ' ' + (p.labels || []).join(' ')).toLowerCase();
        let pt = 0;
        for (const w of palabras) { if (nombre === w) pt += 10; else if (nombre.includes(w)) pt += 5; else if (resto.includes(w)) pt += 1; else { pt = -1; break; } }
        if (pt > 0) puntuados.push([pt, p]);
    }
    puntuados.sort((a, b) => b[0] - a[0] || String(a[1].name).localeCompare(String(b[1].name)));
    return puntuados.slice(0, n).map(([, p]) => {
        const rel = (p.releases || [])[0] || {};
        return norm('packagecontrol', p.name, {
            nombre: p.name, descripcion: p.description, autor: Array.isArray(p.authors) ? p.authors.join(', ') : p.author || p.authors,
            version: rel.version || '', url: p.homepage || 'https://packagecontrol.io/packages/' + encodeURIComponent(p.name), descargas: 0, descarga: rel.url,
        });
    });
}

// ── Zed ──
async function zed(q, n) {
    const d = await pedir('https://api.zed.dev/extensions?max_schema_version=10&filter=' + encodeURIComponent(q));
    return (d.data || []).slice(0, n).map((e) => norm('zed', e.id, {
        nombre: e.name, descripcion: e.description, autor: Array.isArray(e.authors) ? e.authors.join(', ') : e.authors, version: e.version,
        url: 'https://zed.dev/extensions/' + encodeURIComponent(e.id), descargas: e.download_count,
    }));
}

// ── JetBrains ──
async function jetbrains(q, n) {
    const d = await pedir('https://plugins.jetbrains.com/api/searchPlugins?max=' + n + '&offset=0&search=' + encodeURIComponent(q));
    const lista = Array.isArray(d) ? d : d.plugins || d.items || [];
    return lista.slice(0, n).map((p) => norm('jetbrains', p.id || p.pluginId || p.name, {
        nombre: p.name, descripcion: p.preview || p.description, autor: (p.vendor && (p.vendor.name || p.vendor)) || p.vendorName || '', version: p.version || '',
        icono: p.icon ? (String(p.icon).startsWith('/') ? 'https://plugins.jetbrains.com' + p.icon : p.icon) : null,
        url: 'https://plugins.jetbrains.com/plugin/' + encodeURIComponent(p.id || p.pluginId || ''), descargas: p.downloads,
    }));
}

const MOTORES = { openvsx, packagecontrol, zed, jetbrains, eclipse };

// Busca en varias fuentes a la vez. Una que falle NO tumba a las demás: se reporta en "errores".
async function buscar(q, fuentes, porFuente = 12) {
    const consulta = txt(q, 100);
    const lista = (fuentes && fuentes.length ? fuentes : Object.keys(MOTORES)).filter((f) => MOTORES[f]);
    const r = await Promise.allSettled(lista.map((f) => MOTORES[f](consulta, porFuente)));
    const resultados = [], errores = {};
    r.forEach((x, i) => { if (x.status === 'fulfilled') resultados.push(...x.value); else errores[lista[i]] = String(x.reason && x.reason.message || x.reason).slice(0, 120); });
    return { resultados, errores, fuentes: lista };
}

module.exports = { buscar, FUENTES, MOTORES, _internos: { decodificar, etiqueta } };
