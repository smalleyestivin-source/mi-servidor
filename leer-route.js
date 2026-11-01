'use strict';
// Modo lectura para Code IDE: GET /api/leer?url=https://...  ->  { exito, titulo, sitio, contenido }
// Sin dependencias (Node 18+). Pégalo junto a tus otras rutas y regístralo:
//   const { registrarLeer } = require('./leer-route'); registrarLeer(app);
const dns = require('dns').promises;
const net = require('net');

const MAX_BYTES = 2.5 * 1024 * 1024, TIMEOUT_MS = 10000, MAX_REDIRECTS = 3;

// ── Seguridad: nunca leer direcciones internas de tu propio servidor (SSRF) ──
function ipPrivada(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  if (net.isIPv6(ip)) {
    const l = ip.toLowerCase();
    if (l === '::1' || l === '::' || l.startsWith('fe80') || l.startsWith('fc') || l.startsWith('fd')) return true;
    const m = l.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    return m ? ipPrivada(m[1]) : false;
  }
  return true;
}
async function urlSegura(u) {
  let url;
  try { url = new URL(u); } catch (_) { throw new Error('Dirección inválida'); }
  if (!/^https?:$/.test(url.protocol)) throw new Error('Solo se permiten direcciones http o https');
  if (url.username || url.password) throw new Error('Dirección no permitida');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.local') || host.endsWith('.internal')) throw new Error('Dirección no permitida');
  const addrs = net.isIP(host) ? [{ address: host }] : await dns.lookup(host, { all: true });
  if (!addrs.length || addrs.some(a => ipPrivada(a.address))) throw new Error('Dirección no permitida');
  return url;
}
async function descargar(u) {
  let url = await urlSegura(u);
  for (let i = 0; i <= MAX_REDIRECTS; i++) {
    const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), TIMEOUT_MS);
    let r;
    try {
      r = await fetch(url, { redirect: 'manual', signal: ctl.signal, headers: { 'User-Agent': 'Mozilla/5.0 (compatible; CodeIDE-Lector/1.0)', 'Accept': 'text/html,application/xhtml+xml' } });
    } finally { clearTimeout(t); }
    if (r.status >= 300 && r.status < 400 && r.headers.get('location')) { url = await urlSegura(new URL(r.headers.get('location'), url).href); continue; }
    if (!r.ok) throw new Error('El sitio respondió ' + r.status);
    const tipo = r.headers.get('content-type') || '';
    if (!/text\/html|application\/xhtml/i.test(tipo)) throw new Error('La dirección no es una página web');
    const reader = r.body.getReader(); const chunks = []; let total = 0;
    for (;;) { const { done, value } = await reader.read(); if (done) break; total += value.length; if (total > MAX_BYTES) { try { reader.cancel(); } catch (_) {} break; } chunks.push(value); }
    const cs = (tipo.match(/charset=([\w-]+)/i) || [])[1] || 'utf-8';
    let dec; try { dec = new TextDecoder(cs); } catch (_) { dec = new TextDecoder('utf-8'); }
    return { html: dec.decode(Buffer.concat(chunks)), url: url.href };
  }
  throw new Error('Demasiadas redirecciones');
}

// ── Extracción del texto principal ──
const PERMITIDAS = new Set(['p', 'h1', 'h2', 'h3', 'h4', 'ul', 'ol', 'li', 'blockquote', 'pre', 'code', 'em', 'strong', 'b', 'i', 'br', 'img', 'figure', 'figcaption', 'a', 'hr', 'table', 'thead', 'tbody', 'tr', 'th', 'td']);
const ent = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
function decodeEnt(s) {
  return s.replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (m, n) => String.fromCodePoint(Math.min(+n, 0x10FFFF)));
}
function absUrl(v, base) { try { const u = new URL(v, base); return /^https?:$/.test(u.protocol) ? u.href : ''; } catch (_) { return ''; } }
function atributo(tag, nombre) {
  const m = tag.match(new RegExp('\\s' + nombre + '\\s*=\\s*("([^"]*)"|\'([^\']*)\'|([^\\s>]+))', 'i'));
  return m ? decodeEnt(m[2] ?? m[3] ?? m[4] ?? '') : '';
}
function limpiarEtiquetas(html, base) {
  return html.replace(/<\/?([a-zA-Z][a-zA-Z0-9]*)\b[^>]*>/g, (tag, nombre) => {
    const n = nombre.toLowerCase(), cierre = tag[1] === '/';
    if (!PERMITIDAS.has(n)) return '';
    if (cierre) return '</' + n + '>';
    if (n === 'a') { const h = absUrl(atributo(tag, 'href'), base); return h ? '<a href="' + ent(h) + '">' : '<a>'; }
    if (n === 'img') {
      const s = absUrl(atributo(tag, 'src') || atributo(tag, 'data-src'), base);
      return s ? '<img src="' + ent(s) + '" alt="' + ent(atributo(tag, 'alt')) + '">' : '';
    }
    return '<' + n + (n === 'br' || n === 'hr' ? '/' : '') + '>';
  });
}
function textoPlano(h) { return decodeEnt(h.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim(); }
function bloque(html, etiqueta) { // contenido del primer <etiqueta> con su cierre correspondiente (cuenta anidados)
  const abre = new RegExp('<' + etiqueta + '\\b[^>]*>', 'ig'); let m, mejor = '';
  while ((m = abre.exec(html))) {
    let prof = 1, i = abre.lastIndex; const re = new RegExp('<(/?)' + etiqueta + '\\b[^>]*>', 'ig'); re.lastIndex = i; let x;
    while ((x = re.exec(html))) { prof += x[1] ? -1 : 1; if (!prof) break; }
    const fin = x ? x.index : html.length, cont = html.slice(i, fin);
    if (textoPlano(cont).length > textoPlano(mejor).length) mejor = cont;
    abre.lastIndex = i;
  }
  return mejor;
}
function extraer(html, base) {
  let h = html.replace(/<!--[\s\S]*?-->/g, '');
  const titulo = decodeEnt((h.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i) || h.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [, ''])[1]).replace(/\s+/g, ' ').trim();
  h = h.replace(/<(script|style|noscript|template|svg|iframe|form|nav|header|footer|aside|button|select|textarea|dialog|canvas|video|audio)\b[\s\S]*?<\/\1\s*>/gi, ' ')
       .replace(/<(input|link|meta)\b[^>]*>/gi, ' ');
  let cuerpo = '';
  for (const t of ['article', 'main']) { const b = bloque(h, t); if (textoPlano(b).length > textoPlano(cuerpo).length) cuerpo = b; }
  if (textoPlano(cuerpo).length < 400) cuerpo = (h.match(/<body\b[^>]*>([\s\S]*)<\/body>/i) || [, h])[1];
  let out = limpiarEtiquetas(cuerpo, base);
  // quita párrafos casi vacíos y bloques de pura navegación (listas de enlaces cortos)
  out = out.replace(/<(p|li|h[1-4]|blockquote)>\s*(?:<[^>]+>\s*)*<\/\1>/gi, '')
           .replace(/<(ul|ol)>((?:\s*<li>(?:<a[^>]*>)?[^<]{0,40}(?:<\/a>)?<\/li>\s*){4,})<\/\1>/gi, '');
  out = out.replace(/\n{3,}/g, '\n\n').trim();
  return { titulo, contenido: out, texto: textoPlano(out) };
}

function registrarLeer(app) {
  app.get('/api/leer', async (req, res) => {
    res.set('Access-Control-Allow-Origin', '*');
    try {
      const { html, url } = await descargar(String(req.query.url || ''));
      const r = extraer(html, url);
      if (r.texto.length < 200) return res.json({ exito: false, error: 'No se encontró texto para leer en esta página' });
      res.json({ exito: true, titulo: r.titulo, sitio: new URL(url).hostname.replace(/^www\./, ''), contenido: r.contenido.slice(0, 400000) });
    } catch (e) {
      res.status(200).json({ exito: false, error: String(e.message || e) });
    }
  });
}
module.exports = { registrarLeer, extraer, ipPrivada, urlSegura, limpiarEtiquetas };
